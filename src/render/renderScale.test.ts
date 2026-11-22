import { describe, expect, it } from "vitest";
import { fitTransform, normalizedToCanvas } from "../core/geometry";
import { backingSize, cssVideoPoint, renderRatios } from "./renderScale";

describe("renderRatios", () => {
  it("multiplies the screen ratio by the render scale", () => {
    expect(renderRatios(2, 1.25, 0.5)).toEqual({ screen: 1.25, canvas: 0.625 });
    expect(renderRatios(2, 1, 1)).toEqual({ screen: 1, canvas: 1 });
  });

  it("keeps the devicePixelRatio cap (hard cap 2, config.maxDpr)", () => {
    expect(renderRatios(2, 3, 1).screen).toBe(2);
    expect(renderRatios(1.5, 3, 1).screen).toBe(1.5);
    expect(renderRatios(1, 2, 0.75)).toEqual({ screen: 1, canvas: 0.75 });
  });

  it("never goes below 1 on the screen side and clamps a silly scale", () => {
    expect(renderRatios(2, 0.5, 1).screen).toBe(1);
    expect(renderRatios(2, 1, 5).canvas).toBe(1);
    expect(renderRatios(2, 1, 0).canvas).toBe(0.25);
  });
});

describe("backingSize", () => {
  it("rounds and never returns 0", () => {
    expect(backingSize(1920, 970, 0.5)).toEqual({ width: 960, height: 485 });
    expect(backingSize(1920, 970, 0.75)).toEqual({ width: 1440, height: 728 });
    expect(backingSize(0, 0, 0.5)).toEqual({ width: 1, height: 1 });
  });
});

describe("CSS object-fit + scaleX(-1) matches the canvas mapping used for the landmarks", () => {
  const windows: Array<[number, number]> = [
    [1920, 970],
    [1280, 720],
    [800, 600],
    [500, 900],
  ];
  const points: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [0.5, 0.5],
    [0.13, 0.82],
    [0.9, 0.07],
  ];
  for (const fit of ["cover", "contain"] as const) {
    it(`${fit}: same point as fitTransform + normalizedToCanvas`, () => {
      for (const [w, h] of windows) {
        const f = fitTransform(w, h, 640, 480, fit);
        for (const [nx, ny] of points) {
          const a = normalizedToCanvas(nx, ny, f);
          const b = cssVideoPoint(nx, ny, w, h, 640, 480, fit);
          expect(b.x).toBeCloseTo(a.x, 6);
          expect(b.y).toBeCloseTo(a.y, 6);
        }
      }
    });
  }
});
