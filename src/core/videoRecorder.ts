// "Record performance" (PLAN.md section 7, Stage 6): records the picture and the sound to a .webm file the player can share.
//
// The camera is a <video> element UNDER the effects canvas (Stage 0.7), so the canvas alone has no picture. While recording, a
// hidden canvas is drawn every frame from the video + the effects canvas (+ the sharp skeleton canvas), and that canvas is
// captured together with the audio (a MediaStreamDestination fed from the master chain, after the limiter). It costs nothing
// when not recording. Everything stays in the browser: the file is made and downloaded locally.

/** The best recording format this browser supports, or "" when MediaRecorder cannot record video at all. */
export function pickMimeType(isSupported: (mime: string) => boolean): string {
  const wanted = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm;codecs=h264,opus", "video/webm"];
  return wanted.find((m) => isSupported(m)) ?? "";
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "air-instruments-2026-11-23-14-05-09.webm" */
export function recordingFileName(d: Date): string {
  return `air-instruments-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.webm`;
}

/** Size of the recording: the window size, limited to `maxWidth` (keeps the cost of the extra canvas small), even numbers. */
export function recordingSize(w: number, h: number, maxWidth = 1280): { width: number; height: number } {
  const k = w > maxWidth ? maxWidth / w : 1;
  const even = (n: number): number => Math.max(2, Math.round((n * k) / 2) * 2);
  return { width: even(w), height: even(h) };
}

export interface CompositeSource {
  /** Draws the whole picture (camera + effects) into `ctx` at width x height. */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void;
}

export class PerformanceRecorder {
  private recorder: MediaRecorder | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private chunks: Blob[] = [];
  private raf = 0;
  private startedAt = 0;
  private lastFrame = 0;

  /** True where the browser can record (MediaRecorder + canvas capture). */
  static supported(): boolean {
    return typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement !== "undefined" && "captureStream" in HTMLCanvasElement.prototype;
  }

  get recording(): boolean {
    return this.recorder !== null && this.recorder.state === "recording";
  }

  get seconds(): number {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /** Starts. Throws if the browser refuses; the caller shows a friendly message. */
  start(source: CompositeSource, audio: MediaStream | null, width: number, height: number, onDone: (blob: Blob) => void): void {
    if (this.recording) return;
    const size = recordingSize(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.canvas = canvas;

    const stream = canvas.captureStream(30);
    audio?.getAudioTracks().forEach((t) => stream.addTrack(t));
    const mime = pickMimeType((m) => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
    this.chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.onstop = () => {
      window.cancelAnimationFrame(this.raf);
      stream.getVideoTracks().forEach((t) => t.stop()); // the audio tracks belong to the engine: leave them
      const blob = new Blob(this.chunks, { type: mime || "video/webm" });
      this.chunks = [];
      this.recorder = null;
      this.canvas = null;
      onDone(blob);
    };
    this.recorder = recorder;
    this.startedAt = performance.now();
    this.lastFrame = 0;
    const tick = (now: number): void => {
      if (!this.recording || !this.canvas) return;
      // ~30 fps is enough for the file and halves the cost of the extra drawing on a 60 Hz screen.
      if (now - this.lastFrame >= 30) {
        this.lastFrame = now;
        source.draw(ctx, canvas.width, canvas.height);
      }
      this.raf = window.requestAnimationFrame(tick);
    };
    recorder.start(1000);
    this.raf = window.requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
  }
}
