// "Compare render settings" (debug panel): runs the same live camera + hands through several render setups, ~10 s
// each, and prints one table: render fps, inference avg/p95, tracking fps, frame age avg/p95.
//
// Why: the owner measured that rendering at 60 fps steals GPU time from MediaPipe (inference 102 ms with render
// uncapped vs 62 ms capped at 20 fps). This finds which cheaper render setup gives the inference back.
//
// Only samples with a hand in view count (no hands = a different, more expensive MediaPipe path, and a false comparison).
// The pure parts (collector, table) are tested; the runner takes a "host" so it can run against a fake clock in tests.

import { summarize } from "./benchmark";

/** The render settings one case switches on. Everything else (tracking mode, delegate...) stays as the owner has it. */
export interface RenderCaseSettings {
  videoMode: "element" | "canvas";
  renderScale: number;
  renderFpsCap: number;
  software2d: boolean;
}

export interface RenderCase {
  label: string;
  settings: RenderCaseSettings;
}

export const RENDER_CASES: readonly RenderCase[] = [
  { label: "old: video in canvas, scale 1.0, no cap", settings: { videoMode: "canvas", renderScale: 1, renderFpsCap: 0, software2d: false } },
  { label: "new: video element, scale 1.0", settings: { videoMode: "element", renderScale: 1, renderFpsCap: 0, software2d: false } },
  { label: "video element, scale 0.75", settings: { videoMode: "element", renderScale: 0.75, renderFpsCap: 0, software2d: false } },
  { label: "video element, scale 0.5", settings: { videoMode: "element", renderScale: 0.5, renderFpsCap: 0, software2d: false } },
  { label: "video element, scale 0.5, cap 30", settings: { videoMode: "element", renderScale: 0.5, renderFpsCap: 30, software2d: false } },
  { label: "EXPERIMENT: element, 1.0, 2D software", settings: { videoMode: "element", renderScale: 1, renderFpsCap: 0, software2d: true } },
];

export interface TrackSampleLike {
  arrival: number;
  inferenceMs: number;
  frameAgeMs: number;
  hands: number;
}

export interface CompareRow {
  label: string;
  /** Seconds this case ran (collecting, after the settle time). */
  seconds: number;
  renderFps: number;
  infAvgMs: number;
  infP95Ms: number;
  trackFps: number;
  ageAvgMs: number;
  ageP95Ms: number;
  /** Tracking results with a hand in view (the ones the numbers come from) and all results. */
  handSamples: number;
  totalSamples: number;
  /** Of the hand samples, the share that saw two hands. */
  twoHandsPercent: number;
  drawnFrames: number;
}

/** Collects one case. Pure: the caller feeds it tracking results and drawn-frame gaps. */
export class CaseCollector {
  private readonly inf: number[] = [];
  private readonly age: number[] = [];
  private total = 0;
  private two = 0;
  /** Arrival of the previous result, only if it had a hand (so a gap with no hands does not count as slow tracking). */
  private prevHandArrival: number | null = null;
  private pairs = 0;
  private pairDt = 0;
  private draws = 0;
  private drawDt = 0;

  pushTrack(s: TrackSampleLike): void {
    this.total++;
    if (s.hands <= 0) {
      this.prevHandArrival = null; // no hands: discard the sample, break the fps chain
      return;
    }
    this.inf.push(s.inferenceMs);
    this.age.push(s.frameAgeMs);
    if (s.hands >= 2) this.two++;
    if (this.prevHandArrival !== null && s.arrival > this.prevHandArrival) {
      this.pairs++;
      this.pairDt += s.arrival - this.prevHandArrival;
    }
    this.prevHandArrival = s.arrival;
  }

  /** `gapMs` = time between two drawn frames (what the render fps is made of). */
  pushDraw(gapMs: number): void {
    if (gapMs <= 0) return;
    this.draws++;
    this.drawDt += gapMs;
  }

  get handSamples(): number {
    return this.inf.length;
  }

  result(label: string, seconds: number): CompareRow {
    const inf = summarize(this.inf);
    const age = summarize(this.age);
    return {
      label,
      seconds,
      renderFps: this.drawDt > 0 ? (1000 * this.draws) / this.drawDt : 0,
      infAvgMs: inf.avg,
      infP95Ms: inf.p95,
      trackFps: this.pairDt > 0 ? (1000 * this.pairs) / this.pairDt : 0,
      ageAvgMs: age.avg,
      ageP95Ms: age.p95,
      handSamples: this.inf.length,
      totalSamples: this.total,
      twoHandsPercent: this.inf.length > 0 ? (100 * this.two) / this.inf.length : 0,
      drawnFrames: this.draws,
    };
  }
}

