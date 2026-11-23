import { describe, expect, it } from "vitest";
import { trackingBitmapSize } from "./trackingSize";

describe("trackingBitmapSize", () => {
  it("shrinks HD to 640 wide, keeping the shape", () => {
    expect(trackingBitmapSize(1280, 720)).toEqual({ resizeWidth: 640, resizeHeight: 360, resizeQuality: "low" });
    expect(trackingBitmapSize(1920, 1080)?.resizeHeight).toBe(360);
  });
  it("leaves small pictures alone, and survives nonsense", () => {
    expect(trackingBitmapSize(640, 480)).toBeNull();
    expect(trackingBitmapSize(320, 240)).toBeNull();
    expect(trackingBitmapSize(0, 0)).toBeNull();
    expect(trackingBitmapSize(Number.NaN, 100)).toBeNull();
  });
});
