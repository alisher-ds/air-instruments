// Air piano logic tests. Fingers are bent in synthetic hands and the frames go through the REAL tracking pipeline
// (HandPipeline: One Euro smoothing, velocities, curl), because smoothing blurs fast finger motion (found in Stage 3).
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../../config";
import { HandPipeline } from "../../core/tracking";
import { synthHand } from "../../../test/helpers/synthHand";
import { layoutKeys } from "./layout";
import { PianoModel, fingerFlex, pressProgress, pressVelocity, type PianoConfig, type PianoEvent } from "./model";

const W = 1280;
const H = 720;
const DT = 33;

/** Landmark indices of the fingers: thumb 1-4, index 5-8, middle 9-12, ring 13-16, pinky 17-20. */
const MCP = [1, 5, 9, 13, 17];

/**
 * synthHand with finger `k` (0 thumb .. 4 pinky) bent by `angle` radians at its middle joint: the part from the middle joint
 * to the tip turns by `angle` (curl = angle / 2.2) and the tip comes down along the way.
 */
function bendFinger(pts: Array<{ x: number; y: number }>, k: number, angle: number): void {
  if (angle <= 0) return;
  const m = MCP[k]!;
  // the thumb bends at its IP joint (3) and has no DIP; the other fingers bend at the PIP joint (m + 1)
  const joint = k === 0 ? 3 : m + 1;
  const tipIdx = k === 0 ? 4 : m + 3;
  const pip = pts[joint]!;
  const tip = pts[tipIdx]!;
  const L = Math.hypot(tip.x - pip.x, tip.y - pip.y);
  const dir = { x: Math.sin(angle), y: -Math.cos(angle) };
  if (k !== 0) pts[m + 2] = { x: pip.x + dir.x * L * 0.55, y: pip.y + dir.y * L * 0.55 };
  pts[tipIdx] = { x: pip.x + dir.x * L, y: pip.y + dir.y * L };
}

/** The finger gets SHORTER in the picture (bending toward the camera): the joints and the tip move toward the knuckle, the joint angle stays 0. */
function shortenFinger(pts: Array<{ x: number; y: number }>, k: number, amount: number): void {
  if (amount <= 0) return;
  const m = MCP[k]!;
  const base = k === 0 ? pts[2]! : pts[m]!;
  for (const i of k === 0 ? [3, 4] : [m + 1, m + 2, m + 3]) {
    const p = pts[i]!;
    pts[i] = { x: base.x + (p.x - base.x) * (1 - amount), y: base.y + (p.y - base.y) * (1 - amount) };
  }
}

interface HandSpec {
  id?: number;
  /** Wrist position. */
  x: number;
  y: number;
  /** Bend angles per finger (thumb..pinky), radians. */
  bend?: number[];
  /** Per finger: how much shorter it looks (0..1), without any joint-angle change. */
  shorten?: number[];
  open?: number;
}

function makeCfg(over: Partial<Config> = {}): PianoConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

class Rig {
  readonly pipe = new HandPipeline();
  readonly model: PianoModel;
  t = 1000;
  events: PianoEvent[] = [];
  constructor(cfg: PianoConfig = makeCfg()) {
    this.pipe.setViewport(W, H);
    this.pipe.setVideoSize(W, H);
    this.model = new PianoModel(cfg);
    this.model.setViewport(W, H);
  }
  /** One tracking frame with one or two hands. Hand ids come from the pipeline (matching by wrist position). */
  step(hands: HandSpec[], dtMs = DT): PianoEvent[] {
    this.t += dtMs;
    const det = hands.map((h) => {
      const lm = synthHand({ x: h.x, y: h.y, open: h.open ?? 1 });
      (h.bend ?? []).forEach((a, k) => bendFinger(lm, k, a));
      (h.shorten ?? []).forEach((a, k) => shortenFinger(lm, k, a));
      return lm.map((p) => ({ x: 1 - p.x / W, y: p.y / H }));
    });
    const frame = this.pipe.process(det, this.t);
    const ev = this.model.update(frame, this.t);
    this.events.push(...ev);
    return ev;
  }
  ons() {
    return this.events.filter((e): e is Extract<PianoEvent, { type: "on" }> => e.type === "on");
  }
  offs() {
    return this.events.filter((e): e is Extract<PianoEvent, { type: "off" }> => e.type === "off");
  }
}

