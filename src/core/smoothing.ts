// One Euro filter (Casiez et al. 2012): steady when the hand rests, quick when it moves fast.
// Pure: time is passed in explicitly, so it is deterministic and testable.

import type { Vec2 } from "../instruments/Instrument";

export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

/** Smoothing factor for a low-pass filter with the given cutoff (Hz) and time step (s). */
export function smoothingAlpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

export class OneEuroFilter {
  private xPrev = 0;
  private dxPrev = 0;
  private tPrev = 0;
  private initialized = false;

  /** Filter one sample. `tSec` is the sample time in seconds. */
  filter(x: number, tSec: number, p: OneEuroParams): number {
    if (!this.initialized) {
      this.initialized = true;
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = tSec;
      return x;
    }
    const dt = tSec - this.tPrev;
    if (dt <= 0) return this.xPrev; // duplicate or out-of-order timestamp: keep previous output
    this.tPrev = tSec;

    const dx = (x - this.xPrev) / dt;
    const aD = smoothingAlpha(p.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = p.minCutoff + p.beta * Math.abs(dxHat);
    const a = smoothingAlpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }

  reset(): void {
    this.initialized = false;
  }
}

/** One filter per coordinate of every landmark of one hand. */
export class LandmarkSmoother {
  private readonly fx: OneEuroFilter[];
  private readonly fy: OneEuroFilter[];

  constructor(count = 21) {
    this.fx = Array.from({ length: count }, () => new OneEuroFilter());
    this.fy = Array.from({ length: count }, () => new OneEuroFilter());
  }

  filter(points: Vec2[], tSec: number, p: OneEuroParams): Vec2[] {
    return points.map((pt, i) => ({
      x: this.fx[i]!.filter(pt.x, tSec, p),
      y: this.fy[i]!.filter(pt.y, tSec, p),
    }));
  }
}
