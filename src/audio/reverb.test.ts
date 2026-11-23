import { describe, expect, it } from "vitest";
import { makeImpulse } from "./reverb";

const SR = 48000;
const rms = (a: Float32Array, from: number, to: number): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
};

describe("makeImpulse", () => {
  it("has the length of the tail, finite numbers, and stays silent during the pre-delay", () => {
    const ir = makeImpulse(SR, { rt60: 2, preDelay: 0.02 });
    expect(ir.left.length).toBe(Math.round(SR * (2 * 1.15 + 0.02)));
    expect(ir.left.length).toBe(ir.right.length);
    expect(ir.left.every(Number.isFinite)).toBe(true);
    expect(rms(ir.left, 0, Math.round(SR * 0.02))).toBe(0);
  });

  it("decays: about 60 dB down at rt60, and nothing at the very end", () => {
    const ir = makeImpulse(SR, { rt60: 2, preDelay: 0 });
    const early = rms(ir.left, Math.round(0.05 * SR), Math.round(0.15 * SR));
    const atRt60 = rms(ir.left, Math.round(1.9 * SR), Math.round(2.1 * SR));
    expect(early).toBeGreaterThan(0.01);
    expect(atRt60).toBeLessThan(early * 0.01); // > 40 dB down (60 dB for the envelope, the darker noise adds more)
    expect(rms(ir.left, ir.left.length - 100, ir.left.length)).toBeLessThan(early * 0.001);
  });

  it("gets darker with time (less high-frequency energy in the tail)", () => {
    const ir = makeImpulse(SR, { rt60: 2, preDelay: 0 });
    const hf = (from: number, to: number) => {
      let d = 0;
      let t = 0;
      for (let i = from + 1; i < to; i++) {
        d += (ir.left[i]! - ir.left[i - 1]!) ** 2;
        t += ir.left[i]! ** 2;
      }
      return d / t;
    };
    expect(hf(Math.round(0.02 * SR), Math.round(0.3 * SR))).toBeGreaterThan(hf(Math.round(1.2 * SR), Math.round(1.8 * SR)) * 1.5);
  });

  it("is stereo (the channels differ), repeatable, and has no click at the start of the tail", () => {
    const a = makeImpulse(SR);
    const b = makeImpulse(SR);
    expect(a.left).toEqual(b.left);
    let same = 0;
    for (let i = 0; i < 2000; i++) if (a.left[i + 3000] === a.right[i + 3000]) same++;
    expect(same).toBeLessThan(10);
    const first = Math.round(SR * 0.012);
    expect(Math.abs(a.left[first]!)).toBeLessThan(0.01);
  });
});
