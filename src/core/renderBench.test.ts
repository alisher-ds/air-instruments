import { describe, expect, it } from "vitest";
import {
  CaseCollector,
  DEFAULT_COMPARE_OPTIONS,
  RENDER_CASES,
  formatCompareTable,
  runRenderCompare,
  type CompareHost,
  type CompareRow,
} from "./renderBench";

describe("CaseCollector", () => {
  it("discards results with no hands and breaks the fps chain there", () => {
    const c = new CaseCollector();
    c.pushTrack({ arrival: 0, inferenceMs: 40, frameAgeMs: 90, hands: 2 });
    c.pushTrack({ arrival: 100, inferenceMs: 60, frameAgeMs: 110, hands: 2 }); // 100 ms after the first
    c.pushTrack({ arrival: 200, inferenceMs: 999, frameAgeMs: 999, hands: 0 }); // discarded
    c.pushTrack({ arrival: 5000, inferenceMs: 50, frameAgeMs: 100, hands: 1 }); // long gap after "no hands": not a pair
    const r = c.result("x", 10);
    expect(r.handSamples).toBe(3);
    expect(r.totalSamples).toBe(4);
    expect(r.infAvgMs).toBeCloseTo(50);
    expect(r.ageAvgMs).toBeCloseTo(100);
    expect(r.trackFps).toBeCloseTo(10); // 1 pair, 100 ms
    expect(r.twoHandsPercent).toBeCloseTo(66.7, 0);
  });

  it("computes render fps from the gaps between drawn frames", () => {
    const c = new CaseCollector();
    for (let i = 0; i < 30; i++) c.pushDraw(33.333);
    c.pushDraw(0); // ignored
    const r = c.result("x", 1);
    expect(r.renderFps).toBeCloseTo(30, 1);
    expect(r.drawnFrames).toBe(30);
  });

  it("gives zeros, not NaN, when nothing was collected", () => {
    const r = new CaseCollector().result("empty", 0);
    expect(r).toMatchObject({ renderFps: 0, trackFps: 0, infAvgMs: 0, handSamples: 0, twoHandsPercent: 0 });
  });
});

describe("formatCompareTable", () => {
  const row = (over: Partial<CompareRow> = {}): CompareRow => ({
    label: "new: video element, scale 1.0",
    seconds: 10,
    renderFps: 59.9,
    infAvgMs: 44.26,
    infP95Ms: 61.2,
    trackFps: 18.4,
    ageAvgMs: 69.6,
    ageP95Ms: 88,
    handSamples: 120,
    totalSamples: 125,
    twoHandsPercent: 98,
    drawnFrames: 599,
    ...over,
  });

  it("prints every number of the brief: render fps, inference avg/p95, tracking fps, frame age avg/p95", () => {
    const text = formatCompareTable([row()]).join("\n");
    expect(text).toContain("render");
    expect(text).toContain("1. new: video element, scale 1.0");
    expect(text).toContain("59.9");
    expect(text).toContain("44.3");
    expect(text).toContain("61.2");
    expect(text).toContain("18.4");
    expect(text).toContain("120 of 125");
    expect(text).not.toContain("TOO FEW");
  });

  it("warns when a row has too few hand samples", () => {
    expect(formatCompareTable([row({ handSamples: 3, totalSamples: 90 })]).join("\n")).toContain("TOO FEW");
  });
});

describe("the five cases of the brief (plus the software experiment)", () => {
  it("are in the asked order with the asked settings", () => {
    const s = RENDER_CASES.map((c) => c.settings);
    expect(s[0]).toMatchObject({ videoMode: "canvas", renderScale: 1, renderFpsCap: 0 });
    expect(s[1]).toMatchObject({ videoMode: "element", renderScale: 1, renderFpsCap: 0 });
    expect(s[2]).toMatchObject({ videoMode: "element", renderScale: 0.75 });
    expect(s[3]).toMatchObject({ videoMode: "element", renderScale: 0.5, renderFpsCap: 0 });
    expect(s[4]).toMatchObject({ videoMode: "element", renderScale: 0.5, renderFpsCap: 30 });
    expect(s[5]).toMatchObject({ software2d: true });
    expect(s.slice(0, 5).every((x) => !x.software2d)).toBe(true);
  });
});

/** A fake host with a fake clock. While `sleep` advances time it feeds the collector like the app would. */
function fakeHost(handsAt: (tMs: number) => number) {
  let t = 0;
  let collector: CaseCollector | null = null;
  let abortAt = Infinity;
  const applied: string[] = [];
  const shown: string[] = [];
  let hands = 0;
  const host: CompareHost = {
    now: () => t,
    sleep: async (ms) => {
      const end = t + ms;
      while (t < end) {
        t += 50; // a tracking result every 50 ms (20 fps)
        hands = handsAt(t);
        collector?.pushTrack({ arrival: t, inferenceMs: 40, frameAgeMs: 80, hands });
        collector?.pushDraw(16.7);
      }
    },
    apply: (s) => applied.push(`${s.videoMode}/${s.renderScale}/${s.renderFpsCap}/${s.software2d}`),
    setCollector: (c) => (collector = c),
    show: (title, detail) => shown.push(`${title} | ${detail}`),
    handsNow: () => hands,
    aborted: () => t >= abortAt,
  };
  return { host, applied, shown, abortAfter: (ms: number) => (abortAt = ms) };
}

describe("runRenderCompare", () => {
  const fast = { ...DEFAULT_COMPARE_OPTIONS, countdownSec: 2, settleMs: 300 };

  it("runs every case once, with a countdown and the keep-both-hands message", async () => {
    const f = fakeHost(() => 2);
    const rows = await runRenderCompare(f.host, fast);
    expect(rows).toHaveLength(RENDER_CASES.length);
    expect(f.applied).toHaveLength(RENDER_CASES.length);
    expect(f.shown[0]).toContain("Keep BOTH hands visible");
    expect(f.shown[0]).toContain("Starting in 2");
    for (const r of rows) {
      expect(r.seconds).toBeGreaterThanOrEqual(10);
      expect(r.seconds).toBeLessThan(11);
      expect(r.trackFps).toBeCloseTo(20, 0);
      expect(r.handSamples).toBeGreaterThanOrEqual(40);
    }
  });

  it("extends a case while the hands are missing and discards those samples", async () => {
    // Hands only appear 9 s into the case (countdown 2 s + settle 0.3 s + 9 s): at 10 s there are too few samples, so the case runs on.
    const f = fakeHost((t) => (t > 11300 ? 2 : 0));
    const rows = await runRenderCompare(f.host, { ...fast, cases: RENDER_CASES.slice(0, 1) });
    const r = rows[0]!;
    expect(r.seconds).toBeGreaterThan(10);
    expect(r.handSamples).toBeLessThan(r.totalSamples);
    expect(r.handSamples).toBeGreaterThanOrEqual(40);
  });

  it("stops at the maximum time when the hands never come, and says so by having too few samples", async () => {
    const f = fakeHost(() => 0);
    const rows = await runRenderCompare(f.host, { ...fast, cases: RENDER_CASES.slice(0, 1) });
    expect(rows[0]!.seconds).toBeLessThanOrEqual(20.5);
    expect(rows[0]!.handSamples).toBe(0);
    expect(formatCompareTable(rows).join("\n")).toContain("TOO FEW");
  });

  it("can be stopped", async () => {
    const f = fakeHost(() => 2);
    f.abortAfter(2000 + 300 + 3000); // during the first case
    const rows = await runRenderCompare(f.host, fast);
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});
