import { describe, expect, it } from "vitest";
import { LOOKS, lookFilter, lookLabel, lookParams, nextLook } from "./look";

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

  it("the button cycles Soft -> Clear -> Bright -> Soft", () => {
    expect(nextLook("soft")).toBe("clear");
    expect(nextLook("clear")).toBe("bright");
    expect(nextLook("bright")).toBe("soft");
    expect(nextLook("custom")).toBe("soft");
    expect(lookLabel("clear")).toBe("Clear");
  });

  it("an unknown value falls back to clear instead of crashing", () => {
    expect(lookParams("nonsense" as never, 0.5)).toEqual(lookParams("clear", 0));
    expect(LOOKS).toContain("clear");
  });
});
