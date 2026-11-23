import type { AudioEngine } from "../audio/engine";
import type { Effects } from "../render/effects";

/** A point in canvas pixel space (or normalized space inside core/tracking before mapping). */
export interface Vec2 {
  x: number;
  y: number;
}

export type InstrumentId = "harp" | "doira" | "theremin" | "piano";

/** The Instrument contract (PLAN.md section 4). All instruments implement this. */
export interface Instrument {
  id: InstrumentId;
  name: string;
  /** One-line "how to play" shown on screen. */
  hint: string;
  init(audio: AudioEngine): void;
  /** Logic only. Called once per new tracking frame. */
  update(frame: HandFrame, dt: number, now: number): void;
  /** Drawing only. Called once per display frame. */
  render(ctx: CanvasRenderingContext2D, fx: Effects): void;
  /** Stop all sound, free nodes. */
  dispose(): void;
}

export interface HandFrame {
  /** 0-2 hands, already smoothed, in canvas pixel space, mirrored. */
  hands: Hand[];
  /** When the landmarks reached the main thread (performance.now clock). */
  timestamp: number;
  /**
   * When the camera captured the picture the landmarks come from (same clock; usually ~80-100 ms before `timestamp`).
   * Drawing-ahead and prediction must use `now - captureTime`: that is the real age of what the hands are shown doing.
   * Missing (tests, recordings) = use `timestamp`.
   */
  captureTime?: number;
}

export interface Hand {
  /** Stable tracking id across frames (matched by nearest wrist position). */
  id: number;
  /** By SCREEN POSITION (left half / right half, user's view), not MediaPipe's handedness label. */
  side: "left" | "right";
  /** 21 points. */
  landmarks: Vec2[];
  /** The same 21 points BEFORE the One Euro filter (needed where tiny motion matters, e.g. theremin vibrato). */
  rawLandmarks: Vec2[];
  /** Thumb..pinky tips (landmarks 4, 8, 12, 16, 20) - 5 points. */
  tips: Vec2[];
  /** px/s */
  tipVelocity: Vec2[];
  /** Tip velocity MINUS palm velocity (finger motion only, hand motion removed). */
  tipVelocityRel: Vec2[];
  /** 0 = straight, 1 = fully bent, per finger (thumb..pinky). */
  fingerCurl: number[];
  palmCenter: Vec2;
  palmVelocity: Vec2;
  /** wrist(0) -> middle MCP(9) distance, for scale-invariant thresholds. */
  handSize: number;
  pinch: { active: boolean; point: Vec2; strength: number };
}
