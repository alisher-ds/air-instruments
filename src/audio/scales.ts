// Musical scales and note mapping (pure, tested). The harp maps a string's LENGTH to a note of the active scale.

export type ScaleName = "major-pentatonic" | "minor-pentatonic" | "harmonic-minor";

export const SCALE_NAMES: readonly ScaleName[] = ["major-pentatonic", "minor-pentatonic", "harmonic-minor"];

/** Semitones above the root. */
const INTERVALS: Record<ScaleName, readonly number[]> = {
  "major-pentatonic": [0, 2, 4, 7, 9],
  "minor-pentatonic": [0, 3, 5, 7, 10],
  "harmonic-minor": [0, 2, 3, 5, 7, 8, 11],
};

/** D3. The default key is D (D major pentatonic over ~3 octaves, so anything played sounds good). */
export const ROOT_MIDI = 50;
export const OCTAVES = 3;

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** All notes (MIDI numbers, ascending) of the scale from the root up to `octaves` octaves above it, inclusive. */
export function scaleNotes(scale: ScaleName, rootMidi = ROOT_MIDI, octaves = OCTAVES): number[] {
  const out: number[] = [];
  for (let o = 0; o < octaves; o++) {
    for (const i of INTERVALS[scale]) out.push(rootMidi + o * 12 + i);
  }
  out.push(rootMidi + octaves * 12);
  return out;
}

export const midiToFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

export function noteName(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Pitch class 0..11 (C = 0). The colour of a note depends only on this, so an octave has the same colour. */
export const pitchClass = (midi: number): number => ((midi % 12) + 12) % 12;

export interface LengthRange {
  /** String length / canvas diagonal that maps to the HIGHEST note. */
  minFrac: number;
  /** ...and to the LOWEST note. */
  maxFrac: number;
}

/**
 * Longer string = lower note. `lengthFrac` is the string length divided by the canvas diagonal.
 * Returns the MIDI note (a member of `notes`). Out-of-range lengths clamp to the lowest / highest note.
 */
export function noteForLength(lengthFrac: number, notes: readonly number[], range: LengthRange): number {
  const span = Math.max(1e-6, range.maxFrac - range.minFrac);
  const t = Math.min(1, Math.max(0, (lengthFrac - range.minFrac) / span)); // 0 = shortest, 1 = longest
  const idx = Math.round((1 - t) * (notes.length - 1));
  return notes[idx]!;
}
