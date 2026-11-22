// Hand tracking: camera -> MediaPipe HandLandmarker -> stable ids -> smoothing -> HandFrame.
//
// Two layers:
//  - TrackManager / HandPipeline: pure logic (ids, hold-on-loss, smoothing, mapping). Tested without a camera.
//  - HandTracker: the browser part (camera, MediaPipe, per-frame scheduling).

import type { HandLandmarker } from "@mediapipe/tasks-vision";
import {
  CAMERA,
  HAND_MODEL_URL,
  MEDIAPIPE_WASM_URL,
  MP_CONFIDENCE,
  NUM_HANDS,
  config,
  type Config,
} from "../config";
import type { HandFrame, Vec2 } from "../instruments/Instrument";
import { dist, fitTransform, normalizedToCanvas } from "./geometry";
import { HandAnalyzer } from "./gestures";
import { LandmarkSmoother } from "./smoothing";

// ---------------------------------------------------------------------------
// Pure part
// ---------------------------------------------------------------------------

export type TrackingConfig = Pick<Config, "minCutoff" | "beta" | "dCutoff" | "holdMs" | "matchMaxDist">;

export interface TrackedNorm {
  id: number;
  /** Smoothed landmarks in normalized camera space (0..1, not mirrored yet). */
  landmarks: Vec2[];
}

interface Track {
  id: number;
  smoother: LandmarkSmoother;
  landmarks: Vec2[];
  /** Last RAW wrist position, used for matching. */
  wrist: Vec2;
  lastSeenMs: number;
}

/**
 * Gives every hand a stable id across frames (nearest wrist matching), smooths its landmarks with One Euro filters,
 * keeps a lost hand for `holdMs` (its last state), then releases it.
 */
export class TrackManager {
  private tracks: Track[] = [];
  private nextId = 1;

  constructor(private readonly cfg: TrackingConfig = config) {}

  /** `detections`: raw landmarks per detected hand, normalized camera space. */
  update(detections: Vec2[][], tMs: number): TrackedNorm[] {
    const tSec = tMs / 1000;

    // 1. Match detections to existing tracks, closest wrist pairs first.
    const pairs: Array<{ ti: number; di: number; d: number }> = [];
    this.tracks.forEach((track, ti) => {
      detections.forEach((det, di) => {
        const d = dist(track.wrist, det[0]!);
        if (d <= this.cfg.matchMaxDist) pairs.push({ ti, di, d });
      });
    });
    pairs.sort((a, b) => a.d - b.d);
    const trackTaken = new Set<number>();
    const detTaken = new Set<number>();
    for (const p of pairs) {
      if (trackTaken.has(p.ti) || detTaken.has(p.di)) continue;
      trackTaken.add(p.ti);
      detTaken.add(p.di);
      const track = this.tracks[p.ti]!;
      const det = detections[p.di]!;
      track.landmarks = track.smoother.filter(det, tSec, this.cfg);
      track.wrist = det[0]!;
      track.lastSeenMs = tMs;
    }

    // 2. Release hands that have been lost for longer than the hold time.
    this.tracks = this.tracks.filter((t) => tMs - t.lastSeenMs <= this.cfg.holdMs);

    // 3. New hands for detections nobody claimed.
    detections.forEach((det, di) => {
      if (detTaken.has(di)) return;
      if (this.tracks.length >= NUM_HANDS) {
        // Full: only replace a hand that is currently lost (being held); never steal a visible hand.
        const lostIdx = this.tracks.findIndex((t) => t.lastSeenMs < tMs);
        if (lostIdx < 0) return;
        this.tracks.splice(lostIdx, 1);
      }
      const smoother = new LandmarkSmoother(det.length);
      this.tracks.push({
        id: this.nextId++,
        smoother,
        landmarks: smoother.filter(det, tSec, this.cfg),
        wrist: det[0]!,
        lastSeenMs: tMs,
      });
    });

    return this.tracks.map((t) => ({ id: t.id, landmarks: t.landmarks }));
  }

  reset(): void {
    this.tracks = [];
  }
}

/** TrackManager + mapping to canvas pixels + HandAnalyzer. Raw detections in, HandFrame out. */
export class HandPipeline {
  readonly tracks = new TrackManager();
  readonly analyzer = new HandAnalyzer();
  private canvasW = 1280;
  private canvasH = 720;
  private videoW: number = CAMERA.width;
  private videoH: number = CAMERA.height;

  setViewport(canvasW: number, canvasH: number): void {
    this.canvasW = canvasW;
    this.canvasH = canvasH;
  }

  setVideoSize(w: number, h: number): void {
    if (w > 0 && h > 0) {
      this.videoW = w;
      this.videoH = h;
    }
  }

