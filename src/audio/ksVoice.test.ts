import { describe, expect, it } from "vitest";
import { KsSynth, MAX_ACTIVE, POOL, type PluckParams } from "./ksVoice";

const SR = 48000;

function render(synth: KsSynth, seconds: number, block = 128): { l: Float32Array; r: Float32Array } {
  const total = Math.round(seconds * SR);
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  for (let i = 0; i < total; i += block) {
    synth.process(l.subarray(i, i + block), r.subarray(i, i + block));
  }
  return { l, r };
}

const pluck = (synth: KsSynth, over: Partial<PluckParams> = {}) =>
  synth.pluck({ stringId: 1, freq: 220, velocity: 0.8, brightness: 0.8, pan: 0, ...over });

/** Fundamental by autocorrelation with parabolic interpolation, searched around the expected period. */
function measureFreq(x: Float32Array, expected: number): number {
  const start = Math.round(0.1 * SR);
  const n = Math.round(0.4 * SR);
  const p0 = Math.round(SR / expected);
  const corr = (lag: number): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[start + i]! * x[start + i + lag]!;
    return s;
  };
  let best = p0;
  let bestV = -Infinity;
  for (let lag = p0 - 3; lag <= p0 + 3; lag++) {
    const v = corr(lag);
    if (v > bestV) {
      bestV = v;
      best = lag;
    }
  }
  const a = corr(best - 1);
  const b = corr(best);
  const c = corr(best + 1);
  const shift = (0.5 * (a - c)) / (a - 2 * b + c);
  return SR / (best + shift);
}

describe("KsSynth tuning", () => {
  for (const f of [146.8, 220, 440, 880, 1760, 1175]) {
    it(`${f} Hz is in tune (within 4 cents)`, () => {
      const synth = new KsSynth(SR);
      pluck(synth, { freq: f });
      const { l } = render(synth, 0.8);
      const measured = measureFreq(l, f);
      const cents = Math.abs(1200 * Math.log2(measured / f));
      expect(cents).toBeLessThan(4);
    });
  }
});

describe("KsSynth sound", () => {
  it("is audible, finite, and decays", () => {
    const synth = new KsSynth(SR);
    pluck(synth);
    const { l } = render(synth, 3);
    const peak = (a: number, b: number) => l.subarray(a, b).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(l.every(Number.isFinite)).toBe(true);
    const early = peak(0, 4800);
    const late = peak(2 * SR, 3 * SR);
    expect(early).toBeGreaterThan(0.1);
    expect(early).toBeLessThan(1.5);
    expect(late).toBeLessThan(early * 0.5);
  });

  it("harder plucks are louder and a duller pluck has less high-frequency energy", () => {
    const rms = (v: number, b: number) => {
      const s = new KsSynth(SR);
      pluck(s, { velocity: v, brightness: b });
      const { l } = render(s, 0.3);
      return Math.sqrt(l.reduce((a, x) => a + x * x, 0) / l.length);
    };
    expect(rms(1, 0.8)).toBeGreaterThan(rms(0.2, 0.8) * 2);
    const hf = (b: number) => {
      const s = new KsSynth(SR);
      pluck(s, { brightness: b, velocity: 0.8 });
      const { l } = render(s, 0.1);
      let d = 0;
      let t = 0;
      for (let i = 1; i < l.length; i++) {
        d += (l[i]! - l[i - 1]!) ** 2;
        t += l[i]! ** 2;
      }
      return d / t;
    };
    expect(hf(1)).toBeGreaterThan(hf(0));
  });

  it("pans: a right-panned string is louder on the right", () => {
    const s = new KsSynth(SR);
    pluck(s, { pan: 1 });
    const { l, r } = render(s, 0.2);
    const e = (a: Float32Array) => a.reduce((m, v) => m + v * v, 0);
    expect(e(r)).toBeGreaterThan(e(l) * 20);
  });

  it("the voice ends by itself (no endless CPU use)", () => {
    const s = new KsSynth(SR);
    pluck(s, { velocity: 1 });
    render(s, 6);
    expect(s.activeCount).toBe(0);
  });
});

describe("KsSynth polyphony and smooth restarts", () => {
  it("never has more than MAX_ACTIVE sounding voices and steals the oldest first without a hard cut", () => {
    const s = new KsSynth(SR);
    for (let i = 0; i < 30; i++) {
      pluck(s, { stringId: i, freq: 200 + i * 20 });
      render(s, 0.01);
      expect(s.soundingCount).toBeLessThanOrEqual(MAX_ACTIVE);
      expect(s.activeCount).toBeLessThanOrEqual(POOL);
    }
    expect(MAX_ACTIVE).toBeGreaterThanOrEqual(12);
    const sounding = s.voices.filter((v) => v.active && !v.releasing).map((v) => v.stringId);
    expect(sounding).toContain(29);
    expect(sounding).not.toContain(0);
  });

  it("re-plucking a ringing string fades the old voice out quickly (no click)", () => {
    const s = new KsSynth(SR);
    pluck(s, { stringId: 7, velocity: 1 });
    render(s, 0.3);
    pluck(s, { stringId: 7, velocity: 1 });
    const releasing = s.voices.filter((v) => v.active && v.releasing && v.stringId === 7);
    expect(releasing).toHaveLength(1);
    expect(s.soundingCount).toBe(1);
    render(s, 0.05);
    expect(releasing[0]!.active).toBe(false); // faded away within 50 ms
  });

  it("releasing a voice ends without a jump: the fade never makes a step bigger than the signal's own", () => {
    const s = new KsSynth(SR);
    pluck(s, { velocity: 1, freq: 110 });
    const before = render(s, 0.2).l;
    s.stop();
    const after = render(s, 0.05).l;
    const maxStep = (a: Float32Array) => a.reduce((m, v, i) => (i ? Math.max(m, Math.abs(v - a[i - 1]!)) : m), 0);
    expect(maxStep(after)).toBeLessThanOrEqual(maxStep(before) * 1.05);
    expect(Math.abs(after[after.length - 1]!)).toBeLessThan(0.01);
  });

  it("survives extreme input (silly frequencies, NaN velocity)", () => {
    const s = new KsSynth(SR);
    pluck(s, { freq: 5 });
    pluck(s, { freq: 1e6, stringId: 2 });
    pluck(s, { velocity: Number.NaN, stringId: 3 });
    const { l, r } = render(s, 0.5);
    expect(l.every(Number.isFinite)).toBe(true);
    expect(r.every(Number.isFinite)).toBe(true);
  });
});
