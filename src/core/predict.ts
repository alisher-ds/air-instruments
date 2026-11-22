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
