// Creates the MediaPipe HandLandmarker. Shared by the tracking worker AND the main-thread mode, so both load the model
// the same way (same model, same WASM, same options) and the speed comparison between them is fair.

import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { installLogCapture, capturedLogs, loadedFiles, type LoadDiag } from "./diagnostics";
import type { DelegateName, InitMessage } from "./trackerProtocol";

export type LoadRequest = Omit<InitMessage, "type">;

export interface LoadedLandmarker {
  landmarker: HandLandmarker;
  /** The delegate that is really running (GPU can fall back to CPU). */
  delegate: DelegateName;
  /** Set when GPU was asked for but CPU is running; says why. */
  fallbackReason?: string;
  diag: LoadDiag;
}

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

async function create(req: LoadRequest, delegate: DelegateName): Promise<{ lm: HandLandmarker; vision: Vision }> {
  const vision = await getVision(req.wasmUrl);
  const lm = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: req.modelUrl, delegate },
    runningMode: "VIDEO",
    numHands: req.numHands,
    minHandDetectionConfidence: req.minHandDetectionConfidence,
    minHandPresenceConfidence: req.minHandPresenceConfidence,
    minTrackingConfidence: req.minTrackingConfidence,
  });
  return { lm, vision };
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Loads the model with the wanted delegate. A GPU failure at load time falls back to CPU (and says why).
 * `skipGpu`: GPU already failed on a real frame earlier, go straight to CPU.
 */
export async function loadLandmarker(req: LoadRequest, skipGpu = false): Promise<LoadedLandmarker> {
  installLogCapture(); // before the WASM glue loads (Emscripten binds console.log/error then)
  const t0 = performance.now();
  let fallbackReason: string | undefined;
  let used: DelegateName = req.delegate;
  let made: { lm: HandLandmarker; vision: Vision };

  if (req.delegate === "GPU" && !skipGpu) {
    try {
      made = await create(req, "GPU");
    } catch (gpuError) {
      fallbackReason = `GPU delegate failed: ${errText(gpuError)}`;
      used = "CPU";
      made = await create(req, "CPU");
    }
  } else {
    if (req.delegate === "GPU") fallbackReason = "GPU failed earlier on a real frame";
    used = "CPU";
    made = await create(req, "CPU");
  }

  return {
    landmarker: made.lm,
    delegate: used,
    fallbackReason,
    diag: {
      files: loadedFiles(),
      logs: capturedLogs(),
      wasmLoaderPath: String(made.vision.wasmLoaderPath),
      wasmBinaryPath: String(made.vision.wasmBinaryPath),
      modelUrl: req.modelUrl,
      loadMs: performance.now() - t0,
    },
  };
}
