// Hand tracking: camera -> MediaPipe HandLandmarker -> stable ids -> smoothing -> HandFrame.
//
// Two layers:
//  - TrackManager / HandPipeline: pure logic (ids, hold-on-loss, smoothing, mapping). Tested without a camera.
//  - HandTracker: the browser part. It owns the camera and the frame loop on the MAIN thread. MediaPipe runs either in
//    the tracking worker (trackerWorker.ts, mode "worker": the main thread never waits for it) or right on the main
//    thread (mode "main", the Stage 0 way, kept as a speed test). Both modes share the same pipeline after the landmarks.

import type { HandLandmarker } from "@mediapipe/tasks-vision";
import {
  CAMERA,
  HAND_MODEL_URL,
  MEDIAPIPE_WASM_URL,
  MP_CONFIDENCE,
  NUM_HANDS,
  cameraSize,
  config,
  type Config,
} from "../config";
import type { HandFrame, Vec2 } from "../instruments/Instrument";
import { probeEnv, type EnvDiag, type LoadDiag } from "./diagnostics";
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
  /** The same hand BEFORE the One Euro filter (the last detection; for a held hand, the last one seen). */
  raw: Vec2[];
}

interface Track {
  id: number;
  smoother: LandmarkSmoother;
  landmarks: Vec2[];
  /** Last RAW (unsmoothed) detection. */
  raw: Vec2[];
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
      track.raw = det;
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
        raw: det,
        wrist: det[0]!,
        lastSeenMs: tMs,
      });
    });

    return this.tracks.map((t) => ({ id: t.id, landmarks: t.landmarks, raw: t.raw }));
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
      raw: t.raw.map((p) => normalizedToCanvas(p.x, p.y, fit)),
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

/** Raw numbers of one tracking result. */
export interface TrackSample {
  /** performance.now() when the result reached the main thread. */
  arrival: number;
  inferenceMs: number;
  /** Camera capture -> landmarks ready. */
  frameAgeMs: number;
  /** How many hands were found (0 = nobody in view). */
  hands: number;
}

/** State of the tracking backend (the worker, or the main-thread landmarker). */
export type WorkerState = "not-started" | "loading" | "ready" | "failed";
export type TrackMode = "worker" | "main";

export interface TrackerStats {
  mode: TrackMode;
  delegate: DelegateName | "none";
  workerState: WorkerState;
  /** Why GPU was not used, if it fell back. Empty otherwise. */
  fallbackReason: string;
  /** Time inside detectForVideo (inside the worker, or on the main thread in "main" mode). Last frame, then the last 120. */
  inferenceMs: number;
  inferenceAvgMs: number;
  inferenceP95Ms: number;
  inferenceMaxMs: number;
  /** Camera frame captured -> landmarks arrive at the code that uses them (grab + worker + messages + waiting). */
  frameAgeMs: number;
  frameAgeAvgMs: number;
  frameAgeP95Ms: number;
  /** false = the browser gave no capture time, so frame age counts from when we first saw the frame (too small). */
  frameAgeFromCapture: boolean;
  /** createImageBitmap(video) on the main thread, average (worker mode only). */
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
  /** Percent of camera frames that did not reach MediaPipe, and why. The three numbers add up to notSentPercent. */
  notSentPercent: number;
  skippedEveryPercent: number;
  /** The browser delivered the frame but our callback never ran for it (main thread was busy). */
  missedByBrowserPercent: number;
  /** Rest: the worker was still busy with the previous frame. */
  busyPercent: number;
  /** Main mode: how much of every second the main thread spends inside MediaPipe (trackingFps x inference avg). */
  mainBlockedPercent: number;
  watchdogTimeouts: number;
  videoWidth: number;
  videoHeight: number;
  /** What the camera really delivers: "640x480 @30 fps" (from the track settings). */
  cameraSettings: string;
  usesVideoFrameCallback: boolean;
  /** Facts about the worker scope and the page scope (OffscreenCanvas, WebGL2, GPU name, SIMD...). */
  envWorker: EnvDiag | null;
  envMain: EnvDiag | null;
  /** What loading the model told us: files, MediaPipe console lines. null until a model has loaded. */
  load: LoadDiag | null;
}

