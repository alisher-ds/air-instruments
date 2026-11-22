// Record & replay of the smoothed hand stream (landmarks only - never any video).
//
// A recording stores, per tracking frame: timestamp, and for every hand its stable id + 21 smoothed landmarks in
// canvas pixels. Replay feeds those through HandAnalyzer, so every derived value (pinch, velocities, curl, side)
// is recomputed by the CURRENT gesture code. That is what makes recordings useful for reproducing and fixing bugs.

import type { HandFrame, Vec2 } from "../instruments/Instrument";
import { HandAnalyzer, type GestureConfig } from "./gestures";

export const RECORDING_FORMAT = "air-instruments-recording";
export const RECORDING_VERSION = 1;

export interface RecordedHand {
  id: number;
  /** 21 points as [x, y] in canvas pixels. */
  landmarks: Array<[number, number]>;
}

export interface RecordedFrame {
  /** ms since the recording started. */
  t: number;
  hands: RecordedHand[];
}

export interface Recording {
  format: typeof RECORDING_FORMAT;
  version: typeof RECORDING_VERSION;
  /** Canvas size when it was recorded (needed to decide left/right side). */
  canvas: { width: number; height: number };
  /** Free-text note (what was played). Optional. */
  note?: string;
  frames: RecordedFrame[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export class Recorder {
  private frames: RecordedFrame[] = [];
  private startT = 0;
  private active = false;
  private canvas = { width: 0, height: 0 };

  get recording(): boolean {
    return this.active;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Seconds recorded so far. */
  get seconds(): number {
    const last = this.frames[this.frames.length - 1];
    return last ? last.t / 1000 : 0;
  }

  start(canvasWidth: number, canvasHeight: number): void {
    this.frames = [];
    this.startT = -1;
    this.canvas = { width: Math.round(canvasWidth), height: Math.round(canvasHeight) };
    this.active = true;
  }

  push(frame: HandFrame): void {
    if (!this.active) return;
    if (this.startT < 0) this.startT = frame.timestamp;
    this.frames.push({
      t: round1(frame.timestamp - this.startT),
      hands: frame.hands.map((h) => ({
        id: h.id,
        landmarks: h.landmarks.map((p): [number, number] => [round1(p.x), round1(p.y)]),
      })),
    });
  }

  stop(): Recording {
    this.active = false;
    return {
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      canvas: this.canvas,
      frames: this.frames,
    };
  }
}

export function isRecording(data: unknown): data is Recording {
  if (typeof data !== "object" || data === null) return false;
  const r = data as Partial<Recording>;
  return (
    r.format === RECORDING_FORMAT &&
    r.version === RECORDING_VERSION &&
    typeof r.canvas?.width === "number" &&
    Array.isArray(r.frames)
  );
}

/** Replays a recording through the gesture code. Returns one full HandFrame per recorded frame. */
export function replayRecording(rec: Recording, cfg?: GestureConfig): HandFrame[] {
  const analyzer = cfg ? new HandAnalyzer(cfg) : new HandAnalyzer();
  return rec.frames.map((f) =>
    analyzer.analyze(
      f.hands.map((h) => ({
        id: h.id,
        landmarks: h.landmarks.map(([x, y]): Vec2 => ({ x, y })),
      })),
      f.t,
      rec.canvas.width,
    ),
  );
}

export function recordingFileName(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `air-recording-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.json`
  );
}
