// The harp's LOGIC (PLAN.md 6.1), pure: hands in, strings and events out. No audio, no DOM, no drawing, so it is tested
// with synthetic hands (harp.test.ts) and can replay recordings.
//
//  - Pinch decides by where it STARTS: near a string (body or endpoint, within harpGrabDist hand sizes) = GRAB it
//    (move it; flick it fast toward a screen edge to delete it); in empty space = CREATE.
//  - Create: pinch with both hands -> a line between the two pinch points; release either -> the string is fixed.
//    One hand: pinch, drag, release -> a string from the start to the end point. Too short = cancelled.
//  - Pluck: a fingertip whose path (previous -> current position) crosses a string. A hand that is pinching, grabbing or
//    creating cannot pluck, nor for a moment after its pinch ends. The cooldown is per STRING. Strength comes from the
//    fingertip speed perpendicular to the string; the contact point along the string sets the brightness.
//  - Pitch: string length / canvas diagonal -> a note of the active scale (longer = lower).
//  - Clear all: both open palms held still for harpClearHoldMs. Undo: the last create / delete / move / clear.
//
// Fingertip positions can be PREDICTED a little ahead (config.predictEnabled): the whole pluck analysis then works on the
// predicted path, so each crossing still happens exactly once.

import { midiToFreq, noteForLength, scaleNotes, type ScaleName } from "../../audio/scales";
import { predictedTip, type PredictConfig } from "../../core/predict";
import { clamp, dist, pointSegmentDistance, segmentIntersection, sub } from "../../core/geometry";
import type { Hand, HandFrame, Vec2 } from "../Instrument";

export const MAX_STRINGS = 12;
const MAX_UNDO = 100;
const MAX_STRUM_DELAY_MS = 80;

export interface HarpConfig extends PredictConfig {
  harpScale: ScaleName;
  harpMinLenFrac: number;
  harpMaxLenFrac: number;
  harpMinStringHands: number;
  harpGrabDist: number;
  harpCooldownMs: number;
  harpPluckMinSpeed: number;
  harpPluckFullSpeed: number;
  harpPinchLockoutMs: number;
  harpFlickSpeed: number;
  harpMinPinchMs: number;
  harpFistCurl: number;
  harpClearHoldMs: number;
}

export interface HarpString {
  id: number;
  a: Vec2;
  b: Vec2;
  /** Length in px. */
  length: number;
  midi: number;
  freq: number;
  /** Time of the last pluck (frame time, ms), for the per-string cooldown. */
  lastPluck: number;
}

export type HarpEvent =
  | {
      type: "pluck";
      stringId: number;
      strength: number;
      brightness: number;
      contact: Vec2;
      along: number;
      /** A fast strum crosses several strings inside one tracking frame: play them in crossing order, this many ms apart (0 = now). */
      delayMs: number;
    }
  | { type: "created"; id: number }
  | { type: "deleted"; id: number }
  | { type: "limit" }
  | { type: "cleared"; count: number };

type UndoAction =
  | { type: "create"; id: number }
  | { type: "delete"; string: HarpString }
  | { type: "move"; id: number; a: Vec2; b: Vec2 }
  | { type: "clear"; strings: HarpString[] };

type Mode = "none" | "grab" | "create" | "ignored";

interface HandState {
  mode: Mode;
  /** Effective (maybe predicted) fingertip positions of the previous frame, for the crossing test. */
  prevEff: Vec2[] | null;
  prevT: number;
  pinching: boolean;
  /** Time the last pinch ended (frame time), for the lockout. */
  pinchEndedAt: number;
  /** Time the current pinch began (frame time). */
  pinchStartedAt: number;
  /** Pinch point of the last frame in which the pinch was on. */
  lastPoint: Vec2;
  handSize: number;
  // grab
  grabId: number;
  grabFrom: { a: Vec2; b: Vec2 };
  /** Smoothed velocity of the pinch point while grabbing (px/s). */
  grabVel: Vec2;
  // create
  createStart: Vec2;
  /** The other hand this create is paired with (two-hand creation), or -1. */
  partner: number;
}

function newState(): HandState {
  return {
    mode: "none",
    prevEff: null,
    prevT: 0,
    pinching: false,
    pinchEndedAt: -Infinity,
    pinchStartedAt: 0,
    lastPoint: { x: 0, y: 0 },
    handSize: 100,
    grabId: -1,
    grabFrom: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } },
    grabVel: { x: 0, y: 0 },
    createStart: { x: 0, y: 0 },
    partner: -1,
  };
}

