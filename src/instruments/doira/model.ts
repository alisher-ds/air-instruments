// The doira's LOGIC (PLAN.md 6.2), pure: hands in, hits out. No audio, no DOM, no drawing; tested with synthetic hands.
//
// The webcam cannot see depth, so a HIT is defined in 2D (PLAN.md):
//   1. ENTER: the palm centre comes into the drum circle (or crosses it between two tracking frames) fast enough, or
//   2. SLAM-AND-STOP: the palm was fast a moment ago and is now (almost) still inside the circle,
// whichever happens first. Speed -> loudness. After a hit that hand must leave the circle or slow down before it can hit
// again, and it has a short cooldown (one hit = one sound). Two hands are independent, so fast alternating rhythms work.
// FINGER TAPS: a fingertip over the drum moving fast relative to the palm (tipVelocityRel) while the palm itself is slow
// = a soft tap (finger rolls). At most one tap per hand per frame (the strongest finger), because fingers move together.
// ZONE: the distance of the strike from the centre (0 = centre = "bum", 1 = rim = "tak").
// MOVING THE DRUM: pinch inside the drum (hand not a fist, not moving fast) and drag; the position is saved by the caller.
// Positions use PREDICTED palm positions when config.predictEnabled (hides part of the camera delay), like the harp.

import { clamp, dist } from "../../core/geometry";
import { extrapolate, type PredictConfig } from "../../core/predict";
import { isFist } from "../harp/model";
import type { Hand, HandFrame, Vec2 } from "../Instrument";

export interface DoiraConfig extends PredictConfig {
  harpFistCurl: number;
  doiraRadiusFrac: number;
  doiraHitMinSpeed: number;
  doiraHitFullSpeed: number;
  doiraSpikeSpeed: number;
  doiraStopRatio: number;
  doiraRearmSpeed: number;
  doiraHitCooldownMs: number;
  doiraTapMinSpeed: number;
  doiraTapFullSpeed: number;
  doiraTapCooldownMs: number;
  doiraPinchLockoutMs: number;
}

export type DoiraEvent =
  | {
      type: "hit";
      kind: "palm" | "finger";
      handId: number;
      /** Where on the skin (canvas px). */
      point: Vec2;
      /** 0..1 loudness. */
      velocity: number;
      /** 0 = centre ("bum") .. 1 = rim ("tak"). */
      zone: number;
      /** Hand sizes per second that caused it. */
      speed: number;
    }
  | { type: "moved" };

const SPEED_WINDOW_MS = 150;
const ENTER_ZONE_FACTOR = 0.65;
const AFTER_HIT_NO_TAP_MS = 120;
const TAP_PALM_MAX_SPEED = 1.5; // hand sizes/s: a finger tap needs a calm palm
const DRAG_START_MAX_SPEED = 2; // hand sizes/s: a hand that is hitting does not pick the drum up

interface FingerState {
  prevRel: number;
  lastTapAt: number;
}

interface HandState {
  prevPalm: Vec2 | null;
  prevEff: Vec2 | null;
  prevT: number;
  armed: boolean;
  /** Recent palm speeds (hand sizes/s, measured between tracking frames). */
  speeds: Array<{ t: number; v: number }>;
  lastHitAt: number;
  pinching: boolean;
  pinchEndedAt: number;
  dragging: boolean;
  dragOffset: Vec2;
  fingers: FingerState[];
}

function newState(): HandState {
  return {
    prevPalm: null,
    prevEff: null,
    prevT: 0,
    armed: true,
    speeds: [],
    lastHitAt: -Infinity,
    pinching: false,
    pinchEndedAt: -Infinity,
    dragging: false,
    dragOffset: { x: 0, y: 0 },
    fingers: Array.from({ length: 5 }, () => ({ prevRel: 0, lastTapAt: -Infinity })),
  };
}

/** Closest point of segment ab to p. */
function nearestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-12 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** 0 at the centre .. 1 at the rim (the crossfade between bum and tak starts at 0.4 R and ends at 0.85 R). Pure, tested. */
export function zoneOf(point: Vec2, center: Vec2, radius: number): number {
  if (!(radius > 0)) return 0;
  return clamp((dist(point, center) / radius - 0.4) / 0.45, 0, 1);
}

