// The air piano's LOGIC (PLAN.md 6.4), pure: hands in, note-on / note-off events out.
//
// A PRESS is NOT "the fingertip moved down" (moving the whole hand would press every finger at once). It is a finger BENDING:
// its `fingerCurl` rises quickly AND its tip moves down relative to the palm (`tipVelocityRel`, the hand's own motion removed),
// while the tip is over a key. Both signals must be there: one strong and the other at least half as strong. Hand motion
// without bending (a sideways swipe) gives neither; a curl wobble without the tip moving down gives only one.
// RELEASE: the curl comes back (falls `pianoReleaseFrac` of the way back from its peak), or the hand is lost.
// FALSE-TRIGGER PROTECTION: (1) the minimums above; (2) SYMPATHETIC FINGERS: if a neighbour finger moves much more at the same
// moment (ring and pinky move together anatomically), the weaker one is dropped; (3) the thumb is ignored by default;
// (4) no presses while the whole palm moves fast (a swipe) or while the hand pinches; (5) a per-finger cooldown.
// All 10 fingers are independent, so chords work. Speeds are in hand sizes per second, so distance to the camera does not matter.

import { clamp } from "../../core/geometry";
import type { Hand, HandFrame, Vec2 } from "../Instrument";
import { keyAt, layoutKeys, type Key, type Layout } from "./layout";

export interface PianoConfig {
  pianoOctaves: number;
  pianoLowOctave: number;
  pianoThumb: boolean;
  pianoCurlMin: number;
  pianoRelMin: number;
  pianoRelFull: number;
  pianoSympathy: number;
  pianoMaxPalmSpeed: number;
  pianoCooldownMs: number;
  pianoReleaseFrac: number;
}

export type PianoEvent =
  | {
      type: "on";
      /** Identifies the finger (hand id x 8 + finger 0..4). */
      id: number;
      midi: number;
      /** 0.2..1 */
      velocity: number;
      /** Where the fingertip was (canvas px). */
      point: Vec2;
      handId: number;
      finger: number;
      /** What the press measured (for tuning): tip speed down relative to the palm (hand sizes/s), curl rise (0..1), curl rate (per s). */
      rel: number;
      rise: number;
      rate: number;
    }
  | { type: "off"; id: number; midi: number };

/** The window in which a rise of the curl counts as "fast". */
const CURL_WINDOW_MS = 160;
/** How much of a signal the OTHER one must have (as a fraction of its own minimum) for a press. */
const SUPPORT = 0.5;
/** A neighbour only suppresses a finger if it really is moving (its own signals add up to at least this many minimums). */
const NEIGHBOUR_MIN = 1;
/** The tip may be this many hand sizes above the keys and still count as "over" them. */
const HOVER_MARGIN_HANDS = 0.6;

interface FingerState {
  hist: Array<{ t: number; c: number }>;
  down: boolean;
  midi: number;
  base: number;
  peak: number;
  lastPressAt: number;
}

interface HandState {
  fingers: FingerState[];
  seen: boolean;
}

const newFinger = (): FingerState => ({ hist: [], down: false, midi: 0, base: 0, peak: 0, lastPressAt: -Infinity });

/** Curl rates (curl per second) of a soft and of a hard press. */
const RATE_SOFT = 1;
const RATE_HARD = 7;

/**
 * Speed -> loudness 0.2..1 (square-root feel: soft presses stay audible, hard ones saturate). Two measures, the louder wins:
 * the tip's speed down relative to the palm, and how FAST the curl rose (curl per second since it started to rise). The
 * detection frame alone says little: smoothing delays a fast press, so it is caught only when it is already underway.
 */
export function pressVelocity(relSpeed: number, curlRate: number, relMin: number, relFull: number): number {
  const a = clamp((relSpeed - relMin) / Math.max(0.01, relFull - relMin), 0, 1);
  const b = clamp((curlRate - RATE_SOFT) / (RATE_HARD - RATE_SOFT), 0, 1);
  return 0.2 + 0.8 * Math.sqrt(Math.max(a, b));
}

export class PianoModel {
  layout: Layout;
  /** Keys that are down now (midi -> finger id), for drawing. */
  readonly down = new Map<number, number>();
  /** For drawing: per finger id, the key its tip hovers over (or null). Rebuilt every frame. */
  readonly hover = new Map<number, Key | null>();

  private readonly hands = new Map<number, HandState>();
  private w = 1280;
  private h = 720;
  private layoutKey = "";

  constructor(private readonly cfg: PianoConfig) {
    this.layout = layoutKeys(this.w, this.h, cfg.pianoOctaves, cfg.pianoLowOctave);
    this.layoutKey = this.keyOfLayout();
  }

  setViewport(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.relayout();
  }

  private keyOfLayout(): string {
    return `${this.w}x${this.h}|${this.cfg.pianoOctaves}|${this.cfg.pianoLowOctave}`;
  }

  private relayout(): void {
    const key = this.keyOfLayout();
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.layout = layoutKeys(this.w, this.h, this.cfg.pianoOctaves, this.cfg.pianoLowOctave);
  }