/** Where the pinch point is heading: true if a fast pinch would leave the screen within 0.4 s. Pure, tested. */
export function isFlickToEdge(point: Vec2, velocity: Vec2, handSize: number, w: number, h: number, minSpeedHands: number): boolean {
  const speed = Math.hypot(velocity.x, velocity.y);
  if (!(handSize > 0) || speed < minSpeedHands * handSize) return false;
  const reach = 0.4; // seconds ahead
  const x = point.x + velocity.x * reach;
  const y = point.y + velocity.y * reach;
  return x < 0 || y < 0 || x > w || y > h; // it must really leave the screen: a fast move near an edge is not a delete
}

/**
 * A closed fist (middle, ring and pinky bent): the thumb and index touch while a hand closes or opens, which is NOT a
 * pinch for the harp. A real pinch keeps the other fingers at least partly open.
 */
export function isFist(hand: Hand, maxCurl: number): boolean {
  return (hand.fingerCurl[2]! + hand.fingerCurl[3]! + hand.fingerCurl[4]!) / 3 > maxCurl;
}

/** Is `hand` showing an open, still palm? (clear-all gesture) */
export function isOpenStillPalm(hand: Hand): boolean {
  if (hand.pinch.active || hand.handSize <= 0) return false;
  for (let f = 1; f <= 4; f++) if (hand.fingerCurl[f]! > 0.35) return false;
  const palmSpeed = Math.hypot(hand.palmVelocity.x, hand.palmVelocity.y) / hand.handSize;
  if (palmSpeed > 0.6) return false;
  for (const v of hand.tipVelocity) if (Math.hypot(v.x, v.y) / hand.handSize > 1.2) return false;
  return true;
}

/** Progress (0..1) of "both open palms held still". Any movement or a missing hand resets it. */
export class ClearGesture {
  private since: number | null = null;
  private armed = true;
  progress = 0;
  /** Midpoint of the two palms, where the progress ring is drawn. */
  point: Vec2 = { x: 0, y: 0 };

  /** Returns true on the frame the hold is complete. */
  update(hands: readonly Hand[], now: number, holdMs: number): boolean {
    const ok = hands.length === 2 && hands.every(isOpenStillPalm);
    if (!ok) {
      this.since = null;
      this.progress = 0;
      this.armed = true; // the hands moved: the gesture may start again
      return false;
    }
    this.point = { x: (hands[0]!.palmCenter.x + hands[1]!.palmCenter.x) / 2, y: (hands[0]!.palmCenter.y + hands[1]!.palmCenter.y) / 2 };
    if (!this.armed) return false; // it just fired: wait for a movement before it can fire again
    if (this.since === null) this.since = now;
    this.progress = clamp((now - this.since) / Math.max(1, holdMs), 0, 1);
    if (this.progress >= 1) {
      this.since = null;
      this.progress = 0;
      this.armed = false;
      return true;
    }
    return false;
  }

  reset(): void {
    this.since = null;
    this.progress = 0;
    this.armed = true;
  }
}

/** What a hand is doing right now, for drawing. */
export interface PinchView {
  handId: number;
  point: Vec2;
  mode: Mode;
  /** The string being grabbed (mode "grab"), else -1. */
  stringId: number;
}

export class HarpModel {
  strings: HarpString[] = [];
  /** Create preview (a line between the pinch points), or null. */
  preview: { a: Vec2; b: Vec2; double: boolean; handA: number; handB: number } | null = null;
  /** Hands currently pinching (any mode). */
  pinches: PinchView[] = [];
  /** Strings being grabbed right now. */
  grabbed = new Set<number>();
  readonly clear = new ClearGesture();

  private readonly hands = new Map<number, HandState>();
  private readonly undoStack: UndoAction[] = [];
  private nextId = 1;
  private w = 1280;
  private h = 720;
  private notes: number[];
  private notesScale: ScaleName;

  constructor(private readonly cfg: HarpConfig) {
    this.notesScale = cfg.harpScale;
    this.notes = scaleNotes(cfg.harpScale);
  }

  setViewport(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.retune();
  }

  get diagonal(): number {
    return Math.hypot(this.w, this.h);
  }

  /** Re-maps every string to the active scale (after a scale change or a resize). */
  retune(): void {
    if (this.notesScale !== this.cfg.harpScale) {
      this.notesScale = this.cfg.harpScale;
      this.notes = scaleNotes(this.cfg.harpScale);
    }
    for (const s of this.strings) this.assignNote(s);
  }