/** Wrist y that puts the INDEX tip (straight: wrist + (-34, -182)) at tipY. */
const wristY = (tipY: number) => tipY + 182;
const KEY_Y = 540; // inside the white keys (0.66 H = 475 .. 0.92 H = 662)
const WX = 560; // over the middle of the keyboard

const hold = (rig: Rig, spec: HandSpec, frames: number) => {
  for (let i = 0; i < frames; i++) rig.step([spec]);
};
/** Bend finger k from 0 to `to` over `frames` frames, then hold it for `holdFrames`, then straighten over `frames`. */
function pressAndRelease(rig: Rig, base: HandSpec, k: number, to: number, frames: number, holdFrames = 4) {
  const bendAt = (a: number) => {
    const b = [0, 0, 0, 0, 0];
    b[k] = a;
    return { ...base, bend: b };
  };
  for (let i = 1; i <= frames; i++) rig.step([bendAt((to * i) / frames)]);
  for (let i = 0; i < holdFrames; i++) rig.step([bendAt(to)]);
  for (let i = frames - 1; i >= 0; i--) rig.step([bendAt((to * i) / frames)]);
}

describe("pressVelocity", () => {
  it("is 0.2..1, louder for faster presses", () => {
    expect(pressVelocity(1.5, 1, 0.4, 1.5, 7)).toBeGreaterThanOrEqual(0.2);
    expect(pressVelocity(7, 3, 1, 1.5, 7)).toBeCloseTo(1);
    expect(pressVelocity(3, 1, 0.4, 1.5, 7)).toBeCloseTo(pressVelocity(3, 0, 0, 1.5, 7), 5); // the loudest of the measures wins
    expect(pressVelocity(0, 7, 0, 1.5, 7)).toBeCloseTo(1); // a fast curl alone is a loud press
    expect(pressVelocity(0, 0, 3, 1.5, 7)).toBeCloseTo(1); // so is a fast shortening
    expect(pressVelocity(5, 3, 0.4, 1.5, 7)).toBeGreaterThan(pressVelocity(2.5, 3, 0.4, 1.5, 7));
    expect(pressVelocity(100, 99, 99, 1.5, 7)).toBeLessThanOrEqual(1);
  });
});

