// How the camera picture looks on screen ("Look" button). Pure, tested.
//
// The picture used to be dimmed by half so the lights pop, which makes a weak webcam look dull and hazy. Looks:
//  - soft:   the old look (dim 50%, no filter)
//  - clear:  brighter, a little more contrast and colour (the default)
//  - bright: the picture first, the lights on top
//  - custom: only the `video dim` slider, no filter (for tuning in the debug panel)
// "dim" is the black overlay share (the picture's own opacity is 1 - dim); the filter is a CSS / canvas filter string.

export type Look = "soft" | "clear" | "bright" | "custom";

export const LOOKS: readonly Look[] = ["soft", "clear", "bright", "custom"];

export interface LookParams {
  dim: number;
  brightness: number;
  contrast: number;
  saturate: number;
}

const PRESETS: Record<Exclude<Look, "custom">, LookParams> = {
  soft: { dim: 0.5, brightness: 1, contrast: 1, saturate: 1 },
  clear: { dim: 0.22, brightness: 1.22, contrast: 1.12, saturate: 1.1 },
  bright: { dim: 0.08, brightness: 1.38, contrast: 1.2, saturate: 1.15 },
};

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

export function lookParams(look: Look, customDim: number): LookParams {
  if (look === "custom") return { dim: clamp01(customDim), brightness: 1, contrast: 1, saturate: 1 };
  return PRESETS[look] ?? PRESETS.clear;
}

/** CSS / canvas `filter` value, or "none" when the look needs none. */
export function lookFilter(p: LookParams): string {
  if (p.brightness === 1 && p.contrast === 1 && p.saturate === 1) return "none";
  return `brightness(${p.brightness}) contrast(${p.contrast}) saturate(${p.saturate})`;
}

/** The next look in the Soft -> Clear -> Bright cycle of the button (custom goes back to Soft). */
export function nextLook(look: Look): Look {
  if (look === "soft") return "clear";
  if (look === "clear") return "bright";
  return "soft";
}

export const lookLabel = (look: Look): string => look.charAt(0).toUpperCase() + look.slice(1);
