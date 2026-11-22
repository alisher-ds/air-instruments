// Pure geometry helpers. No DOM, no state.
import type { Vec2 } from "../instruments/Instrument";

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const midpoint = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Unsigned angle between two vectors, 0..PI. Returns 0 if either vector has no length. */
export function angleBetween(a: Vec2, b: Vec2): number {
  const la = length(a);
  const lb = length(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(clamp(dot(a, b) / (la * lb), -1, 1));
}

export interface SegmentHit {
  point: Vec2;
  /** Position along segment AB, 0..1. */
  t: number;
  /** Position along segment CD, 0..1. */
  u: number;
}

/**
 * Intersection of segment AB with segment CD, or null.
 * Parallel / collinear segments return null (a fingertip sliding exactly along a string is not a pluck).
 */
export function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): SegmentHit | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-12) return null;
  const ac = sub(c, a);
  const t = cross(ac, s) / denom;
  const u = cross(ac, r) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: { x: a.x + r.x * t, y: a.y + r.y * t }, t, u };
}

/** Shortest distance from point P to segment AB. */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < 1e-12) return dist(p, a);
  const t = clamp(dot(sub(p, a), ab) / len2, 0, 1);
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

export interface FitTransform {
  /** Where the video's top-left lands on the canvas. */
  offsetX: number;
  offsetY: number;
  /** Size the whole video is drawn at. */
  drawWidth: number;
  drawHeight: number;
}

/**
 * How the video is laid on the canvas. "cover" fills the canvas (crops the video edges),
 * "contain" shows the whole video (bars on the sides). The same transform is used to draw the video
 * and to place hand landmarks, so they always line up.
 */
export function fitTransform(
  canvasW: number,
  canvasH: number,
  videoW: number,
  videoH: number,
  mode: "cover" | "contain",
): FitTransform {
  const sx = canvasW / videoW;
  const sy = canvasH / videoH;
  const s = mode === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
  const drawWidth = videoW * s;
  const drawHeight = videoH * s;
  return {
    offsetX: (canvasW - drawWidth) / 2,
    offsetY: (canvasH - drawHeight) / 2,
    drawWidth,
    drawHeight,
  };
}

/** Normalized camera coords (0..1, NOT yet mirrored) -> canvas pixels, mirrored. */
export function normalizedToCanvas(nx: number, ny: number, fit: FitTransform): Vec2 {
  return {
    x: fit.offsetX + (1 - nx) * fit.drawWidth,
    y: fit.offsetY + ny * fit.drawHeight,
  };
}
