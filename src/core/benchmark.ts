// "Run benchmark" button (debug panel): measures, on the OWNER's machine, with his hands in view, which part of the
// tracking path is slow. It loads MediaPipe on the main thread (GPU, then CPU) and feeds the same live camera to it in
// three ways, 30 frames each:
//   video element           what the old main-thread tracking did (the browser uploads the frame to the GPU itself)
//   ImageBitmap             what the worker gets (createImageBitmap(video), uploaded by MediaPipe)
//   OffscreenCanvas copy    the bitmap drawn to a 2D canvas first (the "canvas" worker input)
// Compare the rows: if "video element" is fast and "ImageBitmap" is slow, the way the frame reaches the GPU is the
// problem, not the worker. If all GPU rows are slow, the GPU itself (or the load on it) is the problem.
// Live tracking is paused while it runs (about 15-25 s, mostly model loading).

import type { HandLandmarker } from "@mediapipe/tasks-vision";
import type { LoadRequest } from "./landmarkerLoader";
import type { DelegateName } from "./trackerProtocol";

export interface BenchRow {
  label: string;
  n: number;
  avgMs: number;
  p95Ms: number;
  /** Extra cost before detect (createImageBitmap / canvas copy), average. 0 for the video element. */
  prepMs: number;
  handsPercent: number;
}

type Source = "video" | "bitmap" | "canvas";

/** avg and p95 of a list (pure, tested). */
export function summarize(values: readonly number[]): { avg: number; p95: number } {
  if (values.length === 0) return { avg: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return { avg: sum / sorted.length, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! };
}

export function formatRow(r: BenchRow): string {
  const prep = r.prepMs > 0 ? `  (+${r.prepMs.toFixed(1)} ms to prepare the frame)` : "";
  return `${r.label.padEnd(28)} avg ${r.avgMs.toFixed(1).padStart(6)} ms | p95 ${r.p95Ms.toFixed(1).padStart(6)}${prep}  hands in ${Math.round(r.handsPercent)}% of frames`;
}

/** Waits for the next camera frame, but never longer than 500 ms (a stalled camera must not hang the benchmark). */
function nextVideoFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    if ("requestVideoFrameCallback" in video) {
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}

async function measure(lm: HandLandmarker, video: HTMLVideoElement, source: Source, frames: number, clock: { ts: number }): Promise<Omit<BenchRow, "label">> {
  const detect: number[] = [];
  const prep: number[] = [];
  let withHands = 0;
  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  const warmup = 3;
  for (let i = 0; i < frames + warmup; i++) {
    await nextVideoFrame(video);
    let image: HTMLVideoElement | ImageBitmap | OffscreenCanvas = video;
    let bitmap: ImageBitmap | null = null;
    const p0 = performance.now();
    if (source === "bitmap") {
      bitmap = await createImageBitmap(video);
      image = bitmap;
    } else if (source === "canvas") {
      if (!canvas) {
        canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
        ctx = canvas.getContext("2d");
      }
      ctx?.drawImage(video, 0, 0);
      image = canvas;
    }
    const t0 = performance.now();
    const result = lm.detectForVideo(image, (clock.ts = Math.max(clock.ts + 1, t0)));
    const t1 = performance.now();
    bitmap?.close();
    if (i >= warmup) {
      detect.push(t1 - t0);
      prep.push(t0 - p0);
      if (result.landmarks.length > 0) withHands++;
    }
  }
  const s = summarize(detect);
  return { n: detect.length, avgMs: s.avg, p95Ms: s.p95, prepMs: source === "video" ? 0 : summarize(prep).avg, handsPercent: (100 * withHands) / frames };
}

/**
 * Runs the whole benchmark and returns the report lines. `log` gets progress text. Throws nothing: a failing case
 * becomes a line saying why.
 */
export async function runBenchmark(
  video: HTMLVideoElement,
  makeRequest: (delegate: DelegateName) => LoadRequest,
  log: (text: string) => void,
  frames = 30,
): Promise<string[]> {
  const lines: string[] = [];
  const { loadLandmarker } = await import("./landmarkerLoader");
  for (const delegate of ["GPU", "CPU"] as const) {
    log(`Loading the ${delegate} model on the main thread...`);
    let loaded: Awaited<ReturnType<typeof loadLandmarker>>;
    try {
      loaded = await loadLandmarker(makeRequest(delegate), false);
    } catch (e) {
      lines.push(`main ${delegate}: could not load (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    if (loaded.delegate !== delegate) {
      lines.push(`main ${delegate}: NOT available, MediaPipe fell back to ${loaded.delegate} (${loaded.fallbackReason ?? "no reason given"})`);
    }
    const clock = { ts: performance.now() };
    const cases: Array<[Source, string]> = [
      ["video", "video element"],
      ["bitmap", "ImageBitmap"],
      ["canvas", "OffscreenCanvas copy"],
    ];
    for (const [source, name] of cases) {
      log(`Measuring main ${loaded.delegate}, ${name}...`);
      try {
        const row = await measure(loaded.landmarker, video, source, frames, clock);
        lines.push(formatRow({ label: `main ${loaded.delegate} | ${name}`, ...row }));
      } catch (e) {
        lines.push(`main ${loaded.delegate} | ${name}: failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    loaded.landmarker.close();
  }
  return lines;
}
