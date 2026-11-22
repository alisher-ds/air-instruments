import { describe, expect, it } from "vitest";
import { synthHand } from "../../test/helpers/synthHand";
import { TIP_INDICES } from "../config";
import type { Hand } from "../instruments/Instrument";
import { HandAnalyzer } from "./gestures";
import { extrapolate, predictedTip, type PredictConfig } from "./predict";

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
