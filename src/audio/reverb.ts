// A generated reverb impulse response (PLAN.md: "generated impulse responses for reverb are fine", no audio files).
// Pure maths, no Web Audio, so it is tested. The engine puts it into a ConvolverNode.
//
// Shape: a short pre-delay (the dry pluck stays clear), then stereo noise that decays exponentially (60 dB over `rt60`
// seconds) and gets darker with time (a one-pole lowpass that closes), like a real room: bright early reflections, a
// soft dark tail. The two channels use different noise so the tail is wide.

export interface Impulse {
  left: Float32Array<ArrayBuffer>;
  right: Float32Array<ArrayBuffer>;
}

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1; // -1..1
  };
}

export interface ImpulseOptions {
  /** Time for the tail to fall by 60 dB, seconds. */
  rt60?: number;
  /** Silence before the tail starts, seconds. */
  preDelay?: number;
}

/** Length is `rt60 * 1.15 + preDelay`, so the tail has faded to nothing at the end. */
export function makeImpulse(sampleRate: number, opts: ImpulseOptions = {}): Impulse {
  const rt60 = Math.max(0.2, opts.rt60 ?? 2.2);
  const pre = Math.max(0, opts.preDelay ?? 0.012);
  const total = Math.max(1, Math.round(sampleRate * (rt60 * 1.15 + pre)));
  const preSamples = Math.round(sampleRate * pre);
  const fade = Math.max(1, Math.round(sampleRate * 0.004)); // 4 ms fade-in: no click at the start of the tail
  const make = (seed: number): Float32Array<ArrayBuffer> => {
    const rand = makeRng(seed);
    const out = new Float32Array(total);
    let lp = 0;
    for (let i = preSamples; i < total; i++) {
      const t = (i - preSamples) / sampleRate;
      const env = Math.exp((-6.9078 * t) / rt60);
      const a = Math.min(0.96, 0.15 + 0.8 * (t / rt60)); // the lowpass closes as the tail ages
      lp = a * lp + (1 - a) * rand();
      const fadeIn = Math.min(1, (i - preSamples) / fade);
      out[i] = lp * env * fadeIn;
    }
    return out;
  };
  return { left: make(0x9e3779b1), right: make(0x85ebca6b) };
}
