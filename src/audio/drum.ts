// Doira (Uzbek frame drum) sound, synthesized in code (PLAN.md 6.2): no audio files.
//
//  - "bum": a sine with a fast pitch DROP (the membrane's deep thump) + a tiny low click.
//  - "tak": a bandpass-filtered noise burst (the sharp rim slap) + a short high "ping".
//  - "zil": the jingles (the rings in the frame): a few inharmonic sine partials, only on hard hits.
// The strike position makes `zone` (0 = centre, 1 = rim): the centre is mostly bum, the rim mostly tak, in between both.
//
// `drumVoices` is pure (numbers in, numbers out) and tested; `DoiraSynth` builds short-lived Web Audio nodes from it.
// Every hit makes a few nodes that stop and disconnect themselves; hits are at most ~15 per second, so this is cheap.

export interface DrumHit {
  /** 0..1 loudness. */
  velocity: number;
  /** 0 = centre of the skin, 1 = rim. */
  zone: number;
  /** A fingertip tap: lighter, shorter, higher. */
  soft: boolean;
  /** Base pitch of the bum in Hz. */
  bumHz: number;
}

export interface BumVoice {
  gain: number;
  startHz: number;
  endHz: number;
  dropSec: number;
  decaySec: number;
  clickGain: number;
}
export interface TakVoice {
  gain: number;
  bandHz: number;
  q: number;
  decaySec: number;
  pingHz: number;
  pingGain: number;
}
export interface ZilVoice {
  gain: number;
  partials: number[];
  decaySec: number;
}
export interface DrumVoices {
  bum: BumVoice | null;
  tak: TakVoice | null;
  zil: ZilVoice | null;
}

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0); // NaN -> 0
const MIN_GAIN = 0.015;

/** Jingle partials (Hz): inharmonic, so it sounds like metal, not a note. */
const ZIL_PARTIALS = [5230, 6840, 8120, 9650, 11210];

export function drumVoices(hit: DrumHit): DrumVoices {
  const v = clamp01(hit.velocity);
  const zone = clamp01(hit.zone);
  const soft = hit.soft;
  const bumHz = Math.min(400, Math.max(50, Number.isFinite(hit.bumHz) ? hit.bumHz : 110));

  // The zone crossfades bum and tak with equal-ish power; a fingertip tap is quieter.
  const level = (soft ? 0.5 : 1) * v;
  const bumGain = level * Math.pow(1 - zone, 0.8) * 0.95;
  const takGain = level * Math.pow(zone, 0.6) * 0.8;

  const bum: BumVoice | null =
    bumGain >= MIN_GAIN
      ? {
          gain: bumGain,
          startHz: bumHz * (1.25 + 0.5 * v), // a harder hit starts higher and drops further
          endHz: bumHz * 0.62,
          dropSec: 0.05 + 0.06 * v,
          decaySec: soft ? 0.16 : 0.22 + 0.3 * v,
          clickGain: 0.25 * bumGain,
        }
      : null;

  const tak: TakVoice | null =
    takGain >= MIN_GAIN
      ? {
          gain: takGain,
          bandHz: soft ? 4200 : 2600 + 600 * v,
          q: soft ? 1.6 : 1.1,
          decaySec: soft ? 0.045 : 0.07 + 0.06 * v,
          pingHz: soft ? 2300 : 1750,
          pingGain: 0.35 * takGain,
        }
      : null;

  // Jingles only on hard hits (PLAN.md: "jingle layer on hard hits"), a bit more at the rim.
  const zilAmount = soft ? 0 : clamp01((v - 0.55) / 0.45);
  const zilGain = zilAmount * (0.25 + 0.25 * zone) * 0.5;
  const zil: ZilVoice | null = zilGain >= MIN_GAIN ? { gain: zilGain, partials: ZIL_PARTIALS, decaySec: 0.14 + 0.2 * zilAmount } : null;

  return { bum, tak, zil };
}

export class DoiraSynth {
  private readonly noise: AudioBuffer;

  constructor(
    private readonly ctx: AudioContext,
    private readonly out: AudioNode,
  ) {
    // One second of white noise, made once; every tak starts at a random place in it.
    const n = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let seed = 0x2545f491;
    for (let i = 0; i < n; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      d[i] = ((seed >>> 0) / 2147483648) - 1;
    }
  }

  /** Plays one hit right now. */
  play(hit: DrumHit): void {
    const { ctx } = this;
    const t = ctx.currentTime;
    const voices = drumVoices(hit);

    if (voices.bum) {
      const b = voices.bum;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(b.startHz, t);
      osc.frequency.exponentialRampToValueAtTime(b.endHz, t + b.dropSec);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(b.gain, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + b.decaySec);
      osc.connect(g);
      g.connect(this.out);
      this.finish(osc, [g]);
      osc.start(t);
      osc.stop(t + b.decaySec + 0.02);

      // A tiny low click on the attack: the finger/palm meeting the skin.
      const click = this.noiseSource(t);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 900;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(b.clickGain, t);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
      click.connect(lp);
      lp.connect(cg);
      cg.connect(this.out);
      this.finish(click, [lp, cg]);
      click.start(t, 0, 0.03);
    }

    if (voices.tak) {
      const k = voices.tak;
      const src = this.noiseSource(t);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = k.bandHz;
      bp.Q.value = k.q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(k.gain, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, t + k.decaySec);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.out);
      this.finish(src, [bp, g]);
      src.start(t, 0, k.decaySec + 0.03);

      const ping = ctx.createOscillator();
      ping.type = "sine";
      ping.frequency.value = k.pingHz;
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(k.pingGain, t);
      pg.gain.exponentialRampToValueAtTime(0.0001, t + k.decaySec * 0.9);
      ping.connect(pg);
      pg.connect(this.out);
      this.finish(ping, [pg]);
      ping.start(t);
      ping.stop(t + k.decaySec + 0.03);
    }

    if (voices.zil) {
      const z = voices.zil;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 4000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(z.gain / z.partials.length, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + z.decaySec);
      hp.connect(g);
      g.connect(this.out);
      let last: OscillatorNode | null = null;
      for (const f of z.partials) {
        const o = ctx.createOscillator();
        o.type = "square";
        o.frequency.value = f * (0.995 + Math.random() * 0.01);
        o.connect(hp);
        o.start(t);
        o.stop(t + z.decaySec + 0.03);
        last = o;
      }
      if (last) last.onended = () => this.disconnectAll([hp, g]);
    }
  }

  private noiseSource(t: number): AudioBufferSourceNode {
    void t;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.loopStart = 0;
    s.loopEnd = 1;
    return s;
  }

  /** Disconnects `source` and its helper nodes when it has ended (no leaked nodes). The caller starts and stops it. */
  private finish(source: OscillatorNode | AudioBufferSourceNode, nodes: AudioNode[]): void {
    source.onended = () => {
      source.disconnect();
      this.disconnectAll(nodes);
    };
  }

  private disconnectAll(nodes: AudioNode[]): void {
    for (const n of nodes) n.disconnect();
  }
}
