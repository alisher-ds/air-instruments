// The theremin's LOGIC (PLAN.md 6.3), pure: hands in, a sound description out (pitch, loudness, vibrato). No audio, DOM
// or drawing, so it is tested with synthetic hands.
//
//  - The pitch hand is the RIGHT hand (by screen position), the volume hand the LEFT one. Height of the palm centre, mapped
//    through a calibrated range, gives pitch (3 octaves of D) and loudness. No left hand = silent.
//  - The pitch is pulled toward notes of a scale ("snap": 0 = free glide, 1 = sticks to notes); the audio side glides.
//  - A pinch on the pitch hand mutes it (articulation: separate notes).
//  - VIBRATO comes from a deliberate side-to-side wobble of the pitch hand, measured on the RAW (unsmoothed) palm: the One
//    Euro filter removes small tremble. Without a wobble a gentle automatic vibrato fades in on a held note.
//  - CALIBRATION: "show me your lowest and highest hand position" for 2 seconds, saved by the caller.

import { ROOT_MIDI, OCTAVES, midiToFreq, scaleNotes, type ScaleName } from "../../audio/scales";
import { clamp } from "../../core/geometry";
import type { Hand, HandFrame, Vec2 } from "../Instrument";

export interface ThereminConfig {
  thereminScale: ScaleName;
  thereminSnap: number;
  thereminVibratoCents: number;
  thereminAutoVibrato: number;
  thereminVolumeDead: number;
  thereminWobbleMin: number;
  thereminWobbleFull: number;
}

/** Calibrated hand heights as fractions of the window height: `lo` = the lowest position (large y), `hi` = the highest. */
export interface HeightRange {
  lo: number;
  hi: number;
}
export interface ThereminCalibration {
  pitch: HeightRange;
  vol: HeightRange;
}

export const DEFAULT_RANGE: HeightRange = { lo: 0.85, hi: 0.15 };
export const DEFAULT_CALIBRATION: ThereminCalibration = { pitch: { ...DEFAULT_RANGE }, vol: { ...DEFAULT_RANGE } };

/** Semitones the pitch range spans: 3 octaves. */
export const PITCH_SEMITONES = OCTAVES * 12;

const MIN_SPAN = 0.2; // a calibrated range smaller than this (of the window height) is not believable

/** Height of a hand (y in px) -> 0 (lowest position) .. 1 (highest), through the calibrated range. */
export function heightToT(y: number, viewportH: number, range: HeightRange): number {
  const span = range.lo - range.hi;
  if (!(viewportH > 0) || !(span > 1e-6)) return 0;
  return clamp((range.lo - y / viewportH) / span, 0, 1);
}

/**
 * Pulls a continuous pitch `semis` (MIDI) toward the nearest note of `notes`. snap 0 = unchanged. Between two notes the
 * curve is continuous and rising: near a note it moves slowly (sticky), near the midpoint it changes quickly.
 */
export function applySnap(semis: number, notes: readonly number[], snap: number): number {
  if (notes.length === 0) return semis;
  if (semis <= notes[0]!) return notes[0]!;
  if (semis >= notes[notes.length - 1]!) return notes[notes.length - 1]!;
  let i = 0;
  while (i < notes.length - 2 && notes[i + 1]! <= semis) i++;
  const lo = notes[i]!;
  const hi = notes[i + 1]!;
  const mid = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  const n = semis < mid ? lo : hi;
  const w = clamp(Math.abs(semis - n) / half, 0, 1);
  const k = 1 + 4 * clamp(snap, 0, 1);
  return n + Math.sign(semis - n) * half * Math.pow(w, k);
}

/** Left-hand height (0..1) -> loudness 0..1: silent below `dead`, then a gentle curve. */
export function volumeCurve(t: number, dead: number): number {
  const d = clamp(dead, 0, 0.9);
  if (t <= d) return 0;
  return Math.pow((t - d) / (1 - d), 1.6);
}

/**
 * Deliberate side-to-side wobble of a hand, from RAW x positions. Keeps the last ~500 ms, removes the straight-line trend
 * (a hand that just moves sideways is not vibrato) and takes the RMS of what is left, in hand sizes. Works at any tracking
 * rate: it needs no frequency, so 14 fps tracking is fine. The rate comes from zero crossings when there are enough samples.
 */
export class VibratoDetector {
  private readonly t: number[] = [];
  private readonly x: number[] = [];
  /** RMS of the wobble in hand sizes (0 = still). */
  rms = 0;
  /** Estimated wobble rate in Hz, or 0 if unknown. */
  rateHz = 0;

  constructor(private readonly windowMs = 500) {}

  push(tMs: number, x: number, handSize: number): void {
    this.t.push(tMs);
    this.x.push(x);
    while (this.t.length > 0 && tMs - this.t[0]! > this.windowMs) {
      this.t.shift();
      this.x.shift();
    }
    this.analyse(handSize);
  }

  reset(): void {
    this.t.length = 0;
    this.x.length = 0;
    this.rms = 0;
    this.rateHz = 0;
  }

