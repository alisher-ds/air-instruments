import { describe, expect, it } from "vitest";
import { keyAt, layoutKeys, lowestMidi } from "./layout";

const W = 1280;
const H = 720;

describe("layoutKeys", () => {
  it("2 octaves from C4: 14 white + 10 black keys, 60..83, in the lower third", () => {
    const l = layoutKeys(W, H, 2, 4);
    expect(l.keys.filter((k) => !k.black)).toHaveLength(14);
    expect(l.keys.filter((k) => k.black)).toHaveLength(10);
    expect(Math.min(...l.keys.map((k) => k.midi))).toBe(60);
    expect(Math.max(...l.keys.map((k) => k.midi))).toBe(83);
    expect(l.top).toBeGreaterThan(H * 0.6);
    expect(l.bottom).toBeLessThan(H);
    expect(l.keys.find((k) => k.midi === 60)!.name).toBe("C4");
  });

  it("white keys tile the width without gaps; black keys sit on the boundaries and are shorter and narrower", () => {
    const l = layoutKeys(W, H, 2, 4);
    const whites = l.keys.filter((k) => !k.black);
    for (let i = 1; i < whites.length; i++) expect(whites[i]!.x).toBeCloseTo(whites[i - 1]!.x + whites[i - 1]!.w, 6);
    expect(whites[0]!.x).toBeGreaterThanOrEqual(0);
    const last = whites[whites.length - 1]!;
    expect(last.x + last.w).toBeLessThanOrEqual(W);
    const cSharp = l.keys.find((k) => k.midi === 61)!;
    const c = l.keys.find((k) => k.midi === 60)!;
    const d = l.keys.find((k) => k.midi === 62)!;
    expect(cSharp.black).toBe(true);
    expect(cSharp.x + cSharp.w / 2).toBeCloseTo(c.x + c.w, 6); // centred on the C|D boundary
    expect(cSharp.w).toBeLessThan(c.w);
    expect(cSharp.h).toBeLessThan(c.h);
    expect(d.black).toBe(false);
  });

  it("there is no black key between E and F or B and C", () => {
    const l = layoutKeys(W, H, 1, 4);
    expect(l.keys.some((k) => k.midi === 65 && k.black)).toBe(false); // F
    expect(l.keys.filter((k) => k.black).map((k) => k.midi)).toEqual([61, 63, 66, 68, 70]);
  });

  it("handles 1..3 octaves and any low octave, and clamps silly values", () => {
    expect(layoutKeys(W, H, 3, 3).keys).toHaveLength(36);
    expect(layoutKeys(W, H, 1, 5).keys).toHaveLength(12);
    expect(layoutKeys(W, H, 0, 4).keys.length).toBeGreaterThan(0);
    expect(lowestMidi(4)).toBe(60);
    expect(lowestMidi(2)).toBe(36);
  });
});

describe("keyAt", () => {
  const l = layoutKeys(W, H, 2, 4);
  const c = l.keys.find((k) => k.midi === 60)!;
  const cs = l.keys.find((k) => k.midi === 61)!;

  it("a fingertip over a white key finds it", () => {
    expect(keyAt({ x: c.x + c.w * 0.3, y: l.bottom - 10 }, l, 40)!.midi).toBe(60);
  });

  it("black keys win in their area, and the white key below them is reachable at the bottom", () => {
    expect(keyAt({ x: cs.x + cs.w / 2, y: l.top + 10 }, l, 40)!.midi).toBe(61);
    expect(keyAt({ x: cs.x + cs.w / 2, y: l.bottom - 10 }, l, 40)!.midi).not.toBe(61);
  });

  it("a fingertip a bit above the keys still counts (hovering), a long way above or below does not", () => {
    expect(keyAt({ x: c.x + 10, y: l.top - 30 }, l, 40)!.midi).toBe(60);
    expect(keyAt({ x: c.x + 10, y: l.top - 200 }, l, 40)).toBeNull();
    expect(keyAt({ x: c.x + 10, y: l.bottom + 200 }, l, 40)).toBeNull();
  });

  it("left of the first key or right of the last key: nothing", () => {
    expect(keyAt({ x: 2, y: l.top + 50 }, l, 40)).toBeNull();
    expect(keyAt({ x: W - 2, y: l.top + 50 }, l, 40)).toBeNull();
  });
});
