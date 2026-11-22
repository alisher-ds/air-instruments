import { describe, expect, it } from "vitest";
import { RollingStats } from "./rollingStats";

describe("RollingStats", () => {
  it("is all zeros when empty", () => {
    expect(new RollingStats(10).summary()).toEqual({ count: 0, last: 0, avg: 0, p95: 0, max: 0 });
  });

  it("computes last, avg, p95 and max", () => {
    const s = new RollingStats(100);
    for (let i = 1; i <= 100; i++) s.push(i);
    const r = s.summary();
    expect(r.count).toBe(100);
    expect(r.last).toBe(100);
    expect(r.avg).toBeCloseTo(50.5);
    expect(r.max).toBe(100);
    expect(r.p95).toBe(96); // index floor(100*0.95)=95 -> value 96
  });

  it("keeps only the newest `capacity` values", () => {
    const s = new RollingStats(3);
    [1, 2, 3, 100, 200, 300].forEach((v) => s.push(v));
    const r = s.summary();
    expect(r.count).toBe(3);
    expect(r.avg).toBe(200);
    expect(r.max).toBe(300);
    expect(r.last).toBe(300);
  });

  it("reset() empties it", () => {
    const s = new RollingStats(5);
    s.push(9);
    s.reset();
    expect(s.count).toBe(0);
    expect(s.summary().avg).toBe(0);
  });
});
