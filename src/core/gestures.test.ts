import { describe, expect, it } from "vitest";
import { synthHand } from "../../test/helpers/synthHand";
import type { Vec2 } from "../instruments/Instrument";
import {
  HandAnalyzer,
  fingerCurls,
  handSizeOf,
  palmCenter,
  pinchRatio,
  updatePinch,
  velocityOf,
  type GestureConfig,
} from "./gestures";

const CFG: GestureConfig = {
  pinchOn: 0.25,
  pinchOff: 0.35,
  velocityAlpha: 1, // no velocity smoothing, so expectations are exact
  curlFullBendRad: 2.2,
  sideDeadZone: 0.03,
};

const blank = (): Vec2[] => Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));

describe("hand measurements", () => {
  it("handSize is wrist -> middle knuckle and scales with the hand", () => {
    expect(handSizeOf(synthHand({ x: 500, y: 500 }))).toBeCloseTo(100);
    expect(handSizeOf(synthHand({ x: 500, y: 500, scale: 2 }))).toBeCloseTo(200);
  });

  it("palmCenter sits between wrist and knuckles", () => {
    const p = palmCenter(synthHand({ x: 0, y: 0 }));
    expect(p.y).toBeGreaterThan(-100);
    expect(p.y).toBeLessThan(-50);
  });

  it("pinch ratio does not depend on hand scale (distance from camera)", () => {
    const a = synthHand({ x: 300, y: 300, scale: 1, open: 0.3 });
    const b = synthHand({ x: 300, y: 300, scale: 2.5, open: 0.3 });
    expect(pinchRatio(a, handSizeOf(a))).toBeCloseTo(pinchRatio(b, handSizeOf(b)), 6);
  });

  it("pinch ratio is Infinity for a degenerate hand", () => {
    expect(pinchRatio(blank(), 0)).toBe(Infinity);
  });
});

describe("updatePinch (hysteresis)", () => {
  it("switches ON below pinchOn, OFF above pinchOff, and holds in between", () => {
    const ratios = [0.5, 0.3, 0.2, 0.3, 0.34, 0.36, 0.3];
    const expected = [false, false, true, true, true, false, false];
    let active = false;
    ratios.forEach((r, i) => {
      active = updatePinch(active, r, CFG).active;
      expect(active, `ratio ${r}`).toBe(expected[i]);
    });
  });

  it("does not flicker when the ratio wobbles inside the dead band", () => {
    let active: boolean = true;
    let toggles = 0;
    for (const r of [0.27, 0.33, 0.28, 0.34, 0.3, 0.26, 0.32]) {
      const next: boolean = updatePinch(active, r, CFG).active;
      if (next !== active) toggles++;
      active = next;
    }
    expect(toggles).toBe(0);
  });

  it("strength is 1 at/below ON, 0 at/above OFF, and between in the middle", () => {
    expect(updatePinch(false, 0.1, CFG).strength).toBe(1);
    expect(updatePinch(false, 0.5, CFG).strength).toBe(0);
    expect(updatePinch(true, 0.3, CFG).strength).toBeCloseTo(0.5);
  });

  it("copes with swapped thresholds", () => {
    expect(updatePinch(false, 0.1, { pinchOn: 0.35, pinchOff: 0.25 }).active).toBe(true);
  });
});

describe("fingerCurls", () => {
  it("is ~0 for an open hand", () => {
    const curls = fingerCurls(synthHand({ x: 0, y: 0 }), 2.2);
    expect(curls).toHaveLength(5);
    // Index..pinky are nearly straight in the canonical pose; allow a little natural bend.
    for (const c of curls.slice(1)) expect(c).toBeLessThan(0.15);
  });

  it("grows as a finger bends at its middle joint", () => {
    const lm = blank();
    // Index finger: MCP(5) at origin, PIP(6) straight up, tip(8) bent by a given angle.
    lm[5] = { x: 0, y: 0 };
    lm[6] = { x: 0, y: -40 };
    const curlAt = (bend: number) => {
      lm[8] = { x: Math.sin(bend) * 30, y: -40 - Math.cos(bend) * 30 };
      return fingerCurls(lm, 2.2)[1]!;
    };
    expect(curlAt(0)).toBeCloseTo(0, 5);
    expect(curlAt(Math.PI / 2)).toBeCloseTo(Math.PI / 2 / 2.2, 5);
    expect(curlAt(Math.PI / 2)).toBeGreaterThan(curlAt(Math.PI / 4));
  });

  it("is capped at 1", () => {
    const lm = blank();
    lm[5] = { x: 0, y: 0 };
    lm[6] = { x: 0, y: -40 };
    lm[8] = { x: 0, y: -10 }; // folded straight back: 180 degrees
    expect(fingerCurls(lm, 2.2)[1]).toBe(1);
  });
});

