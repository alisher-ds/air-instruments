import { describe, expect, it } from "vitest";
import { rng } from "../../test/helpers/synthHand";
import { LandmarkSmoother, OneEuroFilter, smoothingAlpha, type OneEuroParams } from "./smoothing";

const DT = 1 / 30;
const P: OneEuroParams = { minCutoff: 1.5, beta: 0, dCutoff: 1 };

describe("OneEuroFilter", () => {
  it("passes the first sample through unchanged", () => {
    expect(new OneEuroFilter().filter(123.4, 0, P)).toBe(123.4);
  });

  it("keeps a constant signal constant", () => {
    const f = new OneEuroFilter();
    let y = 0;
    for (let i = 0; i < 60; i++) y = f.filter(50, i * DT, P);
    expect(y).toBeCloseTo(50, 6);
  });

  it("removes most jitter at rest", () => {
    const f = new OneEuroFilter();
    const rand = rng(7);
    const rawDev: number[] = [];
    const outDev: number[] = [];
    for (let i = 0; i < 300; i++) {
      const noisy = 100 + (rand() - 0.5) * 4; // +-2 px of jitter
      const y = f.filter(noisy, i * DT, P);
      if (i > 30) {
        rawDev.push(Math.abs(noisy - 100));
        outDev.push(Math.abs(y - 100));
      }
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(outDev)).toBeLessThan(mean(rawDev) * 0.4);
  });

  it("a higher beta follows fast motion with less lag", () => {
    const run = (beta: number) => {
      const f = new OneEuroFilter();
      let y = 0;
      // Ramp at 600 px/s for 1 s.
      for (let i = 0; i <= 30; i++) y = f.filter(i * 20, i * DT, { minCutoff: 1.5, beta, dCutoff: 1 });
      return 600 - y; // lag in px at the end of the ramp
    };
    expect(run(10)).toBeLessThan(run(0));
  });

  it("ignores a duplicate or out-of-order timestamp", () => {
    const f = new OneEuroFilter();
    f.filter(10, 1, P);
    const a = f.filter(20, 1.033, P);
    expect(f.filter(999, 1.033, P)).toBe(a);
    expect(f.filter(999, 1.0, P)).toBe(a);
  });

  it("smoothingAlpha is between 0 and 1 and grows with the cutoff", () => {
    const lo = smoothingAlpha(1, DT);
    const hi = smoothingAlpha(10, DT);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("LandmarkSmoother", () => {
  it("filters every landmark independently", () => {
    const s = new LandmarkSmoother(2);
    s.filter([{ x: 0, y: 0 }, { x: 100, y: 100 }], 0, P);
    const out = s.filter([{ x: 0, y: 0 }, { x: 100, y: 100 }], DT, P);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[1]!.x).toBeCloseTo(100);
  });
});