  private analyse(handSize: number): void {
    const n = this.t.length;
    if (n < 5 || !(handSize > 0)) {
      this.rms = 0;
      this.rateHz = 0;
      return;
    }
    // Least-squares line x = a + b t, removed.
    let st = 0;
    let sx = 0;
    for (let i = 0; i < n; i++) {
      st += this.t[i]!;
      sx += this.x[i]!;
    }
    const mt = st / n;
    const mx = sx / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const dt = this.t[i]! - mt;
      num += dt * (this.x[i]! - mx);
      den += dt * dt;
    }
    const slope = den > 1e-9 ? num / den : 0;
    let sq = 0;
    const res: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = this.x[i]! - mx - slope * (this.t[i]! - mt);
      res.push(r);
      sq += r * r;
    }
    this.rms = Math.sqrt(sq / n) / handSize;
    // Zero crossings of the residual -> rate (only when there are enough samples to mean something).
    let crossings = 0;
    for (let i = 1; i < n; i++) if ((res[i - 1]! < 0) !== (res[i]! < 0)) crossings++;
    const dur = (this.t[n - 1]! - this.t[0]!) / 1000;
    this.rateHz = n >= 7 && dur > 0.2 ? crossings / 2 / dur : 0;
  }
}

/** Collects how high and how low each hand goes for `durationMs`. Pure: the caller feeds frames. */
export class Calibration {
  active = false;
  /** 0..1 */
  progress = 0;
  private start: number | null = null;
  private readonly seen = {
    pitch: { min: Infinity, max: -Infinity },
    vol: { min: Infinity, max: -Infinity },
  };
  /** Which hands were seen (for the message after it ends). */
  sawPitch = false;
  sawVol = false;

  begin(): void {
    this.active = true;
    this.progress = 0;
    this.start = null;
    this.seen.pitch = { min: Infinity, max: -Infinity };
    this.seen.vol = { min: Infinity, max: -Infinity };
    this.sawPitch = false;
    this.sawVol = false;
  }

  cancel(): void {
    this.active = false;
    this.progress = 0;
    this.start = null;
  }

  /**
   * Feed one frame. The clock starts when the first hand is seen. Returns the result when the time is up, else null.
   * A hand whose range is too small (or was never seen) keeps `fallback` for its side.
   */
  update(hands: readonly Hand[], now: number, viewportH: number, durationMs: number, fallback: ThereminCalibration): ThereminCalibration | null {
    if (!this.active) return null;
    if (hands.length > 0 && this.start === null) this.start = now;
    for (const h of hands) {
      const f = h.palmCenter.y / Math.max(1, viewportH);
      const side = h.side === "right" ? this.seen.pitch : this.seen.vol;
      side.min = Math.min(side.min, f);
      side.max = Math.max(side.max, f);
      if (h.side === "right") this.sawPitch = true;
      else this.sawVol = true;
    }
    if (this.start === null) return null;
    this.progress = clamp((now - this.start) / durationMs, 0, 1);
    if (this.progress < 1) return null;
    this.active = false;
    const pick = (s: { min: number; max: number }, fb: HeightRange): HeightRange =>
      s.max - s.min >= MIN_SPAN ? { lo: clamp(s.max, MIN_SPAN, 1), hi: clamp(s.min, 0, 1 - MIN_SPAN) } : { ...fb };
    return { pitch: pick(this.seen.pitch, fallback.pitch), vol: pick(this.seen.vol, fallback.vol) };
  }
}

/** Sanitises a saved / hand-edited calibration. */
export function sanitizeCalibration(raw: unknown): ThereminCalibration | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const range = (r: unknown): HeightRange | null => {
    if (typeof r !== "object" || r === null) return null;
    const { lo, hi } = r as Record<string, unknown>;
    if (typeof lo !== "number" || typeof hi !== "number" || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (lo > 1 || hi < 0 || lo - hi < MIN_SPAN) return null;
    return { lo, hi };
  };
  const pitch = range(o.pitch);
  const vol = range(o.vol);
  return pitch && vol ? { pitch, vol } : null;
}

/** What the sound should do right now. */
export interface ThereminState {
  /** Both hands present and the volume hand high enough. */
  playing: boolean;
  /** 0..1 */
  gain: number;
  freq: number;
  /** The note the pitch is pulled toward / continuous MIDI pitch after snapping. */
  midi: number;
  /** Continuous MIDI pitch before snapping. */
  rawMidi: number;
  tPitch: number;
  tVol: number;
  muted: boolean;
  vibratoCents: number;
  vibratoHz: number;
  /** For drawing. */
  pitchHand: Vec2 | null;
  volHand: Vec2 | null;
}

const SILENT: ThereminState = {
  playing: false,
  gain: 0,
  freq: midiToFreq(ROOT_MIDI),
  midi: ROOT_MIDI,
  rawMidi: ROOT_MIDI,
  tPitch: 0,
  tVol: 0,
  muted: false,
  vibratoCents: 0,
  vibratoHz: 5.5,
  pitchHand: null,
  volHand: null,
};

const DEFAULT_VIBRATO_HZ = 5.5;
const AUTO_START_MS = 900;
const AUTO_RAMP_MS = 1600;

