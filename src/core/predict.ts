// Predictive triggering groundwork (PLAN.md section 5): extrapolate a fingertip a little way ahead from its velocity,
// so a fast strike can fire earlier and hide part of the camera + inference delay.
//
// Pure functions. OFF by default (config.predictEnabled) and NOT used by any instrument yet; the harp will opt in.

import type { Hand, Vec2 } from "../instruments/Instrument";

export interface PredictConfig {
  predictEnabled: boolean;
  /** ms ahead. */
  predictLeadMs: number;
  /** Longest allowed shift, as a fraction of handSize. */
  predictMaxShift: number;
}

/**
 * `pos + velocity * leadMs/1000`, with the shift clamped to `maxShift` (same unit as `pos`).
 * No lead, zero velocity or a non-finite input returns `pos` unchanged.
 */
export function extrapolate(pos: Vec2, velocity: Vec2, leadMs: number, maxShift: number): Vec2 {
  if (!(leadMs > 0) || !(maxShift > 0)) return pos;
  let dx = (velocity.x * leadMs) / 1000;
  let dy = (velocity.y * leadMs) / 1000;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return pos;
  const len = Math.hypot(dx, dy);
  if (len > maxShift) {
    const k = maxShift / len;
    dx *= k;
    dy *= k;
  }
  return { x: pos.x + dx, y: pos.y + dy };
}

/**
 * Predicted position of one fingertip of `hand` (index 0..4 = thumb..pinky). With prediction off it returns the
 * measured tip, so an instrument can always call this and just obey the config.
 */
export function predictedTip(hand: Hand, finger: number, cfg: PredictConfig): Vec2 {
  const tip = hand.tips[finger]!;
  if (!cfg.predictEnabled) return tip;
  return extrapolate(tip, hand.tipVelocity[finger]!, cfg.predictLeadMs, cfg.predictMaxShift * hand.handSize);
}

// --- drawing only: the whole skeleton, moved forward by the lag ---------------------------------------------------
//
// The skeleton comes from a camera frame that is `frame age` old (~100+ ms with the worker), so it trails the hand the
// player sees. For DRAWING we shift every joint forward by `leadMs` along its velocity. Only the 5 fingertips and the
// palm have a measured velocity, so a joint gets a blend: the palm velocity at the wrist / knuckles, the fingertip
// velocity at the tip, linearly in between (joint k of 4 along a finger = k/3 of the way to the tip).
// Instruments never see these points: this does not touch HandFrame.

/** Index (0..4 = thumb..pinky) of the finger a landmark belongs to, and how far along it is (0 = knuckle, 1 = tip). -1 = wrist. */
export function jointFinger(landmark: number): { finger: number; along: number } | null {
  if (landmark <= 0) return null;
  return { finger: Math.floor((landmark - 1) / 4), along: ((landmark - 1) % 4) / 3 };
}

/**
 * Writes the drawn position of all landmarks of `hand` into `out` (reused every frame: no allocation once it is full)
 * and returns it. `maxShift` is in px (use fraction x handSize). Lead <= 0 gives the measured positions.
 */
export function predictLandmarksInto(out: Vec2[], hand: Hand, leadMs: number, maxShift: number): Vec2[] {
  const lm = hand.landmarks;
  const pv = hand.palmVelocity;
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i]!;
    const jf = jointFinger(i);
    let vx = pv.x;
    let vy = pv.y;
    if (jf) {
      const tv = hand.tipVelocity[jf.finger]!;
      vx += (tv.x - pv.x) * jf.along;
      vy += (tv.y - pv.y) * jf.along;
    }
    const q = extrapolate(p, { x: vx, y: vy }, leadMs, maxShift);
    const slot = out[i];
    if (slot) {
      slot.x = q.x;
      slot.y = q.y;
    } else {
      out[i] = { x: q.x, y: q.y };
    }
  }
  out.length = lm.length;
  return out;
}
