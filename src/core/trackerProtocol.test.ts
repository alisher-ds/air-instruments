import { describe, expect, it } from "vitest";
import { synthHand } from "../../test/helpers/synthHand";
import { packHands, unpackHands } from "./trackerProtocol";

describe("landmark packing (worker <-> main)", () => {
  it("round-trips two hands (Float32 precision)", () => {
    const hands = [synthHand({ x: 0.3, y: 0.5, scale: 0.0015 }), synthHand({ x: 0.7, y: 0.4, scale: 0.0015 })];
    const packed = packHands(hands);
    expect(packed.count).toBe(2);
    expect(packed.perHand).toBe(21);
    expect(packed.points).toBeInstanceOf(Float32Array);
    expect(packed.points.length).toBe(2 * 21 * 2);

    const back = unpackHands(packed.count, packed.perHand, packed.points);
    expect(back).toHaveLength(2);
    hands.forEach((hand, h) => {
      expect(back[h]).toHaveLength(21);
      hand.forEach((p, i) => {
        expect(back[h]![i]!.x).toBeCloseTo(p.x, 5);
        expect(back[h]![i]!.y).toBeCloseTo(p.y, 5);
      });
    });
  });

  it("keeps the hand order", () => {
    const a = synthHand({ x: 0.1, y: 0.5, scale: 0.0015 });
    const b = synthHand({ x: 0.9, y: 0.5, scale: 0.0015 });
    const packed = packHands([a, b]);
    const back = unpackHands(packed.count, packed.perHand, packed.points);
    expect(back[0]![0]!.x).toBeLessThan(back[1]![0]!.x);
  });

  it("handles no hands", () => {
    const packed = packHands([]);
    expect(packed).toMatchObject({ count: 0, perHand: 0 });
    expect(unpackHands(packed.count, packed.perHand, packed.points)).toEqual([]);
  });
});
