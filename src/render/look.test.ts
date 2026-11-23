import { describe, expect, it } from "vitest";
import { AUTO_TARGET, LOOKS, autoParams, averageLuma, lookFilter, lookLabel, lookParams, nextLook } from "./look";

describe("looks", () => {
  it("soft is the old look: dimmed by half, no filter", () => {
    const p = lookParams("soft", 0.9);
    expect(p.dim).toBe(0.5);
    expect(lookFilter(p)).toBe("none");
  });

  it("clear and bright are brighter than soft and get brighter step by step", () => {
    const soft = lookParams("soft", 0);
    const clear = lookParams("clear", 0);
    const bright = lookParams("bright", 0);
    expect(clear.dim).toBeLessThan(soft.dim);
    expect(bright.dim).toBeLessThan(clear.dim);
    expect(clear.brightness).toBeGreaterThan(1);
    expect(bright.brightness).toBeGreaterThan(clear.brightness);
    expect(lookFilter(clear)).toMatch(/^brightness\([\d.]+\) contrast\([\d.]+\) saturate\([\d.]+\)$/);
  });

  it("custom uses only the dim slider (clamped) and no filter", () => {
    expect(lookParams("custom", 0.3)).toMatchObject({ dim: 0.3, brightness: 1 });
    expect(lookParams("custom", 7).dim).toBe(1);
    expect(lookParams("custom", Number.NaN).dim).toBe(0);
    expect(lookFilter(lookParams("custom", 0.3))).toBe("none");
  });

  it("the button cycles Auto -> Soft -> Clear -> Bright -> Auto", () => {
    expect(nextLook("auto")).toBe("soft");
    expect(nextLook("soft")).toBe("clear");
    expect(nextLook("clear")).toBe("bright");
    expect(nextLook("bright")).toBe("auto");
    expect(nextLook("custom")).toBe("auto");
    expect(lookLabel("auto")).toBe("Auto");
  });

  it("an unknown value falls back to the automatic look instead of crashing", () => {
    expect(lookParams("nonsense" as never, 0.5, 0.4)).toEqual(autoParams(0.4));
    expect(LOOKS).toContain("auto");
  });
});

describe("autoParams (the picture ends up at a medium brightness so the lights show)", () => {
  /** What the player roughly sees: the picture's brightness after the filter, times its opacity. */
  const shown = (luma: number): number => {
    const p = autoParams(luma);
    return Math.min(1, luma * p.brightness) * (1 - p.dim);
  };

  it("a bright wall is dimmed a lot, a dark room is not dimmed at all and is brightened", () => {
    const wall = autoParams(0.85);
    const dark = autoParams(0.12);
    expect(wall.dim).toBeGreaterThan(0.4);
    expect(dark.dim).toBe(0);
    expect(dark.brightness).toBeGreaterThan(1.2);
  });

  it("the more light in the picture, the more it is dimmed (never the other way)", () => {
    let prev = -1;
    for (let l = 0.02; l <= 1.0001; l += 0.02) {
      const d = autoParams(l).dim;
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = d;
    }
  });

  it("a bright scene ends up near the target brightness on screen", () => {
    for (const l of [0.6, 0.75, 0.9]) expect(Math.abs(shown(l) - AUTO_TARGET)).toBeLessThan(0.08);
  });

  it("stays in range and survives nonsense", () => {
    for (const l of [Number.NaN, -5, 0, 1, 9]) {
      const p = autoParams(l);
      expect(p.dim).toBeGreaterThanOrEqual(0);
      expect(p.dim).toBeLessThanOrEqual(0.7);
      expect(Object.values(p).every(Number.isFinite)).toBe(true);
    }
  });

  it("'auto' in lookParams uses the measured brightness", () => {
    expect(lookParams("auto", 0, 0.9).dim).toBeGreaterThan(lookParams("auto", 0, 0.2).dim);
  });
});

describe("averageLuma", () => {
  it("is 0 for black, 1 for white, in between for grey, and weighs green more than blue", () => {
    expect(averageLuma([0, 0, 0, 255, 0, 0, 0, 255])).toBe(0);
    expect(averageLuma([255, 255, 255, 255])).toBeCloseTo(1);
    expect(averageLuma([128, 128, 128, 255])).toBeCloseTo(0.502, 2);
    expect(averageLuma([0, 255, 0, 255])).toBeGreaterThan(averageLuma([0, 0, 255, 255]));
  });
  it("gives a neutral value for empty data", () => {
    expect(averageLuma([])).toBe(0.4);
  });
});
