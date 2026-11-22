import { describe, expect, it } from "vitest";
import { formatRow, summarize } from "./benchmark";

describe("benchmark helpers", () => {
  it("summarizes avg and p95", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const s = summarize(values);
    expect(s.avg).toBeCloseTo(50.5);
    expect(s.p95).toBe(96);
  });

  it("handles an empty list and does not change its input", () => {
    expect(summarize([])).toEqual({ avg: 0, p95: 0 });
    const v = [3, 1, 2];
    summarize(v);
    expect(v).toEqual([3, 1, 2]);
  });

  it("formats a row with the prepare cost only when there is one", () => {
    const base = { label: "main GPU | video element", n: 30, avgMs: 38.04, p95Ms: 52, prepMs: 0, handsPercent: 100 };
    expect(formatRow(base)).toContain("avg   38.0 ms");
    expect(formatRow(base)).not.toContain("prepare");
    expect(formatRow({ ...base, prepMs: 4.2 })).toContain("+4.2 ms to prepare");
  });
});
