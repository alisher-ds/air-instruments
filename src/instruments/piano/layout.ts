// The piano keyboard layout (PLAN.md 6.4: a row of keys in the lower third of the screen), pure and tested.
// White keys fill the width in equal steps; black keys sit on the boundaries (C#, D#, F#, G#, A#), shorter and narrower.

import { noteName, pitchClass } from "../../audio/scales";
import type { Vec2 } from "../Instrument";

export interface Key {
  midi: number;
  black: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  /** 0..11, for the colour. */
  pc: number;
}

export interface Layout {
  keys: Key[];
  /** Top and bottom of the white keys. */
  top: number;
  bottom: number;
}

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const WHITE_WIDTH_OF_BLACK = 0.62;
const BLACK_HEIGHT_OF_WHITE = 0.62;

/** Midi number of the lowest key for "octave 4" = C4 = 60. */
export const lowestMidi = (octave: number): number => 12 * (Math.round(octave) + 1);

export function layoutKeys(w: number, h: number, octaves: number, lowOctave: number): Layout {
  const count = Math.max(1, Math.min(4, Math.round(octaves)));
  const start = lowestMidi(lowOctave);
  const whites = 7 * count;
  const left = 0.05 * w;
  const whiteW = (0.9 * w) / whites;
  const top = 0.62 * h;
  const keyH = 0.30 * h; // tall keys: easier to aim at
  const keys: Key[] = [];
  let whiteIndex = 0;
  const lastMidi = start + 12 * count - 1;
  for (let m = start; m <= lastMidi; m++) {
    const pc = pitchClass(m);
    if (BLACK_PCS.has(pc)) continue;
    keys.push({ midi: m, black: false, x: left + whiteIndex * whiteW, y: top, w: whiteW, h: keyH, name: noteName(m), pc });
    whiteIndex++;
  }
  // Black keys last (they are drawn and hit-tested on top).
  whiteIndex = 0;
  for (let m = start; m <= lastMidi; m++) {
    const pc = pitchClass(m);
    if (!BLACK_PCS.has(pc)) {
      whiteIndex++;
      continue;
    }
    const bw = whiteW * WHITE_WIDTH_OF_BLACK;
    keys.push({
      midi: m,
      black: true,
      x: left + whiteIndex * whiteW - bw / 2,
      y: top,
      w: bw,
      h: keyH * BLACK_HEIGHT_OF_WHITE,
      name: noteName(m),
      pc,
    });
  }
  return { keys, top, bottom: top + keyH };
}

/**
 * The key under a fingertip, or null. Black keys win where they are. The fingertip may be a little ABOVE the keys
 * (`marginAbove` px: a finger that is about to press hovers over its key), and a little below.
 */
export function keyAt(p: Vec2, layout: Layout, marginAbove: number): Key | null {
  const { keys, top, bottom } = layout;
  if (p.y < top - marginAbove || p.y > bottom + marginAbove * 0.3) return null;
  // A fingertip ABOVE the keys could mean the black key or the white key behind it: only the middle of a black key counts then.
  const above = p.y < top;
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i]!;
    if (!k.black) continue;
    const inset = above ? k.w * 0.2 : 0;
    if (p.x >= k.x + inset && p.x <= k.x + k.w - inset && p.y <= k.y + k.h) return k;
  }
  for (const k of keys) {
    if (k.black) continue;
    if (p.x >= k.x && p.x < k.x + k.w) return k;
  }
  return null;
}
