// Doira logic tests: synthetic hands through the real HandAnalyzer, then the model.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../../config";
import { HandAnalyzer } from "../../core/gestures";
import { HandPipeline } from "../../core/tracking";
import { synthHand } from "../../../test/helpers/synthHand";
import { DoiraModel, loudness, zoneOf, type DoiraConfig, type DoiraEvent } from "./model";

const W = 1280;
const H = 720;
// Drum: centre (640, 446.4), radius 0.2 * 720 = 144. synthHand has handSize 100 px, so 1 hand size/s = 100 px/s.
const C = { x: 640, y: 0.62 * H };
const R = 0.2 * H;

/** Palm centre of synthHand = wrist + (10, -74.4). */
const wristFor = (px: number, py: number) => ({ x: px - 10, y: py + 74.4 });

interface Spec {
  id: number;
  /** Palm centre. */
  px: number;
  py: number;
  open?: number;
  /** Index fingertip raised by this many px (a finger flick without moving the palm). */
  indexUp?: number;
  fist?: boolean;
}

function makeCfg(over: Partial<Config> = {}): DoiraConfig {
  return { ...DEFAULT_CONFIG, predictEnabled: false, ...over };
}

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

class Rig {
  readonly analyzer = new HandAnalyzer();
  readonly model: DoiraModel;
  t = 1000;
  events: DoiraEvent[] = [];
  constructor(cfg: DoiraConfig = makeCfg()) {
    this.model = new DoiraModel(cfg);
    this.model.setViewport(W, H);
  }
  step(hands: Spec[], dtMs = 33): DoiraEvent[] {
    this.t += dtMs;
    const frame = this.analyzer.analyze(
      hands.map((h) => {
        const w = wristFor(h.px, h.py);
        let lm = synthHand({ x: w.x, y: w.y, open: h.open ?? 1 });
        if (h.fist) lm = withFist(lm);
        if (h.indexUp) lm[8] = { x: lm[8]!.x, y: lm[8]!.y - h.indexUp };
        return { id: h.id, landmarks: lm };
      }),
      this.t,
      W,
    );
    const ev = this.model.update(frame, this.t);
    this.events.push(...ev);
    return ev;
  }
  hits(kind?: "palm" | "finger") {
    return this.events.filter((e): e is Extract<DoiraEvent, { type: "hit" }> => e.type === "hit" && (!kind || e.kind === kind));
  }
}

/** Palm travels along y = py from x0 by `step` px per frame, `frames` frames (+ the start frame). */
function slide(rig: Rig, py: number, x0: number, step: number, frames: number, id = 1): void {
  for (let i = 0; i <= frames; i++) rig.step([{ id, px: x0 + step * i, py }]);
}

