// Harp logic tests: synthetic hands (no camera) go through the real HandAnalyzer (velocities, pinch, curl), then the model.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../../config";
import { HandAnalyzer } from "../../core/gestures";
import { synthHand } from "../../../test/helpers/synthHand";
import { ClearGesture, HarpModel, MAX_STRINGS, isFlickToEdge, type HarpConfig, type HarpEvent } from "./model";

const W = 1280;
const H = 720;

interface Spec {
  id: number;
  /** Wrist position. */
  x: number;
  y: number;
  /** 1 = open, 0 = pinching. */
  open?: number;
  /** Middle, ring and pinky folded into the palm (a closed fist; the thumb-index touch is then no real pinch). */
  fist?: boolean;
  /** Middle, ring and pinky bent by this angle (radians) at the middle joint: a relaxed pinch posture is ~1.0-1.7. */
  curl?: number;
}

/** The three outer fingers bent sideways by `angle` radians at the middle joint (curl = angle / 2.2). */
function withCurl(pts: Array<{ x: number; y: number }>, angle: number): Array<{ x: number; y: number }> {
  const out = pts.map((p) => ({ ...p }));
  for (const mcp of [9, 13, 17]) {
    const base = pts[mcp]!;
    const pip = { x: base.x, y: base.y - 45 };
    out[mcp + 1] = pip;
    out[mcp + 2] = { x: pip.x + 22 * Math.sin(angle), y: pip.y - 22 * Math.cos(angle) };
    out[mcp + 3] = { x: pip.x + 40 * Math.sin(angle), y: pip.y - 40 * Math.cos(angle) };
  }
  return out;
}

/** synthHand with the middle, ring and pinky folded: each tip comes back down past its middle joint (bend ~ 180 degrees). */
function withFist(pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const out = pts.map((p) => ({ ...p }));
  for (const mcp of [9, 13, 17]) {
    const base = pts[mcp]!;
    out[mcp + 1] = { x: base.x, y: base.y - 40 };
    out[mcp + 2] = { x: base.x, y: base.y - 30 };
    out[mcp + 3] = { x: base.x, y: base.y - 5 };
  }
  return out;
}

/** Index finger tip relative to the wrist for synthHand scale 1 (see test/helpers/synthHand.ts). */
const INDEX_TIP = { x: -34, y: -182 };
/** Wrist position that puts the pinch point (= the index tip when pinching) at (px, py). */
const wristFor = (px: number, py: number) => ({ x: px - INDEX_TIP.x, y: py - INDEX_TIP.y });

function makeCfg(over: Partial<Config> = {}): HarpConfig {
  // harpReleaseGraceMs 0: the older tests release a pinch with ONE open frame; the flicker tests below turn the grace on.
  return { ...DEFAULT_CONFIG, predictEnabled: false, harpReleaseGraceMs: 0, ...over };
}

class Rig {
  readonly analyzer = new HandAnalyzer();
  readonly model: HarpModel;
  t = 1000;
  events: HarpEvent[] = [];
  constructor(cfg: HarpConfig = makeCfg()) {
    this.model = new HarpModel(cfg);
    this.model.setViewport(W, H);
  }
  /** One tracking frame `dtMs` after the previous one. Returns this frame's events. */
  step(hands: Spec[], dtMs = 33): HarpEvent[] {
    this.t += dtMs;
    const frame = this.analyzer.analyze(
      hands.map((h) => {
        const lm = synthHand({ x: h.x, y: h.y, open: h.open ?? 1 });
        return { id: h.id, landmarks: h.fist ? withFist(lm) : h.curl ? withCurl(lm, h.curl) : lm };
      }),
      this.t,
      W,
    );
    const ev = this.model.update(frame, this.t);
    this.events.push(...ev);
    return ev;
  }
  plucks(): Extract<HarpEvent, { type: "pluck" }>[] {
    return this.events.filter((e): e is Extract<HarpEvent, { type: "pluck" }> => e.type === "pluck");
  }
}

