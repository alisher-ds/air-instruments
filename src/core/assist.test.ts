import { describe, expect, it } from "vitest";
import { AssistHints, NO_HANDS_FOR_MS, REPEAT_MS, SHOW_MS, SLOW_FOR_MS } from "./assist";

const ok = { cameraFps: 30, hands: 2, active: true };

/** Feeds `input` every 250 ms for `ms`, returns the last hint seen. */
function run(a: AssistHints, from: number, ms: number, input: { cameraFps: number; hands: number; active: boolean }) {
  let last = null as ReturnType<AssistHints["update"]>;
  for (let t = from; t <= from + ms; t += 250) last = a.update(t, input);
  return last;
}

describe("AssistHints", () => {
  it("says nothing while everything is fine", () => {
    const a = new AssistHints();
    expect(run(a, 0, 60000, ok)).toBeNull();
  });

  it("a slow camera for 6 s gives the 'more light' hint, with the fps in it", () => {
    const a = new AssistHints();
    expect(run(a, 0, SLOW_FOR_MS - 500, { ...ok, cameraFps: 15 })).toBeNull();
    const h = run(a, SLOW_FOR_MS - 500, 1500, { ...ok, cameraFps: 15 });
    expect(h?.id).toBe("slow-camera");
    expect(h?.text).toContain("15");
    expect(h?.text.toLowerCase()).toContain("light");
  });

  it("a short slow patch does not trigger it (the slow time must be unbroken)", () => {
    const a = new AssistHints();
    run(a, 0, 4000, { ...ok, cameraFps: 15 });
    run(a, 4250, 1000, ok); // fast again
    expect(run(a, 5500, 4000, { ...ok, cameraFps: 15 })).toBeNull();
  });

  it("no hands for 12 s gives the 'I can't see your hands' hint, and it goes away when a hand appears", () => {
    const a = new AssistHints();
    const none = { ...ok, hands: 0 };
    expect(run(a, 0, NO_HANDS_FOR_MS - 500, none)).toBeNull();
    const h = run(a, NO_HANDS_FOR_MS - 500, 1000, none);
    expect(h?.id).toBe("no-hands");
    expect(a.update(NO_HANDS_FOR_MS + 1500, { ...ok, hands: 1 })).toBeNull();
  });

  it("a hint stays for a while, then goes, and does not come back right away", () => {
    const a = new AssistHints();
    const slow = { ...ok, cameraFps: 15 };
    const first = run(a, 0, SLOW_FOR_MS + 500, slow);
    expect(first).not.toBeNull();
    expect(a.update(SLOW_FOR_MS + SHOW_MS - 1000, slow)).not.toBeNull(); // shown at 6 s, still up before 6 s + 9 s
    expect(a.update(SLOW_FOR_MS + SHOW_MS + 500, slow)).toBeNull();
    expect(run(a, SLOW_FOR_MS + SHOW_MS + 1000, 30000, slow)).toBeNull();
    // after the repeat time it may come back
    const again = run(a, SLOW_FOR_MS + REPEAT_MS, 2000, slow);
    expect(again?.id).toBe("slow-camera");
  });

  it("the slow-camera hint comes before the no-hands hint", () => {
    const a = new AssistHints();
    const both = { cameraFps: 15, hands: 0, active: true };
    expect(run(a, 0, NO_HANDS_FOR_MS + 1000, both)?.id).toBe("slow-camera");
  });

  it("measures nothing while the app is not active (hidden tab, not started), and restarts the clocks after", () => {
    const a = new AssistHints();
    run(a, 0, 5000, { ...ok, cameraFps: 15 });
    expect(run(a, 5250, 20000, { cameraFps: 15, hands: 0, active: false })).toBeNull();
    expect(a.update(25500, { ...ok, cameraFps: 15 })).toBeNull(); // the 6 s start over
  });

  it("dismiss takes the hint down", () => {
    const a = new AssistHints();
    const h = run(a, 0, SLOW_FOR_MS + 500, { ...ok, cameraFps: 15 });
    expect(h).not.toBeNull();
    a.dismiss();
    expect(a.update(SLOW_FOR_MS + 750, { ...ok, cameraFps: 15 })).toBeNull();
  });

  it("an unknown camera rate (0) is not 'slow'", () => {
    const a = new AssistHints();
    expect(run(a, 0, 30000, { ...ok, cameraFps: 0 })).toBeNull();
  });
});