  private assignNote(s: HarpString): void {
    s.midi = noteForLength(s.length / this.diagonal, this.notes, { minFrac: this.cfg.harpMinLenFrac, maxFrac: this.cfg.harpMaxLenFrac });
    s.freq = midiToFreq(s.midi);
  }

  private makeString(a: Vec2, b: Vec2, id = this.nextId++): HarpString {
    const s: HarpString = { id, a: { ...a }, b: { ...b }, length: dist(a, b), midi: 0, freq: 0, lastPluck: -Infinity };
    this.assignNote(s);
    return s;
  }

  /** Adds a string directly (used by create, and by tests). Returns null when the limit of MAX_STRINGS is reached. */
  addString(a: Vec2, b: Vec2): HarpString | null {
    if (this.strings.length >= MAX_STRINGS) return null;
    const s = this.makeString(a, b);
    this.strings.push(s);
    this.pushUndo({ type: "create", id: s.id });
    return s;
  }

  stringById(id: number): HarpString | undefined {
    return this.strings.find((s) => s.id === id);
  }

  private pushUndo(a: UndoAction): void {
    this.undoStack.push(a);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  // ------------------------------------------------------------------ public actions (buttons / keys)

  /** Deletes everything (Clear button, C key, or the two-palms gesture). Undoable. */
  clearAll(events: HarpEvent[] = []): void {
    if (this.strings.length === 0) return;
    const gone = this.strings;
    this.strings = [];
    this.grabbed.clear();
    for (const st of this.hands.values()) if (st.mode === "grab") st.mode = "ignored";
    this.pushUndo({ type: "clear", strings: gone });
    events.push({ type: "cleared", count: gone.length });
  }

  /** Undo the last action. Returns the events it caused (so the sound of deleted strings can be stopped). */
  undo(): HarpEvent[] {
    const a = this.undoStack.pop();
    const events: HarpEvent[] = [];
    if (!a) return events;
    switch (a.type) {
      case "create":
        if (this.stringById(a.id)) {
          this.strings = this.strings.filter((s) => s.id !== a.id);
          events.push({ type: "deleted", id: a.id });
        }
        break;
      case "delete":
        if (this.strings.length < MAX_STRINGS) this.strings.push(a.string);
        break;
      case "move": {
        const s = this.stringById(a.id);
        if (s) {
          s.a = { ...a.a };
          s.b = { ...a.b };
        }
        break;
      }
      case "clear":
        for (const s of a.strings) if (this.strings.length < MAX_STRINGS) this.strings.push(s);
        break;
    }
    return events;
  }

  // ------------------------------------------------------------------ per tracking frame

  /** `now` = the frame's arrival time (ms). Returns the events of this frame. */
  update(frame: HandFrame, now: number): HarpEvent[] {
    const events: HarpEvent[] = [];
    const present = new Set(frame.hands.map((h) => h.id));

    // Hands that vanished: release everything they held (PLAN.md: lost hands release their state).
    for (const [id, st] of this.hands) {
      if (present.has(id)) continue;
      this.endPinch(st, now, events, true);
      this.hands.delete(id);
    }

    if (this.clear.update(frame.hands, now, this.cfg.harpClearHoldMs)) this.clearAll(events);

    this.pinches = [];
    this.preview = null;

    // Pass 1: pinch state machines (grab / create), in a fixed order by hand id.
    const hands = [...frame.hands].sort((p, q) => p.id - q.id);
    for (const hand of hands) {
      let st = this.hands.get(hand.id);
      if (!st) {
        st = newState();
        this.hands.set(hand.id, st);
      }
      st.handSize = hand.handSize;
      const pinchNow = hand.pinch.active;
      if (pinchNow && !st.pinching) this.beginPinch(hand, st, now, events);
      else if (!pinchNow && st.pinching) this.endPinch(st, now, events, false);
      else if (pinchNow) this.holdPinch(hand, st, now);
      st.pinching = pinchNow;
      if (pinchNow) st.lastPoint = hand.pinch.point;
    }

    // Pass 2: plucks (after the pinches, so a hand that just started pinching cannot pluck in the same frame).
    this.detectPlucks(hands, now, events);

    this.buildViews(hands);
    return events;
  }

  private findGrab(p: Vec2, handSize: number): HarpString | null {
    const limit = this.cfg.harpGrabDist * handSize;
    let best: HarpString | null = null;
    let bestD = limit;
    for (const s of this.strings) {
      const d = pointSegmentDistance(p, s.a, s.b);
      if (d <= bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  private beginPinch(hand: Hand, st: HandState, now: number, events: HarpEvent[]): void {
    const p = hand.pinch.point;
    st.lastPoint = p;
    st.pinchStartedAt = now;
    if (isFist(hand, this.cfg.harpFistCurl)) {
      st.mode = "ignored"; // a closing fist, not a pinch
      return;
    }
    const hit = this.findGrab(p, hand.handSize);
    if (hit) {
      st.mode = "grab";
      st.grabId = hit.id;
      st.grabFrom = { a: { ...hit.a }, b: { ...hit.b } };
      st.grabVel = { x: 0, y: 0 };
      this.grabbed.add(hit.id);
      return;
    }
    if (this.strings.length >= MAX_STRINGS) {
      st.mode = "ignored";
      events.push({ type: "limit" });
      return;
    }
    st.mode = "create";
    st.createStart = { ...p };
    st.partner = -1;
    // Pair with another hand that is creating on its own: a two-hand string.
    for (const [otherId, other] of this.hands) {
      if (other === st || other.mode !== "create" || other.partner !== -1 || !other.pinching) continue;
      other.partner = hand.id;
      st.partner = otherId;
      break;
    }
  }

  private holdPinch(hand: Hand, st: HandState, now: number): void {
    if (st.mode === "create" && isFist(hand, this.cfg.harpFistCurl)) {
      // The hand closed into a fist while "creating": that was no pinch. Cancel and free the partner.
      if (st.partner >= 0) {
        const partner = this.hands.get(st.partner);
        if (partner) partner.partner = -1;
      }
      st.mode = "ignored";
      st.partner = -1;
      return;
    }
    if (st.mode !== "grab") return;
    const s = this.stringById(st.grabId);
    if (!s) {
      st.mode = "ignored";
      return;
    }
    const p = hand.pinch.point;
    const dx = p.x - st.lastPoint.x;
    const dy = p.y - st.lastPoint.y;
    s.a = { x: s.a.x + dx, y: s.a.y + dy };
    s.b = { x: s.b.x + dx, y: s.b.y + dy };
    // Smoothed speed of the grab, for the flick test at release (the opening fingers make the last frame unreliable).
    const dt = Math.max(1, now - st.prevT) / 1000;
    const inst = { x: dx / dt, y: dy / dt };
    st.grabVel = { x: st.grabVel.x + (inst.x - st.grabVel.x) * 0.6, y: st.grabVel.y + (inst.y - st.grabVel.y) * 0.6 };
  }

  /** The pinch ended (hand opened, or the hand vanished: `gone`). Commits or cancels what it was doing. */
  private endPinch(st: HandState, now: number, events: HarpEvent[], gone: boolean): void {
    if (st.mode === "grab") {
      const s = this.stringById(st.grabId);
      this.grabbed.delete(st.grabId);
      if (s && !gone) {
        const flick = isFlickToEdge(st.lastPoint, st.grabVel, st.handSize, this.w, this.h, this.cfg.harpFlickSpeed);
        if (flick) {
          this.strings = this.strings.filter((x) => x.id !== s.id);
          this.pushUndo({ type: "delete", string: { ...s, a: { ...st.grabFrom.a }, b: { ...st.grabFrom.b } } });
          events.push({ type: "deleted", id: s.id });
        } else if (dist(s.a, st.grabFrom.a) > 2) {
          this.pushUndo({ type: "move", id: s.id, a: st.grabFrom.a, b: st.grabFrom.b });
        }
      }
    } else if (st.mode === "create" && !gone) {
      const partner = st.partner >= 0 ? this.hands.get(st.partner) : undefined;
      const [a, b, size] =
        partner && partner.pinching
          ? ([partner.lastPoint, st.lastPoint, (partner.handSize + st.handSize) / 2] as const)
          : ([st.createStart, st.lastPoint, st.handSize] as const);
      if (partner && partner.mode === "create") {
        partner.mode = "ignored"; // the other hand's pinch is used up: it must open before it can do anything
        partner.partner = -1;
      }
      // Held long enough (a quick touch of thumb and index while playing makes nothing) and long enough in space.
      const heldMs = Math.min(now - st.pinchStartedAt, partner && partner.pinching ? now - partner.pinchStartedAt : Infinity);
      if (heldMs >= this.cfg.harpMinPinchMs && dist(a, b) >= this.cfg.harpMinStringHands * size) {
        const s = this.addString(a, b);
        if (s) events.push({ type: "created", id: s.id });
      }
    } else if (st.mode === "create" && gone) {
      // The hand was lost: cancel; free its partner to continue as a single creation.
      if (st.partner >= 0) {
        const partner = this.hands.get(st.partner);
        if (partner) partner.partner = -1;
      }
    }
    st.mode = "none";
    st.partner = -1;
    st.grabId = -1;
    st.pinchEndedAt = now;
  }

  private buildViews(hands: readonly Hand[]): void {
    for (const hand of hands) {
      const st = this.hands.get(hand.id);
      if (!st || !hand.pinch.active) continue;
      this.pinches.push({ handId: hand.id, point: hand.pinch.point, mode: st.mode, stringId: st.mode === "grab" ? st.grabId : -1 });
      if (st.mode !== "create") continue;
      if (st.partner >= 0) {
        const other = hands.find((x) => x.id === st.partner);
        if (other && hand.id < other.id) this.preview = { a: hand.pinch.point, b: other.pinch.point, double: true, handA: hand.id, handB: other.id };
      } else {
        this.preview = { a: st.createStart, b: hand.pinch.point, double: false, handA: -1, handB: hand.id };
      }
    }
  }

  // ------------------------------------------------------------------ plucking

  private detectPlucks(hands: readonly Hand[], now: number, events: HarpEvent[]): void {
    // Best candidate per string this frame (several fingers can cross the same string together).
    const best = new Map<number, { strength: number; brightness: number; contact: Vec2; along: number; when: number }>();

    for (const hand of hands) {
      const st = this.hands.get(hand.id)!;
      const eff: Vec2[] = hand.tips.map((_, k) => predictedTip(hand, k, this.cfg));
      const prev = st.prevEff;
      const dtSec = (now - st.prevT) / 1000;
      st.prevEff = eff;
      st.prevT = now;
      if (!prev || dtSec <= 0.004) continue;

      const blocked =
        hand.pinch.active || st.mode !== "none" || now - st.pinchEndedAt < this.cfg.harpPinchLockoutMs || st.pinching;
      if (blocked) continue;
      const nearPinch = hand.pinch.strength > 0.5; // thumb and index are closing: that is a grab, not a pluck

      for (let k = 0; k < eff.length; k++) {
        if (nearPinch && k <= 1) continue;
        const from = prev[k]!;
        const to = eff[k]!;
        const move = sub(to, from);
        if (move.x === 0 && move.y === 0) continue;
        for (const s of this.strings) {
          if (now - s.lastPluck < this.cfg.harpCooldownMs) continue;
          const hit = segmentIntersection(from, to, s.a, s.b);
          if (!hit) continue;
          // Speed across the string (hand sizes per second).
          const sx = s.b.x - s.a.x;
          const sy = s.b.y - s.a.y;
          const len = Math.hypot(sx, sy) || 1;
          const perp = Math.abs((move.x * -sy + move.y * sx) / len) / dtSec / hand.handSize;
          if (perp < this.cfg.harpPluckMinSpeed) continue;
          const span = Math.max(0.01, this.cfg.harpPluckFullSpeed - this.cfg.harpPluckMinSpeed);
          const strength = Math.sqrt(clamp((perp - this.cfg.harpPluckMinSpeed) / span, 0, 1)) * 0.9 + 0.1;
          const endness = Math.abs(2 * hit.u - 1); // 0 in the middle, 1 at an end
          const brightness = clamp(0.3 + 0.4 * strength + 0.3 * endness, 0, 1);
          const cur = best.get(s.id);
          if (!cur || strength > cur.strength) {
            best.set(s.id, { strength, brightness, contact: hit.point, along: hit.u, when: hit.t * dtSec * 1000 });
          }
        }
      }
    }

    let first = Infinity;
    for (const c of best.values()) first = Math.min(first, c.when);
    const ordered = [...best].sort((p, q) => p[1].when - q[1].when);
    for (const [id, c] of ordered) {
      const s = this.stringById(id);
      if (!s) continue;
      s.lastPluck = now;
      const delayMs = Math.min(MAX_STRUM_DELAY_MS, Math.max(0, c.when - first));
      events.push({ type: "pluck", stringId: id, strength: c.strength, brightness: c.brightness, contact: c.contact, along: c.along, delayMs });
    }
  }
}
