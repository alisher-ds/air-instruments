// Canvas setup (devicePixelRatio capped at 2) and the layers that are always drawn: the mirrored, dimmed video.
// Drawing happens in CSS pixels; the canvas backing store is scaled by dpr.
//
// Per-frame cost notes (Stage 0.5 profiling): the video + dim are the only full-screen work. The dim is folded into
// the video draw (globalAlpha over the dark background) instead of a third full-screen fill, the fit transform and
// the colour strings are cached, and nothing is allocated per frame.

import { MAX_DPR_CAP, config } from "../config";
import { fitTransform, type FitTransform } from "../core/geometry";

const BG = "#05060a";

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  /** Canvas size in CSS pixels. */
  width = 0;
  height = 0;
  /** Pixel ratio in use right now (min of the cap, config.maxDpr and the screen's). */
  dpr = 1;
  /** JS time of the last beginFrame (video draw), ms. Canvas work is queued to the GPU, so this is a lower bound. */
  lastBeginMs = 0;
  onResize: (width: number, height: number) => void = () => {};

  private fit: FitTransform = { offsetX: 0, offsetY: 0, drawWidth: 0, drawHeight: 0 };
  private fitValid = false;
  private fitVideoW = 0;
  private fitVideoH = 0;
  private fitMode = "";

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available in this browser.");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  private wantedDpr(): number {
    return Math.max(1, Math.min(MAX_DPR_CAP, config.maxDpr, window.devicePixelRatio || 1));
  }

  private resize(): void {
    this.dpr = this.wantedDpr();
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.fitValid = false;
    this.onResize(this.width, this.height);
  }

  /** Start of a frame: reset the transform, then draw the mirrored dimmed video over the dark background. */
  beginFrame(video: HTMLVideoElement | null): void {
    const t0 = performance.now();
    // The "max pixel ratio" slider in the debug panel changes config.maxDpr live.
    if (this.wantedDpr() !== this.dpr) this.resize();

    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    const hasVideo = video !== null && video.videoWidth > 0 && video.readyState >= 2;
    const dim = Math.min(1, Math.max(0, config.videoDim));
    const fit = hasVideo ? this.fitFor(video) : null;
    const covers =
      fit !== null && fit.offsetX <= 0.5 && fit.offsetY <= 0.5 && fit.drawWidth >= this.width - 1 && fit.drawHeight >= this.height - 1;

    // The dark background is only needed when something shows through: no video, bars ("contain"), or the dim.
    if (!covers || dim > 0) {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    if (fit && video) {
      ctx.save();
      // Mirror horizontally around the vertical centre line of the drawn video.
      ctx.translate(fit.offsetX + fit.drawWidth, fit.offsetY);
      ctx.scale(-1, 1);
      // Video at (1 - dim) opacity over the background == the old "draw video, then a dark overlay" in one pass.
      ctx.globalAlpha = 1 - dim;
      ctx.drawImage(video, 0, 0, fit.drawWidth, fit.drawHeight);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    this.lastBeginMs = performance.now() - t0;
  }

  /** Cached: only recomputed when the canvas (resize() clears the cache), the video or the fit mode changes. */
  private fitFor(video: HTMLVideoElement): FitTransform {
    if (!this.fitValid || video.videoWidth !== this.fitVideoW || video.videoHeight !== this.fitVideoH || config.videoFit !== this.fitMode) {
      this.fitValid = true;
      this.fitVideoW = video.videoWidth;
      this.fitVideoH = video.videoHeight;
      this.fitMode = config.videoFit;
      this.fit = fitTransform(this.width, this.height, video.videoWidth, video.videoHeight, config.videoFit);
    }
    return this.fit;
  }
}
