// Air piano drawing. Same cheap rules as the other instruments ("render must stay cheap"): additive blending, all key outlines
// in one path per kind, pre-rendered sprites, a fixed pool for the light blooms, no shadowBlur, no full-screen pass, nothing
// allocated per frame.
//
//  - The keys: faint white keys with an outline, darker black keys on top. A key that is down glows in the colour of its note
//    (pitch class) with its name on it; after the release the glow fades. A fingertip hovering over a key lights it softly.
//  - A press blooms from the fingertip: a soft light that rises a little and fades.
//  - Fingertip markers (small rings) show where each finger is, thicker while it holds a key down.
//  Things that follow a hand are drawn ahead by the age of the camera picture (drawing only; the model never sees it).

import type { Vec2 } from "../Instrument";
import { outlinedText } from "../../render/text";
import { keyAt, type Key } from "./layout";
import type { PianoModel } from "./model";

const HUES = [0, 22, 45, 70, 110, 150, 175, 195, 220, 255, 285, 325]; // one per pitch class (C..B), like the harp
const SPRITE = 48;
const BLOOMS = 16;
const BLOOM_LIFE = 0.7;

function makeSprites(): Array<HTMLCanvasElement | null> {
  if (typeof document === "undefined") return HUES.map(() => null);
  return HUES.map((h) => {
    const c = document.createElement("canvas");
    c.width = SPRITE;
    c.height = SPRITE;
    const g = c.getContext("2d");
    if (!g) return null;
    const grad = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
    grad.addColorStop(0, `hsla(${h},100%,92%,1)`);
    grad.addColorStop(0.3, `hsla(${h},100%,64%,0.55)`);
    grad.addColorStop(1, `hsla(${h},100%,50%,0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE, SPRITE);
    return c;
  });
}

/** [fill, edge, label] per pitch class, built once. */
const LIT = HUES.map((h) => [`hsla(${h},100%,62%,0.55)`, `hsla(${h},100%,80%,0.95)`, `hsla(${h},100%,88%,0.95)`] as const);

/** A fingertip as drawn: where (already moved ahead) and whether it holds a key. */
export interface TipView {
  id: number;
  pos: Vec2;
  down: boolean;
  /** How close the finger is to playing (0..1.3, 1 = it plays): drawn as a ring that fills up. */
  fill: number;
}

export class PianoView {
  private readonly sprites = makeSprites();
  /** Glow per key (by midi), 1 while held, fading after the release. */
  private readonly glow = new Map<number, number>();
  private readonly bx = new Float32Array(BLOOMS);
  private readonly by = new Float32Array(BLOOMS);
  private readonly bage = new Float32Array(BLOOMS);
  private readonly bpow = new Float32Array(BLOOMS);
  private readonly bpc = new Uint8Array(BLOOMS);
  private nextBloom = 0;
  private lastT = 0;

  constructor() {
    this.bage.fill(-1);
  }

  press(point: Vec2, key: { pc: number }, velocity: number): void {
    const b = this.nextBloom;
    this.nextBloom = (this.nextBloom + 1) % BLOOMS;
    this.bx[b] = point.x;
    this.by[b] = point.y;
    this.bage[b] = 0;
    this.bpow[b] = velocity;
    this.bpc[b] = key.pc;
  }

  render(ctx: CanvasRenderingContext2D, model: PianoModel, nowMs: number, tips: readonly TipView[]): void {
    const dt = this.lastT > 0 ? Math.min(0.1, (nowMs - this.lastT) / 1000) : 0;
    this.lastT = nowMs;
    const { keys, top } = model.layout;

    // Glow: held keys are at 1, released ones fade out in ~0.5 s.
    for (const k of keys) {
      const held = model.down.has(k.midi);
      const g = this.glow.get(k.midi) ?? 0;
      const next = held ? 1 : g * Math.exp(-dt * 5);
      if (next > 0.01) this.glow.set(k.midi, next);
      else if (g > 0) this.glow.delete(k.midi);
    }

    // Hovered keys (under a fingertip drawn ahead).
    let hover: Set<number> | null = null;
    for (const t of tips) {
      const k = keyAt(t.pos, model.layout, 40);
      if (k) (hover ??= new Set()).add(k.midi);
    }

    ctx.save();
    ctx.lineJoin = "round";

    // White keys, then black keys: one path each.
    ctx.fillStyle = "rgba(235,242,255,0.07)";
    ctx.strokeStyle = "rgba(205,222,255,0.30)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const k of keys) if (!k.black) ctx.rect(k.x + 1, k.y, k.w - 2, k.h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(6,8,16,0.82)";
    ctx.beginPath();
    for (const k of keys) if (k.black) ctx.rect(k.x, k.y, k.w, k.h);
    ctx.fill();
    ctx.strokeStyle = "rgba(205,222,255,0.35)";
    ctx.stroke();

    // Octave guide: the name of every C, faint.
    ctx.font = "11px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "rgba(190,210,255,0.35)";
    for (const k of keys) if (!k.black && k.pc === 0) outlinedText(ctx, k.name, k.x + 6, k.y + k.h - 8, "rgba(225,235,255,0.9)");

    ctx.globalCompositeOperation = "lighter";

    // Hover highlight (faint).
    if (hover) {
      ctx.fillStyle = "rgba(190,215,255,0.10)";
      ctx.beginPath();
      for (const k of keys) if (hover.has(k.midi) && !this.glow.has(k.midi)) ctx.rect(k.x, k.y, k.w, k.h);
      ctx.fill();
    }

    // Lit keys.
    for (const k of keys) {
      const g = this.glow.get(k.midi);
      if (g === undefined) continue;
      this.drawLit(ctx, k, g);
    }

    this.drawBlooms(ctx, dt, top);

    // Fingertip markers: a faint ring, and a ring that FILLS as the finger bends (full = the note plays), so the player sees
    // what the camera sees and learns how far to bend.
    for (const t of tips) {
      ctx.strokeStyle = t.down ? "rgba(255,255,255,0.9)" : "rgba(210,225,255,0.35)";
      ctx.lineWidth = t.down ? 3 : 1.5;
      ctx.beginPath();
      ctx.arc(t.pos.x, t.pos.y, t.down ? 10 : 8, 0, Math.PI * 2);
      ctx.stroke();
      if (!t.down && t.fill > 0.08) {
        ctx.strokeStyle = t.fill >= 1 ? "rgba(120,255,170,0.95)" : "rgba(255,225,140,0.9)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(t.pos.x, t.pos.y, 14, -Math.PI / 2, -Math.PI / 2 + Math.min(1, t.fill) * Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawLit(ctx: CanvasRenderingContext2D, k: Key, g: number): void {
    const c = LIT[k.pc]!;
    ctx.globalAlpha = Math.min(1, 0.25 + 0.75 * g);
    ctx.fillStyle = c[0];
    ctx.fillRect(k.x, k.y, k.w, k.h);
    ctx.strokeStyle = c[1];
    ctx.lineWidth = 2.5;
    ctx.strokeRect(k.x, k.y, k.w, k.h);
    // note name at the top of the key
    ctx.globalAlpha = Math.min(1, g * 1.2);
    ctx.font = "600 12px system-ui, sans-serif";
    outlinedText(ctx, k.name, k.x + 4, k.y + 14, c[2]);
    ctx.globalAlpha = 1;
  }

  /** Light that blooms at the fingertip and rises a little. */
  private drawBlooms(ctx: CanvasRenderingContext2D, dt: number, keysTop: number): void {
    for (let b = 0; b < BLOOMS; b++) {
      const age = this.bage[b]!;
      if (age < 0) continue;
      const na = age + dt;
      if (na >= BLOOM_LIFE) {
        this.bage[b] = -1;
        continue;
      }
      this.bage[b] = na;
      const sprite = this.sprites[this.bpc[b]!];
      if (!sprite) continue;
      const k = na / BLOOM_LIFE;
      const power = this.bpow[b]!;
      const size = (60 + 90 * power) * (0.6 + 0.6 * k);
      const y = Math.min(this.by[b]!, keysTop + 30) - 40 * k;
      ctx.globalAlpha = (1 - k) * (0.5 + 0.5 * power);
      ctx.drawImage(sprite, this.bx[b]! - size / 2, y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }
}
