import { describe, expect, it } from "vitest";
import { thereminParams } from "./theremin";

describe("thereminParams", () => {
  it("louder and higher notes are brighter (the filter opens)", () => {
    const quietLow = thereminParams({ freq: 150, gain: 0.1, vibratoCents: 0, vibratoHz: 5.5 });
    const loudLow = thereminParams({ freq: 150, gain: 1, vibratoCents: 0, vibratoHz: 5.5 });
    const loudHigh = thereminParams({ freq: 1000, gain: 1, vibratoCents: 0, vibratoHz: 5.5 });
    expect(loudLow.cutoff).toBeGreaterThan(quietLow.cutoff);
    expect(loudHigh.cutoff).toBeGreaterThan(loudLow.cutoff);
  });

  it("the filter never cuts the note itself", () => {
    for (const f of [60, 200, 800, 2000, 3500]) {
      for (const g of [0, 0.5, 1]) expect(thereminParams({ freq: f, gain: g, vibratoCents: 0, vibratoHz: 5 }).cutoff).toBeGreaterThanOrEqual(Math.min(12000, f * 2.5));
    }
  });

  it("clamps everything and survives NaN", () => {
    const v = thereminParams({ freq: Number.NaN, gain: Number.NaN, vibratoCents: Number.NaN, vibratoHz: Number.NaN });
    expect(Object.values(v).every(Number.isFinite)).toBe(true);
    const w = thereminParams({ freq: 1e9, gain: 9, vibratoCents: 1e6, vibratoHz: 1e6 });
    expect(w.freq).toBeLessThanOrEqual(4000);
    expect(w.gain).toBeLessThan(1);
    expect(w.vibratoCents).toBeLessThanOrEqual(150);
    expect(w.vibratoHz).toBeLessThanOrEqual(10);
    expect(thereminParams({ freq: 1, gain: -3, vibratoCents: -5, vibratoHz: 0 }).gain).toBe(0);
  });
});
