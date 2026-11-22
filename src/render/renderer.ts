// Canvas setup (devicePixelRatio capped at 2) and the layers that are always drawn: the mirrored, dimmed video.
// Drawing happens in CSS pixels; the canvas backing store is scaled by dpr.

import { config } from "../config";
import { fitTransform } from "../core/geometry";

const MAX_DPR = 2;

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  /** Canvas size in CSS pixels. */
  width = 0;
  height = 0;
  private dpr = 1;
  onResize: (width: number, height: number) => void = () => {};

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available in this browser.");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  private resize(): void {
    this.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.onResize(this.width, this.height);
  }

  /** Start of a frame: reset the transform, clear, and draw the mirrored dimmed video. */
  beginFrame(video: HTMLVideoElement | null): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, this.width, this.height);

    if (video && video.videoWidth > 0 && video.readyState >= 2) {
      const fit = fitTransform(this.width, this.height, video.videoWidth, video.videoHeight, config.videoFit);
      ctx.save();
      // Mirror horizontally around the vertical centre line of the drawn video.
      ctx.translate(fit.offsetX + fit.drawWidth, fit.offsetY);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, fit.drawWidth, fit.drawHeight);
      ctx.restore();
    }
    if (config.videoDim > 0) {
      ctx.fillStyle = `rgba(3, 4, 10, ${config.videoDim})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }
}
