// Optional hand skeleton overlay (debug panel / "show hands").
// Drawn every frame while the debug panel is open, so it is kept cheap: constant colour strings (no per-frame string
// building) and the 21 joints are batched into two paths per hand (not 21 separate fills).

import type { Hand, HandFrame } from "../instruments/Instrument";

const CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const TIP_INDEX = new Set([4, 8, 12, 16, 20]);

interface Palette {
  line: string;
  joint: string;
  tip: string;
  label: string;
}
const LEFT: Palette = {
  line: "rgba(120, 200, 255, 0.7)",
  joint: "rgba(120, 200, 255, 0.6)",
  tip: "rgba(120, 200, 255, 1)",
  label: "rgba(120, 200, 255, 0.95)",
};
const RIGHT: Palette = {
  line: "rgba(255, 190, 110, 0.7)",
  joint: "rgba(255, 190, 110, 0.6)",
  tip: "rgba(255, 190, 110, 1)",
  label: "rgba(255, 190, 110, 0.95)",
};
const PINCH_ON = "rgba(90, 255, 150, 0.95)";
// 21 strings, one per 5% step of pinch strength; the faint ring only needs a rough value.
const PINCH_OFF_STEPS: string[] = Array.from({ length: 21 }, (_, i) => `rgba(255, 255, 255, ${(0.15 + 0.5 * (i / 20)).toFixed(3)})`);
const LABEL_FONT = "12px ui-monospace, Menlo, Consolas, monospace";

export function drawHands(ctx: CanvasRenderingContext2D, frame: HandFrame): void {
  ctx.save(); // one save/restore for all hands, so the line width / font set here never leak into the next frame
  for (const hand of frame.hands) drawHand(ctx, hand);
  ctx.restore();
}

function drawHand(ctx: CanvasRenderingContext2D, hand: Hand): void {
  const lm = hand.landmarks;
  const pal = hand.side === "left" ? LEFT : RIGHT;
  const pinching = hand.pinch.active;

  ctx.lineCap = "round";
  ctx.lineWidth = 2;
  ctx.strokeStyle = pal.line;
  ctx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    ctx.moveTo(lm[a]!.x, lm[a]!.y);
    ctx.lineTo(lm[b]!.x, lm[b]!.y);
  }
  ctx.stroke();

  // Joints in one path, fingertips (bigger) in another.
  ctx.fillStyle = pal.joint;
  ctx.beginPath();
  for (let i = 0; i < lm.length; i++) {
    if (TIP_INDEX.has(i)) continue;
    ctx.moveTo(lm[i]!.x + 2.5, lm[i]!.y);
    ctx.arc(lm[i]!.x, lm[i]!.y, 2.5, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.fillStyle = pal.tip;
  ctx.beginPath();
  for (const i of TIP_INDEX) {
    ctx.moveTo(lm[i]!.x + 4.5, lm[i]!.y);
    ctx.arc(lm[i]!.x, lm[i]!.y, 4.5, 0, Math.PI * 2);
  }
  ctx.fill();

  // Pinch marker: a ring at the pinch point, solid green when ON, faint while still open.
  const p = hand.pinch.point;
  ctx.lineWidth = 3;
  ctx.strokeStyle = pinching ? PINCH_ON : PINCH_OFF_STEPS[Math.round(Math.min(1, Math.max(0, hand.pinch.strength)) * 20)]!;
  ctx.beginPath();
  ctx.arc(p.x, p.y, pinching ? 14 : 10, 0, Math.PI * 2);
  ctx.stroke();

  // Small label near the wrist: id and side.
  ctx.fillStyle = pal.label;
  ctx.font = LABEL_FONT;
  ctx.fillText("#" + hand.id + (hand.side === "left" ? " left" : " right"), lm[0]!.x + 10, lm[0]!.y + 18);
}
