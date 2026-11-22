import { describe, expect, it } from "vitest";
import { synthHand } from "../../test/helpers/synthHand";
import { HandPipeline } from "./tracking";
import { Recorder, isRecording, recordingFileName, replayRecording } from "./recording";

/** Live pipeline over a pinch clip: returns the recorded JSON and the live pinch states. */
function recordLive() {
  const pipeline = new HandPipeline();
  pipeline.setViewport(1280, 720);
  pipeline.setVideoSize(640, 480);
  const recorder = new Recorder();
  recorder.start(1280, 720);
  const live: boolean[] = [];
  for (let i = 0; i < 40; i++) {
    const open = i < 10 ? 1 : i < 30 ? 0.05 : 1;
    const frame = pipeline.process([synthHand({ x: 0.5, y: 0.5, scale: 0.0015, open })], 5000 + i * 33.3);
    recorder.push(frame);
    live.push(frame.hands[0]!.pinch.active);
  }
  return { rec: recorder.stop(), live };
}

describe("Recorder", () => {
  it("ignores frames while not recording", () => {
    const r = new Recorder();
    r.push({ hands: [], timestamp: 0 });
    expect(r.frameCount).toBe(0);
  });

  it("records time relative to the first frame and rounds coordinates", () => {
    const { rec } = recordLive();
    expect(rec.frames[0]!.t).toBe(0);
    expect(rec.frames[1]!.t).toBeCloseTo(33.3, 1);
    expect(rec.frames[0]!.hands[0]!.landmarks).toHaveLength(21);
    const x = rec.frames[0]!.hands[0]!.landmarks[0]![0];
    expect(Math.round(x * 10) / 10).toBe(x);
  });

  it("produces a valid recording that survives a JSON round trip", () => {
    const { rec } = recordLive();
    const copy: unknown = JSON.parse(JSON.stringify(rec));
    expect(isRecording(copy)).toBe(true);
    expect(isRecording({ format: "something-else" })).toBe(false);
    expect(isRecording(null)).toBe(false);
  });

  it("stores landmarks only (no video, no derived values)", () => {
    const { rec } = recordLive();
    expect(Object.keys(rec.frames[0]!.hands[0]!).sort()).toEqual(["id", "landmarks"]);
  });
});

describe("replayRecording", () => {
  it("reproduces the same pinch decisions as the live run", () => {
    const { rec, live } = recordLive();
    const replayed = replayRecording(JSON.parse(JSON.stringify(rec))).map((f) => f.hands[0]!.pinch.active);
    expect(replayed).toEqual(live);
    expect(live).toContain(true);
    expect(live).toContain(false);
  });
});

describe("recordingFileName", () => {
  it("is sortable and ends in .json", () => {
    expect(recordingFileName(new Date(2026, 10, 23, 9, 5, 7))).toBe("air-recording-20261123-090507.json");
  });
});