interface InFlight {
  seq: number;
  /** performance.now() time the camera captured the frame (or when we first saw it, see frameAgeFromCapture). */
  captureTime: number;
  fromCapture: boolean;
  sentAt: number;
}

interface Delivery {
  inferenceMs: number;
  hands: Vec2[][];
  captureTime: number;
  fromCapture: boolean;
  sentAt: number;
  arrival: number;
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
  /** One call per tracking result with its raw numbers (used by the render-settings comparison, which needs per-frame data). */
  onSample: (sample: TrackSample) => void = () => {};
  /** Camera capture time (performance.now clock) of the frame behind the latest onFrame. Used to draw ahead by the frame age. */
  lastCaptureTime = 0;

  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private mainLm: HandLandmarker | null = null;
  private mainToken = 0;
  private mainGpuBroken = false;
  private workerState: WorkerState = "not-started";
  private initWaiter: { resolve: () => void; reject: (e: TrackingError) => void } | null = null;
  private delegate: DelegateName | "none" = "none";
  /** Settings the backend was last asked for (or is running), so repeated requests for them do nothing. */
  private appliedMode: TrackMode | null = null;
  private requestedHands = 0;
  /** "mode|delegate|hands" of the last backend load that was started or finished; applySettings compares against it. */
  private attempt = "";
  private appliedRes = "";
  private camToken = 0;
  private fallbackReason = "";
  private envWorker: EnvDiag | null = null;
  private envMain: EnvDiag | null = null;
  private loadDiag: LoadDiag | null = null;

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
  /** Bumped whenever frames in flight must be thrown away (pause, backend switch). */
  private epoch = 0;
  private seq = 0;
  private lastTimestamp = 0;
  private camIndex = 0;

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
  private skippedEvery = 0;
  private missedFrames = 0;
  private lastPresented = 0;
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
    // Kept in the page so the browser keeps decoding frames reliably. style.css: invisible by default ("cam"), and the
    // renderer turns it into the visible mirrored camera layer ("layer") when videoMode is "element".
    v.className = "cam";
    document.body.appendChild(v);
    this.video = v;
    this.hasRvfc = "requestVideoFrameCallback" in v;
  }

  /** What to ask MediaPipe for (also used by the benchmark, so it loads exactly the same model the app does). */
  makeRequest(delegate: DelegateName): InitMessage {
    return {
      type: "init",
      delegate,
      wasmUrl: MEDIAPIPE_WASM_URL,
      modelUrl: HAND_MODEL_URL,
      numHands: Math.min(2, Math.max(1, Math.round(config.numHands))),
      minHandDetectionConfidence: MP_CONFIDENCE.minHandDetectionConfidence,
      minHandPresenceConfidence: MP_CONFIDENCE.minHandPresenceConfidence,
      minTrackingConfidence: MP_CONFIDENCE.minTrackingConfidence,
    };
  }

  private wantedAttempt(): string {
    return `${config.trackMode}|${config.delegate}|${this.makeRequest(config.delegate).numHands}`;
  }

  /** Opens the camera and starts the backend (in parallel). Safe to call again after a failure. */
  async start(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new TrackingError(
        "insecure",
        "This page cannot use the camera. Open it from https:// or from localhost.",
      );
    }
    this.pause();
    this.releaseStream();
    this.envMain ??= probeEnv("main");
    // A retry after a camera error finds the model already loaded: do not load it again.
    const modelReady = this.workerState === "ready" && this.attempt === this.wantedAttempt();
    const [stream] = await Promise.all([
      this.openCamera(),
      modelReady ? Promise.resolve() : this.initBackend(config.trackMode, config.delegate),
    ]);
    await this.attachStream(stream);
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
    this.lastPresented = 0;
    this.scheduleNext();
  }

  stop(): void {
    this.pause();
    this.releaseStream();
  }

  /**
   * Makes the running tracker match `config`: tracking mode (worker/main), delegate, numHands, camera size.
   * Each of these reloads the model (a second or two) or reopens the camera; frames pause meanwhile.
   * The stats window restarts so the numbers on screen belong to the new setting only. Does nothing for unchanged settings.
   */
  applySettings(): void {
    if (this.appliedMode === null) return; // start() has not run yet: it reads config itself
    if (this.attempt !== this.wantedAttempt()) {
      void this.initBackend(config.trackMode, config.delegate).catch((e: unknown) => {
        // A newer request replaced this one: not an error.
        if (e instanceof TrackingError && e.kind === "unknown") return;
        this.onError(e instanceof TrackingError ? e : new TrackingError("model", "Hand tracking could not be reloaded."));
      });
    }
    if (this.stream && this.appliedRes !== config.cameraRes) void this.reopenCamera();
  }

  getStats(): TrackerStats {
    const inf = this.inference.summary();
    const age = this.frameAge.summary();
    const total = this.cameraFrames + this.missedFrames;
    const pct = (n: number): number => (total > 0 ? (100 * n) / total : 0);
    const notSent = pct(total - this.sentFrames);
    const skipped = pct(this.skippedEvery);
    const missed = pct(this.missedFrames);
    return {
      mode: this.appliedMode ?? config.trackMode,
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
      notSentPercent: notSent,
      skippedEveryPercent: skipped,
      missedByBrowserPercent: missed,
      busyPercent: Math.max(0, notSent - skipped - missed),
      mainBlockedPercent: this.appliedMode === "main" ? Math.min(100, (this.fpsEma * inf.avg) / 10) : 0,
      watchdogTimeouts: this.gate.timeouts,
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
      cameraSettings: this.cameraSettingsText(),
      usesVideoFrameCallback: this.hasRvfc,
      envWorker: this.envWorker,
      envMain: this.envMain,
      load: this.loadDiag,
    };
  }

  // --- camera ---

  private releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  private cameraSettingsText(): string {
    const s = this.stream?.getVideoTracks()[0]?.getSettings();
    if (!s) return "-";
    return `${s.width ?? "?"}x${s.height ?? "?"} @${s.frameRate !== undefined ? Math.round(s.frameRate) : "?"} fps`;
  }

  private async openCamera(): Promise<MediaStream> {
    const size = cameraSize(config.cameraRes);
    this.appliedRes = config.cameraRes;
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: size.width },
          height: { ideal: size.height },
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

  /** Shows a freshly opened stream in the (hidden) video element and waits until it has a size. */
  private async attachStream(stream: MediaStream): Promise<void> {
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
  }

  /** Camera size changed in the panel: close the camera, open it again with the new size, keep the model. */
  private async reopenCamera(): Promise<void> {
    const token = ++this.camToken;
    this.pause();
    this.releaseStream();
    try {
      const stream = await this.openCamera();
      if (token !== this.camToken) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      await this.attachStream(stream);
      this.resetStats();
      this.resume();
    } catch (e) {
      this.onError(e instanceof TrackingError ? e : new TrackingError("unknown", "The camera could not be restarted."));
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

  // --- backend: the worker, or the main-thread landmarker ---

  /** (Re)loads the model for this mode and delegate. Resolves when the backend is ready. */
  private initBackend(mode: TrackMode, delegate: DelegateName): Promise<void> {
    // Whatever was in flight belongs to the old backend: forget it.
    this.epoch++;
    this.inflight = null;
    this.waiting = false;
    this.gate.reset();
    this.appliedMode = mode;
    this.attempt = `${mode}|${delegate}|${this.makeRequest(delegate).numHands}`;
    if (mode === "worker") {
      this.disposeMain();
      return this.initWorker(delegate);
    }
    this.disposeWorker();
    return this.initMain(delegate);
  }

  private disposeWorker(): void {
    this.initWaiter?.reject(new TrackingError("unknown", "Replaced by a newer request."));
    this.initWaiter = null;
    this.worker?.terminate();
    this.worker = null;
  }

  private disposeMain(): void {
    this.mainToken++; // an init that is still loading will throw its result away
    this.mainLm?.close();
    this.mainLm = null;
  }

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
      this.workerFailed(new TrackingError("model", "The hand-tracking worker failed to start."));
    };
    this.worker = worker;
    return worker;
  }

  private initWorker(delegate: DelegateName): Promise<void> {
    const worker = this.ensureWorker();
    this.workerState = "loading";
    const msg = this.makeRequest(delegate);
    this.requestedHands = msg.numHands;
    // "unknown" marks "replaced by a newer request" (applySettings ignores it).
    this.initWaiter?.reject(new TrackingError("unknown", "Replaced by a newer request."));
    return new Promise<void>((resolve, reject) => {
      this.initWaiter = { resolve, reject };
      worker.postMessage(msg satisfies ToWorker);
    });
  }

  private async initMain(delegate: DelegateName): Promise<void> {
    const token = ++this.mainToken;
    this.mainLm?.close();
    this.mainLm = null;
    this.workerState = "loading";
    const req = this.makeRequest(delegate);
    this.requestedHands = req.numHands;
    try {
      // Loaded only when this mode is used, so the worker mode does not carry MediaPipe in the main bundle.
      const { loadLandmarker } = await import("./landmarkerLoader");
      const loaded = await loadLandmarker(req, this.mainGpuBroken);
      if (token !== this.mainToken) {
        loaded.landmarker.close();
        throw new TrackingError("unknown", "Replaced by a newer request.");
      }
      this.mainLm = loaded.landmarker;
      this.onBackendReady(loaded.delegate, loaded.fallbackReason, loaded.diag);
    } catch (e) {
      if (e instanceof TrackingError) throw e;
      if (token === this.mainToken) this.workerState = "failed";
      console.error("Main-thread hand tracking could not load:", e);
      throw new TrackingError("model", "The hand-tracking model could not be loaded. Check your internet connection.");
    }
  }

  private onBackendReady(delegate: DelegateName, fallbackReason: string | undefined, diag: LoadDiag): void {
    this.workerState = "ready";
    this.delegate = delegate;
    this.fallbackReason = fallbackReason ?? "";
    this.attempt = `${this.appliedMode ?? config.trackMode}|${delegate}|${this.requestedHands}`;
    this.loadDiag = diag;
    this.resetStats();
    this.waiting = false;
    this.inflight = null;
    this.gate.reset();
    if (delegate !== config.delegate) this.onDelegateChange(delegate);
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
      case "env":
        this.envWorker = msg.env;
        break;
      case "ready": {
        this.onBackendReady(msg.delegate, msg.fallbackReason, msg.diag);
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

  // --- per-frame loop: one frame per NEW camera frame ---

  private scheduleNext(): void {
    if (!this.running) return;
    if (this.hasRvfc) {
      this.loopHandle = this.video.requestVideoFrameCallback((now, meta) => {
        this.scheduleNext();
        // captureTime: when the camera captured the frame (same clock as performance.now()). Not always provided.
        const cap = meta.captureTime;
        const believable = typeof cap === "number" && cap <= now && now - cap < MAX_BELIEVABLE_AGE_MS;
        this.onCameraFrame(now, believable ? cap : now, believable, meta.presentedFrames);
      });
    } else {
      this.loopHandle = requestAnimationFrame((now) => {
        this.scheduleNext();
        if (this.video.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = this.video.currentTime;
          this.onCameraFrame(now, now, false, undefined);
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

  private onCameraFrame(now: number, captureTime: number, fromCapture: boolean, presented: number | undefined): void {
    // presentedFrames counts every frame the browser showed; a jump means our callback missed frames (main thread busy).
    if (presented !== undefined) {
      if (this.lastPresented > 0 && presented > this.lastPresented + 1) this.missedFrames += presented - this.lastPresented - 1;
      this.lastPresented = presented;
    }
    this.cameraFrames++;
    if (this.lastCameraAt > 0) {
      const inst = 1000 / Math.max(1, now - this.lastCameraAt);
      this.cameraFpsEma = this.cameraFpsEma === 0 ? inst : this.cameraFpsEma * 0.9 + inst * 0.1;
    }
    this.lastCameraAt = now;
    this.latestCapture = captureTime;
    this.latestFromCapture = fromCapture;

    if (this.workerState !== "ready") return;
    const every = Math.max(1, Math.round(config.inferEvery));
    if (++this.camIndex % every !== 0) {
      this.skippedEvery++;
      return;
    }
    if (this.appliedMode === "main") {
      this.detectOnMainThread(captureTime, fromCapture);
      return;
    }
    if (!this.gate.tryAcquire(now)) {
      this.waiting = true; // worker busy: this frame is dropped (maybe replaced by a newer one when the worker is free)
      return;
    }
    this.sendFrame(captureTime, fromCapture);
  }

  /** Strictly increasing timestamps (MediaPipe requires it). */
  private nextTimestamp(t: number): number {
    const ts = t > this.lastTimestamp ? t : this.lastTimestamp + 0.001;
    this.lastTimestamp = ts;
    return ts;
  }

  /** MAIN mode: MediaPipe runs right here and blocks the main thread for the whole call (that is the point of the test). */
  private detectOnMainThread(captureTime: number, fromCapture: boolean): void {
    const lm = this.mainLm;
    if (!lm || this.video.readyState < 2 || this.video.videoWidth === 0) return;
    this.sentFrames++;
    const t0 = performance.now();
    try {
      const result = lm.detectForVideo(this.video, this.nextTimestamp(t0));
      const t1 = performance.now();
      this.deliver({
        inferenceMs: t1 - t0,
        hands: result.landmarks.map((hand) => hand.map((p) => ({ x: p.x, y: p.y }))),
        captureTime,
        fromCapture,
        sentAt: t0,
        arrival: t1,
      });
    } catch (e) {
      if (this.delegate === "GPU" && !this.mainGpuBroken) {
        // The GPU delegate can load fine and still fail on a real frame. Switch to CPU once.
        this.mainGpuBroken = true;
        console.warn("GPU detection failed on the main thread, switching to CPU:", e);
        void this.initMain("CPU").catch(() => {});
      } else {
        console.error("Hand detection failed:", e);
        this.workerFailed(new TrackingError("unknown", "Hand tracking stopped because of an error."));
      }
    }
  }

  /** WORKER mode. Gate is already acquired. Grabs the current video frame as a bitmap and moves it to the worker. */
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
        this.inflight = { seq, captureTime, fromCapture, sentAt: t1 };
        const msg: ToWorker = { type: "frame", seq, ts: this.nextTimestamp(t1), input: config.workerInput, bitmap };
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
    if (!inf || inf.seq !== msg.seq) return; // answer to a frame from before a pause / backend switch
    const arrival = performance.now();
    this.inflight = null;
    this.gate.release();

    // A newer camera frame is waiting: hand it to the worker NOW, before doing any main-thread work with this result.
    if (this.waiting && this.running && config.pickupOnFree && this.gate.tryAcquire(arrival)) {
      this.sendFrame(this.latestCapture, this.latestFromCapture);
    }

    this.deliver({
      inferenceMs: msg.inferenceMs,
      hands: unpackHands(msg.count, msg.perHand, msg.points),
      captureTime: inf.captureTime,
      fromCapture: inf.fromCapture,
      sentAt: inf.sentAt,
      arrival,
    });
  }

  /** One result (from either backend): stats, then the pipeline (ids, smoothing, gestures) and the app callback. */
  private deliver(d: Delivery): void {
    const hasHands = d.hands.length > 0;
    this.inference.push(d.inferenceMs);
    this.frameAge.push(d.arrival - d.captureTime);
    this.roundTrip.push(d.arrival - d.sentAt);
    this.lastFromCapture = d.fromCapture;
    if (hasHands) {
      this.sumWith += d.inferenceMs;
      this.nWith++;
    } else {
      this.sumNo += d.inferenceMs;
      this.nNo++;
    }
    if (this.lastResultAt > 0) {
      const inst = 1000 / Math.max(1, d.arrival - this.lastResultAt);
      this.fpsEma = this.fpsEma === 0 ? inst : this.fpsEma * 0.9 + inst * 0.1;
    }
    this.lastResultAt = d.arrival;
    this.lastCaptureTime = d.captureTime;
    this.onSample({ arrival: d.arrival, inferenceMs: d.inferenceMs, frameAgeMs: d.arrival - d.captureTime, hands: d.hands.length });

    const frame = this.pipeline.process(d.hands, d.arrival);
    frame.captureTime = d.captureTime;
    this.onFrame(frame);
  }

  /** Starts the stats window again (the owner presses "Reset numbers" after changing a setting, to measure it cleanly). */
  resetStats(): void {
    this.inference.reset();
    this.frameAge.reset();
    this.grab.reset();
    this.roundTrip.reset();
    this.sumWith = this.nWith = this.sumNo = this.nNo = 0;
    this.cameraFrames = 0;
    this.sentFrames = 0;
    this.skippedEvery = 0;
    this.missedFrames = 0;
    this.lastPresented = 0;
    this.camIndex = 0;
    this.fpsEma = 0;
    this.lastResultAt = 0;
  }
}
