// Theremin sound (PLAN.md 6.3): a sine plus a little triangle (slightly detuned, so it breathes), through a lowpass filter,
// with a vibrato LFO on the pitch and a gain for loudness. The nodes run for as long as the instrument is selected (the gain is
// 0 when silent, which is nearly free), and every control is ramped with setTargetAtTime, so nothing clicks:
//  - pitch glides (time constant = the glide setting),
//  - loudness follows quickly (30 ms; 15 ms when a pinch mutes it, so notes can be separated),
//  - the filter opens with loudness and pitch (a louder, higher theremin note is brighter).
// `thereminParams` is pure (numbers in, numbers out) and tested.

export interface ThereminParams {
  freq: number;
  /** 0..1 */
  gain: number;
  /** Vibrato depth in cents and rate in Hz. */
  vibratoCents: number;
  vibratoHz: number;
}

export interface ThereminNodeValues {
  freq: number;
  gain: number;
  cutoff: number;
  vibratoCents: number;
  vibratoHz: number;
}

const MASTER = 0.35; // keeps the theremin about as loud as the other instruments before the limiter

/** What each node should be set to (clamped, never NaN). Pure. */
export function thereminParams(p: ThereminParams): ThereminNodeValues {
  const num = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);
  const freq = Math.min(4000, Math.max(30, num(p.freq, 220)));
  const gain = Math.min(1, Math.max(0, num(p.gain, 0)));
  // Filter: 1.2 kHz when quiet and low .. ~8 kHz when loud and high (never below 2x the note so the pitch stays clear).
  const cutoff = Math.min(12000, Math.max(freq * 2.5, 1200 + 5200 * gain + 0.6 * freq));
  return {
    freq,
    gain: gain * MASTER,
    cutoff,
    vibratoCents: Math.min(150, Math.max(0, num(p.vibratoCents, 0))),
    vibratoHz: Math.min(10, Math.max(2, num(p.vibratoHz, 5.5))),
  };
}

export class ThereminSynth {
  private readonly sine: OscillatorNode;
  private readonly tri: OscillatorNode;
  private readonly lfo: OscillatorNode;
  private readonly lfoDepth: GainNode;
  private readonly triGain: GainNode;
  private readonly filter: BiquadFilterNode;
  private readonly voice: GainNode;
  private stopped = false;

  constructor(
    private readonly ctx: AudioContext,
    out: AudioNode,
  ) {
    this.sine = ctx.createOscillator();
    this.sine.type = "sine";
    this.tri = ctx.createOscillator();
    this.tri.type = "triangle";
    this.tri.detune.value = 4; // a few cents apart: a slow, living beat instead of a dead tone
    this.triGain = ctx.createGain();
    this.triGain.gain.value = 0.22;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.Q.value = 0.7;
    this.filter.frequency.value = 2000;
    this.voice = ctx.createGain();
    this.voice.gain.value = 0;

    // Vibrato: an LFO in cents on both oscillators' detune.
    this.lfo = ctx.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.value = 5.5;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0;
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.sine.detune);
    this.lfoDepth.connect(this.tri.detune);

    this.sine.connect(this.filter);
    this.tri.connect(this.triGain);
    this.triGain.connect(this.filter);
    this.filter.connect(this.voice);
    this.voice.connect(out);

    this.sine.frequency.value = 220;
    this.tri.frequency.value = 220;
    const t = ctx.currentTime;
    this.sine.start(t);
    this.tri.start(t);
    this.lfo.start(t);
  }

  /**
   * Sets the sound. `glideMs` = time constant of the pitch glide. `fast` makes the loudness react faster (a pinch mute).
   */
  set(p: ThereminParams, glideMs: number, fast: boolean): void {
    if (this.stopped) return;
    const v = thereminParams(p);
    const t = this.ctx.currentTime;
    const glide = Math.max(0.002, glideMs / 1000);
    this.sine.frequency.setTargetAtTime(v.freq, t, glide);
    this.tri.frequency.setTargetAtTime(v.freq, t, glide);
    this.voice.gain.setTargetAtTime(v.gain, t, fast ? 0.015 : 0.03);
    this.filter.frequency.setTargetAtTime(v.cutoff, t, 0.04);
    this.lfoDepth.gain.setTargetAtTime(v.vibratoCents, t, 0.08);
    this.lfo.frequency.setTargetAtTime(v.vibratoHz, t, 0.1);
  }

  /** Fades out and frees every node. */
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.voice.gain.cancelScheduledValues(t);
    this.voice.gain.setTargetAtTime(0, t, 0.015);
    const end = t + 0.12;
    for (const o of [this.sine, this.tri, this.lfo]) o.stop(end);
    this.sine.onended = () => {
      for (const n of [this.sine, this.tri, this.lfo, this.lfoDepth, this.triGain, this.filter, this.voice]) n.disconnect();
    };
  }
}