describe("velocityOf", () => {
  it("gives px/s", () => {
    expect(velocityOf({ x: 0, y: 0 }, { x: 10, y: -5 }, 0.5)).toEqual({ x: 20, y: -10 });
  });
  it("is zero for a non-positive time step", () => {
    expect(velocityOf({ x: 0, y: 0 }, { x: 10, y: 0 }, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe("HandAnalyzer", () => {
  const W = 1280;

  it("measures hand velocity in px/s and removes it from tipVelocityRel", () => {
    const a = new HandAnalyzer(CFG);
    a.analyze([{ id: 1, landmarks: synthHand({ x: 600, y: 400 }) }], 0, W);
    const f = a.analyze([{ id: 1, landmarks: synthHand({ x: 630, y: 400 }) }], 100, W); // 30 px in 100 ms
    const h = f.hands[0]!;
    expect(h.palmVelocity.x).toBeCloseTo(300);
    expect(h.tipVelocity[1]!.x).toBeCloseTo(300);
    expect(h.tipVelocityRel[1]!.x).toBeCloseTo(0, 6);
    expect(h.tipVelocityRel[1]!.y).toBeCloseTo(0, 6);
  });

  it("tipVelocityRel shows a finger that moves on its own", () => {
    const a = new HandAnalyzer(CFG);
    const base = synthHand({ x: 600, y: 400 });
    a.analyze([{ id: 1, landmarks: base }], 0, W);
    const moved = base.map((p) => ({ ...p }));
    moved[8] = { x: moved[8]!.x, y: moved[8]!.y + 20 }; // index tip dips 20 px in 100 ms
    const h = a.analyze([{ id: 1, landmarks: moved }], 100, W).hands[0]!;
    expect(h.tipVelocityRel[1]!.y).toBeGreaterThan(150);
    expect(Math.abs(h.tipVelocityRel[2]!.y)).toBeLessThan(40); // other fingers barely change
  });

  it("starts with zero velocity on the first frame of a hand", () => {
    const a = new HandAnalyzer(CFG);
    const h = a.analyze([{ id: 5, landmarks: synthHand({ x: 100, y: 100 }) }], 1000, W).hands[0]!;
    expect(h.palmVelocity).toEqual({ x: 0, y: 0 });
    expect(h.tipVelocity.every((v) => v.x === 0 && v.y === 0)).toBe(true);
  });

  it("returns the contract shape: 21 landmarks, 5 tips, 5 curls", () => {
    const a = new HandAnalyzer(CFG);
    const h = a.analyze([{ id: 1, landmarks: synthHand({ x: 600, y: 400 }) }], 0, W).hands[0]!;
    expect(h.landmarks).toHaveLength(21);
    expect(h.tips).toHaveLength(5);
    expect(h.tipVelocity).toHaveLength(5);
    expect(h.tipVelocityRel).toHaveLength(5);
    expect(h.fingerCurl).toHaveLength(5);
    expect(h.tips[1]).toEqual(h.landmarks[8]);
    expect(h.pinch.point).toBeDefined();
  });

  it("detects a pinch with hysteresis across frames", () => {
    const a = new HandAnalyzer(CFG);
    const run = (open: number, t: number) =>
      a.analyze([{ id: 1, landmarks: synthHand({ x: 600, y: 400, open }) }], t, W).hands[0]!.pinch.active;
    expect(run(1, 0)).toBe(false);
    expect(run(0.1, 33)).toBe(true); // ratio ~0.09
    expect(run(0.3, 66)).toBe(true); // ratio ~0.27: inside the dead band, stays ON
    expect(run(0.5, 100)).toBe(false); // ratio ~0.45
  });

  it("decides the side by screen position, not by hand identity", () => {
    const a = new HandAnalyzer(CFG);
    const f = a.analyze(
      [
        { id: 7, landmarks: synthHand({ x: 900, y: 400 }) },
        { id: 3, landmarks: synthHand({ x: 300, y: 400 }) },
      ],
      0,
      W,
    );
    expect(f.hands.find((h) => h.id === 3)!.side).toBe("left");
    expect(f.hands.find((h) => h.id === 7)!.side).toBe("right");
  });

  it("gives two hands on the same half of the screen different sides", () => {
    const a = new HandAnalyzer(CFG);
    const f = a.analyze(
      [
        { id: 1, landmarks: synthHand({ x: 800, y: 400 }) },
        { id: 2, landmarks: synthHand({ x: 1000, y: 400 }) },
      ],
      0,
      W,
    );
    expect(f.hands[0]!.side).toBe("left");
    expect(f.hands[1]!.side).toBe("right");
  });

  it("a lone hand uses the screen half, with a dead zone that keeps its side", () => {
    const a = new HandAnalyzer(CFG);
    const side = (x: number, t: number) =>
      a.analyze([{ id: 1, landmarks: synthHand({ x, y: 400 }) }], t, W).hands[0]!.side;
    // palm centre is a bit right of... the wrist x is the same as palm x for the canonical pose (+~5 px).
    expect(side(200, 0)).toBe("left");
    expect(side(1000, 33)).toBe("right");
    expect(side(640 - 10, 66)).toBe("right"); // inside the dead zone (38 px): keeps "right"
    expect(side(300, 100)).toBe("left");
    expect(side(640 + 10, 133)).toBe("left"); // dead zone again: keeps "left"
  });

  it("forgets hands that disappeared", () => {
    const a = new HandAnalyzer(CFG);
    a.analyze([{ id: 1, landmarks: synthHand({ x: 100, y: 100 }) }], 0, W);
    a.analyze([], 33, W);
    // Same id comes back: it is treated as a new hand (zero velocity, pinch state reset).
    const h = a.analyze([{ id: 1, landmarks: synthHand({ x: 900, y: 100 }) }], 66, W).hands[0]!;
    expect(h.palmVelocity).toEqual({ x: 0, y: 0 });
  });
});
