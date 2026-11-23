// The air piano's LOGIC (PLAN.md 6.4), pure: hands in, note-on / note-off events out.
//
// A PRESS is NOT "the fingertip moved down" (moving the whole hand would press every finger at once). It is a finger BENDING:
//   - FLEX: the fingertip comes closer to its knuckle (tip-to-knuckle distance / the finger's usual length). This is what a
//     webcam really sees: a hand facing the camera bends its fingers TOWARD the camera, where the 2D joint angle hardly changes
//     but the finger gets shorter in the picture. (The old angle-based `fingerCurl` alone missed most real presses.)
//   - CURL: the joint angle (`fingerCurl`), the other way to see a bend (a finger bending sideways in the picture).
//   - REL: the tip moving DOWN relative to the palm (`tipVelocityRel`, the hand's own motion removed).
// The first two are "bend" signals (the stronger counts), the third is the speed. A press needs ONE signal clearly strong
// (1.6 x its minimum) OR one at its minimum and the other at least half of its minimum. Moving the whole hand gives none of
// them. All minimums are scaled by `pianoEase` (the Easy / Normal / Strict buttons).
// WHICH KEY: the key under the fingertip where the finger RESTED just before the press (the tip drifts while it bends and the
// picture is ~100 ms old), else the key under the tip now.
// RELEASE: the signal that caused the press falls half-way back, or the hand is lost.
// FALSE-TRIGGER PROTECTION: sympathetic fingers (a neighbour that moved much more at the same moment wins; ring and pinky move
// together), thumb off by default, nothing while the palm moves fast (a swipe) or the hand pinches, a per-finger cooldown, the
// same key never twice at once. Every finger is independent, so chords work. Speeds are in hand sizes per second.

import { clamp } from "../../core/geometry";
import type { Hand, HandFrame, Vec2 } from "../Instrument";
import { keyAt, layoutKeys, type Key, type Layout } from "./layout";

export interface PianoConfig {
  pianoOctaves: number;
  pianoLowOctave: number;
  pianoThumb: boolean;
  pianoCurlMin: number;
  pianoFlexMin: number;
  pianoRelMin: number;
  pianoRelFull: number;
  pianoEase: number;
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
      /** What the press measured (for tuning): tip speed down relative to the palm (hand sizes/s), flex rise, curl rise. */
      rel: number;
      flexRise: number;
      curlRise: number;
    }
  | { type: "off"; id: number; midi: number };

/** The window in which a rise of a bend signal counts as "fast". */
const WINDOW_MS = 160;
/** How much of a signal the OTHER one must have (as a fraction of its own minimum) for a press. */
const SUPPORT = 0.5;
/** One signal alone is enough when it is this many times its minimum. */
const STRONG = 1.6;
/** A neighbour only suppresses a finger if it really is moving (its own signals add up to at least this many minimums). */
const NEIGHBOUR_MIN = 1;
/** The tip may be this many hand sizes above the keys and still count as "over" them. */
const HOVER_MARGIN_HANDS = 1.0;
/** Usual finger length (MCP to tip, straight) in hand sizes (wrist to middle knuckle): thumb, index, middle, ring, pinky. */
const FINGER_LENGTH = [0.55, 0.9, 1.0, 0.9, 0.7] as const;
/** Landmark index of the knuckle (MCP) and the tip of each finger. */
const MCP = [2, 5, 9, 13, 17] as const;
const TIP = [4, 8, 12, 16, 20] as const;
/** Flex rate (flex per second) and curl rate of a soft and of a hard press. */
const FLEX_RATE_SOFT = 0.4;
const FLEX_RATE_HARD = 3;
const CURL_RATE_SOFT = 1;
const CURL_RATE_HARD = 7;

/** 0 = the finger looks as long as usual .. 1 = the tip is at the knuckle. Pure, tested. */
export function fingerFlex(hand: Hand, k: number): number {
  const mcp = hand.landmarks[MCP[k]!]!;
  const tip = hand.landmarks[TIP[k]!]!;
  const len = FINGER_LENGTH[k]! * Math.max(1, hand.handSize);
  return clamp(1 - Math.hypot(tip.x - mcp.x, tip.y - mcp.y) / len, 0, 1);
}

interface Sample {
  t: number;
  curl: number;
  flex: number;
  pos: Vec2;
}

interface FingerState {
  hist: Sample[];
  down: boolean;
  midi: number;
  /** Which signal caused the press, its value before the press and its peak since. */
  signal: "curl" | "flex";
  base: number;
  peak: number;
  lastPressAt: number;
}

interface HandState {
  fingers: FingerState[];
}

const newFinger = (): FingerState => ({ hist: [], down: false, midi: 0, signal: "flex", base: 0, peak: 0, lastPressAt: -Infinity });

/**
 * Speed -> loudness 0.2..1 (square-root feel: soft presses stay audible, hard ones saturate). Three measures, the loudest wins:
 * the tip's speed down relative to the palm, and how FAST the curl and the flex rose. The detection frame alone says little:
 * smoothing delays a fast press, so it is caught only when it is already underway.
 */
export function pressVelocity(relSpeed: number, curlRate: number, flexRate: number, relMin: number, relFull: number): number {
  const a = clamp((relSpeed - relMin) / Math.max(0.01, relFull - relMin), 0, 1);
  const b = clamp((curlRate - CURL_RATE_SOFT) / (CURL_RATE_HARD - CURL_RATE_SOFT), 0, 1);
  const c = clamp((flexRate - FLEX_RATE_SOFT) / (FLEX_RATE_HARD - FLEX_RATE_SOFT), 0, 1);
  return 0.2 + 0.8 * Math.sqrt(Math.max(a, b, c));
}

