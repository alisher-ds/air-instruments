import { describe, expect, it } from "vitest";
import {
  angleBetween,
  fitTransform,
  normalizedToCanvas,
  pointSegmentDistance,
  segmentIntersection,
} from "./geometry";

describe("segmentIntersection", () => {
  it("finds a crossing and reports where along each segment", () => {
    const hit = segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 });
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(5);
    expect(hit!.point.y).toBeCloseTo(5);
    expect(hit!.t).toBeCloseTo(0.5);
    expect(hit!.u).toBeCloseTo(0.5);
  });

  it("returns null when the segments do not reach each other", () => {
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBeNull();
  });

  it("returns null for parallel segments", () => {
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })).toBeNull();
  });

  it("returns null for collinear overlapping segments", () => {
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 })).toBeNull();
  });

  it("counts touching at an endpoint as a hit", () => {
    const hit = segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: -5 }, { x: 10, y: 5 });
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(1);
  });
});

describe("pointSegmentDistance", () => {
  it("measures to the closest point inside the segment", () => {
    expect(pointSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3);
  });
  it("measures to the nearest endpoint when past the end", () => {
    expect(pointSegmentDistance({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
  });
  it("handles a zero-length segment", () => {
    expect(pointSegmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5);
  });
});

describe("angleBetween", () => {
  it("is 0 for the same direction, PI/2 for perpendicular, PI for opposite", () => {
    expect(angleBetween({ x: 1, y: 0 }, { x: 5, y: 0 })).toBeCloseTo(0);
    expect(angleBetween({ x: 1, y: 0 }, { x: 0, y: 3 })).toBeCloseTo(Math.PI / 2);
    expect(angleBetween({ x: 1, y: 0 }, { x: -2, y: 0 })).toBeCloseTo(Math.PI);
  });
  it("is 0 when a vector has no length", () => {
    expect(angleBetween({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(0);
  });
});

describe("fitTransform + normalizedToCanvas", () => {
  it("cover fills the canvas and crops the long side", () => {
    const fit = fitTransform(1280, 720, 640, 480, "cover");
    expect(fit.drawWidth).toBeCloseTo(1280);
    expect(fit.drawHeight).toBeCloseTo(960);
    expect(fit.offsetX).toBeCloseTo(0);
    expect(fit.offsetY).toBeCloseTo(-120);
  });

  it("contain shows the whole video with bars", () => {
    const fit = fitTransform(1280, 720, 640, 480, "contain");
    expect(fit.drawHeight).toBeCloseTo(720);
    expect(fit.drawWidth).toBeCloseTo(960);
    expect(fit.offsetX).toBeCloseTo(160);
    expect(fit.offsetY).toBeCloseTo(0);
  });

  it("mirrors x: camera-left (0) lands on the right of the screen", () => {
    const fit = fitTransform(800, 600, 640, 480, "cover");
    expect(normalizedToCanvas(0, 0, fit).x).toBeCloseTo(800);
    expect(normalizedToCanvas(1, 0, fit).x).toBeCloseTo(0);
    expect(normalizedToCanvas(0.5, 0.5, fit)).toEqual({ x: 400, y: 300 });
  });
});
