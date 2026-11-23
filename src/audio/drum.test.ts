import { describe, expect, it } from "vitest";
import { drumVoices, type DrumHit } from "./drum";

const hit = (over: Partial<DrumHit> = {}): DrumHit => ({ velocity: 0.8, zone: 0, soft: false, bumHz: 110, ...over });

describe("drumVoices: zones", () => {
  it("the centre is a bum (no tak), the rim is a tak (no bum), in between both", () => {
    const c = drumVoices(hit({ zone: 0 }));
    expect(c.bum).not.toBeNull();
    expect(c.tak).toBeNull();
    const r = drumVoices(hit({ zone: 1 }));
    expect(r.bum).toBeNull();
    expect(r.tak).not.toBeNull();
    const m = drumVoices(hit({ zone: 0.5 }));
    expect(m.bum).not.toBeNull();
    expect(m.tak).not.toBeNull();
  });

  it("bum is deep (a sine dropping below 150 Hz) and tak is high (band above 2 kHz), so they are easy to tell apart", () => {
    const { bum } = drumVoices(hit({ zone: 0 }));
    const { tak } = drumVoices(hit({ zone: 1 }));
    expect(bum!.endHz).toBeLessThan(100);
    expect(bum!.startHz).toBeGreaterThan(bum!.endHz);
    expect(bum!.startHz).toBeLessThan(250);
    expect(tak!.bandHz).toBeGreaterThan(2000);
    expect(bum!.decaySec).toBeGreaterThan(tak!.decaySec * 2);
  });

  it("moving from the centre to the rim fades bum out and tak in, smoothly", () => {
    let prevBum = Infinity;
    let prevTak = -Infinity;
    for (let z = 0; z <= 1.0001; z += 0.1) {
      const v = drumVoices(hit({ zone: z }));
      const b = v.bum?.gain ?? 0;
      const t = v.tak?.gain ?? 0;
      expect(b).toBeLessThanOrEqual(prevBum + 1e-9);
      expect(t).toBeGreaterThanOrEqual(prevTak - 1e-9);
      prevBum = b;
      prevTak = t;
    }
  });
});

describe("drumVoices: loudness and jingles", () => {
  it("harder hits are louder and drop further in pitch", () => {
    const soft = drumVoices(hit({ velocity: 0.3 })).bum!;
    const hard = drumVoices(hit({ velocity: 1 })).bum!;
    expect(hard.gain).toBeGreaterThan(soft.gain * 2);
    expect(hard.startHz).toBeGreaterThan(soft.startHz);
    expect(hard.decaySec).toBeGreaterThan(soft.decaySec);
  });

  it("jingles only on hard hits", () => {
    expect(drumVoices(hit({ velocity: 0.4, zone: 0.6 })).zil).toBeNull();
    expect(drumVoices(hit({ velocity: 1, zone: 0.6 })).zil).not.toBeNull();
    expect(drumVoices(hit({ velocity: 1, zone: 0.6, soft: true })).zil).toBeNull();
  });

  it("a fingertip tap is quieter, shorter and higher than a palm hit at the same speed", () => {
    const palm = drumVoices(hit({ zone: 1, velocity: 0.7 })).tak!;
    const tap = drumVoices(hit({ zone: 1, velocity: 0.7, soft: true })).tak!;
    expect(tap.gain).toBeLessThan(palm.gain);
    expect(tap.decaySec).toBeLessThan(palm.decaySec);
    expect(tap.bandHz).toBeGreaterThan(palm.bandHz);
  });

  it("silence in gives no voices, and silly numbers do not give NaN", () => {
    expect(drumVoices(hit({ velocity: 0 }))).toEqual({ bum: null, tak: null, zil: null });
    const v = drumVoices(hit({ velocity: Number.NaN, zone: Number.NaN, bumHz: Number.NaN }));
    expect(v).toEqual({ bum: null, tak: null, zil: null });
    const w = drumVoices(hit({ velocity: 5, zone: -3, bumHz: 1e9 }));
    expect(Number.isFinite(w.bum!.gain)).toBe(true);
    expect(w.bum!.gain).toBeLessThanOrEqual(1);
    expect(w.bum!.startHz).toBeLessThan(1000);
  });
});