  get viewport(): { width: number; height: number } {
    return { width: this.canvasW, height: this.canvasH };
  }

  process(detections: Vec2[][], tMs: number): HandFrame {
    const tracked = this.tracks.update(detections, tMs);
    const fit = fitTransform(this.canvasW, this.canvasH, this.videoW, this.videoH, config.videoFit);
    const inputs = tracked.map((t) => ({
      id: t.id,
      landmarks: t.landmarks.map((p) => normalizedToCanvas(p.x, p.y, fit)),
    }));
    return this.analyzer.analyze(inputs, tMs, this.canvasW);
  }

  reset(): void {
    this.tracks.reset();
    this.analyzer.reset();
  }
}

// ---------------------------------------------------------------------------
// Browser part
// ---------------------------------------------------------------------------

export type TrackingErrorKind =
  | "camera-denied"
  | "no-camera"
  | "camera-busy"
  | "insecure"
  | "unsupported"
  | "model"
  | "unknown";

export class TrackingError extends Error {
  constructor(
    readonly kind: TrackingErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TrackingError";
  }
}

export interface TrackerStats {
  delegate: "GPU" | "CPU" | "none";
  /** Last frame, ms. */
  inferenceMs: number;
  /** Rolling over the last 120 frames, ms. */
  inferenceAvgMs: number;
  inferenceP95Ms: number;
  inferenceMaxMs: number;
  /** Averages over the whole session, split by whether a hand was in the picture. */
  avgWithHandsMs: number;
  avgNoHandsMs: number;
  framesWithHands: number;
  framesNoHands: number;
  trackingFps: number;
  videoWidth: number;
  videoHeight: number;
  usesVideoFrameCallback: boolean;
}

const SAMPLE_WINDOW = 120;

export class HandTracker {
  readonly video: HTMLVideoElement;
  readonly pipeline = new HandPipeline();
  onFrame: (frame: HandFrame) => void = () => {};
  onError: (err: TrackingError) => void = () => {};

  private stream: MediaStream | null = null;
  private landmarker: HandLandmarker | null = null;
  private landmarkerPromise: Promise<HandLandmarker> | null = null;
  private delegate: "GPU" | "CPU" | "none" = "none";
  private running = false;
  private lastVideoTime = -1;
  private lastTimestamp = 0;
  private lastFrameAt = 0;
  private fpsEma = 0;
  private samples: number[] = [];
  private lastInference = 0;
  private sumWith = 0;
  private nWith = 0;
  private sumNo = 0;
  private nNo = 0;
  private fellBackToCpu = false;
  private readonly hasRvfc: boolean;

  constructor() {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    // Kept in the page (but invisible) so the browser keeps decoding frames reliably.
    v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
    document.body.appendChild(v);
    this.video = v;
    this.hasRvfc = "requestVideoFrameCallback" in v;
  }