describe("flex: what a webcam really sees when a finger bends toward it", () => {
  it("fingerFlex is ~0 for a straight finger and grows when the finger looks shorter", () => {
    const rig = new Rig();
    rig.step([{ x: WX, y: wristY(KEY_Y) }]);
    const straight = rig.pipe.process([[...synthHand({ x: WX, y: wristY(KEY_Y) })].map((p) => ({ x: 1 - p.x / W, y: p.y / H }))], rig.t + 33).hands[0]!;
    const lm = synthHand({ x: WX, y: wristY(KEY_Y) });
    shortenFinger(lm, 1, 0.3);
    const rig2 = new Rig();
    rig2.step([{ x: WX, y: wristY(KEY_Y), shorten: [0, 0.3, 0, 0, 0] }]);
    const shortHand = rig2.pipe.process([lm.map((p) => ({ x: 1 - p.x / W, y: p.y / H }))], rig2.t + 33).hands[0]!;
    expect(fingerFlex(straight, 1)).toBeLessThan(0.15);
    expect(fingerFlex(shortHand, 1)).toBeGreaterThan(fingerFlex(straight, 1) + 0.15);
  });

  it("a finger that only gets SHORTER (joint angle unchanged) still plays the key: the common real-life press", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
    hold(rig, base, 8);
    for (let i = 1; i <= 3; i++) rig.step([{ ...base, shorten: [0, (0.3 * i) / 3, 0, 0, 0] }]);
    for (let i = 0; i < 4; i++) rig.step([{ ...base, shorten: [0, 0.3, 0, 0, 0] }]);
    expect(rig.ons()).toHaveLength(1);
    expect(rig.ons()[0]!.flexRise).toBeGreaterThan(rig.ons()[0]!.curlRise);
    for (let i = 2; i >= 0; i--) rig.step([{ ...base, shorten: [0, (0.3 * i) / 3, 0, 0, 0] }]);
    expect(rig.offs()).toHaveLength(1);
  });

  it("the play key is the key where the finger RESTED, not the neighbour it drifts into while bending", () => {
    const rig = new Rig();
    const l = layoutKeys(W, H, 2, 4);
    const e = l.keys.find((k) => k.midi === 64)!;
    const boundary = e.x + e.w; // E | F: no black key in between
    const wx = boundary - 15 + 34; // the index tip (wrist - 34) rests 15 px left of the boundary, in E
    const base: HandSpec = { x: wx, y: wristY(KEY_Y) };
    hold(rig, base, 8);
    pressAndRelease(rig, base, 1, 1.4, 3); // the bend swings the tip ~45 px to the right, into F
    expect(rig.ons().length).toBeGreaterThanOrEqual(1);
    expect(rig.ons()[0]!.midi).toBe(64);
  });

  it("the fingertip meter fills as the finger bends and is back at ~0 at rest", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
    hold(rig, base, 8);
    const id = [...rig.model.meter.keys()].find((k) => k % 8 === 1)!;
    expect(rig.model.meter.get(id)!).toBeLessThan(0.15);
    rig.step([{ ...base, shorten: [0, 0.12, 0, 0, 0] }]);
    const partway = rig.model.meter.get(id)!;
    expect(partway).toBeGreaterThan(0.1);
    expect(pressProgress(2, 0)).toBeGreaterThan(1); // a strong signal alone is a press
    expect(pressProgress(1, 0.5)).toBeCloseTo(1); // one at its minimum + half of the other is a press
    expect(pressProgress(0.1, 0.1)).toBeLessThan(0.3);
  });

  it("sensitivity: a small, slow bend plays in Easy but not in Strict", () => {
    const run = (ease: number) => {
      const rig = new Rig(makeCfg({ pianoEase: ease }));
      const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
      hold(rig, base, 8);
      for (let i = 1; i <= 3; i++) rig.step([{ ...base, shorten: [0, (0.09 * i) / 3, 0, 0, 0] }]);
      for (let i = 0; i < 4; i++) rig.step([{ ...base, shorten: [0, 0.09, 0, 0, 0] }]);
      return rig.ons().length;
    };
    expect(run(0.7)).toBe(1);
    expect(run(1.4)).toBe(0);
  });
});

describe("a finger press", () => {
  it("bending a finger over a key plays that key once, and straightening it releases it", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
    hold(rig, base, 8);
    pressAndRelease(rig, base, 1, 1.3, 3);
    expect(rig.ons()).toHaveLength(1);
    const on = rig.ons()[0]!;
    expect(on.finger).toBe(1);
    expect(on.midi).toBeGreaterThanOrEqual(60);
    expect(on.velocity).toBeGreaterThan(0.2);
    expect(rig.offs()).toHaveLength(1);
    expect(rig.offs()[0]!.midi).toBe(on.midi);
    expect(rig.model.down.size).toBe(0);
  });

  it("a note stays on while the finger stays bent (no retrigger), and the key is 'down' meanwhile", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
    hold(rig, base, 8);
    for (let i = 1; i <= 3; i++) rig.step([{ ...base, bend: [0, (1.3 * i) / 3, 0, 0, 0] }]);
    for (let i = 0; i < 12; i++) rig.step([{ ...base, bend: [0, 1.3, 0, 0, 0] }]);
    expect(rig.ons()).toHaveLength(1);
    expect(rig.offs()).toHaveLength(0);
    expect(rig.model.down.size).toBe(1);
  });

  it("pressing again after the release plays again", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
    hold(rig, base, 8);
    pressAndRelease(rig, base, 1, 1.3, 3);
    hold(rig, base, 3);
    pressAndRelease(rig, base, 1, 1.3, 3);
    expect(rig.ons()).toHaveLength(2);
    expect(rig.offs()).toHaveLength(2);
  });

  it("a harder (faster) press is louder", () => {
    const slow = new Rig();
    const fast = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
    hold(slow, base, 8);
    hold(fast, base, 8);
    pressAndRelease(slow, base, 1, 1.3, 6); // 6 frames to bend
    pressAndRelease(fast, base, 1, 1.5, 2); // 2 frames to bend
    expect(slow.ons()).toHaveLength(1);
    expect(fast.ons()).toHaveLength(1);
    expect(fast.ons()[0]!.velocity).toBeGreaterThan(slow.ons()[0]!.velocity);
  });
});

