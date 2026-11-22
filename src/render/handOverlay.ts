// Optional hand skeleton overlay (debug panel / "show hands").

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

export function drawHands(ctx: CanvasRenderingContext2D, frame: HandFrame): void {
  for (const hand of frame.hands) drawHand(ctx, hand);
}

function drawHand(ctx: CanvasRenderingContext2D, hand: Hand): void {
  const lm = hand.landmarks;
  const color = hand.side === "left" ? "120, 200, 255" : "255, 190, 110";
  const pinching = hand.pinch.active;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = 2;
  ctx.strokeStyle = `rgba(${color}, 0.7)`;
  ctx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    ctx.moveTo(lm[a]!.x, lm[a]!.y);
    ctx.lineTo(lm[b]!.x, lm[b]!.y);
  }
  ctx.stroke();

  for (let i = 0; i < lm.length; i++) {
    const tip = TIP_INDEX.has(i);
    ctx.fillStyle = tip ? `rgba(${color}, 1)` : `rgba(${color}, 0.6)`;
    ctx.beginPath();
    ctx.arc(lm[i]!.x, lm[i]!.y, tip ? 4.5 : 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pinch marker: a ring at the pinch point, solid green when ON, faint while still open.
  const p = hand.pinch.point;
  ctx.lineWidth = 3;
  ctx.strokeStyle = pinching ? "rgba(90, 255, 150, 0.95)" : `rgba(255, 255, 255, ${0.15 + 0.5 * hand.pinch.strength})`;
  ctx.beginPath();
  ctx.arc(p.x, p.y, pinching ? 14 : 10, 0, Math.PI * 2);
  ctx.stroke();

  // Small label near the wrist: id and side.
  ctx.fillStyle = `rgba(${color}, 0.95)`;
  ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
  ctx.fillText(`#${hand.id} ${hand.side}`, lm[0]!.x + 10, lm[0]!.y + 18);
  ctx.restore();
}