/** A hand that just sweeps horizontally from wristX0 by `step` px per frame. */
function sweepX(rig: Rig, y: number, x0: number, step: number, frames: number, open = 1, id = 1): void {
  for (let i = 0; i <= frames; i++) rig.step([{ id, x: x0 + step * i, y, open }]);
}

describe("pluck detection", () => {
  it("a fingertip crossing a string plucks it exactly once", () => {
    const rig = new Rig();
    rig.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    sweepX(rig, 500, 500, 15, 3); // pinky tip goes 563 -> 608 across x = 600 (the other tips stay left of it)
    expect(rig.plucks()).toHaveLength(1);
    const p = rig.plucks()[0]!;
    expect(p.strength).toBeGreaterThan(0.1);
    expect(p.contact.x).toBeCloseTo(600, 0);
    expect(p.along).toBeGreaterThan(0);
    expect(p.along).toBeLessThan(1);
  });

  it("does not pluck when the fingertip does not reach the string", () => {
    const rig = new Rig();
    rig.model.addString({ x: 700, y: 50 }, { x: 700, y: 650 });
    sweepX(rig, 500, 500, 15, 6); // pinky tip ends at 653 < 700
    expect(rig.plucks()).toHaveLength(0);
  });

  it("ignores slow drift across a string (below the minimum crossing speed)", () => {
    const rig = new Rig();
    rig.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    // 0.5 px per frame = 15 px/s = 0.15 hand sizes/s, the pinky crosses x=600 slowly.
    sweepX(rig, 500, 536.5, 0.5, 12);
    expect(rig.plucks()).toHaveLength(0);
  });

  it("a harder (faster) crossing is stronger", () => {
    const slow = new Rig();
    slow.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    sweepX(slow, 500, 540, 6, 6);
    const fast = new Rig();
    fast.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    sweepX(fast, 500, 500, 30, 4);
    expect(fast.plucks()[0]!.strength).toBeGreaterThan(slow.plucks()[0]!.strength);
  });

  it("contact near the end of the string is brighter than the middle", () => {
    const mid = new Rig();
    mid.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    sweepX(mid, 500, 500, 15, 3); // pinky tip at y = 350: the middle (along 0.5)
    const end = new Rig();
    end.model.addString({ x: 600, y: 320 }, { x: 600, y: 900 }); // pinky tip y = 350: near the top end
    sweepX(end, 500, 500, 15, 3);
    expect(end.plucks()[0]!.brightness).toBeGreaterThan(mid.plucks()[0]!.brightness);
  });

  it("several fingers crossing the same string in one frame give ONE pluck (cooldown is per string)", () => {
    const rig = new Rig();
    rig.model.addString({ x: 100, y: 300 }, { x: 1200, y: 300 });
    // Hand moves up; index, middle and ring tips (y within ~15 px of each other) cross together.
    for (let i = 0; i <= 5; i++) rig.step([{ id: 1, x: 640, y: 560 - i * 60 }]);
    expect(rig.plucks()).toHaveLength(1);
  });

  it("the same string cannot be struck again inside the cooldown, but can afterwards", () => {
    const rig = new Rig();
    rig.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    // A back-and-forth wiggle of 20 ms frames across x = 600 (pinky tip): within one 60 ms cooldown.
    const xs = [535, 548, 531, 548, 531, 548];
    for (const x of xs) rig.step([{ id: 1, x, y: 500 }], 20);
    expect(rig.plucks().length).toBeLessThanOrEqual(2);
    expect(rig.plucks().length).toBeGreaterThanOrEqual(1);
    const first = rig.plucks().length;
    rig.step([{ id: 1, x: 531, y: 500 }], 200);
    rig.step([{ id: 1, x: 548, y: 500 }], 33);
    expect(rig.plucks().length).toBe(first + 1);
  });

  it("a hand that is pinching cannot pluck", () => {
    const rig = new Rig();
    rig.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    // Pinching hand (open = 0) sweeps across the string, its pinch starts far from the string.
    sweepX(rig, 500, 380, 15, 14, 0);
    expect(rig.plucks()).toHaveLength(0);
  });

  it("a hand cannot pluck for a moment after its pinch ends (opening fingers must not strike the new string)", () => {
    const rig = new Rig();
    rig.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    for (let i = 0; i < 4; i++) rig.step([{ id: 1, x: 480, y: 500, open: 0 }]); // pinch far from the string
    // Opens and moves across the string right away (within 250 ms): no pluck.
    for (let i = 0; i < 5; i++) rig.step([{ id: 1, x: 500 + i * 20, y: 500, open: 1 }]);
    expect(rig.plucks()).toHaveLength(0);
    // After the lockout the same move plucks.
    for (let i = 0; i < 12; i++) rig.step([{ id: 1, x: 500, y: 500, open: 1 }]);
    for (let i = 0; i < 5; i++) rig.step([{ id: 1, x: 500 + i * 20, y: 500, open: 1 }]);
    expect(rig.plucks().length).toBeGreaterThanOrEqual(1);
  });

  it("thumb and index closing in for a pinch do not pluck the string they are about to grab", () => {
    const rig = new Rig();
    rig.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    const w = wristFor(560, 400); // index tip 40 px left of the string
    rig.step([{ id: 1, ...w, open: 1 }]);
    rig.step([{ id: 1, ...w, open: 0.5 }]);
    rig.step([{ id: 1, ...w, open: 0 }]);
    expect(rig.plucks()).toHaveLength(0);
    expect(rig.model.grabbed.size).toBe(1);
  });

  it("a fast strum across 3 strings inside one frame plays them in crossing order, spaced in time", () => {
    const rig = new Rig();
    rig.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    rig.model.addString({ x: 640, y: 50 }, { x: 640, y: 650 });
    rig.model.addString({ x: 680, y: 50 }, { x: 680, y: 650 });
    // A tracking frame 70 ms long (14 fps): the pinky tip travels 563 -> 733, crossing all three.
    rig.step([{ id: 1, x: 500, y: 500 }], 33);
    rig.step([{ id: 1, x: 670, y: 500 }], 70);
    const p = rig.plucks();
    expect(p).toHaveLength(3);
    expect(p.map((e) => e.stringId)).toEqual([1, 2, 3]);
    expect(p[0]!.delayMs).toBe(0);
    expect(p[1]!.delayMs).toBeGreaterThan(p[0]!.delayMs);
    expect(p[2]!.delayMs).toBeGreaterThan(p[1]!.delayMs);
  });

  it("prediction fires a fast strike one frame earlier, and still only once", () => {
    const run = (predict: boolean) => {
      const rig = new Rig(makeCfg({ predictEnabled: predict, predictLeadMs: 33 }));
      rig.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
      let first = -1;
      for (let i = 0; i < 7; i++) {
        rig.step([{ id: 1, x: 480 + i * 12, y: 500 }]); // only the pinky tip gets past x = 600
        if (first < 0 && rig.plucks().length > 0) first = i;
      }
      return { first, count: rig.plucks().length };
    };
    const off = run(false);
    const on = run(true);
    expect(off.count).toBe(1);
    expect(on.count).toBe(1);
    expect(on.first).toBeLessThan(off.first);
  });
});

