// Karplus-Strong string synthesis core (pure DSP, no Web Audio globals, so Vitest can run it).
//
// ONE KsSynth holds all voices (PLAN.md 6.1): the AudioWorklet creates a single KsSynth and calls process() per block.
//  - Delay line + averaging lowpass (the string's damping) + first-order ALLPASS for the fractional part of the delay,
//    so high notes stay in tune (the loop delay is exactly sampleRate / freq).
//  - Excitation: a noise burst, low-passed by `brightness` (hard, fast, near-the-end plucks are brighter) and scaled by
//    `velocity`. Decay time grows a little with velocity.
//  - Polyphony: a pool of POOL voices, of which at most MAX_ACTIVE sound at once. Beyond that the OLDEST one is not cut
//    off but released with a fast (6 ms) fade, and it keeps a pool slot until it has faded (so no click). Plucking a
//    string that is still ringing releases the old voice the same way and starts a new one (a smooth restart).

export interface PluckParams {
  /** Identifies the string, so a re-pluck can release the ringing voice of the same string. */
  stringId: number;
  freq: number;
  /** 0..1, loudness and decay. */
  velocity: number;
  /** 0..1, tone (1 = bright, white-noise excitation). */
  brightness: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
}

export const POOL = 24;
export const MAX_ACTIVE = 14;
const MAX_LEN = 4096;
const RELEASE_SEC = 0.006;
const ATTACK_SEC = 0.0005;

class Voice {
  readonly buf = new Float32Array(MAX_LEN);
  active = false;
  releasing = false;
  stringId = -1;
  len = 2;
  pos = 0;
  c = 0;
  apx = 0;
  apy = 0;
  loopGain = 0.999;
  gain = 1;
  /** Samples since the pluck. */
  age = 0;
  life = 0;
  attackLeft = 0;
  gl = 0.7;
  gr = 0.7;
  /** Monotonic start order, for "oldest first". */
  serial = 0;
}

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0); // NaN -> 0

export class KsSynth {
  readonly voices: Voice[] = Array.from({ length: POOL }, () => new Voice());
  private serial = 0;
  private seed = 0x1234567;
  private readonly relCoef: number;
  private readonly attackSamples: number;

  constructor(
    private readonly sampleRate: number,
    private readonly maxActive = MAX_ACTIVE,
  ) {
    this.relCoef = Math.exp(-1 / (RELEASE_SEC * sampleRate));
    this.attackSamples = Math.max(1, Math.round(ATTACK_SEC * sampleRate));
  }

