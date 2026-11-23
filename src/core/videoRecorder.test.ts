import { describe, expect, it } from "vitest";
import { pickMimeType, recordingFileName, recordingSize } from "./videoRecorder";

describe("pickMimeType", () => {
  it("prefers VP9 with Opus, falls back step by step, and returns '' when nothing works", () => {
    expect(pickMimeType(() => true)).toBe("video/webm;codecs=vp9,opus");
    expect(pickMimeType((m) => m === "video/webm;codecs=vp8,opus" || m === "video/webm")).toBe("video/webm;codecs=vp8,opus");
    expect(pickMimeType((m) => m === "video/webm")).toBe("video/webm");
    expect(pickMimeType(() => false)).toBe("");
  });
});

describe("recordingFileName", () => {
  it("is a readable, sortable .webm name", () => {
    expect(recordingFileName(new Date(2026, 10, 23, 14, 5, 9))).toBe("air-instruments-2026-11-23-14-05-09.webm");
    expect(recordingFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe("air-instruments-2026-01-02-03-04-05.webm");
  });
});

describe("recordingSize", () => {
  it("keeps small windows, limits big ones to 1280 wide keeping the shape, and always gives even numbers", () => {
    expect(recordingSize(1024, 768)).toEqual({ width: 1024, height: 768 });
    const big = recordingSize(1920, 970);
    expect(big.width).toBe(1280);
    expect(big.height).toBe(646);
    expect(recordingSize(1001, 601).width % 2).toBe(0);
    expect(recordingSize(1001, 601).height % 2).toBe(0);
    expect(recordingSize(0, 0).width).toBeGreaterThanOrEqual(2);
  });
});
