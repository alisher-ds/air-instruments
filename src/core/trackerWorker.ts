// Tracking worker (module worker built by Vite). Runs MediaPipe HandLandmarker OFF the main thread.
//
//   main -> worker: "init" (delegate, urls), then "frame" (an ImageBitmap, transferred = zero-copy)
//   worker -> main: "ready", "result" (landmarks + measured inference ms), "skipped", "error"
//
// The main thread sends at most one frame at a time (see frameGate.ts), so this worker never has a queue.

import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import {
  packHands,
  type DelegateName,
  type FromWorker,
  type InitMessage,
  type ToWorker,
} from "./trackerProtocol";

// tsconfig uses the DOM lib (not the WebWorker lib), so describe the little we use of the worker scope.
interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;

// MediaPipe loads its WASM glue (a CLASSIC script that sets the global `ModuleFactory`) with importScripts(). Module
// workers have no working importScripts, so MediaPipe falls back to `self.import(url)` if it exists, else to a plain
// import(), which runs the glue as an ES module and fails with "ModuleFactory not set". So we provide `self.import`:
// fetch the glue and run it as a global script (indirect eval), which is what importScripts would have done.
// The glue comes from the same pinned jsdelivr URL MediaPipe would have loaded anyway. (This needs no CSP that
// forbids eval; GitHub Pages and Vercel add none by default.)
(self as unknown as { import: (url: string) => Promise<void> }).import = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: HTTP ${res.status}`);
  (0, eval)(await res.text());
};

let landmarker: HandLandmarker | null = null;
let currentDelegate: DelegateName = "CPU";
let lastInit: InitMessage | null = null;
/** Bumped by every "init"; a slower, older init that finishes late is thrown away. */
let initToken = 0;
/** After a GPU failure on a real frame we drop to CPU once, and stay there. */
let gpuBroken = false;

type Vision = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
let visionPromise: Promise<Vision> | null = null;
let visionUrl = "";

function getVision(wasmUrl: string): Promise<Vision> {
  if (!visionPromise || visionUrl !== wasmUrl) {
    visionUrl = wasmUrl;
    visionPromise = FilesetResolver.forVisionTasks(wasmUrl);
  }
  return visionPromise;
}

async function makeLandmarker(init: InitMessage, delegate: DelegateName): Promise<HandLandmarker> {
  const vision = await getVision(init.wasmUrl);
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: init.modelUrl, delegate },
    runningMode: "VIDEO",
    numHands: init.numHands,
    minHandDetectionConfidence: init.minHandDetectionConfidence,
    minHandPresenceConfidence: init.minHandPresenceConfidence,
    minTrackingConfidence: init.minTrackingConfidence,
  });
}

async function handleInit(init: InitMessage): Promise<void> {
  const token = ++initToken;
  lastInit = init;
  const t0 = performance.now();
  const old = landmarker;
  landmarker = null; // frames that arrive while loading are answered with "skipped"
  old?.close();

  let fallbackReason: string | undefined;
  let lm: HandLandmarker;
  let used: DelegateName = init.delegate;
  try {
    if (init.delegate === "GPU" && !gpuBroken) {
      try {
        lm = await makeLandmarker(init, "GPU");
      } catch (gpuError) {
        fallbackReason = `GPU delegate failed: ${errText(gpuError)}`;
        used = "CPU";
        lm = await makeLandmarker(init, "CPU");
      }
    } else {
      if (init.delegate === "GPU") fallbackReason = "GPU failed earlier on a real frame";
      used = "CPU";
      lm = await makeLandmarker(init, "CPU");
    }
  } catch (e) {
    if (token !== initToken) return;
    scope.postMessage({ type: "error", phase: "init", message: errText(e) });
    return;
  }
  if (token !== initToken) {
    lm.close(); // a newer init started while this one was loading
    return;
  }
  landmarker = lm;
  currentDelegate = used;
  scope.postMessage({ type: "ready", delegate: used, loadMs: performance.now() - t0, fallbackReason });
}

function handleFrame(seq: number, ts: number, bitmap: ImageBitmap): void {
  const lm = landmarker;
  if (!lm) {
    bitmap.close();
    scope.postMessage({ type: "skipped", seq });
    return;
  }
  try {
    const t0 = performance.now();
    const result = lm.detectForVideo(bitmap, ts);
    const inferenceMs = performance.now() - t0;
    const packed = packHands(result.landmarks);
    scope.postMessage(
      { type: "result", seq, inferenceMs, count: packed.count, perHand: packed.perHand, points: packed.points },
      [packed.points.buffer],
    );
  } catch (e) {
    if (currentDelegate === "GPU" && lastInit && !gpuBroken) {
      // The GPU delegate can load fine and still fail on a real frame. Switch to CPU once.
      gpuBroken = true;
      console.warn("GPU detection failed in the worker, switching to CPU:", e);
      scope.postMessage({ type: "skipped", seq });
      // handleInit announces "ready" with delegate CPU, which tells the main thread what happened.
      void handleInit({ ...lastInit, delegate: "CPU" });
    } else {
      scope.postMessage({ type: "error", phase: "detect", message: errText(e) });
    }
  } finally {
    bitmap.close();
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "init") void handleInit(msg);
  else if (msg.type === "frame") handleFrame(msg.seq, msg.ts, msg.bitmap);
};