describe("palm hits", () => {
  it("a fast palm entering the drum makes exactly one hit, louder when faster", () => {
    const slow = new Rig();
    slide(slow, C.y, 300, 14, 14); // 14 px / 33 ms = 4.2 hand sizes/s
    const fast = new Rig();
    slide(fast, C.y, 300, 45, 5); // 13.6 hand sizes/s
    expect(slow.hits()).toHaveLength(1);
    expect(fast.hits()).toHaveLength(1);
    expect(fast.hits()[0]!.velocity).toBeGreaterThan(slow.hits()[0]!.velocity);
    expect(fast.hits()[0]!.kind).toBe("palm");
    expect(fast.hits()[0]!.velocity).toBeLessThanOrEqual(1);
  });

  it("a palm drifting into the drum slowly does not hit", () => {
    const rig = new Rig();
    slide(rig, C.y, 380, 3, 60); // 3 px / 33 ms = 0.9 hand sizes/s
    expect(rig.hits()).toHaveLength(0);
  });

  it("a hand resting or moving slowly inside the drum does not hit", () => {
    const rig = new Rig();
    for (let i = 0; i < 20; i++) rig.step([{ id: 1, px: 600 + Math.sin(i / 3) * 10, py: C.y }]);
    expect(rig.hits()).toHaveLength(0);
  });

  it("slam and stop: fast inside the drum, then suddenly still = one hit", () => {
    const rig = new Rig();
    for (let i = 0; i < 4; i++) rig.step([{ id: 1, px: 560, py: C.y }]); // resting inside, armed
    rig.step([{ id: 1, px: 560, py: C.y + 40 }]);
    rig.step([{ id: 1, px: 560, py: C.y + 80 }]); // 40 px / 33 ms = 12 hand sizes/s downward
    expect(rig.hits()).toHaveLength(0);
    rig.step([{ id: 1, px: 560, py: C.y + 82 }]); // stops
    expect(rig.hits()).toHaveLength(1);
    expect(rig.hits()[0]!.velocity).toBeGreaterThan(0.6);
    for (let i = 0; i < 5; i++) rig.step([{ id: 1, px: 560, py: C.y + 82 }]);
    expect(rig.hits()).toHaveLength(1);
  });

  it("enter and then stop is ONE hit, not two", () => {
    const rig = new Rig();
    slide(rig, C.y, 330, 45, 4); // enters fast
    for (let i = 0; i < 6; i++) rig.step([{ id: 1, px: 330 + 45 * 4, py: C.y }]); // stops inside
    expect(rig.hits()).toHaveLength(1);
  });

  it("enter, keep sweeping fast through the drum, then stop: still ONE hit (the fast tail is part of the same strike)", () => {
    const rig = new Rig();
    for (let i = 0; i < 4; i++) rig.step([{ id: 1, px: 400, py: C.y - 100 }]);
    for (const d of [15, 45, 80, 115, 125, 127, 127, 127, 127]) rig.step([{ id: 1, px: 400, py: C.y - 100 + d * 1.2 }]);
    expect(rig.hits().length).toBeLessThanOrEqual(1);
  });

  it("after a hit the hand must leave the circle (or slow down) before it can hit again", () => {
    const rig = new Rig();
    slide(rig, C.y, 330, 45, 4); // hit 1
    // keeps moving through the drum at a medium-fast speed: still no second hit
    for (let i = 1; i <= 3; i++) rig.step([{ id: 1, px: 510 + i * 30, py: C.y }]);
    expect(rig.hits()).toHaveLength(1);
    // leaves the circle, waits out the cooldown, then comes back in fast: hit 2
    for (let i = 0; i < 4; i++) rig.step([{ id: 1, px: 800, py: C.y }]);
    for (let i = 0; i <= 4; i++) rig.step([{ id: 1, px: 800 - 60 * i, py: C.y }]);
    expect(rig.hits()).toHaveLength(2);
  });

  it("a hand cannot hit twice inside the cooldown (one hit = one sound)", () => {
    const rig = new Rig();
    slide(rig, C.y, 330, 45, 4); // hit 1 around t0
    // out and in again within ~60 ms, fast
    rig.step([{ id: 1, px: 900, py: C.y }], 20);
    rig.step([{ id: 1, px: 500, py: C.y }], 20);
    rig.step([{ id: 1, px: 600, py: C.y }], 20);
    expect(rig.hits()).toHaveLength(1);
  });

  it("two hands hit alternately and each hit belongs to its hand", () => {
    const rig = new Rig();
    // left hand (id 1) comes in from the left, then the right hand (id 2) from the right, while the other waits outside
    for (let i = 0; i <= 5; i++) rig.step([{ id: 1, px: 330 + 45 * i, py: C.y }, { id: 2, px: 1000, py: C.y }]);
    for (let i = 0; i < 4; i++) rig.step([{ id: 1, px: 330, py: C.y }, { id: 2, px: 1000, py: C.y }]);
    for (let i = 0; i <= 5; i++) rig.step([{ id: 1, px: 330, py: C.y }, { id: 2, px: 1000 - 45 * i, py: C.y }]);
    const hits = rig.hits("palm");
    expect(hits.map((h) => h.handId)).toEqual([hits[0]!.handId, hits[1]!.handId]);
    expect(new Set(hits.map((h) => h.handId)).size).toBe(2);
  });

  it("a fast swipe across the drum between two frames still counts (frames are far apart at 14 fps)", () => {
    const rig = new Rig();
    rig.step([{ id: 1, px: 400, py: C.y }]);
    rig.step([{ id: 1, px: 400, py: C.y }]);
    rig.step([{ id: 1, px: 900, py: C.y }], 70); // 500 px in 70 ms: passes through the whole drum
    expect(rig.hits()).toHaveLength(1);
  });

  it("prediction fires a fast entry one frame earlier", () => {
    const run = (predict: boolean) => {
      const rig = new Rig(makeCfg({ predictEnabled: predict }));
      let first = -1;
      for (let i = 0; i < 8; i++) {
        rig.step([{ id: 1, px: 330 + i * 30, py: C.y }]);
        if (first < 0 && rig.hits().length > 0) first = i;
      }
      return first;
    };
    expect(run(true)).toBeLessThan(run(false));
    expect(run(true)).toBeGreaterThan(-1);
  });
});

