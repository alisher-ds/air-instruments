import { describe, expect, it } from "vitest";
import { pianoVoice } from "./piano";

describe("pianoVoice", () => {
  it("a harder key is louder and brighter (higher FM index at the start)", () => {
    const soft = pianoVoice(60, 0.2);
    const hard = pianoVoice(60, 1);
    expect(hard.gain).toBeGreaterThan(soft.gain * 1.8);
    expect(hard.indexStart).toBeGreaterThan(soft.indexStart * 1.8);
    expect(hard.tineGain).toBeGreaterThan(soft.tineGain);
  });

  it("the FM index falls after the attack (bark, then a clean tone)", () => {
    const v = pianoVoice(60, 0.8);
    expect(v.indexEnd).toBeLessThan(v.indexStart * 0.5);
  });

  it("low notes ring longer than high notes", () => {
    expect(pianoVoice(36, 0.7).decaySec).toBeGreaterThan(pianoVoice(84, 0.7).decaySec * 1.5);
    expect(pianoVoice(36, 0.7).releaseSec).toBeGreaterThan(pianoVoice(84, 0.7).releaseSec);
  });

  it("the pitch is right (A4 = 440 Hz) and a note an octave up is twice as high", () => {
    expect(pianoVoice(69, 0.5).freq).toBeCloseTo(440);
    expect(pianoVoice(81, 0.5).freq / pianoVoice(69, 0.5).freq).toBeCloseTo(2);
  });

  it("never loud enough to clip alone, and survives silly input", () => {
    expect(pianoVoice(60, 1).gain).toBeLessThanOrEqual(0.6);
    const v = pianoVoice(Number.NaN, Number.NaN);
    expect(Object.values(v).every(Number.isFinite)).toBe(true);
    const w = pianoVoice(1e6, 99);
    expect(Object.values(w).every(Number.isFinite)).toBe(true);
    expect(w.freq).toBeLessThan(5000);
  });
});