/** Speed (hand sizes/s) -> loudness 0.12..1 (palm) with a square-root feel: soft hits stay audible, hard ones saturate. */
export function loudness(speed: number, minSpeed: number, fullSpeed: number): number {
  const span = Math.max(0.01, fullSpeed - minSpeed);
  return 0.12 + 0.88 * Math.sqrt(clamp((speed - minSpeed) / span, 0, 1));
}

export class DoiraModel {
  /** Drum centre as a fraction of the window (so it survives a resize). */
  fx = 0.5;
  fy = 0.62;
  /** Hands currently pinching the drum (dragging it). */
  dragging = new Set<number>();
  /** For drawing: can this hand hit now? and where its palm is (predicted). */
  readonly handInfo = new Map<number, { armed: boolean; palm: Vec2 }>();

  private readonly hands = new Map<number, HandState>();
  private w = 1280;
  private h = 720;

  constructor(private readonly cfg: DoiraConfig) {}

  setViewport(w: number, h: number): void {
    this.w = w;
    this.h = h;
  }

  get center(): Vec2 {
    return { x: this.fx * this.w, y: this.fy * this.h };
  }

  get radius(): number {
    return this.cfg.doiraRadiusFrac * Math.min(this.w, this.h);
  }

  setPosition(fx: number, fy: number): void {
    this.fx = clamp(Number.isFinite(fx) ? fx : 0.5, 0.1, 0.9);
    this.fy = clamp(Number.isFinite(fy) ? fy : 0.62, 0.15, 0.9);
  }

  resetPosition(): void {
    this.setPosition(0.5, 0.62);
  }

  update(frame: HandFrame, now: number): DoiraEvent[] {
    const events: DoiraEvent[] = [];
    const present = new Set(frame.hands.map((h) => h.id));
    for (const [id, st] of this.hands) {
      if (present.has(id)) continue;
      if (st.dragging) events.push({ type: "moved" });
      this.hands.delete(id);
    }
    this.dragging.clear();
    this.handInfo.clear();

    const c = this.center;
    const R = this.radius;
    const hands = [...frame.hands].sort((a, b) => a.id - b.id);
    for (const hand of hands) {
      let st = this.hands.get(hand.id);
      if (!st) {
        st = newState();
        this.hands.set(hand.id, st);
      }
      this.updateHand(hand, st, now, c, R, events);
    }
    return events;
  }

