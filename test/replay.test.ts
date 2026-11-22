// Replays recordings through the gesture code. Every .json in test/recordings/ is checked for basic sanity;
// the synthetic recording is also checked against exact expectations.
//
// To add a real recording: press R in the app, play for a few seconds, press R again, and put the downloaded
// .json file into test/recordings/. It will be picked up here automatically.

import { describe, expect, it } from "vitest";
import { isRecording, replayRecording, type Recording } from "../src/core/recording";
import { syntheticTwoHandsRecording } from "./helpers/synthHand";

const files = import.meta.glob("./recordings/*.json", { eager: true, import: "default" }) as Record<string, unknown>;

describe("recordings", () => {
  const entries = Object.entries(files);

  it("finds at least the synthetic sample recording", () => {
    expect(entries.some(([name]) => name.includes("synthetic-two-hands"))).toBe(true);
  });

  for (const [name, data] of entries) {
    describe(name, () => {
      it("is a valid recording", () => {
        expect(isRecording(data)).toBe(true);
      });

      it("replays with sane values and no pinch flicker", () => {
        const rec = data as Recording;
        const frames = replayRecording(rec);
        expect(frames).toHaveLength(rec.frames.length);

        const pinchHistory = new Map<number, boolean[]>();
        for (const frame of frames) {
          expect(frame.hands.length).toBeLessThanOrEqual(2);
          expect(new Set(frame.hands.map((h) => h.id)).size).toBe(frame.hands.length);
          for (const h of frame.hands) {
            expect(h.landmarks).toHaveLength(21);
            const numbers = [
              h.handSize,
              h.palmCenter.x,
              h.palmCenter.y,
              h.palmVelocity.x,
              h.palmVelocity.y,
              h.pinch.strength,
              ...h.fingerCurl,
              ...h.tipVelocity.flatMap((v) => [v.x, v.y]),
              ...h.tipVelocityRel.flatMap((v) => [v.x, v.y]),
            ];
            for (const n of numbers) expect(Number.isFinite(n)).toBe(true);
            for (const c of h.fingerCurl) {
              expect(c).toBeGreaterThanOrEqual(0);
              expect(c).toBeLessThanOrEqual(1);
            }
            const hist = pinchHistory.get(h.id) ?? [];
            hist.push(h.pinch.active);
            pinchHistory.set(h.id, hist);
          }
        }

        // Flicker check: a pinch state never flips twice within 3 frames (~100 ms).
        for (const [, hist] of pinchHistory) {
          let lastToggle = -100;
          for (let i = 1; i < hist.length; i++) {
            if (hist[i] !== hist[i - 1]) {
              expect(i - lastToggle).toBeGreaterThan(3);
              lastToggle = i;
            }
          }
        }
      });
    });
  }
});

describe("synthetic two-hand recording (exact expectations)", () => {
  const rec = syntheticTwoHandsRecording() as unknown as Recording;
  const frames = replayRecording(rec);
  const pinchOf = (frame: number, id: number) => frames[frame]!.hands.find((h) => h.id === id)!.pinch.active;

  it("the committed JSON matches the generator (run scripts/make-sample-recording.mjs after changing it)", () => {
    const committed = Object.entries(files).find(([n]) => n.includes("synthetic-two-hands"))![1];
    expect(committed).toEqual(JSON.parse(JSON.stringify(rec)));
  });

  it("keeps ids stable and sides correct for the whole clip", () => {
    for (const f of frames) {
      expect(f.hands).toHaveLength(2);
      expect(f.hands.find((h) => h.id === 1)!.side).toBe("left");
      expect(f.hands.find((h) => h.id === 2)!.side).toBe("right");
    }
  });

  it("the right hand pinches exactly once, then lets go", () => {
    expect(pinchOf(10, 2)).toBe(false); // still open
    expect(pinchOf(30, 2)).toBe(true); // holding the pinch
    expect(pinchOf(44, 2)).toBe(true);
    expect(pinchOf(58, 2)).toBe(false); // open again
    let toggles = 0;
    for (let i = 1; i < frames.length; i++) if (pinchOf(i, 2) !== pinchOf(i - 1, 2)) toggles++;
    expect(toggles).toBe(2);
  });

  it("the left hand never pinches", () => {
    for (let i = 0; i < frames.length; i++) expect(pinchOf(i, 1)).toBe(false);
  });

  it("the circling left hand has hand motion but almost no finger motion of its own", () => {
    const h = frames[30]!.hands.find((x) => x.id === 1)!;
    const palmSpeed = Math.hypot(h.palmVelocity.x, h.palmVelocity.y);
    const idxRel = Math.hypot(h.tipVelocityRel[1]!.x, h.tipVelocityRel[1]!.y);
    expect(palmSpeed).toBeGreaterThan(50);
    expect(idxRel).toBeLessThan(palmSpeed);
  });
});
