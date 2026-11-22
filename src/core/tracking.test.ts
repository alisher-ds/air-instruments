import { describe, expect, it } from "vitest";
import { synthHand } from "../../test/helpers/synthHand";
import type { Vec2 } from "../instruments/Instrument";
import { HandPipeline, TrackManager, type TrackingConfig } from "./tracking";

const CFG: TrackingConfig = { minCutoff: 2, beta: 10, dCutoff: 1, holdMs: 150, matchMaxDist: 0.3 };

/** A hand in normalized camera space (0..1). The canonical hand is ~200 px tall, so scale it to ~0.3. */
function hand(wx: number, wy: number): Vec2[] {
  return synthHand({ x: wx, y: wy, scale: 0.0015 });
}

describe("TrackManager ids", () => {
  it("keeps the same id for a hand that moves a little each frame", () => {
    const tm = new TrackManager(CFG);
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const out = tm.update([hand(0.3 + i * 0.01, 0.5)], i * 33);
      expect(out).toHaveLength(1);
      ids.push(out[0]!.id);
    }
    expect(new Set(ids).size).toBe(1);
  });

  it("matches by wrist position, not by the order MediaPipe lists the hands", () => {
    const tm = new TrackManager(CFG);
    const first = tm.update([hand(0.2, 0.5), hand(0.8, 0.5)], 0);
    const idLeft = first[0]!.id;
    const idRight = first[1]!.id;
    expect(idLeft).not.toBe(idRight);
    // Detection order flipped in the next frame.
    const second = tm.update([hand(0.81, 0.5), hand(0.21, 0.5)], 33);
    const byWrist = (wx: number) => second.find((t) => Math.abs(t.landmarks[0]!.x - wx) < 0.1)!;
    expect(byWrist(0.2).id).toBe(idLeft);
    expect(byWrist(0.8).id).toBe(idRight);
  });

  it("gives a brand new hand far from every track a new id", () => {
    const tm = new TrackManager(CFG);
    const a = tm.update([hand(0.1, 0.5)], 0)[0]!.id;
    const out = tm.update([hand(0.1, 0.5), hand(0.9, 0.5)], 33);
    expect(out).toHaveLength(2);
    expect(out.map((t) => t.id)).toContain(a);
    expect(new Set(out.map((t) => t.id)).size).toBe(2);
  });
});

describe("TrackManager lost hands", () => {
  it("holds the last state for 150 ms, then releases", () => {
    const tm = new TrackManager(CFG);
    const t0 = tm.update([hand(0.4, 0.5)], 1000);
    const lastLandmarks = t0[0]!.landmarks;

    const at100 = tm.update([], 1100);
    expect(at100).toHaveLength(1);
    expect(at100[0]!.id).toBe(t0[0]!.id);
    expect(at100[0]!.landmarks).toEqual(lastLandmarks);

    expect(tm.update([], 1150)).toHaveLength(1); // exactly at the limit: still held
    expect(tm.update([], 1151)).toHaveLength(0); // beyond: released
  });

  it("gives the hand back its id if it returns within the hold time", () => {
    const tm = new TrackManager(CFG);
    const id = tm.update([hand(0.4, 0.5)], 0)[0]!.id;
    tm.update([], 66);
    const back = tm.update([hand(0.42, 0.5)], 120);
    expect(back).toHaveLength(1);
    expect(back[0]!.id).toBe(id);
  });

  it("gives a NEW id if the hand returns after it was released", () => {
    const tm = new TrackManager(CFG);
    const id = tm.update([hand(0.4, 0.5)], 0)[0]!.id;
    tm.update([], 200);
    const back = tm.update([hand(0.4, 0.5)], 250);
    expect(back).toHaveLength(1);
    expect(back[0]!.id).not.toBe(id);
  });

  it("never reports more than 2 hands", () => {
    const tm = new TrackManager(CFG);
    tm.update([hand(0.1, 0.5), hand(0.9, 0.5)], 0);
    // Both lost, then two completely different hands appear within the hold time.
    const out = tm.update([hand(0.5, 0.1), hand(0.5, 0.9)], 50);
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("keeps a visible hand when a third detection shows up", () => {
    const tm = new TrackManager(CFG);
    const first = tm.update([hand(0.1, 0.1), hand(0.9, 0.9)], 0);
    const out = tm.update([hand(0.1, 0.1), hand(0.9, 0.9), hand(0.5, 0.5)], 33);
    expect(out.map((t) => t.id).sort()).toEqual(first.map((t) => t.id).sort());
  });
});

describe("HandPipeline", () => {
  it("mirrors: a hand on the camera's left appears on the screen's right", () => {
    const p = new HandPipeline();
    p.setViewport(1280, 720);
    p.setVideoSize(640, 480);
    const frame = p.process([hand(0.1, 0.5)], 0);
    expect(frame.hands).toHaveLength(1);
    expect(frame.hands[0]!.palmCenter.x).toBeGreaterThan(640);
    expect(frame.hands[0]!.side).toBe("right");
  });

  it("returns an empty frame with no detections", () => {
    const p = new HandPipeline();
    expect(p.process([], 0).hands).toEqual([]);
  });

  it("holds a pinch through a short dropout (no flicker, no release)", () => {
    const p = new HandPipeline();
    p.setViewport(1280, 720);
    const pinched = (x: number) => synthHand({ x, y: 0.5, scale: 0.0015, open: 0.05 });
    expect(p.process([pinched(0.5)], 0).hands[0]!.pinch.active).toBe(true);
    expect(p.process([], 33).hands[0]!.pinch.active).toBe(true);
    expect(p.process([], 100).hands[0]!.pinch.active).toBe(true);
    expect(p.process([], 200).hands).toHaveLength(0);
  });
});