  /** Voices that are sounding (including ones that are fading out). */
  get activeCount(): number {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  /** Voices that are sounding and not already fading out. */
  get soundingCount(): number {
    let n = 0;
    for (const v of this.voices) if (v.active && !v.releasing) n++;
    return n;
  }

  private rand(): number {
    // xorshift32 -> -1..1 (deterministic, so tests are repeatable)
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 2147483648 - 1;
  }

  pluck(p: PluckParams): void {
    // 1. A ringing voice of the same string fades out quickly.
    for (const v of this.voices) if (v.active && !v.releasing && v.stringId === p.stringId) v.releasing = true;

    // 2. Keep the number of sounding voices at most maxActive: release the oldest.
    while (this.soundingCount >= this.maxActive) {
      let oldest: Voice | null = null;
      for (const v of this.voices) if (v.active && !v.releasing && (!oldest || v.serial < oldest.serial)) oldest = v;
      if (!oldest) break;
      oldest.releasing = true;
    }

    // 3. A free slot; if the pool is full of fading voices, take the oldest of them (hard steal, very rare).
    let slot: Voice | null = null;
    for (const v of this.voices) {
      if (!v.active) {
        slot = v;
        break;
      }
    }
    if (!slot) for (const v of this.voices) if (!slot || v.serial < slot.serial) slot = v;
    this.start(slot!, p);
  }

  private start(v: Voice, p: PluckParams): void {
    const sr = this.sampleRate;
    const freq = Math.min(Math.max(Number.isFinite(p.freq) ? p.freq : 220, 40), sr / 8);
    const velocity = clamp01(p.velocity);
    const brightness = clamp01(p.brightness);
    // The loop writes y[n] = allpass(0.5 * (y[n-L] + y[n-L+1])): its delay is L - 0.5 (averaging filter) + d (allpass).
    // d is kept in [0.5, 1.5) for an accurate, stable allpass, so L = floor(total) and d = total + 0.5 - L.
    const total = sr / freq;
    const L = Math.max(2, Math.min(MAX_LEN, Math.floor(total)));
    const d = Math.min(1.5, Math.max(0.5, total + 0.5 - L));
    v.len = L;
    v.c = (1 - d) / (1 + d);
    v.apx = 0;
    v.apy = 0;
    v.pos = 0;

    // Decay: T60 grows with velocity; the loop gain gives that decay over the whole loop delay.
    const t60 = 1.8 + 2.7 * velocity;
    v.loopGain = Math.pow(10, (-3 * total) / (t60 * sr));
    v.life = Math.round(t60 * 1.2 * sr);

    // Excitation: noise, low-passed by brightness, DC removed, RMS-normalised, scaled by velocity.
    const a = 0.88 * (1 - brightness); // one-pole coefficient: 0 = white noise
    let lp = 0;
    let sum = 0;
    for (let i = 0; i < L; i++) {
      lp = a * lp + (1 - a) * this.rand();
      v.buf[i] = lp;
      sum += lp;
    }
    const mean = sum / L;
    let sq = 0;
    for (let i = 0; i < L; i++) {
      const x = v.buf[i]! - mean;
      v.buf[i] = x;
      sq += x * x;
    }
    const rms = Math.sqrt(sq / L) || 1;
    const level = (0.08 + 0.52 * velocity) / rms; // output RMS ~ 0.08 .. 0.6 of full scale before the master limiter
    for (let i = 0; i < L; i++) v.buf[i] = v.buf[i]! * level;

    const pan = Number.isFinite(p.pan) ? Math.min(1, Math.max(-1, p.pan)) : 0;
    v.gl = Math.cos(((pan + 1) * Math.PI) / 4);
    v.gr = Math.sin(((pan + 1) * Math.PI) / 4);
    v.gain = 1;
    v.age = 0;
    v.attackLeft = this.attackSamples;
    v.active = true;
    v.releasing = false;
    v.stringId = p.stringId;
    v.serial = ++this.serial;
  }

  /** Fade out the voices of one string (or all voices when `stringId` is undefined). */
  stop(stringId?: number): void {
    for (const v of this.voices) if (v.active && (stringId === undefined || v.stringId === stringId)) v.releasing = true;
  }

  /** Adds the sound of all voices to `left` / `right` (the caller zeroes them first; worklet outputs start at 0). */
  process(left: Float32Array, right: Float32Array | undefined): void {
    const n = left.length;
    const attackSamples = this.attackSamples;
    const relCoef = this.relCoef;
    for (const v of this.voices) {
      if (!v.active) continue;
      const buf = v.buf;
      const L = v.len;
      let pos = v.pos;
      let apx = v.apx;
      let apy = v.apy;
      let gain = v.gain;
      let attackLeft = v.attackLeft;
      const c = v.c;
      const g = v.loopGain;
      const rel = v.releasing;
      for (let i = 0; i < n; i++) {
        const next = pos + 1 === L ? 0 : pos + 1;
        const s = buf[pos]!;
        const avg = 0.5 * (s + buf[next]!);
        const ap = c * avg + apx - c * apy;
        apx = avg;
        apy = ap;
        buf[pos] = ap * g;
        pos = next;

        let out = s * gain;
        if (attackLeft > 0) {
          out *= 1 - attackLeft / attackSamples;
          attackLeft--;
        }
        if (rel) gain *= relCoef;
        left[i] = left[i]! + out * v.gl;
        if (right) right[i] = right[i]! + out * v.gr;
      }
      v.pos = pos;
      v.apx = apx;
      v.apy = apy;
      v.gain = gain;
      v.attackLeft = attackLeft;
      v.age += n;
      if (!Number.isFinite(apy) || gain < 0.001 || v.age >= v.life) {
        v.active = false;
        v.releasing = false;
      }
    }
  }
}