/** How close a finger is to registering a press, 0..1.3 (1 = it plays): `a` = bend signal, `b` = speed signal, in minimums. */
export function pressProgress(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  const strong = hi / STRONG;
  const combo = Math.min(hi, 1) * Math.min(1, lo / SUPPORT);
  return Math.min(1.3, Math.max(strong, combo));
}

export class PianoModel {
  layout: Layout;
  /** Keys that are down now (midi -> finger id), for drawing. */
  readonly down = new Map<number, number>();
  /** For drawing: per finger id, the key its tip hovers over (or null). Rebuilt every frame. */
  readonly hover = new Map<number, Key | null>();
  /** For drawing: per finger id, how close the finger is to registering a press (see pressProgress). Rebuilt every frame. */
  readonly meter = new Map<number, number>();

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
    this.meter.clear();
    for (const hand of frame.hands) {
      let st = this.hands.get(hand.id);
      if (!st) {
        st = { fingers: Array.from({ length: 5 }, newFinger) };
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
    const ease = clamp(cfg.pianoEase, 0.3, 3);
    const curlMin = Math.max(1e-6, cfg.pianoCurlMin * ease);
    const flexMin = Math.max(1e-6, cfg.pianoFlexMin * ease);
    const relMin = Math.max(1e-6, cfg.pianoRelMin * ease);
    const hs = Math.max(1, hand.handSize);
    const palmSpeed = Math.hypot(hand.palmVelocity.x, hand.palmVelocity.y) / hs;
    const canPress = !hand.pinch.active && palmSpeed <= cfg.pianoMaxPalmSpeed;
    const first = cfg.pianoThumb ? 0 : 1;

    // 1. Signals for every finger, and the release of keys that are down.
    const motion = [0, 0, 0, 0, 0];
    const rel = [0, 0, 0, 0, 0];
    const curlRise = [0, 0, 0, 0, 0];
    const flexRise = [0, 0, 0, 0, 0];
    const curlRate = [0, 0, 0, 0, 0];
    const flexRate = [0, 0, 0, 0, 0];
    const rest: Vec2[] = [hand.tips[0]!, hand.tips[1]!, hand.tips[2]!, hand.tips[3]!, hand.tips[4]!];
    const cand = [false, false, false, false, false];
    for (let k = first; k < 5; k++) {
      const f = st.fingers[k]!;
      const curl = hand.fingerCurl[k]!;
      const flex = fingerFlex(hand, k);
      f.hist.push({ t: now, curl, flex, pos: hand.tips[k]! });
      while (f.hist.length > 0 && now - f.hist[0]!.t > WINDOW_MS) f.hist.shift();
      let lowCurl = curl;
      let lowFlex = flex;
      let lowFlexPos = hand.tips[k]!;
      let steepCurl = 0;
      let steepFlex = 0;
      for (const s of f.hist) {
        if (s.curl < lowCurl) lowCurl = s.curl;
        if (s.flex < lowFlex) {
          lowFlex = s.flex;
          lowFlexPos = s.pos;
        }
        // the steepest climb from any recent sample to now (an old, slightly lower resting value must not slow the estimate down)
        const dt = Math.max(0.03, (now - s.t) / 1000);
        steepCurl = Math.max(steepCurl, (curl - s.curl) / dt);
        steepFlex = Math.max(steepFlex, (flex - s.flex) / dt);
      }
      curlRise[k] = Math.max(0, curl - lowCurl);
      flexRise[k] = Math.max(0, flex - lowFlex);
      curlRate[k] = steepCurl;
      flexRate[k] = steepFlex;
      rest[k] = lowFlexPos;
      rel[k] = Math.max(0, hand.tipVelocityRel[k]!.y) / hs; // y grows downward: the tip moving down relative to the palm

      const a = Math.max(curlRise[k]! / curlMin, flexRise[k]! / flexMin); // the stronger bend signal
      const b = rel[k]! / relMin;
      motion[k] = a + b;
      cand[k] = a >= STRONG || b >= STRONG || (a >= 1 && b >= SUPPORT) || (b >= 1 && a >= SUPPORT);
      this.meter.set(hand.id * 8 + k, f.down ? 1 : pressProgress(a, b));

      if (f.down) {
        const value = f.signal === "curl" ? curl : flex;
        f.peak = Math.max(f.peak, value);
        // Released when the signal that caused the press has fallen back part of the way from its peak.
        if (value <= f.base + (1 - cfg.pianoReleaseFrac) * (f.peak - f.base)) this.release(hand.id * 8 + k, f, events);
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
      const key = keyAt(rest[k]!, this.layout, HOVER_MARGIN_HANDS * hs) ?? keyAt(tip, this.layout, HOVER_MARGIN_HANDS * hs);
      if (!key) continue;
      // The same key cannot be played twice at once (two fingers over one key): the stronger finger already has it.
      if (this.down.has(key.midi)) continue;

      const viaCurl = curlRise[k]! / curlMin > flexRise[k]! / flexMin;
      f.signal = viaCurl ? "curl" : "flex";
      const now_ = viaCurl ? hand.fingerCurl[k]! : fingerFlex(hand, k);
      let low = now_;
      for (const s of f.hist) low = Math.min(low, viaCurl ? s.curl : s.flex);
      f.base = low;
      f.peak = now_;
      f.down = true;
      f.midi = key.midi;
      f.lastPressAt = now;
      this.down.set(key.midi, hand.id * 8 + k);
      events.push({
        type: "on",
        id: hand.id * 8 + k,
        midi: key.midi,
        velocity: pressVelocity(rel[k]!, curlRate[k]!, flexRate[k]!, relMin, cfg.pianoRelFull),
        point: tip,
        handId: hand.id,
        finger: k,
        rel: rel[k]!,
        flexRise: flexRise[k]!,
        curlRise: curlRise[k]!,
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
