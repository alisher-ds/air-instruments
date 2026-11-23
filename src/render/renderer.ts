// Canvas setup and the layers that are always there.
//
// Stage 0.7 layout (bottom to top): the camera <video> element (mirrored and dimmed by CSS, see style.css), then the
// transparent effects canvas, then (only while the skeleton is drawn at a render scale below 1) a small sharp canvas
// for the skeleton, then the UI. The canvas draws effects only, so the GPU does no full-screen video draw per frame.
// The old way (video drawn into an opaque canvas) stays as videoMode "canvas", only so the benchmark can compare.
//
// Drawing happens in CSS pixels. The effects canvas backing store is `window x screen ratio x renderScale`; CSS
// stretches it over the whole window. Instruments never see the scale.

import { config } from "../config";
import { fitTransform, type FitTransform } from "../core/geometry";
import { lookFilter, lookParams } from "./look";
import { backingSize, renderRatios } from "./renderScale";

const BG = "#05060a";

export class Renderer {
  /** The effects context. REPLACED when the 2D mode changes (video mode / software): read it fresh every frame. */
  ctx: CanvasRenderingContext2D;
  /** Window size in CSS pixels. */
  width = 0;
  height = 0;
  /** Backing pixels per CSS pixel of the effects canvas (screen ratio x render scale). Can be below 1. */
  dpr = 1;
  /** Backing pixels per CSS pixel the screen could show (devicePixelRatio capped by maxDpr and the hard cap). */
  screenDpr = 1;
  /** JS time of the last beginFrame, ms. Canvas work is queued to the GPU, so this is a lower bound. */
  lastBeginMs = 0;
  onResize: (width: number, height: number) => void = () => {};

  private canvas: HTMLCanvasElement;
  private contextUsed = false;
  private ctxKey = "";
  private overlay: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private overlayShown = false;
  private layerKey = "";
  private layerVideo: HTMLVideoElement | null = null;

  private fit: FitTransform = { offsetX: 0, offsetY: 0, drawWidth: 0, drawHeight: 0 };
  private fitValid = false;
  private fitVideoW = 0;
  private fitVideoH = 0;
  private fitMode = "";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = this.makeContext();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  /** What the 2D context needs right now: an opaque canvas only when the video is drawn into it; CPU drawing for the test. */
  private wantedKey(): string {
    return `${config.videoMode === "canvas" ? "opaque" : "alpha"}|${config.software2d ? "software" : "gpu"}`;
  }

  private makeContext(): CanvasRenderingContext2D {
    // A canvas gets its context only once and the options cannot change afterwards: use a fresh element instead.
    if (this.contextUsed) {
      const fresh = document.createElement("canvas");
      fresh.id = this.canvas.id;
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
    }
    this.contextUsed = true;
    this.ctxKey = this.wantedKey();
    const ctx = this.canvas.getContext("2d", {
      alpha: config.videoMode !== "canvas",
      willReadFrequently: config.software2d,
    });
    if (!ctx) throw new Error("Canvas 2D is not available in this browser.");
    return ctx;
  }

  private resize(): void {
    const ratios = renderRatios(config.maxDpr, window.devicePixelRatio || 1, config.renderScale);
    this.dpr = ratios.canvas;
    this.screenDpr = ratios.screen;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    const size = backingSize(this.width, this.height, this.dpr);
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    // The CSS size stays the whole window: the browser stretches a smaller backing store over it.
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.fitValid = false;
    this.sizeOverlay();
    this.onResize(this.width, this.height);
  }

  /** Picks up live changes from the debug panel: pixel ratio / render scale, 2D mode, video layer. Cheap when nothing changed. */
  private syncSettings(video: HTMLVideoElement | null): void {
    const key = this.wantedKey();
    const ratios = renderRatios(config.maxDpr, window.devicePixelRatio || 1, config.renderScale);
    if (key !== this.ctxKey) {
      this.ctx = this.makeContext();
      this.resize();
    } else if (ratios.canvas !== this.dpr || ratios.screen !== this.screenDpr) {
      this.resize();
    }
    this.syncVideoLayer(video);
  }

  /** videoMode "element": the <video> becomes the visible, mirrored, dimmed camera layer. Otherwise it is hidden again. */
  private syncVideoLayer(video: HTMLVideoElement | null): void {
    if (!video) return;
    const layer = config.videoMode === "element";
    const look = lookParams(config.videoLook, config.videoDim);
    const dim = look.dim;
    const filter = lookFilter(look);
    const key = `${layer}|${config.videoFit}|${dim}|${filter}`;
    if (key === this.layerKey && video === this.layerVideo) return;
    this.layerKey = key;
    this.layerVideo = video;
    video.classList.toggle("layer", layer);
    video.classList.toggle("contain", layer && config.videoFit === "contain");
    video.style.setProperty("--cam-opacity", String(1 - dim));
    video.style.filter = filter === "none" ? "" : filter;
  }

