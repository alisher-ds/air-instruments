// Theremin logic tests: synthetic hands through the real HandAnalyzer, then the model.
import { describe, expect, it } from "vitest";
import { ROOT_MIDI, midiToFreq, scaleNotes } from "../../audio/scales";
import { DEFAULT_CONFIG, type Config } from "../../config";
import { HandAnalyzer } from "../../core/gestures";
import { HandPipeline } from "../../core/tracking";
import { synthHand } from "../../../test/helpers/synthHand";
import {
  Calibration,
  DEFAULT_CALIBRATION,
  PITCH_SEMITONES,
  ThereminModel,
  VibratoDetector,
  applySnap,
  heightToT,
  sanitizeCalibration,
  volumeCurve,
  type ThereminConfig,
} from "./model";

const W = 1280;
const H = 720;

/** Palm centre of synthHand = wrist + (10, -74.4). */
const wristFor = (px: number, py: number) => ({ x: px - 10, y: py + 74.4 });

interface Spec {
  id: number;
  px: number;
  py: number;
  open?: number;
  /** Sideways offset of the RAW landmarks only (the smoothed ones stay where they are): a wrist wobble the filter removed. */
  rawDx?: number;
}

function makeCfg(over: Partial<Config> = {}): ThereminConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

class Rig {
  readonly analyzer = new HandAnalyzer();
  readonly model: ThereminModel;
  t = 1000;
  calibrated: unknown = null;
  constructor(cfg: ThereminConfig = makeCfg()) {
    this.model = new ThereminModel(cfg);
    this.model.setViewport(W, H);
  }
  step(hands: Spec[], dtMs = 33) {
    this.t += dtMs;
    const frame = this.analyzer.analyze(
      hands.map((h) => {
        const w = wristFor(h.px, h.py);
        const lm = synthHand({ x: w.x, y: w.y, open: h.open ?? 1 });
        const raw = h.rawDx ? lm.map((p) => ({ x: p.x + h.rawDx!, y: p.y })) : undefined;
        return { id: h.id, landmarks: lm, raw };
      }),
      this.t,
      W,
    );
    const r = this.model.update(frame, this.t);
    if (r.calibrated) this.calibrated = r.calibrated;
    return this.model.state;
  }
}

const LEFT = 300;
const RIGHT = 960;
/** y (px) of a hand at height fraction t (0 = lowest .. 1 = highest) with the default range. */
const yAt = (t: number) => H * (0.85 - 0.7 * t);