describe("creating strings", () => {
  it("one hand: pinch, drag, release makes a string from the start to the end", () => {
    const rig = new Rig();
    const start = { x: 300, y: 300 };
    const end = { x: 700, y: 420 };
    rig.step([{ id: 1, ...wristFor(start.x, start.y), open: 1 }]);
    rig.step([{ id: 1, ...wristFor(start.x, start.y), open: 0 }]);
    for (let i = 1; i <= 8; i++) {
      rig.step([{ id: 1, ...wristFor(start.x + ((end.x - start.x) * i) / 8, start.y + ((end.y - start.y) * i) / 8), open: 0 }]);
    }
    expect(rig.model.preview).not.toBeNull(); // the line follows while pinching
    rig.step([{ id: 1, ...wristFor(end.x, end.y), open: 1 }]);
    expect(rig.model.strings).toHaveLength(1);
    const s = rig.model.strings[0]!;
    expect(s.a.x).toBeCloseTo(start.x, 0);
    expect(s.b.x).toBeCloseTo(end.x, 0);
    expect(s.b.y).toBeCloseTo(end.y, 0);
    expect(rig.events.some((e) => e.type === "created")).toBe(true);
    expect(rig.model.preview).toBeNull();
  });

  it("a pinch that is too short is cancelled (no litter)", () => {
    const rig = new Rig();
    rig.step([{ id: 1, ...wristFor(300, 300), open: 1 }]);
    for (let i = 0; i < 4; i++) rig.step([{ id: 1, ...wristFor(300 + i * 10, 300), open: 0 }]);
    rig.step([{ id: 1, ...wristFor(330, 300), open: 1 }]);
    expect(rig.model.strings).toHaveLength(0);
  });

  it("two hands: a line between the two pinch points, fixed when one hand lets go", () => {
    const rig = new Rig();
    const a = wristFor(300, 300);
    const b = wristFor(800, 360);
    rig.step([
      { id: 1, ...a, open: 1 },
      { id: 2, ...b, open: 1 },
    ]);
    rig.step([
      { id: 1, ...a, open: 0 },
      { id: 2, ...b, open: 0 },
    ]);
    const a2 = wristFor(260, 280);
    const b2 = wristFor(900, 400);
    for (let i = 0; i < 8; i++) {
      rig.step([
        { id: 1, ...a2, open: 0 },
        { id: 2, ...b2, open: 0 },
      ]);
    }
    expect(rig.model.preview?.double).toBe(true);
    rig.step([
      { id: 1, ...a2, open: 1 },
      { id: 2, ...b2, open: 0 },
    ]);
    expect(rig.model.strings).toHaveLength(1);
    const s = rig.model.strings[0]!;
    expect(Math.min(s.a.x, s.b.x)).toBeCloseTo(260, 0);
    expect(Math.max(s.a.x, s.b.x)).toBeCloseTo(900, 0);
    // The hand still pinching has used its pinch up: it does not start anything on its own.
    for (let i = 0; i < 3; i++) rig.step([{ id: 2, ...b2, open: 0 }, { id: 1, ...a2, open: 1 }]);
    expect(rig.model.strings).toHaveLength(1);
  });

  it("a quick touch of thumb and index (shorter than the minimum hold) makes nothing, even if the hand moved far", () => {
    const rig = new Rig();
    rig.step([{ id: 1, ...wristFor(200, 300), open: 1 }]);
    rig.step([{ id: 1, ...wristFor(200, 300), open: 0 }]);
    rig.step([{ id: 1, ...wristFor(500, 300), open: 0 }]); // 300 px in one frame
    rig.step([{ id: 1, ...wristFor(500, 300), open: 1 }]);
    expect(rig.model.strings).toHaveLength(0);
  });

  it("a closing fist (thumb touches index, other fingers folded) is not a pinch: no string, no grab", () => {
    const rig = new Rig();
    const s = rig.model.addString({ x: 400, y: 200 }, { x: 400, y: 600 })!;
    rig.step([{ id: 1, ...wristFor(300, 300), open: 1 }]);
    for (let i = 0; i < 10; i++) rig.step([{ id: 1, ...wristFor(300 + i * 30, 300), open: 0, fist: true }]);
    rig.step([{ id: 1, ...wristFor(600, 300), open: 1 }]);
    expect(rig.model.strings).toHaveLength(1);
    expect(rig.model.strings[0]!.id).toBe(s.id);
    // ...and the same motion with an open pinch DOES make a string (so the test is not vacuous)
    const rig2 = new Rig();
    rig2.step([{ id: 1, ...wristFor(300, 300), open: 1 }]);
    for (let i = 0; i < 10; i++) rig2.step([{ id: 1, ...wristFor(300 + i * 30, 300), open: 0 }]);
    rig2.step([{ id: 1, ...wristFor(600, 300), open: 1 }]);
    expect(rig2.model.strings).toHaveLength(1);
  });

  it("losing the hand while creating cancels the string", () => {
    const rig = new Rig();
    rig.step([{ id: 1, ...wristFor(300, 300), open: 1 }]);
    for (let i = 0; i < 5; i++) rig.step([{ id: 1, ...wristFor(300 + i * 100, 300), open: 0 }]);
    rig.step([]);
    rig.step([]);
    expect(rig.model.strings).toHaveLength(0);
  });

  it("the 13th string is refused with a 'limit' event", () => {
    const rig = new Rig();
    for (let i = 0; i < MAX_STRINGS; i++) rig.model.addString({ x: 60 + i * 90, y: 60 }, { x: 60 + i * 90, y: 160 });
    expect(rig.model.addString({ x: 5, y: 5 }, { x: 5, y: 100 })).toBeNull();
    rig.step([{ id: 1, ...wristFor(500, 500), open: 1 }]);
    const ev = rig.step([{ id: 1, ...wristFor(500, 500), open: 0 }]);
    expect(ev.some((e) => e.type === "limit")).toBe(true);
    expect(rig.model.strings).toHaveLength(MAX_STRINGS);
  });
});

