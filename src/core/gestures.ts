// Gesture maths and the per-hand analyzer. Pure: no DOM, no camera, no clock.
// Everything is expressed relative to handSize so it works at any distance from the camera.

import type { Hand, HandFrame, Vec2 } from "../instruments/Instrument";
import { LM, TIP_INDICES, config as liveConfig } from "../config";
import { angleBetween, clamp, dist, midpoint, scale, sub } from "./geometry";

export interface GestureConfig {
  pinchOn: number;
  pinchOff: number;
  velocityAlpha: number;
  curlFullBendRad: number;
  sideDeadZone: number;
}

/** Average of wrist and the four finger knuckles: a stable "centre of the palm". */
export function palmCenter(lm: Vec2[]): Vec2 {
  const idx = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  let x = 0;
  let y = 0;
  for (const i of idx) {
    x += lm[i]!.x;
    y += lm[i]!.y;
  }
  return { x: x / idx.length, y: y / idx.length };
}

/** wrist -> middle finger knuckle distance. */
export function handSizeOf(lm: Vec2[]): number {
  return dist(lm[LM.WRIST]!, lm[LM.MIDDLE_MCP]!);
}

/** Thumb tip <-> index tip distance divided by handSize. Smaller = more pinched. */
export function pinchRatio(lm: Vec2[], handSize: number): number {
  if (handSize < 1e-6) return Infinity;
  return dist(lm[LM.THUMB_TIP]!, lm[LM.INDEX_TIP]!) / handSize;
}

export interface PinchResult {
  active: boolean;
  /** 0 at (or above) the OFF threshold, 1 at (or below) the ON threshold. */
  strength: number;
}

/** Pinch with hysteresis: switches ON below `pinchOn`, OFF above `pinchOff`, holds in between. */
export function updatePinch(
  wasActive: boolean,
  ratio: number,
  cfg: Pick<GestureConfig, "pinchOn" | "pinchOff">,
): PinchResult {
  // Guard against an inverted config (ON threshold above OFF threshold).
  const on = Math.min(cfg.pinchOn, cfg.pinchOff);
  const off = Math.max(cfg.pinchOn, cfg.pinchOff);
  let active = wasActive;
  if (!wasActive && ratio < on) active = true;
  else if (wasActive && ratio > off) active = false;
  const span = off - on;
  const strength = span > 1e-9 ? clamp((off - ratio) / span, 0, 1) : active ? 1 : 0;
  return { active, strength };
}

/**
 * Per-finger curl, thumb..pinky. 0 = straight, 1 = fully bent.
 * Uses the bend angle at the middle joint between (knuckle -> middle joint) and (middle joint -> tip).
 */
export function fingerCurls(lm: Vec2[], fullBendRad: number): number[] {
  const joints: Array<[number, number, number]> = [
    [LM.THUMB_MCP, LM.THUMB_IP, LM.THUMB_TIP],
    [LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_TIP],
    [LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_TIP],
    [LM.RING_MCP, LM.RING_PIP, LM.RING_TIP],
    [LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_TIP],
  ];
  const full = Math.max(fullBendRad, 1e-3);
  return joints.map(([base, mid, tip]) => {
    const bend = angleBetween(sub(lm[mid]!, lm[base]!), sub(lm[tip]!, lm[mid]!));
    return clamp(bend / full, 0, 1);
  });
}

/** Velocity (units/s) from two positions `dtSec` apart. */
export function velocityOf(prev: Vec2, cur: Vec2, dtSec: number): Vec2 {
  if (dtSec <= 0) return { x: 0, y: 0 };
  return scale(sub(cur, prev), 1 / dtSec);
}

/** Exponential blend of a new velocity sample into the previous estimate. alpha=1 means "no smoothing". */
export function blendVelocity(prev: Vec2, sample: Vec2, alpha: number): Vec2 {
  return {
    x: prev.x + (sample.x - prev.x) * alpha,
    y: prev.y + (sample.y - prev.y) * alpha,
  };
}

// ---------------------------------------------------------------------------
// HandAnalyzer: smoothed landmarks (with stable ids) in, full Hand objects out.
// This is exactly the part of the pipeline that a recording is replayed through.
// ---------------------------------------------------------------------------