describe("zones", () => {
  it("zoneOf: 0 in the centre, 1 at the rim, smooth in between", () => {
    expect(zoneOf(C, C, R)).toBe(0);
    expect(zoneOf({ x: C.x + R * 0.3, y: C.y }, C, R)).toBe(0);
    expect(zoneOf({ x: C.x + R, y: C.y }, C, R)).toBe(1);
    const mid = zoneOf({ x: C.x + R * 0.6, y: C.y }, C, R);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
  });

  it("a slam in the middle is mostly bum, a slam near the edge is mostly tak", () => {
    const slam = (px: number, py: number) => {
      const rig = new Rig();
      for (let i = 0; i < 4; i++) rig.step([{ id: 1, px, py }]);
      rig.step([{ id: 1, px, py: py + 40 }]);
      rig.step([{ id: 1, px, py: py + 60 }]);
      rig.step([{ id: 1, px, py: py + 61 }]);
      return rig.hits();
    };
    const centre = slam(C.x, C.y - 70);
    const rim = slam(C.x + 128, C.y - 30);
    expect(centre).toHaveLength(1);
    expect(rim).toHaveLength(1);
    expect(centre[0]!.zone).toBeLessThan(0.3);
    expect(rim[0]!.zone).toBeGreaterThan(0.6);
  });

  it("a hand sweeping in from outside is pulled toward the centre: it is not a rim strike", () => {
    const rig = new Rig();
    for (let i = 0; i <= 5; i++) rig.step([{ id: 1, px: C.x + 130, py: 150 + i * 50 }]); // comes in from above near the right edge
    expect(rig.hits()).toHaveLength(1);
    expect(rig.hits()[0]!.zone).toBeLessThan(0.7);
  });

  it("loudness grows with speed and is audible even for the softest hit", () => {
    expect(loudness(2.5, 2.5, 10)).toBeGreaterThan(0.1);
    expect(loudness(10, 2.5, 10)).toBeCloseTo(1);
    expect(loudness(6, 2.5, 10)).toBeGreaterThan(loudness(4, 2.5, 10));
    expect(loudness(100, 2.5, 10)).toBeLessThanOrEqual(1);
  });
});

describe("finger taps", () => {
  it("a quick finger flick over the drum with a calm palm is a soft tap", () => {
    const rig = new Rig();
    for (let i = 0; i < 6; i++) rig.step([{ id: 1, px: 640, py: C.y + 60 }]);
    rig.step([{ id: 1, px: 640, py: C.y + 60, indexUp: 35 }]);
    const taps = rig.hits("finger");
    expect(taps).toHaveLength(1);
    expect(rig.hits("palm")).toHaveLength(0);
    expect(taps[0]!.velocity).toBeLessThan(0.75);
  });

  it("a tap is one event: a finger that stays raised does not keep tapping", () => {
    const rig = new Rig();
    for (let i = 0; i < 6; i++) rig.step([{ id: 1, px: 640, py: C.y + 60 }]);
    for (let i = 0; i < 8; i++) rig.step([{ id: 1, px: 640, py: C.y + 60, indexUp: 35 }]);
    expect(rig.hits("finger")).toHaveLength(1);
  });

  it("finger rolls: separate flicks give separate taps (after the finger cooldown)", () => {
    const rig = new Rig();
    for (let i = 0; i < 6; i++) rig.step([{ id: 1, px: 640, py: C.y + 60 }]);
    for (let n = 0; n < 3; n++) {
      rig.step([{ id: 1, px: 640, py: C.y + 60, indexUp: 35 }]);
      for (let i = 0; i < 3; i++) rig.step([{ id: 1, px: 640, py: C.y + 60 }]);
    }
    expect(rig.hits("finger")).toHaveLength(3);
  });

  it("a finger flick away from the drum does nothing", () => {
    const rig = new Rig();
    for (let i = 0; i < 6; i++) rig.step([{ id: 1, px: 1100, py: C.y }]);
    rig.step([{ id: 1, px: 1100, py: C.y, indexUp: 35 }]);
    expect(rig.hits()).toHaveLength(0);
  });

  it("a palm hit does not also make a finger tap", () => {
    const rig = new Rig();
    slide(rig, C.y, 330, 45, 5);
    expect(rig.hits("palm")).toHaveLength(1);
    expect(rig.hits("finger")).toHaveLength(0);
  });
});

