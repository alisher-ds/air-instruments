// Pure maths for the render scale (Stage 0.7). No DOM.
//
// The canvas is drawn in CSS pixels (instruments never see the scale). Its backing store has
// `cssSize x ratio` pixels, where ratio = screen ratio (devicePixelRatio, capped) x renderScale. The CSS size of the
// canvas stays the full window, so the browser upscales it. renderScale < 1 therefore means fewer pixels to fill.

import { MAX_DPR_CAP } from "../config";

export interface RenderRatios {
  /** Pixel ratio the screen can show: min(hard cap, config.maxDpr, devicePixelRatio), never below 1. */
  screen: number;
  /** Backing pixels per CSS pixel actually used for the effects canvas: screen x renderScale. Can be below 1. */
  canvas: number;
}

export function renderRatios(maxDpr: number, devicePixelRatio: number, renderScale: number): RenderRatios {
  const screen = Math.max(1, Math.min(MAX_DPR_CAP, maxDpr, devicePixelRatio || 1));
  const scale = Math.min(1, Math.max(0.25, renderScale));
  return { screen, canvas: screen * scale };
}

/** Backing store size for a canvas that covers `cssW x cssH` CSS pixels. At least 1 pixel each way. */
export function backingSize(cssW: number, cssH: number, ratio: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(cssW * ratio)), height: Math.max(1, Math.round(cssH * ratio)) };
}

/**
 * Where the browser puts a camera point when the <video> fills the window with `object-fit: cover|contain` and is
 * mirrored with `transform: scaleX(-1)`. Written the way CSS does it (scale, centre, then flip about the window centre),
 * independently of fitTransform, so a test can prove the two agree: the skeleton lines up with the visible video.
 */
export function cssVideoPoint(
  nx: number,
  ny: number,
  windowW: number,
  windowH: number,
  videoW: number,
  videoH: number,
  fit: "cover" | "contain",
): { x: number; y: number } {
  const s = fit === "cover" ? Math.max(windowW / videoW, windowH / videoH) : Math.min(windowW / videoW, windowH / videoH);
  const x = (windowW - videoW * s) / 2 + nx * videoW * s; // object-position 50% 50%, not mirrored yet
  const y = (windowH - videoH * s) / 2 + ny * videoH * s;
  return { x: windowW - x, y }; // scaleX(-1) around the element centre (the element is the whole window)
}