const smooth01 = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

export class ThereminModel {
  calibration: ThereminCalibration = { pitch: { ...DEFAULT_RANGE }, vol: { ...DEFAULT_RANGE } };
  readonly calibrator = new Calibration();
  state: ThereminState = { ...SILENT };

  private readonly vibrato = new VibratoDetector();
  private vibratoHandId = -1;
  private notes: number[];
  private notesScale: ScaleName;
  private sustainSince = -1;
  private lastNote = -1;
  private viewH = 720;

  constructor(private readonly cfg: ThereminConfig) {
    this.notesScale = cfg.thereminScale;
    this.notes = scaleNotes(cfg.thereminScale);
  }

  setViewport(_w: number, h: number): void {
    this.viewH = h;
  }

  setCalibration(c: ThereminCalibration): void {
    this.calibration = { pitch: { ...c.pitch }, vol: { ...c.vol } };
  }

  /** Starts the "show me your lowest and highest position" step. */
  startCalibration(): void {
    this.calibrator.begin();
  }

  /** The finished calibration, or null while nothing new has finished (the caller saves it). */
  update(frame: HandFrame, now: number): { calibrated: ThereminCalibration | null } {
    let calibrated: ThereminCalibration | null = null;
    if (this.calibrator.active) {
      calibrated = this.calibrator.update(frame.hands, now, this.viewH, 2000, this.calibration);
      if (calibrated) this.calibration = calibrated;
    }

    if (this.notesScale !== this.cfg.thereminScale) {
      this.notesScale = this.cfg.thereminScale;
      this.notes = scaleNotes(this.cfg.thereminScale);
    }

    // The right hand (by screen position) plays the pitch, the left one sets the volume.
    const pitchHand = frame.hands.find((h) => h.side === "right") ?? null;
    const volHand = frame.hands.find((h) => h.side === "left") ?? null;
    const prev = this.state;

    if (!pitchHand) {
      this.vibrato.reset();
      this.vibratoHandId = -1;
      this.sustainSince = -1;
      this.state = { ...prev, playing: false, gain: 0, muted: false, vibratoCents: 0, pitchHand: null, volHand: volHand ? volHand.palmCenter : null };
      return { calibrated };
    }

    // Pitch
    const tPitch = heightToT(pitchHand.palmCenter.y, this.viewH, this.calibration.pitch);
    const rawMidi = ROOT_MIDI + tPitch * PITCH_SEMITONES;
    const midi = applySnap(rawMidi, this.notes, this.cfg.thereminSnap);

    // Volume (no left hand = silent), articulation by a pinch on the pitch hand
    const tVol = volHand ? heightToT(volHand.palmCenter.y, this.viewH, this.calibration.vol) : 0;
    const muted = pitchHand.pinch.active;
    const gain = volHand && !muted ? volumeCurve(tVol, this.cfg.thereminVolumeDead) : 0;
    const playing = gain > 0.004;

    // Vibrato from the RAW palm's sideways wobble
    if (this.vibratoHandId !== pitchHand.id) {
      this.vibrato.reset();
      this.vibratoHandId = pitchHand.id;
    }
    const raw = pitchHand.rawLandmarks;
    let rawX = 0;
    for (const i of PALM_POINTS) rawX += raw[i]!.x;
    this.vibrato.push(now, rawX / PALM_POINTS.length, pitchHand.handSize);
    const wobble = smooth01((this.vibrato.rms - this.cfg.thereminWobbleMin) / Math.max(1e-6, this.cfg.thereminWobbleFull - this.cfg.thereminWobbleMin));

    // Automatic vibrato fades in on a held note (the nearest note did not change, the sound is on)
    const note = Math.round(midi);
    if (!playing || note !== this.lastNote) this.sustainSince = playing ? now : -1;
    this.lastNote = note;
    const held = this.sustainSince >= 0 ? now - this.sustainSince : 0;
    const auto = this.cfg.thereminAutoVibrato * smooth01((held - AUTO_START_MS) / AUTO_RAMP_MS);

    const depth = Math.max(wobble, auto * (1 - wobble));
    const hz = this.vibrato.rateHz >= 3.5 && this.vibrato.rateHz <= 9 && wobble > 0.2 ? this.vibrato.rateHz : DEFAULT_VIBRATO_HZ;

    this.state = {
      playing,
      gain,
      freq: midiToFreq(midi),
      midi,
      rawMidi,
      tPitch,
      tVol,
      muted,
      vibratoCents: this.cfg.thereminVibratoCents * depth,
      vibratoHz: hz,
      pitchHand: pitchHand.palmCenter,
      volHand: volHand ? volHand.palmCenter : null,
    };
    return { calibrated };
  }

  reset(): void {
    this.vibrato.reset();
    this.vibratoHandId = -1;
    this.sustainSince = -1;
    this.lastNote = -1;
    this.state = { ...SILENT };
  }
}

/** Raw points averaged for the sideways wobble: wrist and the four finger knuckles (a stable palm centre). */
const PALM_POINTS = [0, 5, 9, 13, 17] as const;