export interface TrackedInput {
  id: number;
  /** 21 smoothed landmarks in canvas pixels, mirrored. */
  landmarks: Vec2[];
}

interface HandState {
  prevLandmarks: Vec2[];
  prevPalm: Vec2;
  prevT: number;
  tipVel: Vec2[];
  palmVel: Vec2;
  pinchActive: boolean;
  side: "left" | "right";
}

const ZERO: Vec2 = { x: 0, y: 0 };

export class HandAnalyzer {
  private readonly states = new Map<number, HandState>();

  constructor(private readonly cfg: GestureConfig = liveConfig) {}

  analyze(inputs: TrackedInput[], tMs: number, canvasWidth: number): HandFrame {
    const seen = new Set<number>();
    const palms = inputs.map((h) => palmCenter(h.landmarks));
    const sides = this.decideSides(inputs, palms, canvasWidth);

    const hands: Hand[] = inputs.map((input, i) => {
      seen.add(input.id);
      const lm = input.landmarks;
      const palm = palms[i]!;
      const tips = TIP_INDICES.map((k) => lm[k]!);
      const prev = this.states.get(input.id);

      let tipVel: Vec2[];
      let palmVel: Vec2;
      if (!prev) {
        tipVel = tips.map(() => ZERO);
        palmVel = ZERO;
      } else {
        const dtSec = (tMs - prev.prevT) / 1000;
        if (dtSec > 0) {
          const a = this.cfg.velocityAlpha;
          tipVel = tips.map((tip, k) =>
            blendVelocity(prev.tipVel[k]!, velocityOf(prev.prevLandmarks[TIP_INDICES[k]!]!, tip, dtSec), a),
          );
          palmVel = blendVelocity(prev.palmVel, velocityOf(prev.prevPalm, palm, dtSec), a);
        } else {
          tipVel = prev.tipVel;
          palmVel = prev.palmVel;
        }
      }

      const size = handSizeOf(lm);
      const ratio = pinchRatio(lm, size);
      const pinch = updatePinch(prev?.pinchActive ?? false, ratio, this.cfg);

      this.states.set(input.id, {
        prevLandmarks: lm,
        prevPalm: palm,
        prevT: prev && tMs <= prev.prevT ? prev.prevT : tMs,
        tipVel,
        palmVel,
        pinchActive: pinch.active,
        side: sides[i]!,
      });

      return {
        id: input.id,
        side: sides[i]!,
        landmarks: lm,
        tips,
        tipVelocity: tipVel,
        tipVelocityRel: tipVel.map((v) => sub(v, palmVel)),
        fingerCurl: fingerCurls(lm, this.cfg.curlFullBendRad),
        palmCenter: palm,
        palmVelocity: palmVel,
        handSize: size,
        pinch: {
          active: pinch.active,
          point: midpoint(lm[LM.THUMB_TIP]!, lm[LM.INDEX_TIP]!),
          strength: pinch.strength,
        },
      };
    });

    // Forget hands that are gone (they were released upstream).
    for (const id of [...this.states.keys()]) {
      if (!seen.has(id)) this.states.delete(id);
    }
    return { hands, timestamp: tMs };
  }

  reset(): void {
    this.states.clear();
  }

  /**
   * Side by SCREEN POSITION. Two hands: the one further left is "left". One hand: which half of the screen
   * it is in, with a small dead zone around the centre where it keeps its previous side (no flicker).
   */
  private decideSides(inputs: TrackedInput[], palms: Vec2[], canvasWidth: number): Array<"left" | "right"> {
    const half = canvasWidth / 2;
    if (inputs.length >= 2) {
      const order = palms.map((p, i) => ({ x: p.x, i })).sort((a, b) => a.x - b.x || a.i - b.i);
      const out: Array<"left" | "right"> = palms.map(() => "right");
      out[order[0]!.i] = "left";
      return out;
    }
    return inputs.map((input, i) => {
      const x = palms[i]!.x;
      const dead = this.cfg.sideDeadZone * canvasWidth;
      const prev = this.states.get(input.id)?.side;
      if (prev && Math.abs(x - half) < dead) return prev;
      return x < half ? "left" : "right";
    });
  }
}