  /** Opens the camera and loads the model (in parallel). Safe to call again after a failure. */
  async start(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new TrackingError(
        "insecure",
        "This page cannot use the camera. Open it from https:// or from localhost.",
      );
    }
    const [stream] = await Promise.all([this.openCamera(), this.ensureLandmarker()]);
    this.stream = stream;
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch {
      throw new TrackingError("unknown", "The camera started but the video could not play.");
    }
    await this.waitForVideoSize();
    this.pipeline.setVideoSize(this.video.videoWidth, this.video.videoHeight);
    this.pipeline.reset();
    this.lastVideoTime = -1;
    this.resume();
  }

  pause(): void {
    this.running = false;
  }

  resume(): void {
    if (this.running || !this.landmarker || !this.stream) return;
    this.running = true;
    this.lastFrameAt = 0;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  getStats(): TrackerStats {
    const s = this.samples;
    let avg = 0;
    let p95 = 0;
    let max = 0;
    if (s.length > 0) {
      const sorted = [...s].sort((a, b) => a - b);
      avg = s.reduce((a, b) => a + b, 0) / s.length;
      p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
      max = sorted[sorted.length - 1]!;
    }
    return {
      delegate: this.delegate,
      inferenceMs: this.lastInference,
      inferenceAvgMs: avg,
      inferenceP95Ms: p95,
      inferenceMaxMs: max,
      avgWithHandsMs: this.nWith ? this.sumWith / this.nWith : 0,
      avgNoHandsMs: this.nNo ? this.sumNo / this.nNo : 0,
      framesWithHands: this.nWith,
      framesNoHands: this.nNo,
      trackingFps: this.fpsEma,
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
      usesVideoFrameCallback: this.hasRvfc,
    };
  }

  // --- camera ---

  private async openCamera(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: CAMERA.width },
          height: { ideal: CAMERA.height },
          facingMode: "user",
        },
        audio: false,
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new TrackingError("camera-denied", "Camera permission was denied.");
      }
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        throw new TrackingError("no-camera", "No camera was found on this device.");
      }
      if (name === "NotReadableError" || name === "AbortError") {
        throw new TrackingError("camera-busy", "The camera is being used by another app.");
      }
      throw new TrackingError("unknown", "The camera could not be started.");
    }
  }

  private waitForVideoSize(): Promise<void> {
    if (this.video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      this.video.addEventListener("loadedmetadata", done, { once: true });
      setTimeout(done, 3000);
    });
  }

  // --- model ---

  private ensureLandmarker(): Promise<HandLandmarker> {
    if (!this.landmarkerPromise) {
      this.landmarkerPromise = this.createLandmarker("GPU").catch((e: unknown) => {
        this.landmarkerPromise = null; // allow a retry after a network failure
        if (e instanceof TrackingError) throw e;
        throw new TrackingError("model", "The hand-tracking model could not be loaded. Check your internet connection.");
      });
    }
    return this.landmarkerPromise;
  }

  private async createLandmarker(preferred: "GPU" | "CPU"): Promise<HandLandmarker> {
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
    const make = (delegate: "GPU" | "CPU") =>
      HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
        runningMode: "VIDEO",
        numHands: NUM_HANDS,
        ...MP_CONFIDENCE,
      });
    let lm: HandLandmarker;
    if (preferred === "GPU") {
      try {
        lm = await make("GPU");
        this.delegate = "GPU";
      } catch (gpuError) {
        console.warn("GPU delegate failed, falling back to CPU:", gpuError);
        lm = await make("CPU");
        this.delegate = "CPU";
      }
    } else {
      lm = await make("CPU");
      this.delegate = "CPU";
    }
    this.landmarker = lm;
    return lm;
  }

  // --- per-frame loop: one detection per NEW camera frame ---

  private scheduleNext(): void {
    if (!this.running) return;
    if (this.hasRvfc) {
      this.video.requestVideoFrameCallback(() => {
        this.processFrame();
        this.scheduleNext();
      });
    } else {
      requestAnimationFrame(() => {
        if (this.video.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = this.video.currentTime;
          this.processFrame();
        }
        this.scheduleNext();
      });
    }
  }

  private processFrame(): void {
    const lm = this.landmarker;
    if (!lm || !this.running || this.video.readyState < 2) return;

    // MediaPipe needs strictly increasing timestamps.
    const t0 = performance.now();
    const ts = t0 > this.lastTimestamp ? t0 : this.lastTimestamp + 0.001;
    this.lastTimestamp = ts;

    let detections: Vec2[][];
    try {
      const result = lm.detectForVideo(this.video, ts);
      detections = result.landmarks.map((hand) => hand.map((p) => ({ x: p.x, y: p.y })));
    } catch (e) {
      this.handleDetectError(e);
      return;
    }
    const t1 = performance.now();

    this.recordTiming(t1 - t0, detections.length > 0, t1);
    this.onFrame(this.pipeline.process(detections, t1));
  }

  private handleDetectError(e: unknown): void {
    if (this.delegate === "GPU" && !this.fellBackToCpu) {
      // The GPU delegate can load fine and still fail on the first frame. Switch to CPU once.
      this.fellBackToCpu = true;
      console.warn("GPU detection failed, switching to CPU:", e);
      this.running = false;
      this.landmarker?.close();
      this.landmarker = null;
      this.landmarkerPromise = this.createLandmarker("CPU");
      this.landmarkerPromise
        .then(() => {
          this.resume();
        })
        .catch(() => {
          this.onError(new TrackingError("model", "Hand tracking failed on both GPU and CPU."));
        });
      return;
    }
    console.error("Hand tracking error:", e);
    this.running = false;
    this.onError(new TrackingError("unknown", "Hand tracking stopped because of an error."));
  }

  private recordTiming(ms: number, hasHands: boolean, now: number): void {
    this.lastInference = ms;
    this.samples.push(ms);
    if (this.samples.length > SAMPLE_WINDOW) this.samples.shift();
    if (hasHands) {
      this.sumWith += ms;
      this.nWith++;
    } else {
      this.sumNo += ms;
      this.nNo++;
    }
    if (this.lastFrameAt > 0) {
      const inst = 1000 / Math.max(1, now - this.lastFrameAt);
      this.fpsEma = this.fpsEma === 0 ? inst : this.fpsEma * 0.9 + inst * 0.1;
    }
    this.lastFrameAt = now;
  }
}
