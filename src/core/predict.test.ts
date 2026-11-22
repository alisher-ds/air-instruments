import { describe, expect, it } from "vitest";
import { synthHand } from "../../test/helpers/synthHand";
import { TIP_INDICES } from "../config";
import type { Hand } from "../instruments/Instrument";
import { HandAnalyzer } from "./gestures";
import type { Vec2 } from "../instruments/Instrument";
import { extrapolate, jointFinger, predictLandmarksInto, predictedTip, type PredictConfig } from "./predict";

describe("extrapolate", () => {
  it("moves the point by velocity * lead", () => {
    const p = extrapolate({ x: 100, y: 200 }, { x: 600, y: -300 }, 33, 1000);
    expect(p.x).toBeCloseTo(100 + 600 * 0.033);
    expect(p.y).toBeCloseTo(200 - 300 * 0.033);
  });

  it("returns the same point for zero velocity, zero lead or zero max shift", () => {
    const pos = { x: 5, y: 6 };
    expect(extrapolate(pos, { x: 0, y: 0 }, 33, 100)).toEqual(pos);
    expect(extrapolate(pos, { x: 900, y: 900 }, 0, 100)).toEqual(pos);
    expect(extrapolate(pos, { x: 900, y: 900 }, 33, 0)).toEqual(pos);
  });

  it("clamps the shift to maxShift and keeps its direction", () => {
    const p = extrapolate({ x: 0, y: 0 }, { x: 30000, y: 40000 }, 33, 10); // would move 1650 px
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(10);
    expect(p.y / p.x).toBeCloseTo(4 / 3);
  });

  it("ignores a broken (NaN / Infinity) velocity", () => {
    const pos = { x: 1, y: 2 };
    expect(extrapolate(pos, { x: NaN, y: 0 }, 33, 100)).toEqual(pos);
    expect(extrapolate(pos, { x: Infinity, y: 0 }, 33, 100)).toEqual(pos);
  });
});

describe("predictedTip", () => {
  /** A moving hand: the second analyzed frame has real tip velocities. handSize = 100 px. */
  function movingHand(): Hand {
    const an = new HandAnalyzer({
      pinchOn: 0.25,
      pinchOff: 0.35,
      velocityAlpha: 1,
      curlFullBendRad: 2.2,
      sideDeadZone: 0.03,
    });
    const at = (dx: number) => synthHand({ x: 600 + dx, y: 500, scale: 1 });
    an.analyze([{ id: 1, landmarks: at(0) }], 0, 1280);
    return an.analyze([{ id: 1, landmarks: at(10) }], 33, 1280).hands[0]!; // 10 px in 33 ms = ~303 px/s to the right
  }

  const off: PredictConfig = { predictEnabled: false, predictLeadMs: 33, predictMaxShift: 0.5 };
  const on: PredictConfig = { ...off, predictEnabled: true };

  it("is OFF by default: returns the measured fingertip", () => {
    const hand = movingHand();
    expect(predictedTip(hand, 1, off)).toBe(hand.tips[1]);
  });

  it("when enabled, the fingertip is shifted ahead along its velocity", () => {
    const hand = movingHand();
    const tip = hand.tips[1]!;
    const pred = predictedTip(hand, 1, on);
    const expected = (hand.tipVelocity[1]!.x * 33) / 1000;
    expect(expected).toBeGreaterThan(5);
    expect(pred.x - tip.x).toBeCloseTo(expected, 5);
    expect(pred.y).toBeCloseTo(tip.y, 5);
  });

  it("never shifts further than predictMaxShift * handSize", () => {
    const hand = movingHand();
    const tight: PredictConfig = { ...on, predictMaxShift: 0.01 };
    const pred = predictedTip(hand, 1, tight);
    const tip = hand.tips[1]!;
    expect(Math.hypot(pred.x - tip.x, pred.y - tip.y)).toBeLessThanOrEqual(0.01 * hand.handSize + 1e-9);
  });

  it("works for every finger index", () => {
    const hand = movingHand();
    for (let i = 0; i < TIP_INDICES.length; i++) expect(predictedTip(hand, i, on).x).toBeGreaterThan(hand.tips[i]!.x);
  });
});

describe("predictLandmarksInto (drawing only)", () => {
  function movingHand(): Hand {
    const an = new HandAnalyzer({ pinchOn: 0.25, pinchOff: 0.35, velocityAlpha: 1, curlFullBendRad: 2.2, sideDeadZone: 0.03 });
    const at = (dx: number) => synthHand({ x: 600 + dx, y: 500, scale: 1 });
    an.analyze([{ id: 1, landmarks: at(0) }], 0, 1280);
    return an.analyze([{ id: 1, landmarks: at(10) }], 33, 1280).hands[0]!; // all points ~303 px/s to the right
  }

  it("maps landmarks to fingers", () => {
    expect(jointFinger(0)).toBeNull();
    expect(jointFinger(1)).toEqual({ finger: 0, along: 0 });
    expect(jointFinger(4)).toEqual({ finger: 0, along: 1 });
    expect(jointFinger(8)).toEqual({ finger: 1, along: 1 });
    expect(jointFinger(20)).toEqual({ finger: 4, along: 1 });
  });

  it("moves every joint ahead by velocity * lead when the whole hand moves", () => {
    const hand = movingHand();
    const out: Vec2[] = [];
    predictLandmarksInto(out, hand, 100, 1000);
    expect(out).toHaveLength(21);
    const expected = (hand.palmVelocity.x * 100) / 1000;
    expect(expected).toBeGreaterThan(20);
    for (let i = 0; i < 21; i++) {
      expect(out[i]!.x - hand.landmarks[i]!.x).toBeGreaterThan(expected * 0.8);
      expect(out[i]!.x - hand.landmarks[i]!.x).toBeLessThan(expected * 1.2);
    }
  });

  it("the fingertip uses its own velocity, the wrist the palm velocity", () => {
    const hand = movingHand();
    const custom: Hand = { ...hand, tipVelocity: hand.tipVelocity.map(() => ({ x: 0, y: 0 })), palmVelocity: { x: 500, y: 0 } };
    const out: Vec2[] = [];
    predictLandmarksInto(out, custom, 100, 1000);
    expect(out[0]!.x - custom.landmarks[0]!.x).toBeCloseTo(50, 5); // wrist: palm velocity
    expect(out[8]!.x - custom.landmarks[8]!.x).toBeCloseTo(0, 5); // index tip: its own (zero) velocity
    expect(out[6]!.x - custom.landmarks[6]!.x).toBeCloseTo(50 * (2 / 3), 5); // PIP: one third of the way to the tip
  });

  it("never shifts a joint further than maxShift (no big overshoot)", () => {
    const hand = movingHand();
    const out: Vec2[] = [];
    predictLandmarksInto(out, hand, 300, 5);
    for (let i = 0; i < 21; i++) {
      expect(Math.hypot(out[i]!.x - hand.landmarks[i]!.x, out[i]!.y - hand.landmarks[i]!.y)).toBeLessThanOrEqual(5 + 1e-9);
    }
  });

  it("zero lead gives the measured positions, and the output array is reused", () => {
    const hand = movingHand();
    const out: Vec2[] = [];
    predictLandmarksInto(out, hand, 0, 100);
    hand.landmarks.forEach((p, i) => expect(out[i]).toEqual(p));
    const first = out[3];
    predictLandmarksInto(out, hand, 50, 100);
    expect(out[3]).toBe(first); // same object, no allocation
  });
});