describe("moving the drum with a pinch", () => {
  it("pinch inside the drum and drag moves it, without any hit, and a 'moved' event at the end", () => {
    const rig = new Rig();
    const fx0 = rig.model.fx;
    // pinch point = index tip = palm + (-34 - 10, -182 + 74.4) = palm + (-44, -107.6)
    const palmAt = (x: number) => ({ px: x + 44, py: C.y + 107.6 });
    for (let i = 0; i < 3; i++) rig.step([{ id: 1, ...palmAt(C.x), open: 1 }]);
    for (let i = 0; i < 2; i++) rig.step([{ id: 1, ...palmAt(C.x), open: 0 }]);
    for (let i = 1; i <= 6; i++) rig.step([{ id: 1, ...palmAt(C.x + i * 15), open: 0 }]);
    expect(rig.model.dragging.has(1)).toBe(true);
    const ev = rig.step([{ id: 1, ...palmAt(C.x + 90), open: 1 }]);
    expect(ev.some((e) => e.type === "moved")).toBe(true);
    expect(rig.model.fx).toBeGreaterThan(fx0 + 0.05);
    expect(rig.hits()).toHaveLength(0);
  });

  it("right after a pinch the hand cannot hit for a moment", () => {
    const rig = new Rig();
    const palmAt = (x: number) => ({ px: x + 44, py: C.y + 107.6 });
    for (let i = 0; i < 3; i++) rig.step([{ id: 1, ...palmAt(C.x), open: 1 }]);
    for (let i = 0; i < 3; i++) rig.step([{ id: 1, ...palmAt(C.x), open: 0 }]);
    rig.step([{ id: 1, px: 200, py: C.y, open: 1 }]);
    for (let i = 0; i <= 3; i++) rig.step([{ id: 1, px: 200 + 60 * i, py: C.y, open: 1 }]);
    expect(rig.hits("palm")).toHaveLength(0);
  });

  it("a closing fist near the drum does not pick it up", () => {
    const rig = new Rig();
    const fx0 = rig.model.fx;
    for (let i = 0; i < 3; i++) rig.step([{ id: 1, px: C.x, py: C.y }]);
    for (let i = 0; i < 6; i++) rig.step([{ id: 1, px: C.x + i * 3, py: C.y, open: 0, fist: true }]);
    expect(rig.model.dragging.size).toBe(0);
    expect(rig.model.fx).toBe(fx0);
  });

  it("the position stays on screen", () => {
    const m = new DoiraModel(makeCfg());
    m.setPosition(5, -3);
    expect(m.fx).toBeLessThanOrEqual(0.9);
    expect(m.fy).toBeGreaterThanOrEqual(0.15);
    m.setPosition(Number.NaN, Number.NaN);
    expect(Number.isFinite(m.fx + m.fy)).toBe(true);
  });
});

describe("with the REAL tracking pipeline (One Euro smoothing lags and blurs a sudden stop)", () => {
  /** Palm positions (canvas px) per frame, through HandPipeline exactly like the app does. */
  function runPipeline(palms: Array<[number, number]>, dtMs = 33): { hits: DoiraEvent[]; hitFrame: number } {
    const pipe = new HandPipeline();
    pipe.setViewport(W, H);
    pipe.setVideoSize(W, H);
    const model = new DoiraModel(makeCfg());
    model.setViewport(W, H);
    const hits: DoiraEvent[] = [];
    let hitFrame = -1;
    let t = 1000;
    palms.forEach(([px, py], i) => {
      t += dtMs;
      const w = wristFor(px, py);
      const lm = synthHand({ x: w.x, y: w.y });
      // pipeline input: normalized, NOT mirrored yet (it mirrors itself)
      const det = [lm.map((p) => ({ x: 1 - p.x / W, y: p.y / H }))];
      const ev = model.update(pipe.process(det, t), t).filter((e) => e.type === "hit");
      if (ev.length && hitFrame < 0) hitFrame = i;
      hits.push(...ev);
    });
    return { hits, hitFrame };
  }

  it("slam and stop inside the drum is still ONE hit, within 3 frames of the stop", () => {
    const rest: Array<[number, number]> = Array.from({ length: 8 }, () => [640, 380]);
    // accelerates down ~35 px/frame (10 hand sizes/s), then stops like a hand meeting a table
    const move: Array<[number, number]> = [[640, 395], [640, 425], [640, 460], [640, 495], [640, 505], [640, 507], [640, 507], [640, 507], [640, 507], [640, 507]];
    const { hits, hitFrame } = runPipeline([...rest, ...move]);
    expect(hits).toHaveLength(1);
    const stopFrame = rest.length + 4; // the last fast frame
    expect(hitFrame).toBeGreaterThan(-1);
    expect(hitFrame - stopFrame).toBeLessThanOrEqual(3);
  });

  it("a fast palm coming in from outside is one hit, at a believable loudness", () => {
    const outside: Array<[number, number]> = Array.from({ length: 6 }, () => [250, 446]);
    const move: Array<[number, number]> = [[280, 446], [330, 446], [390, 446], [450, 446], [510, 446], [560, 446], [585, 446], [590, 446]];
    const { hits } = runPipeline([...outside, ...move]);
    expect(hits).toHaveLength(1);
    const h = hits[0]! as Extract<DoiraEvent, { type: "hit" }>;
    expect(h.velocity).toBeGreaterThan(0.3);
  });

  it("a hand drifting slowly around inside the drum makes nothing", () => {
    const path: Array<[number, number]> = Array.from({ length: 40 }, (_, i) => [600 + 40 * Math.sin(i / 6), 420 + 30 * Math.cos(i / 5)]);
    expect(runPipeline(path).hits).toHaveLength(0);
  });
});
