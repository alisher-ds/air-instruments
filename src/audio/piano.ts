// Air piano sound (PLAN.md 6.4): a soft electric piano, made with 2-operator FM plus a short "tine" partial, no samples.
//
//  - Carrier = the note (sine). The modulator (ratio 1) bends it with an index that starts high and falls fast: the soft "bark"
//    of a Rhodes at the start of a note, then a clean bell-like tone. A harder key = a higher index (brighter) and louder.
//  - A short, quiet partial at ~5.9 x the note (the tine) decays in ~120 ms.
//  - Amplitude: 3 ms attack, then a long exponential decay (low notes ring longer). A key release damps it in ~0.15 s.
//  - At most MAX_VOICES notes at once; the oldest is damped quickly when there are more (10 fingers + tails).
// `pianoVoice` is pure (numbers in, numbers out) and tested; `PianoSynth` builds short-lived Web Audio nodes from it.

import { midiToFreq } from "./scales";

export interface PianoVoice {
  freq: number;
  /** Peak amplitude (0..1, before the bus). */
  gain: number;
  /** FM index at the start of the note and the value it falls to. */
  indexStart: number;
  indexEnd: number;
  /** Time constants, seconds. */
  indexDecay: number;
  decaySec: number;
  releaseSec: number;
  tineGain: number;
  tineRatio: number;
}

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0); // NaN -> 0

export function pianoVoice(midi: number, velocity: number): PianoVoice {
  const v = clamp01(velocity);
  const m = Math.min(108, Math.max(21, Number.isFinite(midi) ? midi : 60));
  const freq = midiToFreq(m);
  return {
    freq,
    gain: 0.1 + 0.4 * Math.pow(v, 1.3),
    indexStart: 0.6 + 2.6 * v,
    indexEnd: 0.15 + 0.35 * v,
    indexDecay: 0.45,
    // Low notes ring longer, high ones shorter (a real string's behaviour).
    decaySec: Math.min(5, Math.max(0.8, 3.4 - 0.032 * (m - 60))),
    releaseSec: Math.min(0.4, Math.max(0.08, 0.3 - 0.0025 * (m - 48))),
    tineGain: 0.05 + 0.12 * v,
    tineRatio: 5.9,
  };
}

const MAX_VOICES = 24;

interface Playing {
  id: number;
  amp: GainNode;
  stop: (releaseSec: number) => void;
  serial: number;
  releasing: boolean;
  release: number;
}

export class PianoSynth {
  private readonly playing = new Map<number, Playing>();
  private serial = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: AudioNode,
  ) {}

  get active(): number {
    return this.playing.size;
  }

  /** Starts a note. `id` identifies the finger that plays it, so noteOff(id) can end it. */
  noteOn(id: number, midi: number, velocity: number): void {
    // The same finger pressing again: the old note is damped quickly (no click, no pile-up).
    this.noteOff(id, 0.04);
    // Too many notes: damp the oldest sounding ones.
    while (this.soundingCount() >= MAX_VOICES) {
      let oldest: Playing | null = null;
      for (const p of this.playing.values()) if (!p.releasing && (!oldest || p.serial < oldest.serial)) oldest = p;
      if (!oldest) break;
      this.release(oldest, 0.05);
    }

    const { ctx } = this;
    const v = pianoVoice(midi, velocity);
    const t = ctx.currentTime;

    const carrier = ctx.createOscillator();
    carrier.type = "sine";
    carrier.frequency.value = v.freq;
    const mod = ctx.createOscillator();
    mod.type = "sine";
    mod.frequency.value = v.freq; // ratio 1
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(v.indexStart * v.freq, t);
    modGain.gain.setTargetAtTime(v.indexEnd * v.freq, t, v.indexDecay);
    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    const tine = ctx.createOscillator();
    tine.type = "sine";
    tine.frequency.value = v.freq * v.tineRatio;
    const tineAmp = ctx.createGain();
    tineAmp.gain.setValueAtTime(v.tineGain, t);
    tineAmp.gain.setTargetAtTime(0, t, 0.04);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(v.gain, t + 0.003);
    amp.gain.setTargetAtTime(0, t + 0.003, v.decaySec / 4.6); // ~ -40 dB after decaySec

    carrier.connect(amp);
    tine.connect(tineAmp);
    tineAmp.connect(amp);
    amp.connect(this.out);

    carrier.start(t);
    mod.start(t);
    tine.start(t);

    const playing: Playing = {
      id,
      amp,
      serial: ++this.serial,
      releasing: false,
      release: v.releaseSec,
      stop: (releaseSec) => {
        const now = ctx.currentTime;
        amp.gain.cancelScheduledValues(now);
        amp.gain.setTargetAtTime(0, now, releaseSec / 3);
        const end = now + releaseSec * 2 + 0.05;
        carrier.stop(end);
        mod.stop(end);
        tine.stop(end);
      },
    };
    carrier.onended = () => {
      for (const n of [carrier, mod, modGain, tine, tineAmp, amp]) n.disconnect();
      if (this.playing.get(id) === playing) this.playing.delete(id);
    };
    this.playing.set(id, playing);
    // A note nobody releases (a lost hand) still ends by itself.
    window.setTimeout(() => {
      if (this.playing.get(id) === playing && !playing.releasing) this.release(playing, 0.3);
    }, (v.decaySec * 1.6 + 1) * 1000);
  }

  /** Ends the note of finger `id` (the key came up): damped over the note's release time, or `releaseSec`. */
  noteOff(id: number, releaseSec?: number): void {
    const p = this.playing.get(id);
    if (p) this.release(p, releaseSec ?? p.release);
  }

  stopAll(): void {
    for (const p of [...this.playing.values()]) this.release(p, 0.06);
  }

  private release(p: Playing, sec: number): void {
    if (p.releasing) return;
    p.releasing = true;
    p.stop(sec);
  }

  private soundingCount(): number {
    let n = 0;
    for (const p of this.playing.values()) if (!p.releasing) n++;
    return n;
  }
}
