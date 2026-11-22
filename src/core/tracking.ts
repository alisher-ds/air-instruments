// Hand tracking: camera -> MediaPipe HandLandmarker -> stable ids -> smoothing -> HandFrame.
//
// Two layers:
//  - TrackManager / HandPipeline: pure logic (ids, hold-on-loss, smoothing, mapping). Tested without a camera.
//  - HandTracker: the browser part. It owns the camera and the frame loop on the MAIN thread and sends camera frames
//    to the tracking worker (trackerWorker.ts), where MediaPipe runs. The main thread never waits for the worker.

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
import { FrameGate } from "./frameGate";
import { HandAnalyzer } from "./gestures";
import { RollingStats } from "./rollingStats";
import { LandmarkSmoother } from "./smoothing";
import { unpackHands, type DelegateName, type FromWorker, type InitMessage, type ToWorker } from "./trackerProtocol";

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

export type WorkerState = "not-started" | "loading" | "ready" | "failed";

export interface TrackerStats {
  delegate: DelegateName | "none";
  workerState: WorkerState;
  /** Why GPU was not used, if it fell back. Empty otherwise. */
  fallbackReason: string;
  /** Time inside detectForVideo, measured INSIDE the worker. Last frame, then the last 120 frames. */
  inferenceMs: number;
  inferenceAvgMs: number;
  inferenceP95Ms: number;
  inferenceMaxMs: number;
  /** Camera frame captured -> landmarks arrive on the main thread (grab + worker + messages + waiting). */
  frameAgeMs: number;
  frameAgeAvgMs: number;
  frameAgeP95Ms: number;
  /** false = the browser gave no capture time, so frame age counts from when we first saw the frame (too small). */
  frameAgeFromCapture: boolean;
  /** createImageBitmap(video) on the main thread, average. */
  grabAvgMs: number;
  /** Frame sent -> answer received, average (worker inference + queueing + message cost). */
  roundTripAvgMs: number;
  /** Averages over the session, split by whether a hand was in the picture. */
  avgWithHandsMs: number;
  avgNoHandsMs: number;
  framesWithHands: number;
  framesNoHands: number;
  /** Frames per second that produced landmarks. */
  trackingFps: number;
  /** New camera frames per second as seen by the browser. */
  cameraFps: number;
  /** Camera frames that were not sent to the worker (it was busy), percent. */
  droppedPercent: number;
  watchdogTimeouts: number;
  videoWidth: number;
  videoHeight: number;
  usesVideoFrameCallback: boolean;
}

interface InFlight {
  seq: number;
  /** performance.now() time the camera captured the frame (or when we first saw it, see frameAgeFromCapture). */
  captureTime: number;
  fromCapture: boolean;
  sentAt: number;
}

const SAMPLE_WINDOW = 120;
/** If the browser's capture time is further than this behind "now", it is not believable. */
const MAX_BELIEVABLE_AGE_MS = 1000;

export class HandTracker {
  readonly video: HTMLVideoElement;
  readonly pipeline = new HandPipeline();
  onFrame: (frame: HandFrame) => void = () => {};
  onError: (err: TrackingError) => void = () => {};
  /** Called when the delegate that is really running differs from the one asked for (GPU -> CPU fallback). */
  onDelegateChange: (delegate: DelegateName) => void = () => {};

  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private workerState: WorkerState = "not-started";
  private initWaiter: { resolve: () => void; reject: (e: TrackingError) => void } | null = null;
  private delegate: DelegateName | "none" = "none";
  /** The delegate the worker was last asked for (or is running), so repeated requests for it do nothing. */
  private requested: DelegateName | null = null;
  private fallbackReason = "";

  private running = false;
  private readonly hasRvfc: boolean;
  private loopHandle = 0;
  private lastVideoTime = -1;

  private readonly gate = new FrameGate();
  private inflight: InFlight | null = null;
  /** A newer camera frame arrived while the worker was busy. */
  private waiting = false;
  private latestCapture = 0;
  private latestFromCapture = false;
  /** Bumped whenever frames in flight must be thrown away (pause, delegate switch). */
  private epoch = 0;
  private seq = 0;
  private lastTimestamp = 0;