  private updateHand(hand: Hand, st: HandState, now: number, c: Vec2, R: number, events: DoiraEvent[]): void {
    const cfg = this.cfg;
    const hs = Math.max(1, hand.handSize);
    const palm = hand.palmCenter;
    const dtSec = st.prevPalm ? (now - st.prevT) / 1000 : 0;
    const segSpeed = st.prevPalm && dtSec > 0.004 ? dist(palm, st.prevPalm) / dtSec / hs : 0;
    const vSpeed = Math.hypot(hand.palmVelocity.x, hand.palmVelocity.y) / hs;
    const eff = cfg.predictEnabled ? extrapolate(palm, hand.palmVelocity, cfg.predictLeadMs, cfg.predictMaxShift * hs) : palm;

    // --- pinch: moving the drum ---
    const pinchNow = hand.pinch.active;
    if (pinchNow && !st.pinching) {
      const p = hand.pinch.point;
      if (!isFist(hand, cfg.harpFistCurl) && Math.max(segSpeed, vSpeed) < DRAG_START_MAX_SPEED && dist(p, c) <= 1.2 * R) {
        st.dragging = true;
        st.dragOffset = { x: c.x - p.x, y: c.y - p.y };
      }
    } else if (!pinchNow && st.pinching) {
      if (st.dragging) events.push({ type: "moved" });
      st.dragging = false;
      st.pinchEndedAt = now;
    }
    st.pinching = pinchNow;
    if (pinchNow && st.dragging) {
      const p = hand.pinch.point;
      this.setPosition((p.x + st.dragOffset.x) / this.w, (p.y + st.dragOffset.y) / this.h);
      this.dragging.add(hand.id);
    }

    const blocked = pinchNow || now - st.pinchEndedAt < cfg.doiraPinchLockoutMs;

    const inside1 = dist(eff, c) <= R;
    const inside0 = st.prevEff ? dist(st.prevEff, c) <= R : inside1;
    // Re-arm: the hand left the drum, or slowed down. The speed history starts again from there, so the fast tail of
    // the movement that just hit cannot count as a new "slam" when the hand finally stops (one hit = one sound).
    if (!st.armed && (!inside1 || segSpeed < cfg.doiraRearmSpeed)) {
      st.armed = true;
      st.speeds = [];
    }

    // --- speed history (for slam-and-stop), only while the hand is able to hit ---
    const peakBefore = st.speeds.reduce((m, s) => (now - s.t <= SPEED_WINDOW_MS ? Math.max(m, s.v) : m), 0);
    if (st.armed) st.speeds.push({ t: now, v: segSpeed });
    st.speeds = st.speeds.filter((s) => now - s.t <= SPEED_WINDOW_MS);

    let hitThisFrame = false;
    if (!blocked && st.armed && st.prevEff && now - st.lastHitAt >= cfg.doiraHitCooldownMs) {
      const enterSpeed = Math.max(segSpeed, vSpeed);
      const crossed = !inside0 && (inside1 || dist(c, nearestOnSegment(c, st.prevEff, eff)) <= R);
      let point: Vec2 | null = null;
      let speed = 0;
      let zoneK = 1;
      if (crossed && enterSpeed >= cfg.doiraHitMinSpeed) {
        point = inside1 ? eff : nearestOnSegment(c, st.prevEff, eff);
        speed = enterSpeed;
        // A hand that comes in from outside is first seen just inside the edge, whatever it aims at: that is not a rim
        // strike. Pull entering hits toward the centre ("bum"); a slam-and-stop inside the drum keeps its true position.
        zoneK = ENTER_ZONE_FACTOR;
      } else if (inside1 && peakBefore >= cfg.doiraSpikeSpeed && segSpeed <= cfg.doiraStopRatio * peakBefore) {
        point = eff;
        speed = peakBefore;
      }
      if (point) {
        hitThisFrame = true;
        st.armed = false;
        st.lastHitAt = now;
        st.speeds = []; // the slam that caused this hit must not cause another when the hand stops
        events.push({
          type: "hit",
          kind: "palm",
          handId: hand.id,
          point,
          velocity: loudness(speed, cfg.doiraHitMinSpeed, cfg.doiraHitFullSpeed),
          zone: zoneOf(point, c, R) * zoneK,
          speed,
        });
      }
    }

    // --- finger taps (one per hand per frame: the strongest finger) ---
    let best: { k: number; rel: number } | null = null;
    const tapAllowed = !hitThisFrame && !blocked && now - st.lastHitAt >= AFTER_HIT_NO_TAP_MS && segSpeed < TAP_PALM_MAX_SPEED;
    for (let k = 1; k <= 4; k++) {
      const f = st.fingers[k]!;
      const v = hand.tipVelocityRel[k]!;
      const rel = Math.hypot(v.x, v.y) / hs;
      const rising = rel >= cfg.doiraTapMinSpeed && f.prevRel < 0.6 * rel;
      if (tapAllowed && rising && now - f.lastTapAt >= cfg.doiraTapCooldownMs && dist(hand.tips[k]!, c) <= 1.05 * R) {
        if (!best || rel > best.rel) best = { k, rel };
      }
      f.prevRel = rel;
    }
    if (best) {
      const tip = hand.tips[best.k]!;
      st.fingers[best.k]!.lastTapAt = now;
      const full = Math.max(cfg.doiraTapMinSpeed + 0.01, cfg.doiraTapFullSpeed);
      events.push({
        type: "hit",
        kind: "finger",
        handId: hand.id,
        point: tip,
        velocity: 0.15 + 0.55 * Math.sqrt(clamp((best.rel - cfg.doiraTapMinSpeed) / (full - cfg.doiraTapMinSpeed), 0, 1)),
        zone: zoneOf(tip, c, R),
        speed: best.rel,
      });
    }

    this.handInfo.set(hand.id, { armed: st.armed, palm: eff });
    st.prevPalm = palm;
    st.prevEff = eff;
    st.prevT = now;
  }
}