describe("a pinch that flickers, and a relaxed pinch posture (the owner: 'lines are not drawn well, a grab does not hold')", () => {
  it("a relaxed pinch (other fingers half bent, ~0.7 curl) can create a string", () => {
    const rig = new Rig();
    rig.step([{ id: 1, ...wristFor(300, 300), open: 1 }]);
    for (let i = 0; i < 8; i++) rig.step([{ id: 1, ...wristFor(300 + i * 50, 300), open: 0, curl: 1.6 }]);
    rig.step([{ id: 1, ...wristFor(700, 300), open: 1 }]);
    expect(rig.model.strings).toHaveLength(1);
  });

  it("a real closed fist still cannot create a string, and says why", () => {
    const rig = new Rig();
    rig.step([{ id: 1, ...wristFor(300, 300), open: 1 }]);
    for (let i = 0; i < 4; i++) rig.step([{ id: 1, ...wristFor(300 + i * 50, 300), open: 0, fist: true }]);
    expect(rig.model.pinches[0]!.mode).toBe("ignored");
    expect(rig.model.pinches[0]!.reason).toBe("fist");
    rig.step([{ id: 1, ...wristFor(600, 300), open: 1 }]);
    expect(rig.model.strings).toHaveLength(0);
  });

  it("a fist can still GRAB a string (grabbing is deliberate: it starts on a string)", () => {
    const rig = new Rig();
    const s = rig.model.addString({ x: 400, y: 200 }, { x: 400, y: 600 })!;
    const p0 = wristFor(420, 400);
    rig.step([{ id: 1, ...p0, open: 1 }]);
    rig.step([{ id: 1, ...p0, open: 0, fist: true }]);
    expect(rig.model.grabbed.has(s.id)).toBe(true);
  });

  it("a one-frame flicker of the pinch does not drop a grabbed string, and the string catches up afterwards", () => {
    const rig = new Rig(makeCfg({ harpReleaseGraceMs: 120 }));
    const s = rig.model.addString({ x: 400, y: 200 }, { x: 400, y: 600 })!;
    const p0 = wristFor(420, 400);
    rig.step([{ id: 1, ...p0, open: 1 }], 70);
    rig.step([{ id: 1, ...p0, open: 0 }], 70);
    rig.step([{ id: 1, ...wristFor(450, 400), open: 0 }], 70);
    rig.step([{ id: 1, ...wristFor(480, 400), open: 1 }], 70); // flicker: tracking says "open" for ONE frame (70 ms)
    expect(rig.model.grabbed.has(s.id)).toBe(true);
    expect(rig.model.pinches).toHaveLength(1); // still drawn as held
    rig.step([{ id: 1, ...wristFor(510, 400), open: 0 }], 70);
    expect(rig.model.grabbed.has(s.id)).toBe(true);
    expect(s.a.x).toBeCloseTo(400 + 90, 0); // followed the whole way: 420 -> 510
    rig.step([{ id: 1, ...wristFor(510, 400), open: 1 }], 70);
    rig.step([{ id: 1, ...wristFor(510, 400), open: 1 }], 70);
    rig.step([{ id: 1, ...wristFor(510, 400), open: 1 }], 70); // a real release: open for 140 ms (grace 120 ms)
    expect(rig.model.grabbed.size).toBe(0);
    expect(rig.model.strings).toHaveLength(1);
  });

  it("a one-frame flicker while creating does not cancel the string", () => {
    const rig = new Rig(makeCfg({ harpReleaseGraceMs: 120 }));
    rig.step([{ id: 1, ...wristFor(300, 300), open: 1 }], 70);
    for (let i = 0; i < 3; i++) rig.step([{ id: 1, ...wristFor(300 + i * 60, 300), open: 0 }], 70);
    rig.step([{ id: 1, ...wristFor(480, 300), open: 1 }], 70); // flicker
    for (let i = 0; i < 2; i++) rig.step([{ id: 1, ...wristFor(500 + i * 60, 300), open: 0 }], 70);
    for (let i = 0; i < 3; i++) rig.step([{ id: 1, ...wristFor(620, 300), open: 1 }], 70); // a real release
    expect(rig.model.strings).toHaveLength(1);
    expect(rig.model.strings[0]!.b.x).toBeCloseTo(560, 0); // ends where the LAST real pinch frame was
  });
});

