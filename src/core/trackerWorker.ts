// Tracking worker (module worker built by Vite). Runs MediaPipe HandLandmarker OFF the main thread.
//
//   main -> worker: "init" (delegate, urls), then "frame" (an ImageBitmap, transferred = zero-copy)
//   worker -> main: "env" (what this worker scope can do), "ready", "result" (landmarks + measured inference ms),
//                   "skipped", "error"
//
// The main thread sends at most one frame at a time (see frameGate.ts), so this worker never has a queue.

import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { installLogCapture, probeEnv } from "./diagnostics";
import { errText, loadLandmarker } from "./landmarkerLoader";
import {
  packHands,
  type DelegateName,
  type FromWorker,
  type InitMessage,
  type ToWorker,
  type WorkerInput,
} from "./trackerProtocol";

// tsconfig uses the DOM lib (not the WebWorker lib), so describe the little we use of the worker scope.
interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;

// Must happen before MediaPipe's WASM glue runs (Emscripten binds console.log / console.error at that moment).
installLogCapture();

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

// What the worker's own scope can do. Sent first, so it is there even if the model never loads.
scope.postMessage({ type: "env", env: probeEnv("worker") });

async function handleInit(init: InitMessage): Promise<void> {
  const token = ++initToken;
  lastInit = init;
  const old = landmarker;
  landmarker = null; // frames that arrive while loading are answered with "skipped"
  old?.close();

  let loaded: Awaited<ReturnType<typeof loadLandmarker>>;
  try {
    loaded = await loadLandmarker(init, gpuBroken);
  } catch (e) {
    if (token !== initToken) return;
    scope.postMessage({ type: "error", phase: "init", message: errText(e) });
    return;
  }
  if (token !== initToken) {
    loaded.landmarker.close(); // a newer init started while this one was loading
    return;
  }
  landmarker = loaded.landmarker;
  currentDelegate = loaded.delegate;
  scope.postMessage({
    type: "ready",
    delegate: loaded.delegate,
    loadMs: loaded.diag.loadMs,
    fallbackReason: loaded.fallbackReason,
    diag: loaded.diag,
  });
}

// "canvas" input: the bitmap is first drawn onto an OffscreenCanvas here, and MediaPipe gets the canvas.
let scratch: OffscreenCanvas | null = null;
let scratchCtx: OffscreenCanvasRenderingContext2D | null = null;

function viaCanvas(bitmap: ImageBitmap): OffscreenCanvas {
  if (!scratch || scratch.width !== bitmap.width || scratch.height !== bitmap.height) {
    scratch = new OffscreenCanvas(bitmap.width, bitmap.height);
    scratchCtx = scratch.getContext("2d");
  }
  scratchCtx?.drawImage(bitmap, 0, 0);
  return scratch;
}

function handleFrame(seq: number, ts: number, bitmap: ImageBitmap, input: WorkerInput): void {
  const lm = landmarker;
  if (!lm) {
    bitmap.close();
    scope.postMessage({ type: "skipped", seq });
    return;
  }
  try {
    const t0 = performance.now();
    const source = input === "canvas" ? viaCanvas(bitmap) : bitmap;
    const result = lm.detectForVideo(source, ts);
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

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "init") void handleInit(msg);
  else if (msg.type === "frame") handleFrame(msg.seq, msg.ts, msg.bitmap, msg.input);
};