describe("false triggers", () => {
  it("moving the whole hand sideways over the keys, fingers straight: no notes", () => {
    const rig = new Rig();
    for (let i = 0; i < 20; i++) rig.step([{ x: 300 + i * 25, y: wristY(KEY_Y) }]);
    expect(rig.ons()).toHaveLength(0);
  });

  it("moving the whole hand DOWN onto the keys, fingers straight: no notes (absolute fingertip speed is not a press)", () => {
    const rig = new Rig();
    for (let i = 0; i < 12; i++) rig.step([{ x: WX, y: wristY(360 + i * 18) }]);
    for (let i = 0; i < 6; i++) rig.step([{ x: WX, y: wristY(360 + 11 * 18) }]);
    expect(rig.ons()).toHaveLength(0);
  });

  it("a small finger wobble (bend change below the minimum) makes no note", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
    hold(rig, base, 8);
    for (let i = 0; i < 20; i++) rig.step([{ ...base, bend: [0, 0.12 * Math.abs(Math.sin(i / 2)), 0, 0, 0] }]);
    expect(rig.ons()).toHaveLength(0);
  });

  it("a finger bent above the keys, nowhere near them, plays nothing", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(200) };
    hold(rig, base, 8);
    pressAndRelease(rig, base, 1, 1.3, 3);
    expect(rig.ons()).toHaveLength(0);
  });

  it("a fast swipe of the whole hand with bending fingers makes no notes", () => {
    const rig = new Rig();
    for (let i = 0; i < 10; i++) rig.step([{ x: 200 + i * 110, y: wristY(KEY_Y), bend: [0, 0.4 + 0.5 * (i % 2), 0, 0, 0] }]); // 110 px/frame = 33 hand sizes/s
    expect(rig.ons()).toHaveLength(0);
  });

  it("a pinching hand plays nothing", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y), open: 0 };
    hold(rig, base, 8);
    pressAndRelease(rig, base, 2, 1.3, 3);
    expect(rig.ons()).toHaveLength(0);
  });

  it("the thumb is ignored by default and plays when switched on", () => {
    const off = new Rig();
    const on = new Rig(makeCfg({ pianoThumb: true }));
    // thumb tip (wrist + (-80, -105)) over the keys
    const base: HandSpec = { x: 700, y: 540 + 105 };
    for (const rig of [off, on]) {
      hold(rig, base, 8);
      pressAndRelease(rig, base, 0, 1.3, 3);
    }
    expect(off.ons()).toHaveLength(0);
    expect(on.ons().length).toBeGreaterThanOrEqual(1);
  });

  it("sympathetic fingers: the pinky bends a little along with a strongly bending ring finger: only the ring finger plays", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
    hold(rig, base, 8);
    for (let i = 1; i <= 3; i++) rig.step([{ ...base, bend: [0, 0, 0, (1.4 * i) / 3, (0.55 * i) / 3] }]);
    for (let i = 0; i < 4; i++) rig.step([{ ...base, bend: [0, 0, 0, 1.4, 0.55] }]);
    expect(rig.ons().map((e) => e.finger)).toEqual([3]);
  });

  it("...but a pinky that really presses on its own plays", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
    hold(rig, base, 8);
    pressAndRelease(rig, base, 4, 1.4, 3);
    expect(rig.ons().map((e) => e.finger)).toEqual([4]);
  });
});

