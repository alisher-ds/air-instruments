// Messages between the main thread and the tracking worker (trackerWorker.ts), plus the landmark packing.
// Types and pure functions only, so both sides (and the tests) can import it.

import type { Vec2 } from "../instruments/Instrument";
import type { EnvDiag, LoadDiag } from "./diagnostics";

export type DelegateName = "GPU" | "CPU";
/** How the worker hands a frame to MediaPipe (see config.workerInput). */
export type WorkerInput = "bitmap" | "canvas";

// --- main -> worker ---

export interface InitMessage {
  type: "init";
  delegate: DelegateName;
  wasmUrl: string;
  modelUrl: string;
  numHands: number;
  minHandDetectionConfidence: number;
  minHandPresenceConfidence: number;
  minTrackingConfidence: number;
}

export interface FrameMessage {
  type: "frame";
  /** Counts up with every frame sent. The answer carries the same number. */
  seq: number;
  /** Strictly increasing ms (MediaPipe requires it). */
  ts: number;
  input: WorkerInput;
  /** Transferred (moved, not copied) to the worker. The worker closes it. */
  bitmap: ImageBitmap;
}

export type ToWorker = InitMessage | FrameMessage;

// --- worker -> main ---

export interface ReadyMessage {
  type: "ready";
  /** The delegate that is really running (GPU can fall back to CPU). */
  delegate: DelegateName;
  loadMs: number;
  /** Set when GPU was asked for but CPU is running; says why. */
  fallbackReason?: string;
  diag: LoadDiag;
}

/** Sent once when the worker starts: what the worker's own scope can do (OffscreenCanvas, WebGL2, which GPU...). */
export interface EnvMessage {
  type: "env";
  env: EnvDiag;
}

export interface ResultMessage {
  type: "result";
  seq: number;
  /** Time spent inside detectForVideo, measured in the worker. */
  inferenceMs: number;
  /** Number of hands in `points`. */
  count: number;
  /** count * perHand * 2 numbers: x, y per landmark, normalized camera space. */
  points: Float32Array;
  perHand: number;
}

/** The worker could not run this frame (still loading, or switching delegate). Frees the gate. */
export interface SkippedMessage {
  type: "skipped";
  seq: number;
}

export interface ErrorMessage {
  type: "error";
  phase: "init" | "detect";
  message: string;
}

export type FromWorker = EnvMessage | ReadyMessage | ResultMessage | SkippedMessage | ErrorMessage;

// --- landmark packing (a small typed array moves cheaper than 21 objects per hand) ---

export function packHands(hands: ReadonlyArray<ReadonlyArray<Vec2>>): {
  count: number;
  perHand: number;
  points: Float32Array;
} {
  const perHand = hands[0]?.length ?? 0;
  const points = new Float32Array(hands.length * perHand * 2);
  let k = 0;
  for (const hand of hands) {
    for (let i = 0; i < perHand; i++) {
      const p = hand[i]!;
      points[k++] = p.x;
      points[k++] = p.y;
    }
  }
  return { count: hands.length, perHand, points };
}

export function unpackHands(count: number, perHand: number, points: Float32Array): Vec2[][] {
  const hands: Vec2[][] = [];
  let k = 0;
  for (let h = 0; h < count; h++) {
    const hand: Vec2[] = new Array<Vec2>(perHand);
    for (let i = 0; i < perHand; i++) {
      hand[i] = { x: points[k]!, y: points[k + 1]! };
      k += 2;
    }
    hands.push(hand);
  }
  return hands;
}