  /** Start of a frame. Element mode: just clear the transparent canvas. Canvas mode (old): draw the mirrored dimmed video. */
  beginFrame(video: HTMLVideoElement | null): void {
    const t0 = performance.now();
    this.syncSettings(video);

    const { ctx } = this;
    if (config.videoMode === "element") {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.lastBeginMs = performance.now() - t0;
      return;
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    const hasVideo = video !== null && video.videoWidth > 0 && video.readyState >= 2;
    const look = lookParams(config.videoLook, config.videoDim);
    const dim = look.dim;
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
      ctx.filter = lookFilter(look);
      ctx.drawImage(video, 0, 0, fit.drawWidth, fit.drawHeight);
      ctx.restore(); // also puts the filter back to none
      ctx.globalAlpha = 1;
    }
    this.lastBeginMs = performance.now() - t0;
  }

  /**
   * The context the hand skeleton is drawn into, or null when nothing should be drawn this frame.
   * Render scale 1: the normal effects canvas. Render scale below 1: a separate canvas at the screen's full ratio, so
   * thin skeleton lines stay sharp while heavy effects stay cheap. It exists and is visible only while the skeleton is
   * on (a hidden canvas costs nothing).
   */
  overlayContext(active: boolean): CanvasRenderingContext2D | null {
    if (this.dpr >= this.screenDpr - 1e-6) {
      this.hideOverlay();
      return active ? this.ctx : null;
    }
    if (!active) {
      this.hideOverlay();
      return null;
    }
    if (!this.overlay) {
      const c = document.createElement("canvas");
      c.id = "overlay";
      document.body.append(c);
      this.overlay = c;
      this.overlayCtx = c.getContext("2d");
      this.sizeOverlay();
    }
    const ctx = this.overlayCtx;
    if (!ctx || !this.overlay) return null;
    if (!this.overlayShown) {
      this.overlay.style.display = "block";
      this.overlayShown = true;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(this.screenDpr, 0, 0, this.screenDpr, 0, 0);
    return ctx;
  }

  private hideOverlay(): void {
    if (!this.overlay || !this.overlayShown) return;
    this.overlay.style.display = "none";
    this.overlayShown = false;
  }

  private sizeOverlay(): void {
    const c = this.overlay;
    if (!c) return;
    const size = backingSize(this.width, this.height, this.screenDpr);
    c.width = size.width;
    c.height = size.height;
    c.style.width = `${this.width}px`;
    c.style.height = `${this.height}px`;
  }

  get backingWidth(): number {
    return this.canvas.width;
  }

  get backingHeight(): number {
    return this.canvas.height;
  }

  /**
   * Draws the whole picture (dimmed mirrored camera + effects + the sharp skeleton canvas) into `target` for "Record
   * performance". The camera is a <video> element, so the canvas alone has no picture. Not used when not recording.
   */
  compose(target: CanvasRenderingContext2D, w: number, h: number, video: HTMLVideoElement | null): void {
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    target.fillStyle = BG;
    target.fillRect(0, 0, w, h);
    // In videoMode "canvas" the video is already inside the effects canvas.
    if (config.videoMode === "element" && video && video.videoWidth > 0 && video.readyState >= 2) {
      const fit = fitTransform(w, h, video.videoWidth, video.videoHeight, config.videoFit);
      target.save();
      target.translate(fit.offsetX + fit.drawWidth, fit.offsetY);
      target.scale(-1, 1);
      const look = lookParams(config.videoLook, config.videoDim);
      target.globalAlpha = 1 - look.dim;
      target.filter = lookFilter(look);
      target.drawImage(video, 0, 0, fit.drawWidth, fit.drawHeight);
      target.restore();
    }
    target.drawImage(this.canvas, 0, 0, w, h);
    if (this.overlay && this.overlayShown) target.drawImage(this.overlay, 0, 0, w, h);
  }

  /** What the canvas is really doing, for the debug panel. */
  describe(): string {
    return `${config.videoMode === "element" ? "video element" : "video in canvas"} | scale ${config.renderScale} | 2D ${config.software2d ? "software (CPU)" : "GPU"}${config.testLoad ? " | test load ON" : ""}`;
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