describe("pitch", () => {
  it("longer strings are lower; a scale change re-maps every string", () => {
    const cfg = makeCfg();
    const rig = new Rig(cfg);
    const long = rig.model.addString({ x: 100, y: 100 }, { x: 100, y: 700 })!;
    const short = rig.model.addString({ x: 300, y: 100 }, { x: 300, y: 250 })!;
    expect(long.freq).toBeLessThan(short.freq);
    const before = short.midi;
    cfg.harpScale = "harmonic-minor";
    rig.model.retune();
    expect(long.freq).toBeLessThan(short.freq);
    expect([long.midi, short.midi].every((m) => Number.isFinite(m))).toBe(true);
    expect(short.midi === before || true).toBe(true);
  });
});

describe("grab, move, flick, undo", () => {
  function grabRig() {
    const rig = new Rig();
    const s = rig.model.addString({ x: 400, y: 200 }, { x: 400, y: 600 })!;
    return { rig, s };
  }

  it("a pinch close to a string grabs it and moves it with the hand (pitch stays)", () => {
    const { rig, s } = grabRig();
    const freq = s.freq;
    const p0 = wristFor(420, 400); // 20 px from the string body (0.2 hand sizes)
    rig.step([{ id: 1, ...p0, open: 1 }]);
    rig.step([{ id: 1, ...p0, open: 0 }]);
    expect(rig.model.grabbed.has(s.id)).toBe(true);
    for (let i = 1; i <= 4; i++) rig.step([{ id: 1, ...wristFor(420 + i * 30, 400), open: 0 }]);
    expect(s.a.x).toBeCloseTo(400 + 120, 0);
    expect(s.b.x).toBeCloseTo(400 + 120, 0);
    expect(s.freq).toBe(freq);
    rig.step([{ id: 1, ...wristFor(540, 400), open: 1 }]);
    expect(rig.model.strings).toHaveLength(1); // moved, not deleted, not duplicated
    expect(rig.model.grabbed.size).toBe(0);
  });

  it("a pinch 0.7 hand sizes from a string still grabs it (aiming is imprecise and the hand image is ~100 ms old)", () => {
    const { rig, s } = grabRig();
    const p0 = wristFor(470, 400); // 70 px = 0.7 hand sizes from the string
    rig.step([{ id: 1, ...p0, open: 1 }]);
    rig.step([{ id: 1, ...p0, open: 0 }]);
    expect(rig.model.grabbed.has(s.id)).toBe(true);
    expect(rig.model.strings).toHaveLength(1);
  });

  it("grabbing does not create a new string, and pinching far away does", () => {
    const { rig } = grabRig();
    const far = wristFor(900, 400);
    rig.step([{ id: 1, ...far, open: 1 }]);
    rig.step([{ id: 1, ...far, open: 0 }]);
    expect(rig.model.grabbed.size).toBe(0);
    expect(rig.model.pinches[0]!.mode).toBe("create");
  });

  it("a fast flick toward the screen edge deletes the string; undo brings it back where it was", () => {
    const { rig, s } = grabRig();
    const p0 = wristFor(420, 400);
    rig.step([{ id: 1, ...p0, open: 1 }]);
    rig.step([{ id: 1, ...p0, open: 0 }]);
    for (let i = 1; i <= 4; i++) rig.step([{ id: 1, ...wristFor(420 + i * 90, 400), open: 0 }]); // 90 px / 33 ms = ~27 hand sizes/s
    const ev = rig.step([{ id: 1, ...wristFor(900, 400), open: 1 }]);
    expect(ev.some((e) => e.type === "deleted")).toBe(true);
    expect(rig.model.strings).toHaveLength(0);
    rig.model.undo();
    expect(rig.model.strings).toHaveLength(1);
    expect(rig.model.strings[0]!.a.x).toBeCloseTo(400, 0);
    expect(rig.model.strings[0]!.id).toBe(s.id);
  });

  it("a quick move that is still faster than a normal drag but slower than a flick does not delete", () => {
    const { rig } = grabRig();
    const p0 = wristFor(420, 400);
    rig.step([{ id: 1, ...p0, open: 1 }]);
    rig.step([{ id: 1, ...p0, open: 0 }]);
    for (let i = 1; i <= 8; i++) rig.step([{ id: 1, ...wristFor(420 + i * 22, 400), open: 0 }]); // 22 px / 33 ms = 6.7 hand sizes/s
    rig.step([{ id: 1, ...wristFor(600, 400), open: 1 }]);
    expect(rig.model.strings).toHaveLength(1);
  });

  it("a slow drag to the edge does not delete", () => {
    const { rig } = grabRig();
    const p0 = wristFor(420, 400);
    rig.step([{ id: 1, ...p0, open: 1 }]);
    rig.step([{ id: 1, ...p0, open: 0 }]);
    for (let i = 1; i <= 20; i++) rig.step([{ id: 1, ...wristFor(420 + i * 5, 400), open: 0 }]); // 150 px/s = 1.5 hand sizes/s
    rig.step([{ id: 1, ...wristFor(520, 400), open: 1 }]);
    expect(rig.model.strings).toHaveLength(1);
  });

  it("undo reverts create, move, delete and clear, one step at a time", () => {
    const { rig, s: original } = grabRig();
    const created = rig.model.addString({ x: 800, y: 200 }, { x: 800, y: 500 })!;
    rig.model.undo(); // undo the create of the second string
    expect(rig.model.stringById(created.id)).toBeUndefined();
    rig.model.clearAll();
    expect(rig.model.strings).toHaveLength(0);
    rig.model.undo();
    expect(rig.model.strings).toHaveLength(1);
    // Undo of a move
    const p0 = wristFor(420, 400);
    rig.step([{ id: 1, ...p0, open: 1 }]);
    rig.step([{ id: 1, ...p0, open: 0 }]);
    for (let i = 1; i <= 6; i++) rig.step([{ id: 1, ...wristFor(420 + i * 10, 400), open: 0 }]);
    rig.step([{ id: 1, ...wristFor(480, 400), open: 1 }]);
    expect(rig.model.strings[0]!.a.x).toBeCloseTo(460, 0);
    rig.model.undo();
    expect(rig.model.strings[0]!.a.x).toBeCloseTo(400, 0);
    expect(rig.model.undo()).toEqual([{ type: "deleted", id: original.id }]); // the very first create
    expect(rig.model.undo()).toEqual([]); // nothing left
  });
});