  update(frame: HandFrame, now: number): PianoEvent[] {
    this.relayout(); // octaves / low octave may have been changed in the panel
    const events: PianoEvent[] = [];
    const present = new Set(frame.hands.map((h) => h.id));

    // A lost hand lets go of its keys.
    for (const [id, st] of this.hands) {
      if (present.has(id)) continue;
      st.fingers.forEach((f, k) => {
        if (f.down) this.release(id * 8 + k, f, events);
      });
      this.hands.delete(id);
    }

    this.hover.clear();
    for (const hand of frame.hands) {
      let st = this.hands.get(hand.id);
      if (!st) {
        st = { fingers: Array.from({ length: 5 }, newFinger), seen: true };
        this.hands.set(hand.id, st);
      }
      this.updateHand(hand, st, now, events);
    }
    return events;
  }

  private release(id: number, f: FingerState, events: PianoEvent[]): void {
    f.down = false;
    this.down.delete(f.midi);
    events.push({ type: "off", id, midi: f.midi });
  }

  private updateHand(hand: Hand, st: HandState, now: number, events: PianoEvent[]): void {
    const cfg = this.cfg;
    const hs = Math.max(1, hand.handSize);
    const palmSpeed = Math.hypot(hand.palmVelocity.x, hand.palmVelocity.y) / hs;
    const canPress = !hand.pinch.active && palmSpeed <= cfg.pianoMaxPalmSpeed;
    const first = cfg.pianoThumb ? 0 : 1;

    // 1. Signals for every finger, and the release of keys that are down.
    const motion: number[] = [0, 0, 0, 0, 0];
    const rise: number[] = [0, 0, 0, 0, 0];
    const rate: number[] = [0, 0, 0, 0, 0];
    const rel: number[] = [0, 0, 0, 0, 0];
    const cand: boolean[] = [false, false, false, false, false];
    for (let k = first; k < 5; k++) {
      const f = st.fingers[k]!;
      const curl = hand.fingerCurl[k]!;
      f.hist.push({ t: now, c: curl });
      while (f.hist.length > 0 && now - f.hist[0]!.t > CURL_WINDOW_MS) f.hist.shift();
      let lowest = curl;
      let steepest = 0;
      for (const s of f.hist) {
        if (s.c < lowest) lowest = s.c;
        // the steepest climb from any recent sample to now (an old, slightly lower resting value must not slow the estimate down)
        steepest = Math.max(steepest, (curl - s.c) / Math.max(0.03, (now - s.t) / 1000));
      }
      rise[k] = Math.max(0, curl - lowest);
      rate[k] = steepest;
      rel[k] = Math.max(0, hand.tipVelocityRel[k]!.y) / hs; // y grows downward: the tip moving down relative to the palm
      const a = rise[k]! / Math.max(1e-6, cfg.pianoCurlMin);
      const b = rel[k]! / Math.max(1e-6, cfg.pianoRelMin);
      motion[k] = a + b;
      cand[k] = (a >= 1 && b >= SUPPORT) || (b >= 1 && a >= SUPPORT);

      if (f.down) {
        f.peak = Math.max(f.peak, curl);
        // Released when the curl has fallen back part of the way from its peak.
        if (curl <= f.base + (1 - cfg.pianoReleaseFrac) * (f.peak - f.base)) this.release(hand.id * 8 + k, f, events);
      }
    }

    // 2. Hover (for drawing) for every fingertip.
    for (let k = 0; k < 5; k++) this.hover.set(hand.id * 8 + k, keyAt(hand.tips[k]!, this.layout, HOVER_MARGIN_HANDS * hs));

    if (!canPress) return;

    // 3. Presses, with sympathetic-finger suppression.
    for (let k = first; k < 5; k++) {
      const f = st.fingers[k]!;
      if (!cand[k] || f.down || now - f.lastPressAt < cfg.pianoCooldownMs) continue;
      let suppressed = false;
      for (const j of [k - 1, k + 1]) {
        if (j < first || j > 4) continue;
        // a neighbour that moved much more at the same moment is the one that really pressed
        if (motion[j]! >= NEIGHBOUR_MIN && motion[j]! > cfg.pianoSympathy * motion[k]!) suppressed = true;
      }
      if (suppressed) continue;
      const tip = hand.tips[k]!;
      const key = keyAt(tip, this.layout, HOVER_MARGIN_HANDS * hs);
      if (!key) continue;
      // The same key cannot be played twice at once (two fingers over one key): the stronger finger already has it.
      if (this.down.has(key.midi)) continue;
      f.down = true;
      f.midi = key.midi;
      f.lastPressAt = now;
      let lowest = hand.fingerCurl[k]!;
      for (const s of f.hist) if (s.c < lowest) lowest = s.c;
      f.base = lowest;
      f.peak = hand.fingerCurl[k]!;
      this.down.set(key.midi, hand.id * 8 + k);
      events.push({
        type: "on",
        id: hand.id * 8 + k,
        midi: key.midi,
        velocity: pressVelocity(rel[k]!, rate[k]!, cfg.pianoRelMin, cfg.pianoRelFull),
        point: tip,
        handId: hand.id,
        finger: k,
        rel: rel[k]!,
        rise: rise[k]!,
        rate: rate[k]!,
      });
    }
  }

  reset(): PianoEvent[] {
    const events: PianoEvent[] = [];
    for (const [id, st] of this.hands) st.fingers.forEach((f, k) => f.down && this.release(id * 8 + k, f, events));
    this.hands.clear();
    this.down.clear();
    return events;
  }
}
