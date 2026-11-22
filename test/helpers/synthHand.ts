// Synthetic hands for tests (no camera needed). Deliberately has only type imports so plain Node can also load it
// (see scripts/make-sample-recording.mjs, which writes test/recordings/synthetic-two-hands.json).

import type { Vec2 } from "../../src/instruments/Instrument";

/** Open hand pointing up on screen, wrist at (0,0), handSize (wrist -> middle knuckle) = 100. */
const CANONICAL: Array<[number, number]> = [
  [0, 0], // 0 wrist
  [-35, -25], [-55, -55], [-70, -80], [-80, -105], // thumb 1-4
  [-30, -95], [-32, -135], [-33, -160], [-34, -182], // index 5-8
  [0, -100], [0, -145], [0, -172], [0, -195], // middle 9-12
  [28, -95], [31, -135], [32, -160], [33, -180], // ring 13-16
  [52, -82], [58, -112], [61, -132], [63, -150], // pinky 17-20
];

export interface SynthOptions {
  /** Wrist position in canvas px. */
  x: number;
  y: number;
  /** 1 = handSize 100 px. */
  scale?: number;
  /** 1 = thumb fully away from the index tip (ratio ~0.9), 0 = thumb touching the index tip. */
  open?: number;
}

export function synthHand({ x, y, scale = 1, open = 1 }: SynthOptions): Vec2[] {
  const pts: Vec2[] = CANONICAL.map(([px, py]) => ({ x: px, y: py }));
  const index = pts[8]!;
  const thumbOpen = pts[4]!;
  pts[4] = {
    x: index.x + (thumbOpen.x - index.x) * open,
    y: index.y + (thumbOpen.y - index.y) * open,
  };
  return pts.map((p) => ({ x: x + p.x * scale, y: y + p.y * scale }));
}

/** Small deterministic pseudo-random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two seconds at 30 fps in a 1280x720 canvas.
 *  - hand id 1 (screen left, x ~ 320): open, slowly circling. Never pinches.
 *  - hand id 2 (screen right, x ~ 900): open for 0.5 s, closes the pinch over 0.33 s, holds it with a little
 *    jitter, opens again at 1.5 s.
 */
export function syntheticTwoHandsRecording() {
  const frames = [];
  const rand = rng(42);
  const jitter = () => (rand() - 0.5) * 1.6;
  const N = 60;
  for (let i = 0; i < N; i++) {
    const t = Math.round(((i * 1000) / 30) * 10) / 10;
    const angle = (i / N) * Math.PI * 2;
    const left = synthHand({ x: 320 + Math.cos(angle) * 40, y: 450 + Math.sin(angle) * 40, open: 1 });

    let open: number;
    if (i < 15) open = 1;
    else if (i < 25) open = 1 - (i - 15) / 10 * 0.95; // 1 -> 0.05
    else if (i < 45) open = 0.05;
    else if (i < 55) open = 0.05 + ((i - 45) / 10) * 0.95;
    else open = 1;
    const right = synthHand({ x: 900, y: 460, open });

    const round = (p: { x: number; y: number }): [number, number] => [
      Math.round((p.x + jitter()) * 10) / 10,
      Math.round((p.y + jitter()) * 10) / 10,
    ];
    frames.push({
      t,
      hands: [
        { id: 1, landmarks: left.map(round) },
        { id: 2, landmarks: right.map(round) },
      ],
    });
  }
  return {
    format: "air-instruments-recording",
    version: 1,
    note: "Synthetic: left hand circles, right hand pinches between 0.5 s and 1.5 s.",
    canvas: { width: 1280, height: 720 },
    frames,
  };
}