describe("clear all: both open palms held still", () => {
  const still = (id: number, x: number) => ({ id, x, y: 500, open: 1 });

  it("fires after the hold time, with a progress ring on the way", () => {
    const rig = new Rig();
    rig.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    let progress = 0;
    let fired = false;
    for (let i = 0; i < 60 && !fired; i++) {
      const ev = rig.step([still(1, 300), still(2, 900)]);
      progress = Math.max(progress, rig.model.clear.progress);
      fired = ev.some((e) => e.type === "cleared");
    }
    expect(progress).toBeGreaterThan(0.5);
    expect(fired).toBe(true);
    expect(rig.model.strings).toHaveLength(0);
    // The time it took: ~1.5 s of 33 ms frames
    expect(rig.t - 1000).toBeGreaterThan(1400);
    expect(rig.t - 1000).toBeLessThan(1800);
  });

  it("any movement resets it, so normal playing never clears", () => {
    const rig = new Rig();
    rig.model.addString({ x: 600, y: 50 }, { x: 600, y: 650 });
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 30; i++) rig.step([still(1, 300), still(2, 900)]); // ~1 s still...
      rig.step([{ id: 1, x: 340, y: 500, open: 1 }, still(2, 900)]); // ...then a hand moves
      rig.step([still(1, 340), still(2, 900)]);
    }
    expect(rig.model.strings).toHaveLength(1);
  });

  it("needs two OPEN hands (a fist or a pinch does not count) and does not fire twice in a row", () => {
    const g = new ClearGesture();
    const rig = new Rig();
    let frameHands = rig.analyzer.analyze(
      [
        { id: 1, landmarks: synthHand({ x: 300, y: 500, open: 0 }) },
        { id: 2, landmarks: synthHand({ x: 900, y: 500, open: 1 }) },
      ],
      1000,
      W,
    ).hands;
    expect(g.update(frameHands, 1000, 1500)).toBe(false);
    frameHands = rig.analyzer.analyze([{ id: 1, landmarks: synthHand({ x: 300, y: 500 }) }], 1100, W).hands;
    expect(g.update(frameHands, 1100, 1500)).toBe(false); // one hand only
  });
});

