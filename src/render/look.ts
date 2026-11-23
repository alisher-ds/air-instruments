// How the camera picture looks on screen ("Look" button). Pure, tested.
//
// The picture used to be dimmed by half so the lights pop, which makes a weak webcam look dull and hazy; a fixed bright look
// washes the lights out in a bright room (the light effects are ADDED to the picture, so on a white wall they vanish).
//  - auto:   (default) looks at how bright the picture is and sets the dim so the picture ends up at a medium brightness:
//            a dark room gets brightened, a bright wall gets dimmed, the lights always show
//  - soft:   the old look (dim 50%, no filter)
//  - clear:  brighter, a little more contrast and colour
//  - bright: the picture first, the lights on top
//  - custom: only the `video dim` slider, no filter (for tuning in the debug panel)
// "dim" is the black overlay share (the picture's own opacity is 1 - dim); the filter is a CSS / canvas filter string.

export type Look = "auto" | "soft" | "clear" | "bright" | "custom";

export const LOOKS: readonly Look[] = ["auto", "soft", "clear", "bright", "custom"];

export interface LookParams {
  dim: number;
  brightness: number;
  contrast: number;
  saturate: number;
}

const PRESETS: Record<"soft" | "clear" | "bright", LookParams> = {
  soft: { dim: 0.5, brightness: 1, contrast: 1, saturate: 1 },
  clear: { dim: 0.22, brightness: 1.22, contrast: 1.12, saturate: 1.1 },
  bright: { dim: 0.08, brightness: 1.38, contrast: 1.2, saturate: 1.15 },
};

const clamp = (x: number, lo: number, hi: number): number => (x > lo ? (x < hi ? x : hi) : lo); // NaN -> lo

/** How bright the picture should end up on screen (0..1). Low enough that additive lights show on top of it. */
export const AUTO_TARGET = 0.42;

/**
 * The automatic look for a picture whose average brightness is `luma` (0..1). A dark picture is brightened (a filter), a bright
 * one is dimmed so that the result is about AUTO_TARGET. The dim is rounded to steps of 0.02 so it does not flicker.
 */
export function autoParams(luma: number): LookParams {
  const l = clamp(Number.isFinite(luma) ? luma : 0.4, 0.02, 1);
  // Smoothly less brightening for brighter pictures (a step here would make the dim jump back at the step).
  const brightness = Math.round(Math.max(1.05, 1.32 - 0.5 * l) * 1000) / 1000;
  const opacity = clamp(AUTO_TARGET / (l * brightness), 0.3, 1);
  const dim = Math.round((1 - opacity) / 0.02) * 0.02;
  return { dim: Math.round(dim * 100) / 100, brightness, contrast: 1.1, saturate: 1.08 };
}

/** `luma` is only used by "auto" (the renderer measures it about once a second). */
export function lookParams(look: Look, customDim: number, luma = 0.4): LookParams {
  if (look === "custom") return { dim: clamp(customDim, 0, 1), brightness: 1, contrast: 1, saturate: 1 };
  if (look === "auto") return autoParams(luma);
  return PRESETS[look] ?? autoParams(luma);
}

/** CSS / canvas `filter` value, or "none" when the look needs none. */
export function lookFilter(p: LookParams): string {
  if (p.brightness === 1 && p.contrast === 1 && p.saturate === 1) return "none";
  return `brightness(${p.brightness}) contrast(${p.contrast}) saturate(${p.saturate})`;
}

/** The next look in the Auto -> Soft -> Clear -> Bright cycle of the button (custom goes back to Auto). */
export function nextLook(look: Look): Look {
  if (look === "auto") return "soft";
  if (look === "soft") return "clear";
  if (look === "clear") return "bright";
  return "auto";
}

export const lookLabel = (look: Look): string => look.charAt(0).toUpperCase() + look.slice(1);

/** Average brightness 0..1 of RGBA pixel data (Rec. 601 weights). Pure, tested; the renderer feeds it a tiny copy of the video. */
export function averageLuma(rgba: ArrayLike<number>): number {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return 0.4;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
  return sum / n / 255;
}
