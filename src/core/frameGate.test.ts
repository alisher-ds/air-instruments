import { describe, expect, it } from "vitest";
import { FrameGate } from "./frameGate";

describe("FrameGate (at most one frame in flight)", () => {
  it("lets the first frame through and refuses the rest while busy (no queue)", () => {
    const g = new FrameGate(2000);
    expect(g.tryAcquire(0)).toBe(true);
    expect(g.tryAcquire(33)).toBe(false);
    expect(g.tryAcquire(66)).toBe(false);
    expect(g.busy).toBe(true);
  });

  it("lets the next frame through after release", () => {
    const g = new FrameGate(2000);
    expect(g.tryAcquire(0)).toBe(true);
    g.release();
    expect(g.busy).toBe(false);
    expect(g.tryAcquire(40)).toBe(true);
  });

  it("watchdog: a worker that never answers does not block tracking forever", () => {
    const g = new FrameGate(2000);
    expect(g.tryAcquire(0)).toBe(true);
    expect(g.tryAcquire(2000)).toBe(false); // exactly at the limit: still waiting
    expect(g.tryAcquire(2001)).toBe(true);
    expect(g.timeouts).toBe(1);
  });

  it("reset() frees the gate and clears the timeout counter", () => {
    const g = new FrameGate(10);
    g.tryAcquire(0);
    g.tryAcquire(100);
    g.reset();
    expect(g.busy).toBe(false);
    expect(g.timeouts).toBe(0);
  });
});