  // stats
  private readonly inference = new RollingStats(SAMPLE_WINDOW);
  private readonly frameAge = new RollingStats(SAMPLE_WINDOW);
  private readonly grab = new RollingStats(SAMPLE_WINDOW);
  private readonly roundTrip = new RollingStats(SAMPLE_WINDOW);
  private sumWith = 0;
  private nWith = 0;
  private sumNo = 0;
  private nNo = 0;
  private cameraFrames = 0;
  private sentFrames = 0;
  private lastResultAt = 0;
  private lastCameraAt = 0;
  private fpsEma = 0;
  private cameraFpsEma = 0;
  private lastFromCapture = false;

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

  /** Opens the camera and starts the worker (in parallel). Safe to call again after a failure. */
  async start(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new TrackingError(
        "insecure",
        "This page cannot use the camera. Open it from https:// or from localhost.",
      );
    }
    this.pause();
    this.releaseStream();
    // A retry after a camera error finds the model already loaded: do not load it again.
    const modelReady = this.workerState === "ready" && this.requested === config.delegate;
    const [stream] = await Promise.all([this.openCamera(), modelReady ? Promise.resolve() : this.initWorker(config.delegate)]);
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
    this.epoch++;
    this.cancelLoop();
    this.inflight = null;
    this.waiting = false;
    this.gate.reset();
  }

  resume(): void {
    if (this.running || this.workerState !== "ready" || !this.stream) return;
    this.running = true;
    this.cameraFpsEma = 0;
    this.fpsEma = 0;
    this.lastCameraAt = 0;
    this.lastResultAt = 0;
    this.scheduleNext();
  }

  stop(): void {
    this.pause();
    this.releaseStream();
  }

  /**
   * Switch GPU/CPU while running. The worker reloads the model (a second or two); frames pause meanwhile.
   * The stats window restarts so the new numbers belong to the new delegate only.
   */
  setDelegate(delegate: DelegateName): void {
    if (!this.worker || this.workerState === "not-started") return;
    if (this.requested === delegate && this.workerState !== "failed") return;
    void this.initWorker(delegate).catch((e: unknown) => {
      // A newer request replaced this one: not an error.
      if (e instanceof TrackingError && e.kind === "unknown") return;
      this.onError(e instanceof TrackingError ? e : new TrackingError("model", "Hand tracking could not be reloaded."));
    });
  }

  getStats(): TrackerStats {
    const inf = this.inference.summary();
    const age = this.frameAge.summary();
    return {
      delegate: this.delegate,
      workerState: this.workerState,
      fallbackReason: this.fallbackReason,
      inferenceMs: inf.last,
      inferenceAvgMs: inf.avg,
      inferenceP95Ms: inf.p95,
      inferenceMaxMs: inf.max,
      frameAgeMs: age.last,
      frameAgeAvgMs: age.avg,
      frameAgeP95Ms: age.p95,
      frameAgeFromCapture: this.lastFromCapture,
      grabAvgMs: this.grab.summary().avg,
      roundTripAvgMs: this.roundTrip.summary().avg,
      avgWithHandsMs: this.nWith ? this.sumWith / this.nWith : 0,
      avgNoHandsMs: this.nNo ? this.sumNo / this.nNo : 0,
      framesWithHands: this.nWith,
      framesNoHands: this.nNo,
      trackingFps: this.fpsEma,
      cameraFps: this.cameraFpsEma,
      droppedPercent: this.cameraFrames > 0 ? (100 * (this.cameraFrames - this.sentFrames)) / this.cameraFrames : 0,
      watchdogTimeouts: this.gate.timeouts,
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
      usesVideoFrameCallback: this.hasRvfc,
    };
  }

  // --- camera ---

  private releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

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

  // --- worker ---

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      // The literal `new Worker(new URL(...), { type: "module" })` form is what Vite recognises and bundles.
      worker = new Worker(new URL("./trackerWorker.ts", import.meta.url), { type: "module", name: "hand-tracker" });
    } catch (e) {
      console.error("Could not create the tracking worker:", e);
      throw new TrackingError("unsupported", "This browser cannot run the hand-tracking worker.");
    }
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.handleWorkerMessage(e.data);
    worker.onerror = (e) => {
      console.error("Tracking worker error:", e.message || e);
      this.worker?.terminate(); // a dead worker cannot be reused: the next start() makes a new one
      this.worker = null;
      this.requested = null;
      this.workerFailed(new TrackingError("model", "The hand-tracking worker failed to start."));
    };
    this.worker = worker;
    return worker;
  }

  /** (Re)loads the model in the worker with this delegate. Resolves when the worker says "ready". */
  private initWorker(delegate: DelegateName): Promise<void> {
    const worker = this.ensureWorker();
    // Whatever was in flight belongs to the old model: forget it.
    this.epoch++;
    this.inflight = null;
    this.waiting = false;
    this.gate.reset();
    this.workerState = "loading";
    this.requested = delegate;
    // "unknown" marks "replaced by a newer request" (setDelegate ignores it).
    this.initWaiter?.reject(new TrackingError("unknown", "Replaced by a newer request."));
    return new Promise<void>((resolve, reject) => {
      this.initWaiter = { resolve, reject };
      const msg: InitMessage = {
        type: "init",
        delegate,
        wasmUrl: MEDIAPIPE_WASM_URL,
        modelUrl: HAND_MODEL_URL,
        numHands: NUM_HANDS,
        minHandDetectionConfidence: MP_CONFIDENCE.minHandDetectionConfidence,
        minHandPresenceConfidence: MP_CONFIDENCE.minHandPresenceConfidence,
        minTrackingConfidence: MP_CONFIDENCE.minTrackingConfidence,
      };
      worker.postMessage(msg satisfies ToWorker);
    });
  }

  private workerFailed(err: TrackingError): void {
    this.workerState = "failed";
    this.running = false;
    this.cancelLoop();
    const waiter = this.initWaiter;
    this.initWaiter = null;
    if (waiter) waiter.reject(err);
    else this.onError(err);
  }

  private handleWorkerMessage(msg: FromWorker): void {
    switch (msg.type) {
      case "ready": {
        this.workerState = "ready";
        this.delegate = msg.delegate;
        this.requested = msg.delegate;
        this.fallbackReason = msg.fallbackReason ?? "";
        this.resetStats();
        this.waiting = false;
        this.inflight = null;
        this.gate.reset();
        if (msg.delegate !== config.delegate) this.onDelegateChange(msg.delegate);
        const waiter = this.initWaiter;
        this.initWaiter = null;
        waiter?.resolve();
        // After a switch while running, the loop is still alive and the next camera frame is sent normally.
        break;
      }
      case "result":
        this.handleResult(msg);
        break;
      case "skipped":
        if (this.inflight?.seq === msg.seq) {
          this.inflight = null;
          this.gate.release();
        }
        break;
      case "error":
        console.error("Tracking worker reported an error:", msg.message);
        this.workerFailed(
          new TrackingError(
            msg.phase === "init" ? "model" : "unknown",
            msg.phase === "init"
              ? "The hand-tracking model could not be loaded. Check your internet connection."
              : "Hand tracking stopped because of an error.",
          ),
        );
        break;
    }
  }

  // --- per-frame loop: one frame per NEW camera frame, at most one in flight ---

  private scheduleNext(): void {
    if (!this.running) return;
    if (this.hasRvfc) {
      this.loopHandle = this.video.requestVideoFrameCallback((now, meta) => {
        this.scheduleNext();
        // captureTime: when the camera captured the frame (same clock as performance.now()). Not always provided.
        const cap = meta.captureTime;
        const believable = typeof cap === "number" && cap <= now && now - cap < MAX_BELIEVABLE_AGE_MS;
        this.onCameraFrame(now, believable ? cap : now, believable);
      });
    } else {
      this.loopHandle = requestAnimationFrame((now) => {
        this.scheduleNext();
        if (this.video.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = this.video.currentTime;
          this.onCameraFrame(now, now, false);
        }
      });
    }
  }

  private cancelLoop(): void {
    if (this.loopHandle) {
      if (this.hasRvfc) this.video.cancelVideoFrameCallback(this.loopHandle);
      else cancelAnimationFrame(this.loopHandle);
      this.loopHandle = 0;
    }
  }

  private onCameraFrame(now: number, captureTime: number, fromCapture: boolean): void {
    this.cameraFrames++;
    if (this.lastCameraAt > 0) {
      const inst = 1000 / Math.max(1, now - this.lastCameraAt);
      this.cameraFpsEma = this.cameraFpsEma === 0 ? inst : this.cameraFpsEma * 0.9 + inst * 0.1;
    }
    this.lastCameraAt = now;
    this.latestCapture = captureTime;
    this.latestFromCapture = fromCapture;

    if (this.workerState !== "ready") return;
    if (!this.gate.tryAcquire(now)) {
      this.waiting = true; // worker busy: this frame is dropped (maybe replaced by a newer one when the worker is free)
      return;
    }
    this.sendFrame(captureTime, fromCapture);
  }

  /** Gate is already acquired. Grabs the current video frame as a bitmap and moves it to the worker. */
  private sendFrame(captureTime: number, fromCapture: boolean): void {
    const worker = this.worker;
    if (!worker || this.video.readyState < 2 || this.video.videoWidth === 0) {
      this.gate.release();
      return;
    }
    this.waiting = false;
    this.sentFrames++;
    const epoch = this.epoch;
    const seq = ++this.seq;
    const t0 = performance.now();
    createImageBitmap(this.video).then(
      (bitmap) => {
        if (epoch !== this.epoch || !this.running) {
          bitmap.close();
          return; // pause()/switch already reset the gate
        }
        const t1 = performance.now();
        this.grab.push(t1 - t0);
        // MediaPipe needs strictly increasing timestamps.
        const ts = t1 > this.lastTimestamp ? t1 : this.lastTimestamp + 0.001;
        this.lastTimestamp = ts;
        this.inflight = { seq, captureTime, fromCapture, sentAt: t1 };
        const msg: ToWorker = { type: "frame", seq, ts, bitmap };
        worker.postMessage(msg, [bitmap]);
      },
      (e: unknown) => {
        console.warn("createImageBitmap failed:", e);
        if (epoch === this.epoch) this.gate.release();
      },
    );
  }

  private handleResult(msg: Extract<FromWorker, { type: "result" }>): void {
    const inf = this.inflight;
    if (!inf || inf.seq !== msg.seq) return; // answer to a frame from before a pause / delegate switch
    const arrival = performance.now();
    this.inflight = null;
    this.gate.release();

    // A newer camera frame is waiting: hand it to the worker NOW, before doing any main-thread work with this result.
    if (this.waiting && this.running && config.pickupOnFree && this.gate.tryAcquire(arrival)) {
      this.sendFrame(this.latestCapture, this.latestFromCapture);
    }

    const hasHands = msg.count > 0;
    this.inference.push(msg.inferenceMs);
    this.frameAge.push(arrival - inf.captureTime);
    this.roundTrip.push(arrival - inf.sentAt);
    this.lastFromCapture = inf.fromCapture;
    if (hasHands) {
      this.sumWith += msg.inferenceMs;
      this.nWith++;
    } else {
      this.sumNo += msg.inferenceMs;
      this.nNo++;
    }
    if (this.lastResultAt > 0) {
      const inst = 1000 / Math.max(1, arrival - this.lastResultAt);
      this.fpsEma = this.fpsEma === 0 ? inst : this.fpsEma * 0.9 + inst * 0.1;
    }
    this.lastResultAt = arrival;

    this.onFrame(this.pipeline.process(unpackHands(msg.count, msg.perHand, msg.points), arrival));
  }

  private resetStats(): void {
    this.inference.reset();
    this.frameAge.reset();
    this.grab.reset();
    this.roundTrip.reset();
    this.sumWith = this.nWith = this.sumNo = this.nNo = 0;
    this.cameraFrames = 0;
    this.sentFrames = 0;
    this.fpsEma = 0;
    this.lastResultAt = 0;
  }
}