describe("heightToT / volumeCurve / applySnap", () => {
  it("maps the calibrated range to 0..1 and clamps outside it", () => {
    const r = { lo: 0.8, hi: 0.2 };
    expect(heightToT(0.8 * H, H, r)).toBeCloseTo(0);
    expect(heightToT(0.2 * H, H, r)).toBeCloseTo(1);
    expect(heightToT(0.5 * H, H, r)).toBeCloseTo(0.5);
    expect(heightToT(0.95 * H, H, r)).toBe(0);
    expect(heightToT(0.01 * H, H, r)).toBe(1);
    expect(heightToT(100, H, { lo: 0.5, hi: 0.5 })).toBe(0); // a broken range does not divide by zero
  });

  it("volume: silent below the dead zone, then rising, never above 1", () => {
    expect(volumeCurve(0.05, 0.08)).toBe(0);
    expect(volumeCurve(0.08, 0.08)).toBe(0);
    let prev = 0;
    for (let t = 0.1; t <= 1.0001; t += 0.1) {
      const v = volumeCurve(t, 0.08);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(volumeCurve(1, 0.08)).toBeCloseTo(1);
  });

  const notes = scaleNotes("major-pentatonic");
  it("snap 0 leaves the pitch alone, snap 1 sticks to the notes", () => {
    for (const s of [50.3, 53.7, 60.1, 70.9]) expect(applySnap(s, notes, 0)).toBeCloseTo(s, 6);
    // F#3 = 54 is a note, 53.8 is close to it: full snap lands almost exactly on it
    expect(Math.abs(applySnap(53.8, notes, 1) - 54)).toBeLessThan(0.01);
    expect(Math.abs(applySnap(53.8, notes, 0.5) - 54)).toBeLessThan(Math.abs(53.8 - 54));
  });

  it("snap is continuous and never goes backwards", () => {
    for (const snap of [0, 0.5, 1]) {
      let prev = -Infinity;
      for (let s = ROOT_MIDI - 1; s <= ROOT_MIDI + PITCH_SEMITONES + 1; s += 0.01) {
        const v = applySnap(s, notes, snap);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        if (Number.isFinite(prev)) expect(v - prev).toBeLessThan(0.5); // no jumps (the biggest note gap in the scale is 3 semitones)
        prev = v;
      }
    }
  });

  it("stays inside the range of the scale", () => {
    expect(applySnap(10, notes, 0.5)).toBe(notes[0]);
    expect(applySnap(200, notes, 0.5)).toBe(notes[notes.length - 1]);
  });
});

describe("VibratoDetector (raw sideways wobble)", () => {
  const wobble = (fps: number, hz: number, amp: number, seconds = 1.2, noise = 0) => {
    const d = new VibratoDetector();
    const dt = 1000 / fps;
    for (let t = 0; t < seconds * 1000; t += dt) d.push(t, 640 + amp * Math.sin((2 * Math.PI * hz * t) / 1000) + (Math.sin(t * 12.9898) * noise), 100);
    return d;
  };

  it("a still hand with tracking noise has almost no wobble", () => {
    expect(wobble(30, 5, 0, 1.2, 1.5).rms).toBeLessThan(0.03);
    expect(wobble(14, 5, 0, 1.2, 1.5).rms).toBeLessThan(0.03);
  });

  it("a 5 Hz wobble of 12 px (0.12 hand sizes) is clearly seen at 30 fps and at 14 fps", () => {
    expect(wobble(30, 5, 12).rms).toBeGreaterThan(0.06);
    expect(wobble(14, 5, 12).rms).toBeGreaterThan(0.05);
  });

  it("a bigger wobble reads as a bigger depth", () => {
    expect(wobble(30, 5, 20).rms).toBeGreaterThan(wobble(30, 5, 8).rms * 1.8);
  });

  it("moving the hand sideways is not vibrato (the straight-line trend is removed)", () => {
    const d = new VibratoDetector();
    for (let t = 0; t < 1000; t += 33) d.push(t, 500 + t * 0.12, 100); // 120 px/s drift
    expect(d.rms).toBeLessThan(0.02);
  });

  it("estimates the rate at 30 fps", () => {
    expect(wobble(30, 5.5, 12).rateHz).toBeGreaterThan(4);
    expect(wobble(30, 5.5, 12).rateHz).toBeLessThan(7.5);
  });

  it("needs a few samples and resets cleanly", () => {
    const d = new VibratoDetector();
    d.push(0, 100, 100);
    d.push(30, 130, 100);
    expect(d.rms).toBe(0);
    for (let t = 0; t < 600; t += 33) d.push(t, 640 + 15 * Math.sin(t / 30), 100);
    d.reset();
    expect(d.rms).toBe(0);
  });
});

describe("the model: pitch, volume, mute", () => {
  const play = (rig: Rig, pitchT: number, volT: number, frames = 4) => {
    let s = rig.model.state;
    for (let i = 0; i < frames; i++) s = rig.step([{ id: 1, px: LEFT, py: yAt(volT) }, { id: 2, px: RIGHT, py: yAt(pitchT) }]);
    return s;
  };

  it("the right hand's height sets the pitch: higher hand = higher note", () => {
    const lo = play(new Rig(makeCfg({ thereminSnap: 0 })), 0.1, 0.8);
    const hi = play(new Rig(makeCfg({ thereminSnap: 0 })), 0.9, 0.8);
    expect(hi.freq).toBeGreaterThan(lo.freq * 4);
    expect(lo.rawMidi).toBeCloseTo(ROOT_MIDI + 0.1 * PITCH_SEMITONES, 0);
    expect(hi.pitchHand).not.toBeNull();
  });

  it("the left hand's height sets the volume: low = silent, high = loud", () => {
    const silent = play(new Rig(), 0.5, 0.02);
    const mid = play(new Rig(), 0.5, 0.5);
    const loud = play(new Rig(), 0.5, 0.95);
    expect(silent.gain).toBe(0);
    expect(silent.playing).toBe(false);
    expect(mid.gain).toBeGreaterThan(0.05);
    expect(loud.gain).toBeGreaterThan(mid.gain);
    expect(loud.gain).toBeLessThanOrEqual(1);
  });

  it("no left hand = silent; no right hand = silent", () => {
    const rig = new Rig();
    play(rig, 0.5, 0.8);
    const onlyRight = rig.step([{ id: 2, px: RIGHT, py: yAt(0.5) }]);
    expect(onlyRight.gain).toBe(0);
    play(rig, 0.5, 0.8);
    const onlyLeft = rig.step([{ id: 1, px: LEFT, py: yAt(0.8) }]);
    expect(onlyLeft.gain).toBe(0);
    expect(onlyLeft.playing).toBe(false);
  });

  it("a pinch on the pitch hand mutes it, and it sounds again when released (articulation)", () => {
    const rig = new Rig();
    const on = play(rig, 0.5, 0.8);
    expect(on.gain).toBeGreaterThan(0);
    const pinched = rig.step([{ id: 1, px: LEFT, py: yAt(0.8) }, { id: 2, px: RIGHT, py: yAt(0.5), open: 0 }]);
    expect(pinched.muted).toBe(true);
    expect(pinched.gain).toBe(0);
    const off = rig.step([{ id: 1, px: LEFT, py: yAt(0.8) }, { id: 2, px: RIGHT, py: yAt(0.5), open: 1 }]);
    expect(off.muted).toBe(false);
    expect(off.gain).toBeGreaterThan(0);
  });

  it("with snap the pitch sits on scale notes; with the scale changed it follows", () => {
    const cfg = makeCfg({ thereminSnap: 1 });
    const rig = new Rig(cfg);
    const notes = scaleNotes("major-pentatonic").map(midiToFreq);
    // a few heights: each result must be (almost) a note of the scale
    for (const t of [0.13, 0.31, 0.5, 0.77]) {
      const s = play(rig, t, 0.8, 3);
      const nearest = Math.min(...notes.map((f) => Math.abs(1200 * Math.log2(s.freq / f))));
      expect(nearest).toBeLessThan(40); // cents from a scale note (not exact: snap 1 still flows a bit between two notes)
    }
    cfg.thereminScale = "harmonic-minor";
    const s = play(rig, 0.43, 0.8, 3); // 65.5: close to the note 65 of this scale (0.5 would be exactly between two notes)
    const minor = scaleNotes("harmonic-minor").map(midiToFreq);
    expect(Math.min(...minor.map((f) => Math.abs(1200 * Math.log2(s.freq / f))))).toBeLessThan(40);
  });

  it("calibration changes the mapping: a small hand range still reaches the top note", () => {
    const rig = new Rig(makeCfg({ thereminSnap: 0 }));
    rig.model.setCalibration({ pitch: { lo: 0.6, hi: 0.4 + 0.0 }, vol: { lo: 0.85, hi: 0.15 } });
    const top = play(rig, 0, 0.8, 3); // yAt is for the default range: y at t=0 is 0.85 H, which is below this range -> t 0
    expect(top.tPitch).toBe(0);
    for (let i = 0; i < 3; i++) rig.step([{ id: 1, px: LEFT, py: yAt(0.8) }, { id: 2, px: RIGHT, py: 0.4 * H }]);
    expect(rig.model.state.tPitch).toBeCloseTo(1, 1);
  });
});

describe("vibrato", () => {
  it("a wrist wobble that exists only in the RAW landmarks makes vibrato (the smoothed ones are still)", () => {
    const rig = new Rig(makeCfg({ thereminAutoVibrato: 0 }));
    let s = rig.model.state;
    for (let i = 0; i < 20; i++) {
      s = rig.step([{ id: 1, px: LEFT, py: yAt(0.8) }, { id: 2, px: RIGHT, py: yAt(0.5), rawDx: 14 * Math.sin(i * 1.3) }]);
    }
    expect(s.vibratoCents).toBeGreaterThan(20);
    expect(s.vibratoHz).toBeGreaterThan(3);
  });

  it("no wobble and no held note: no vibrato", () => {
    const rig = new Rig(makeCfg({ thereminAutoVibrato: 0.3 }));
    let s = rig.model.state;
    for (let i = 0; i < 12; i++) s = rig.step([{ id: 1, px: LEFT, py: yAt(0.8) }, { id: 2, px: RIGHT, py: yAt(0.5) }]);
    expect(s.vibratoCents).toBeLessThan(2);
  });

  it("a held note gets a gentle automatic vibrato that fades in, and a new note starts over", () => {
    const cfg = makeCfg({ thereminAutoVibrato: 0.3, thereminVibratoCents: 40, thereminSnap: 1 });
    const rig = new Rig(cfg);
    const hold = (t: number, seconds: number) => {
      let s = rig.model.state;
      for (let ms = 0; ms < seconds * 1000; ms += 33) s = rig.step([{ id: 1, px: LEFT, py: yAt(0.8) }, { id: 2, px: RIGHT, py: yAt(t) }]);
      return s;
    };
    const early = hold(0.5, 0.5);
    const late = hold(0.5, 3);
    expect(late.vibratoCents).toBeGreaterThan(early.vibratoCents + 3);
    expect(late.vibratoCents).toBeLessThanOrEqual(40 * 0.3 + 0.01);
    const newNote = hold(0.8, 0.3);
    expect(newNote.vibratoCents).toBeLessThan(late.vibratoCents * 0.5);
  });

  it("auto vibrato can be switched off", () => {
    const rig = new Rig(makeCfg({ thereminAutoVibrato: 0 }));
    let s = rig.model.state;
    for (let ms = 0; ms < 4000; ms += 33) s = rig.step([{ id: 1, px: LEFT, py: yAt(0.8) }, { id: 2, px: RIGHT, py: yAt(0.5) }]);
    expect(s.vibratoCents).toBeLessThan(1);
  });
});

describe("calibration", () => {
  it("records the lowest and highest position of each hand during 2 s and applies it", () => {
    const rig = new Rig();
    rig.model.startCalibration();
    let t = 0;
    for (let ms = 0; ms < 2300; ms += 33) {
      const k = 0.5 + 0.5 * Math.sin(t);
      t += 0.12;
      // right hand sweeps y from 0.3 H to 0.7 H, left hand from 0.25 H to 0.8 H
      rig.step([
        { id: 1, px: LEFT, py: H * (0.25 + 0.55 * k) },
        { id: 2, px: RIGHT, py: H * (0.3 + 0.4 * k) },
      ]);
    }
    const c = rig.calibrated as { pitch: { lo: number; hi: number }; vol: { lo: number; hi: number } };
    expect(c).not.toBeNull();
    expect(c.pitch.hi).toBeCloseTo(0.3, 1);
    expect(c.pitch.lo).toBeCloseTo(0.7, 1);
    expect(c.vol.hi).toBeCloseTo(0.25, 1);
    expect(c.vol.lo).toBeCloseTo(0.8, 1);
    expect(rig.model.calibration.pitch.lo).toBeCloseTo(0.7, 1);
    expect(rig.model.calibrator.active).toBe(false);
  });

  it("the 2 seconds start when the first hand shows up, and a hand that did not move keeps the default", () => {
    const rig = new Rig();
    rig.model.startCalibration();
    for (let i = 0; i < 30; i++) rig.step([]); // nobody there: nothing happens
    expect(rig.model.calibrator.active).toBe(true);
    expect(rig.model.calibrator.progress).toBe(0);
    for (let ms = 0; ms < 2300; ms += 33) rig.step([{ id: 2, px: RIGHT, py: H * (0.2 + 0.6 * (0.5 + 0.5 * Math.sin(ms / 250))) }]); // only the right hand
    const c = rig.calibrated as { pitch: { lo: number; hi: number }; vol: { lo: number; hi: number } };
    expect(c.pitch.lo - c.pitch.hi).toBeGreaterThan(0.4);
    expect(c.vol).toEqual(DEFAULT_CALIBRATION.vol); // never seen: the default stays
  });

  it("a range that is too small is not believed", () => {
    const cal = new Calibration();
    cal.begin();
    const rig = new Rig();
    const hand = (y: number) => rig.analyzer.analyze([{ id: 1, landmarks: synthHand({ x: 900, y: y + 74.4 }) }], 1000, W).hands[0]!;
    let res = null;
    for (let t = 0; t <= 2200; t += 100) res = cal.update([hand(300 + (t % 200) / 10)], 1000 + t, H, 2000, DEFAULT_CALIBRATION) ?? res;
    expect(res!.pitch).toEqual(DEFAULT_CALIBRATION.pitch);
  });

  it("sanitizeCalibration accepts good values and rejects the rest", () => {
    const good = { pitch: { lo: 0.8, hi: 0.2 }, vol: { lo: 0.9, hi: 0.1 } };
    expect(sanitizeCalibration(good)).toEqual(good);
    expect(sanitizeCalibration(null)).toBeNull();
    expect(sanitizeCalibration({ pitch: { lo: 0.5, hi: 0.45 }, vol: good.vol })).toBeNull();
    expect(sanitizeCalibration({ pitch: { lo: "a", hi: 0 }, vol: good.vol })).toBeNull();
    expect(sanitizeCalibration({ pitch: { lo: 5, hi: 0 }, vol: good.vol })).toBeNull();
  });
});

describe("raw landmarks through the real pipeline", () => {
  it("keep the tremble that smoothing removes", () => {
    const pipe = new HandPipeline();
    pipe.setViewport(W, H);
    pipe.setVideoSize(W, H);
    let lastRawX = 0;
    let lastSmoothX = 0;
    let t = 1000;
    for (let i = 0; i < 20; i++) {
      t += 33;
      const jitter = i % 2 === 0 ? 8 : -8; // a 8 px tremble
      const lm = synthHand({ x: 600 + jitter, y: 500 });
      const frame = pipe.process([lm.map((p) => ({ x: 1 - p.x / W, y: p.y / H }))], t);
      const hand = frame.hands[0]!;
      lastRawX = hand.rawLandmarks[0]!.x;
      lastSmoothX = hand.landmarks[0]!.x;
    }
    expect(Math.abs(lastRawX - 600)).toBeGreaterThan(6); // raw still has the tremble
    expect(Math.abs(lastSmoothX - 600)).toBeLessThan(Math.abs(lastRawX - 600)); // smoothed has less
  });
});
