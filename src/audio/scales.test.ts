import { describe, expect, it } from "vitest";
import { ROOT_MIDI, midiToFreq, noteForLength, noteName, pitchClass, scaleNotes } from "./scales";

describe("scales", () => {
  it("D major pentatonic over 3 octaves: D E F# A B, 16 notes, D3..D6", () => {
    const n = scaleNotes("major-pentatonic");
    expect(n).toHaveLength(16);
    expect(n[0]).toBe(ROOT_MIDI);
    expect(n.slice(0, 5).map(noteName)).toEqual(["D3", "E3", "F#3", "A3", "B3"]);
    expect(n[n.length - 1]).toBe(ROOT_MIDI + 36);
    expect(noteName(n[n.length - 1]!)).toBe("D6");
  });

  it("every scale is strictly ascending and stays inside its pitch classes", () => {
    for (const s of ["major-pentatonic", "minor-pentatonic", "harmonic-minor"] as const) {
      const n = scaleNotes(s);
      for (let i = 1; i < n.length; i++) expect(n[i]!).toBeGreaterThan(n[i - 1]!);
    }
    expect(scaleNotes("harmonic-minor")).toHaveLength(22);
    expect(scaleNotes("minor-pentatonic").slice(0, 5).map(noteName)).toEqual(["D3", "F3", "G3", "A3", "C4"]);
  });

  it("A4 = 440 Hz, an octave doubles", () => {
    expect(midiToFreq(69)).toBeCloseTo(440);
    expect(midiToFreq(81) / midiToFreq(69)).toBeCloseTo(2);
    expect(pitchClass(50)).toBe(2);
    expect(pitchClass(-1)).toBe(11);
  });
});

describe("noteForLength: longer = lower", () => {
  const notes = scaleNotes("major-pentatonic");
  const range = { minFrac: 0.1, maxFrac: 0.6 };
  it("clamps to the lowest and highest note", () => {
    expect(noteForLength(0.9, notes, range)).toBe(notes[0]);
    expect(noteForLength(0.01, notes, range)).toBe(notes[notes.length - 1]);
  });
  it("is monotonic and uses every note of the scale", () => {
    const seen = new Set<number>();
    let prev = Infinity;
    for (let l = 0.1; l <= 0.6001; l += 0.001) {
      const m = noteForLength(l, notes, range);
      expect(m).toBeLessThanOrEqual(prev);
      prev = m;
      seen.add(m);
    }
    expect(seen.size).toBe(notes.length);
  });
});