/** A row is only trustworthy with enough hand samples. */
export const MIN_HAND_SAMPLES = 25;

const n = (v: number, d: number, w: number): string => v.toFixed(d).padStart(w);

/** The table, as text lines (panel and "Copy report"). Pure. */
export function formatCompareTable(rows: readonly CompareRow[]): string[] {
  const head = "case                                      render |   inference ms  | tracking |  frame age ms  | samples with hands";
  const sub = "                                            fps  |   avg     p95   |   fps    |  avg     p95   |";
  const lines = [head, sub];
  rows.forEach((r, i) => {
    const label = `${i + 1}. ${r.label}`.padEnd(42).slice(0, 42);
    const few = r.handSamples < MIN_HAND_SAMPLES;
    lines.push(
      `${label} ${n(r.renderFps, 1, 6)} | ${n(r.infAvgMs, 1, 6)} ${n(r.infP95Ms, 1, 7)}  | ${n(r.trackFps, 1, 6)}   | ${n(r.ageAvgMs, 0, 5)} ${n(r.ageP95Ms, 0, 7)}  | ${r.handSamples} of ${r.totalSamples} (${Math.round(r.twoHandsPercent)}% two hands)${few ? "  <- TOO FEW, do not trust" : ""}`,
    );
  });
  return lines;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface CompareHost {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Switch the renderer to a case. */
  apply(settings: RenderCaseSettings): void;
  /** From now on tracking results and drawn-frame gaps go to this collector (null = nobody). */
  setCollector(c: CaseCollector | null): void;
  /** Text for the on-screen banner: a title line and a detail line. */
  show(title: string, detail: string): void;
  /** Hands the last tracking result saw. */
  handsNow(): number;
  aborted(): boolean;
}

export interface CompareOptions {
  countdownSec: number;
  settleMs: number;
  /** A case ends after this long if it has enough hand samples. */
  caseSec: number;
  /** ...and is extended (hands were missing) up to this long. */
  maxCaseSec: number;
  minHandSamples: number;
  cases: readonly RenderCase[];
}

export const DEFAULT_COMPARE_OPTIONS: CompareOptions = {
  countdownSec: 5,
  settleMs: 1200,
  caseSec: 10,
  maxCaseSec: 20,
  minHandSamples: 40,
  cases: RENDER_CASES,
};

export async function runRenderCompare(host: CompareHost, opts: CompareOptions = DEFAULT_COMPARE_OPTIONS): Promise<CompareRow[]> {
  const rows: CompareRow[] = [];
  const hands = () => {
    const h = host.handsNow();
    return h >= 2 ? "both hands seen" : h === 1 ? "only ONE hand seen" : "NO hands seen";
  };

  for (let s = opts.countdownSec; s > 0; s--) {
    if (host.aborted()) return rows;
    host.show(`Keep BOTH hands visible to the camera. Starting in ${s}...`, `Move them a little, like when you play. (${hands()})`);
    await host.sleep(1000);
  }

  for (let i = 0; i < opts.cases.length; i++) {
    const c = opts.cases[i]!;
    if (host.aborted()) break;
    const title = `Case ${i + 1} of ${opts.cases.length}: ${c.label}`;
    host.setCollector(null);
    host.apply(c.settings);
    host.show(`Keep BOTH hands visible. ${title}`, "switching...");
    await host.sleep(opts.settleMs);

    const collector = new CaseCollector();
    host.setCollector(collector);
    const t0 = host.now();
    for (;;) {
      await host.sleep(200);
      const elapsed = (host.now() - t0) / 1000;
      const enough = collector.handSamples >= opts.minHandSamples;
      host.show(
        `Keep BOTH hands visible. ${title}`,
        `${Math.max(0, Math.ceil(opts.caseSec - elapsed))} s left | ${hands()} | hand samples ${collector.handSamples}${enough ? "" : " (need " + opts.minHandSamples + ")"}`,
      );
      if (host.aborted()) break;
      if (elapsed >= opts.maxCaseSec || (elapsed >= opts.caseSec && enough)) break;
    }
    host.setCollector(null);
    rows.push(collector.result(c.label, (host.now() - t0) / 1000));
  }
  return rows;
}