describe("chords", () => {
  it("two hands press different keys at once: two notes at the same time, two releases", () => {
    const rig = new Rig();
    const left: HandSpec = { x: 300, y: wristY(KEY_Y) };
    const right: HandSpec = { x: 900, y: wristY(KEY_Y) };
    for (let i = 0; i < 8; i++) rig.step([left, right]);
    for (let i = 1; i <= 3; i++) {
      const a = (1.3 * i) / 3;
      rig.step([{ ...left, bend: [0, a, 0, 0, 0] }, { ...right, bend: [0, a, 0, 0, 0] }]);
    }
    for (let i = 0; i < 4; i++) rig.step([{ ...left, bend: [0, 1.3, 0, 0, 0] }, { ...right, bend: [0, 1.3, 0, 0, 0] }]);
    const ons = rig.ons();
    expect(ons).toHaveLength(2);
    expect(new Set(ons.map((e) => e.midi)).size).toBe(2);
    expect(rig.model.down.size).toBe(2);
    for (let i = 2; i >= 0; i--) {
      const a = (1.3 * i) / 3;
      rig.step([{ ...left, bend: [0, a, 0, 0, 0] }, { ...right, bend: [0, a, 0, 0, 0] }]);
    }
    expect(rig.offs()).toHaveLength(2);
  });

  it("three fingers of one hand (index, ring, pinky... separated by a finger) on different keys: a chord", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
    hold(rig, base, 8);
    // index (x-34) and ring (x+33) tips are ~67 px apart: with 82 px keys they may share a key; use pinky (x+63) too
    for (let i = 1; i <= 3; i++) rig.step([{ ...base, bend: [0, (1.4 * i) / 3, 0, (1.4 * i) / 3, (1.4 * i) / 3] }]);
    for (let i = 0; i < 4; i++) rig.step([{ ...base, bend: [0, 1.4, 0, 1.4, 1.4] }]);
    const midis = rig.ons().map((e) => e.midi);
    expect(new Set(midis).size).toBe(midis.length); // never the same key twice at once
    expect(midis.length).toBeGreaterThanOrEqual(2);
  });
});

describe("lost hands and the keyboard", () => {
  it("a hand that disappears lets go of its keys", () => {
    const rig = new Rig();
    const base: HandSpec = { x: WX, y: wristY(KEY_Y) };
    hold(rig, base, 8);
    for (let i = 1; i <= 3; i++) rig.step([{ ...base, bend: [0, (1.3 * i) / 3, 0, 0, 0] }]);
    for (let i = 0; i < 3; i++) rig.step([{ ...base, bend: [0, 1.3, 0, 0, 0] }]);
    expect(rig.model.down.size).toBe(1);
    for (let i = 0; i < 12; i++) rig.step([]); // the tracker holds the hand for 150 ms, then it is gone
    expect(rig.offs()).toHaveLength(1);
    expect(rig.model.down.size).toBe(0);
  });

  it("hovering: every fingertip over a key is reported for drawing", () => {
    const rig = new Rig();
    rig.step([{ x: WX, y: wristY(KEY_Y) }]);
    const over = [...rig.model.hover.values()].filter((k) => k !== null);
    expect(over.length).toBeGreaterThanOrEqual(3);
  });

  it("changing the octave setting in the panel re-lays the keys", () => {
    const cfg = makeCfg();
    const m = new PianoModel(cfg);
    m.setViewport(W, H);
    expect(m.layout.keys).toHaveLength(24);
    cfg.pianoOctaves = 3;
    m.update({ hands: [], timestamp: 0 }, 0);
    expect(m.layout.keys).toHaveLength(36);
    cfg.pianoLowOctave = 3;
    m.update({ hands: [], timestamp: 10 }, 10);
    expect(Math.min(...m.layout.keys.map((k) => k.midi))).toBe(48);
  });
});
