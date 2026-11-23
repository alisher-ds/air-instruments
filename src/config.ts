// ALL tunable numbers live here (PLAN.md section 5). The debug panel (key D) edits `config` live.
// Constants that are not meant to be tuned live (URLs, camera size) are exported separately below.

import pkg from "../package.json";
import type { ScaleName } from "./audio/scales";

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

  // --- tracking: where MediaPipe runs and how it is fed (Stage 0.6 speed test bench; all of these are saved) ---
  /** "worker" = MediaPipe in a Web Worker (render never waits). "main" = on the main thread (the Stage 0 way). */
  trackMode: "worker" | "main";
  /** MediaPipe delegate. Switching it live reloads the model (a second or two). */
  delegate: "GPU" | "CPU";
  /**
   * Worker only: how the camera frame reaches MediaPipe. "bitmap" = the transferred ImageBitmap as it is.
   * "canvas" = first drawn onto an OffscreenCanvas inside the worker (a different upload path to the GPU).
   */
  workerInput: "bitmap" | "canvas";
  /**
   * When the worker finishes a frame and a newer camera frame arrived meanwhile, send that newest frame
   * right away (older ones are dropped, there is never a queue). Off = wait for the next camera frame.
   */
  pickupOnFree: boolean;
  /** Run MediaPipe on every Nth camera frame only (1 = every frame). Frees the GPU/main thread at the cost of fps. */
  inferEvery: number;
  /** How many hands MediaPipe looks for (1 or 2). Reloads the model. */
  numHands: number;
  /** Camera size. A TEST toggle: reopens the camera. */
  cameraRes: "640x480" | "320x240" | "1280x720";

  // --- predictive triggering (the harp uses it for plucks; turn it off to compare) ---
  predictEnabled: boolean;
  /** How far ahead (ms) a fingertip is extrapolated from its velocity. ~1 camera frame = 33 ms. */
  predictLeadMs: number;
  /** The extrapolated shift is never longer than this, as a fraction of handSize (so a glitchy velocity cannot fling a point). */
  predictMaxShift: number;

  // --- visual lag compensation (DRAWING ONLY: instruments never see these shifted points) ---
  /** Draw the hand skeleton moved forward by the measured frame age, using the hand velocity. */
  drawLeadEnabled: boolean;
  /** Never extrapolate further ahead than this many ms. */
  drawLeadMaxMs: number;
  /** The drawn shift is never longer than this, as a fraction of handSize (so it can not overshoot far when a hand stops). */
  drawLeadMaxShift: number;

  // --- rendering ---
  /** 0..1 black overlay on the video so light effects pop. */
  videoDim: number;
  showHands: boolean;
  videoFit: "cover" | "contain";
  /**
   * How the camera picture reaches the screen. "element" = a normal mirrored <video> under a transparent canvas (the
   * browser's compositor does the work; the canvas draws only effects). "canvas" = the Stage 0 way: the video is drawn
   * into the canvas every frame (kept only so the benchmark can compare).
   */
  videoMode: "element" | "canvas";
  /** Upper limit for devicePixelRatio (hard cap 2). Lower = fewer pixels to fill = faster render. */
  maxDpr: number;
  /** Internal resolution of the effects canvas as a fraction of the screen's (0.5, 0.75, 1). CSS upscales it to the full window. */
  renderScale: number;
  /** TEST: create the 2D context with willReadFrequently (software, CPU-drawn) to see if it frees the GPU for MediaPipe. */
  software2d: boolean;
  /** TEST: draw a synthetic "harp-like" load (additive glow strokes + sprites) so render settings can be compared before the harp exists. */
  testLoad: boolean;
  /** Draw at most this many frames per second (0 = every display frame). A speed TEST: does less GPU work for render help inference? */
  renderFpsCap: number;

  // --- harp (Stage 1). Lengths and speeds are in hand sizes so they work at any distance from the camera. ---
  /** Notes the strings can play. */
  harpScale: ScaleName;
  /** String length / canvas diagonal that maps to the HIGHEST note (shorter strings clamp to it). */
  harpMinLenFrac: number;
  /** ...and to the LOWEST note. */
  harpMaxLenFrac: number;
  /** A new string shorter than this many hand sizes is cancelled (accidental pinches). */
  harpMinStringHands: number;
  /** A pinch this close (hand sizes) to a string's body or endpoint grabs it instead of creating a new one. */
  harpGrabDist: number;
  /** Per STRING (not per finger): a string cannot be plucked again for this long. ms. */
  harpCooldownMs: number;
  /** Crossing speed (hand sizes/s) perpendicular to the string below which a crossing is ignored (drift, jitter). */
  harpPluckMinSpeed: number;
  /** ...and at which a pluck is at full strength. */
  harpPluckFullSpeed: number;
  /** After a pinch ends, that hand cannot pluck for this long (opening the fingers must not strike the new string). ms. */
  harpPinchLockoutMs: number;
  /** Flicking a grabbed string faster than this (hand sizes/s) toward a screen edge deletes it. */
  harpFlickSpeed: number;
  /** A pinch must be held this long before it can make a string (touching thumb and index while playing makes nothing). ms. */
  harpMinPinchMs: number;
  /** A hand whose middle, ring and pinky are bent more than this (0..1, average) is a fist: its thumb-index touch is not a pinch. */
  harpFistCurl: number;
  /** A grab or creation keeps going this long after the pinch seems to open (tracking flickers). ms. */
  harpReleaseGraceMs: number;
  /** Both open palms held still this long clear all strings. ms. */
  harpClearHoldMs: number;

  /** 0 = dark and soft, 1 = bright. Scales how bright every pluck sounds. */
  harpTone: number;

  // --- doira (Stage 3). Speeds are in hand sizes per second so they work at any distance from the camera. ---
  /** Drum radius as a fraction of the smaller screen side. */
  doiraRadiusFrac: number;
  /** A palm entering the drum slower than this does not hit. */
  doiraHitMinSpeed: number;
  /** ...and at this speed a hit is at full loudness. */
  doiraHitFullSpeed: number;
  /** "Slam and stop": the palm was this fast within the last ~150 ms ... */
  doiraSpikeSpeed: number;
  /** ...and is now at most this fraction of that speed, inside the drum: a hit. */
  doiraStopRatio: number;
  /** After a hit the hand may hit again once it left the drum or moved slower than this. */
  doiraRearmSpeed: number;
  /** One hand cannot hit twice within this. ms. */
  doiraHitCooldownMs: number;
  /** Fingertip speed relative to the palm for a finger tap, and the speed for the loudest tap. */
  doiraTapMinSpeed: number;
  doiraTapFullSpeed: number;
  /** A finger cannot tap twice within this. ms. */
  doiraTapCooldownMs: number;
  /** After a pinch (moving the drum) the hand cannot hit for this long. ms. */
  doiraPinchLockoutMs: number;
  /** Pitch of the deep "bum", Hz. */
  doiraBumHz: number;

  // --- theremin (Stage 4) ---
  /** Notes the pitch is pulled toward. */
  thereminScale: ScaleName;
  /** 0 = free glide (no pull), 1 = strongly sticks to scale notes. */
  thereminSnap: number;
  /** Time constant of the pitch glide, ms (higher = smoother, laggier). */
  thereminGlideMs: number;
  /** Vibrato depth at full wobble, cents (100 = a semitone). */
  thereminVibratoCents: number;
  /** Depth (0..1 of the above) the automatic vibrato fades in to on a held note. 0 = off. */
  thereminAutoVibrato: number;
  /** Left hand this low (0..1 of its calibrated range) is silent. */
  thereminVolumeDead: number;
  /** Side-to-side wrist wobble (RMS, in hand sizes) where vibrato starts / reaches full depth. */
  thereminWobbleMin: number;
  thereminWobbleFull: number;

  // --- audio (all instruments) ---
  /** Reverb amount 0..1. */
  reverbMix: number;

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

  trackMode: "worker",
  delegate: "GPU",
  workerInput: "bitmap",
  pickupOnFree: true,
  inferEvery: 1,
  numHands: 2,
  cameraRes: "640x480",

  predictEnabled: true,
  predictLeadMs: 33,
  predictMaxShift: 0.5,

  drawLeadEnabled: true,
  drawLeadMaxMs: 150,
  drawLeadMaxShift: 0.5,

  videoDim: 0.5,
  showHands: false,
  videoFit: "cover",
  videoMode: "element",
  maxDpr: 2,
  renderScale: 1,
  software2d: false,
  testLoad: false,
  renderFpsCap: 30,

  harpScale: "major-pentatonic",
  harpMinLenFrac: 0.08,
  harpMaxLenFrac: 0.6,
  harpMinStringHands: 1.5,
  harpGrabDist: 0.75,
  harpCooldownMs: 60,
  harpPluckMinSpeed: 0.4,
  harpPluckFullSpeed: 6,
  harpPinchLockoutMs: 250,
  harpFlickSpeed: 9,
  harpMinPinchMs: 120,
  harpFistCurl: 0.9,
  harpReleaseGraceMs: 120,
  harpTone: 0.55,
  doiraRadiusFrac: 0.2,
  doiraHitMinSpeed: 2.5,
  doiraHitFullSpeed: 10,
  doiraSpikeSpeed: 3.5,
  doiraStopRatio: 0.5,
  doiraRearmSpeed: 1,
  doiraHitCooldownMs: 90,
  doiraTapMinSpeed: 2.5,
  doiraTapFullSpeed: 8,
  doiraTapCooldownMs: 55,
  doiraPinchLockoutMs: 250,
  doiraBumHz: 110,
  thereminScale: "major-pentatonic",
  thereminSnap: 0.5,
  thereminGlideMs: 60,
  thereminVibratoCents: 45,
  thereminAutoVibrato: 0.3,
  thereminVolumeDead: 0.08,
  thereminWobbleMin: 0.03,
  thereminWobbleFull: 0.12,
  reverbMix: 0.3,
  harpClearHoldMs: 1500,

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
  { kind: "choice", group: "Tracking", key: "trackMode", label: "tracking mode", options: ["worker", "main"] },
  { kind: "choice", group: "Tracking", key: "delegate", label: "delegate (GPU/CPU)", options: ["GPU", "CPU"] },
  { kind: "choice", group: "Tracking", key: "workerInput", label: "worker input", options: ["bitmap", "canvas"] },
  { kind: "boolean", group: "Tracking", key: "pickupOnFree", label: "grab newest when free" },
  { kind: "number", group: "Tracking", key: "inferEvery", label: "infer every Nth frame", min: 1, max: 3, step: 1 },
  { kind: "number", group: "Tracking", key: "numHands", label: "numHands", min: 1, max: 2, step: 1 },
  { kind: "choice", group: "Tracking", key: "cameraRes", label: "camera size (test)", options: ["640x480", "320x240", "1280x720"] },
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
  { kind: "choice", group: "View", key: "videoMode", label: "video layer", options: ["element", "canvas"] },
  { kind: "number", group: "View", key: "maxDpr", label: "max pixel ratio", min: 1, max: 2, step: 0.25 },
  { kind: "number", group: "View", key: "renderScale", label: "render scale (0.5 / 0.75 / 1)", min: 0.5, max: 1, step: 0.25 },
  { kind: "number", group: "View", key: "renderFpsCap", label: "render fps cap (0 = off)", min: 0, max: 60, step: 5 },
  { kind: "boolean", group: "View", key: "software2d", label: "2D canvas in software (test)" },
  { kind: "boolean", group: "View", key: "testLoad", label: "synthetic effects load (test)" },
  { kind: "choice", group: "Harp", key: "harpScale", label: "scale", options: ["major-pentatonic", "minor-pentatonic", "harmonic-minor"] },
  { kind: "number", group: "Harp", key: "harpMinLenFrac", label: "highest note at length (x diagonal)", min: 0.02, max: 0.4, step: 0.01 },
  { kind: "number", group: "Harp", key: "harpMaxLenFrac", label: "lowest note at length (x diagonal)", min: 0.2, max: 1, step: 0.01 },
  { kind: "number", group: "Harp", key: "harpMinStringHands", label: "min string length (hands)", min: 0.5, max: 4, step: 0.1 },
  { kind: "number", group: "Harp", key: "harpGrabDist", label: "grab distance (hands)", min: 0.1, max: 1.5, step: 0.05 },
  { kind: "number", group: "Harp", key: "harpCooldownMs", label: "string cooldown (ms)", min: 0, max: 300, step: 5 },
  { kind: "number", group: "Harp", key: "harpPluckMinSpeed", label: "pluck min speed (hands/s)", min: 0, max: 3, step: 0.05 },
  { kind: "number", group: "Harp", key: "harpPluckFullSpeed", label: "pluck full-strength speed (hands/s)", min: 1, max: 15, step: 0.5 },
  { kind: "number", group: "Harp", key: "harpPinchLockoutMs", label: "no pluck after pinch (ms)", min: 0, max: 800, step: 10 },
  { kind: "number", group: "Harp", key: "harpFlickSpeed", label: "flick-delete speed (hands/s)", min: 2, max: 20, step: 0.5 },
  { kind: "number", group: "Harp", key: "harpMinPinchMs", label: "pinch held at least (ms)", min: 0, max: 600, step: 10 },
  { kind: "number", group: "Harp", key: "harpFistCurl", label: "fist = other fingers bent more than", min: 0.3, max: 1, step: 0.05 },
  { kind: "number", group: "Harp", key: "harpReleaseGraceMs", label: "keep holding after pinch flickers (ms)", min: 0, max: 400, step: 10 },
  { kind: "number", group: "Harp", key: "harpTone", label: "tone (dark .. bright)", min: 0, max: 1, step: 0.05 },
  { kind: "number", group: "Doira", key: "doiraRadiusFrac", label: "drum size (x screen height)", min: 0.1, max: 0.4, step: 0.01 },
  { kind: "number", group: "Doira", key: "doiraHitMinSpeed", label: "hit min speed (hands/s)", min: 0.5, max: 8, step: 0.1 },
  { kind: "number", group: "Doira", key: "doiraHitFullSpeed", label: "hit full-volume speed (hands/s)", min: 3, max: 25, step: 0.5 },
  { kind: "number", group: "Doira", key: "doiraSpikeSpeed", label: "slam-and-stop: was this fast", min: 1, max: 12, step: 0.1 },
  { kind: "number", group: "Doira", key: "doiraStopRatio", label: "slam-and-stop: now at most (x)", min: 0.05, max: 0.9, step: 0.05 },
  { kind: "number", group: "Doira", key: "doiraRearmSpeed", label: "can hit again below (hands/s)", min: 0.2, max: 5, step: 0.1 },
  { kind: "number", group: "Doira", key: "doiraHitCooldownMs", label: "hand cooldown (ms)", min: 0, max: 300, step: 5 },
  { kind: "number", group: "Doira", key: "doiraTapMinSpeed", label: "finger tap min speed (hands/s)", min: 0.5, max: 8, step: 0.1 },
  { kind: "number", group: "Doira", key: "doiraTapFullSpeed", label: "finger tap full speed (hands/s)", min: 2, max: 20, step: 0.5 },
  { kind: "number", group: "Doira", key: "doiraTapCooldownMs", label: "finger cooldown (ms)", min: 0, max: 200, step: 5 },
  { kind: "number", group: "Doira", key: "doiraBumHz", label: "bum pitch (Hz)", min: 60, max: 250, step: 5 },
  { kind: "choice", group: "Theremin", key: "thereminScale", label: "scale", options: ["major-pentatonic", "minor-pentatonic", "harmonic-minor"] },
  { kind: "number", group: "Theremin", key: "thereminSnap", label: "snap to notes (0 = free glide)", min: 0, max: 1, step: 0.05 },
  { kind: "number", group: "Theremin", key: "thereminGlideMs", label: "glide (ms)", min: 5, max: 300, step: 5 },
  { kind: "number", group: "Theremin", key: "thereminVibratoCents", label: "vibrato depth (cents)", min: 0, max: 120, step: 5 },
  { kind: "number", group: "Theremin", key: "thereminAutoVibrato", label: "auto vibrato on long notes", min: 0, max: 1, step: 0.05 },
  { kind: "number", group: "Theremin", key: "thereminVolumeDead", label: "silent below (left hand)", min: 0, max: 0.4, step: 0.01 },
  { kind: "number", group: "Theremin", key: "thereminWobbleMin", label: "wobble starts (hands)", min: 0.005, max: 0.2, step: 0.005 },
  { kind: "number", group: "Theremin", key: "thereminWobbleFull", label: "wobble = full vibrato (hands)", min: 0.03, max: 0.4, step: 0.01 },
  { kind: "number", group: "Audio", key: "reverbMix", label: "reverb amount", min: 0, max: 1, step: 0.05 },
  { kind: "number", group: "Harp", key: "harpClearHoldMs", label: "clear-all hold (ms)", min: 500, max: 4000, step: 100 },
  { kind: "boolean", group: "Draw lag fix", key: "drawLeadEnabled", label: "draw skeleton ahead (by frame age)" },
  { kind: "number", group: "Draw lag fix", key: "drawLeadMaxMs", label: "max lead (ms)", min: 0, max: 300, step: 10 },
  { kind: "number", group: "Draw lag fix", key: "drawLeadMaxShift", label: "max shift (x handSize)", min: 0.05, max: 1.5, step: 0.05 },
  { kind: "boolean", group: "Prediction", key: "predictEnabled", label: "predict fingertips (harp plucks)" },
  { kind: "number", group: "Prediction", key: "predictLeadMs", label: "lead (ms)", min: 0, max: 100, step: 1 },
  { kind: "number", group: "Prediction", key: "predictMaxShift", label: "max shift (x handSize)", min: 0.05, max: 1, step: 0.05 },
];

// ---------------------------------------------------------------------------
// Constants (not live-tunable)
// ---------------------------------------------------------------------------

export const CAMERA = { width: 640, height: 480 } as const;

/** Sizes for the "camera size (test)" toggle. */
export function cameraSize(res: Config["cameraRes"]): { width: number; height: number } {
  const [w, h] = res.split("x").map(Number);
  return w && h ? { width: w, height: h } : { width: CAMERA.width, height: CAMERA.height };
}

/** Hard upper limit for devicePixelRatio (PLAN.md section 5). */
export const MAX_DPR_CAP = 2;

/**
 * The only official HandLandmarker model Google publishes (checked: float16/1 and float16/latest exist, float32 and
 * int8 return 404). So there is no model variant to switch between; the delegate is the only speed switch.
 */

/** Largest number of hands tracked at once (ids, smoothing). MediaPipe itself is asked for `config.numHands` (1 or 2). */
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
