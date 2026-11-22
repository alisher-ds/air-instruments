// ALL tunable numbers live here (PLAN.md section 5). The debug panel (key D) edits `config` live.
// Constants that are not meant to be tuned live (URLs, camera size) are exported separately below.

import pkg from "../package.json";

export interface Config {
  // --- smoothing (One Euro filter, applied to every landmark) ---
  /** Lower = steadier at rest, but laggier on slow motion. Hz. */
  minCutoff: number;
  /** Higher = less lag on fast motion, but more jitter. */
  beta: number;
  /** Cutoff of the speed estimate inside the filter. Hz. */
  dCutoff: number;

  // --- pinch (distance thumb tip <-> index tip, divided by handSize) ---
  pinchOn: number;
  pinchOff: number;

  // --- hand tracking ---
  /** A lost hand keeps its last state this long, then is released. ms. */
  holdMs: number;
  /** Max wrist jump (fraction of the camera image) that still counts as the same hand. */
  matchMaxDist: number;
  /** Dead zone around the screen centre where a lone hand keeps its previous side (fraction of canvas width). */
  sideDeadZone: number;

  // --- gestures ---
  /** 0..1. How much of the new velocity sample is used (1 = no velocity smoothing). */
  velocityAlpha: number;
  /** Bend angle (radians) at the middle joint that counts as curl = 1. */
  curlFullBendRad: number;

  // --- rendering ---
  /** 0..1 black overlay on the video so light effects pop. */
  videoDim: number;
  showHands: boolean;
  videoFit: "cover" | "contain";

  // --- recording ---
  recordMaxSeconds: number;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  minCutoff: 2.0,
  beta: 10,
  dCutoff: 1.0,

  pinchOn: 0.25,
  pinchOff: 0.35,

  holdMs: 150,
  matchMaxDist: 0.3,
  sideDeadZone: 0.03,

  velocityAlpha: 0.6,
  curlFullBendRad: 2.2,

  videoDim: 0.5,
  showHands: false,
  videoFit: "cover",

  recordMaxSeconds: 60,
});

/** The live, mutable config. Everything reads from this object at the moment it needs a value. */
export const config: Config = { ...DEFAULT_CONFIG };

export function resetConfig(): void {
  Object.assign(config, DEFAULT_CONFIG);
}

export interface NumberTunable {
  kind: "number";
  key: keyof Config & string;
  label: string;
  min: number;
  max: number;
  step: number;
  group: string;
}
export interface BooleanTunable {
  kind: "boolean";
  key: keyof Config & string;
  label: string;
  group: string;
}
export interface ChoiceTunable {
  kind: "choice";
  key: keyof Config & string;
  label: string;
  options: string[];
  group: string;
}
export type Tunable = NumberTunable | BooleanTunable | ChoiceTunable;

/** What the debug panel shows as live controls. */
export const TUNABLES: Tunable[] = [
  { kind: "number", group: "Smoothing", key: "minCutoff", label: "minCutoff", min: 0.1, max: 10, step: 0.1 },
  { kind: "number", group: "Smoothing", key: "beta", label: "beta", min: 0, max: 50, step: 0.5 },
  { kind: "number", group: "Smoothing", key: "dCutoff", label: "dCutoff", min: 0.1, max: 10, step: 0.1 },
  { kind: "number", group: "Pinch", key: "pinchOn", label: "pinch ON below", min: 0.05, max: 0.6, step: 0.01 },
  { kind: "number", group: "Pinch", key: "pinchOff", label: "pinch OFF above", min: 0.1, max: 0.8, step: 0.01 },
  { kind: "number", group: "Hands", key: "holdMs", label: "hold lost hand (ms)", min: 0, max: 500, step: 10 },
  { kind: "number", group: "Hands", key: "matchMaxDist", label: "id match distance", min: 0.05, max: 0.8, step: 0.01 },
  { kind: "number", group: "Gestures", key: "velocityAlpha", label: "velocity alpha", min: 0.05, max: 1, step: 0.05 },
  { kind: "number", group: "Gestures", key: "curlFullBendRad", label: "curl full bend (rad)", min: 1, max: 3.14, step: 0.05 },
  { kind: "number", group: "View", key: "videoDim", label: "video dim", min: 0, max: 1, step: 0.05 },
  { kind: "boolean", group: "View", key: "showHands", label: "show hands" },
  { kind: "choice", group: "View", key: "videoFit", label: "video fit", options: ["cover", "contain"] },
];

// ---------------------------------------------------------------------------
// Constants (not live-tunable)
// ---------------------------------------------------------------------------

export const CAMERA = { width: 640, height: 480 } as const;

/** Number of hands MediaPipe is asked to find. */
export const NUM_HANDS = 2;
export const MP_CONFIDENCE = {
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
} as const;

// WASM files and the model must match the pinned @mediapipe/tasks-vision version exactly.
// The version string is read from package.json (which pins it without ^ or ~).
export const MEDIAPIPE_VERSION: string = pkg.dependencies["@mediapipe/tasks-vision"];
export const MEDIAPIPE_WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** MediaPipe hand landmark indices. */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export const TIP_INDICES = [4, 8, 12, 16, 20] as const;