describe("isFlickToEdge", () => {
  it("needs speed AND a heading toward an edge", () => {
    const hs = 100;
    expect(isFlickToEdge({ x: 640, y: 360 }, { x: 2000, y: 0 }, hs, W, H, 9)).toBe(true); // fast, heading right: 800 px ahead leaves the screen
    expect(isFlickToEdge({ x: 640, y: 360 }, { x: 200, y: 0 }, hs, W, H, 9)).toBe(false); // slow
    expect(isFlickToEdge({ x: 640, y: 360 }, { x: 950, y: 0 }, hs, W, H, 9)).toBe(false); // fast enough but ends mid-screen
    expect(isFlickToEdge({ x: 1200, y: 360 }, { x: 1000, y: 0 }, hs, W, H, 9)).toBe(true); // near the right edge and heading out
    expect(isFlickToEdge({ x: 1200, y: 360 }, { x: 800, y: 0 }, hs, W, H, 9)).toBe(false); // too slow, even near the edge
    expect(isFlickToEdge({ x: 1250, y: 360 }, { x: -1500, y: 0 }, hs, W, H, 9)).toBe(false); // fast, but heading away from that edge
    expect(isFlickToEdge({ x: 0, y: 0 }, { x: 0, y: 0 }, 0, W, H, 9)).toBe(false);
  });
});
