// Harp drawing (Stage 1: functional, Stage 2 polishes it). Cheap on purpose (PLAN.md "render must stay cheap"):
// additive "lighter" blending, glow = three layered strokes per string, sparks = pre-rendered coloured sprites from a
// fixed pool, all colour strings built once. No shadowBlur, nothing allocated per frame.
//
//  - A string is a straight glowing line; after a pluck it shows a decaying standing wave (a slow visual wobble: the real
//    note is hundreds of Hz and cannot be drawn at 30 fps) and brightens. Colour = pitch class of its note.
//  - While creating, a brighter line follows the pinch point(s); a ring marks each pinch; a grabbed string is thicker.
//  - Hand positions come at tracking rate (~14 fps), so things that follow a hand are drawn shifted ahead by `shifts`
//    (drawing only; the model never sees them).

import { noteName, pitchClass } from "../../audio/scales";
import type { Vec2 } from "../Instrument";
import type { HarpModel, HarpString } from "./model";

const LEVELS = 8; // brightness steps of the precomputed colours
const HUES = [0, 22, 45, 70, 110, 150, 175, 195, 220, 255, 285, 325]; // one per pitch class (C..B)
const WIDTHS = [18, 7, 2.2] as const;
const SPARKS = 96;
const SPRITE = 40;
const WAVE_POINTS = 20;
const WAVE_HZ = 9;

/** GLOW[pitchClass][level][layer] -> CSS colour. Built once. */
const GLOW: string[][][] = HUES.map((h) =>
  Array.from({ length: LEVELS }, (_, l) => {
    const k = l / (LEVELS - 1);
    return [
      `hsla(${h},100%,58%,${(0.05 + 0.13 * k).toFixed(3)})`,
      `hsla(${h},100%,62%,${(0.2 + 0.3 * k).toFixed(3)})`,
      `hsla(${h},100%,${Math.round(78 + 14 * k)}%,${(0.7 + 0.3 * k).toFixed(3)})`,
    ];
  }),
);
const LABEL = HUES.map((h) => `hsla(${h},100%,80%,0.55)`);

function makeSprites(): Array<HTMLCanvasElement | null> {
  if (typeof document === "undefined") return HUES.map(() => null);
  return HUES.map((h) => {
    const c = document.createElement("canvas");
    c.width = SPRITE;
    c.height = SPRITE;
    const g = c.getContext("2d");
    if (!g) return null;
    const grad = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
    grad.addColorStop(0, `hsla(${h},100%,90%,1)`);
    grad.addColorStop(0.3, `hsla(${h},100%,62%,0.55)`);
    grad.addColorStop(1, `hsla(${h},100%,50%,0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE, SPRITE);
    return c;
  });
}

interface StringFx {
  /** Wobble amplitude, px. */
  amp: number;
  phase: number;
  /** 0..1 brightness boost after a pluck / creation. */
  flash: number;
}

export class HarpView {
  private readonly fx = new Map<number, StringFx>();
  private readonly sprites = makeSprites();
  // spark pool (struct of arrays)
  private readonly sx = new Float32Array(SPARKS);
  private readonly sy = new Float32Array(SPARKS);
  private readonly svx = new Float32Array(SPARKS);
  private readonly svy = new Float32Array(SPARKS);
  private readonly slife = new Float32Array(SPARKS); // seconds left, 0 = free
  private readonly smax = new Float32Array(SPARKS);
  private readonly sclass = new Uint8Array(SPARKS);
  private nextSpark = 0;
  private lastT = 0;
  /** Text shown for a moment (limits, hints). */
  toast = "";
  private toastUntil = 0;

  pluck(s: HarpString, strength: number, contact: Vec2): void {
    const f = this.fxOf(s.id);
    f.amp = Math.max(f.amp, 4 + 14 * strength);
    f.flash = 1;
    const pc = pitchClass(s.midi);
    const n = 4 + Math.round(8 * strength);
    for (let i = 0; i < n; i++) {
      const k = this.nextSpark;
      this.nextSpark = (this.nextSpark + 1) % SPARKS;
      const ang = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 160 * (0.4 + strength);
      this.sx[k] = contact.x;
      this.sy[k] = contact.y;
      this.svx[k] = Math.cos(ang) * sp;
      this.svy[k] = Math.sin(ang) * sp;
      this.smax[k] = this.slife[k] = 0.35 + Math.random() * 0.45;
      this.sclass[k] = pc;
    }
  }

  flash(id: number, level: number): void {
    this.fxOf(id).flash = Math.max(this.fxOf(id).flash, level);
  }

  forget(id: number): void {
    this.fx.delete(id);
  }

  forgetAll(): void {
    this.fx.clear();
  }

  showToast(text: string, nowMs: number, ms = 2200): void {
    this.toast = text;
    this.toastUntil = nowMs + ms;
  }

  private fxOf(id: number): StringFx {
    let f = this.fx.get(id);
    if (!f) {
      f = { amp: 0, phase: 0, flash: 0 };
      this.fx.set(id, f);
    }
    return f;
  }

  /** `shifts`: hand id -> how far ahead (px) to draw things that follow that hand. */
  render(ctx: CanvasRenderingContext2D, model: HarpModel, nowMs: number, shifts: ReadonlyMap<number, Vec2>, width: number): void {
    const dt = this.lastT > 0 ? Math.min(0.1, (nowMs - this.lastT) / 1000) : 0;
    this.lastT = nowMs;
    const t = nowMs / 1000;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Which hand moves which string (so a grabbed string follows the hand smoothly).
    let grabShift: Map<number, Vec2> | null = null;
    for (const p of model.pinches) {
      if (p.mode === "grab" && p.stringId >= 0) {
        const sh = shifts.get(p.handId);
        if (sh) (grabShift ??= new Map()).set(p.stringId, sh);
      }
    }

    for (const s of model.strings) this.drawString(ctx, s, dt, t, grabShift?.get(s.id), model.grabbed.has(s.id));

    this.drawSparks(ctx, dt);
    this.drawPreview(ctx, model, shifts);
    this.drawPinches(ctx, model, shifts);
    this.drawClear(ctx, model);
    ctx.restore();

    if (this.toast && nowMs < this.toastUntil) {
      ctx.save();
      ctx.font = "600 16px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(this.toast, width / 2, 110);
      ctx.restore();
    }
  }

  private drawString(ctx: CanvasRenderingContext2D, s: HarpString, dt: number, t: number, shift: Vec2 | undefined, grabbed: boolean): void {
    const f = this.fxOf(s.id);
    f.amp *= Math.exp(-dt * 2.4);
    f.flash *= Math.exp(-dt * 3.5);
    if (f.amp < 0.15) f.amp = 0;
    const pc = pitchClass(s.midi);
    const level = Math.min(LEVELS - 1, Math.round((0.3 + 0.7 * f.flash + (grabbed ? 0.4 : 0)) * (LEVELS - 1)));
    const colors = GLOW[pc]![level]!;
    const ox = shift?.x ?? 0;
    const oy = shift?.y ?? 0;
    const ax = s.a.x + ox;
    const ay = s.a.y + oy;
    const bx = s.b.x + ox;
    const by = s.b.y + oy;
    const widthK = grabbed ? 1.5 : 1;

    for (let layer = 0; layer < 3; layer++) {
      ctx.strokeStyle = colors[layer]!;
      ctx.lineWidth = WIDTHS[layer]! * widthK;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      if (f.amp > 0) {
        // Standing wave: displacement across the string, fundamental + a little second mode.
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const w1 = Math.cos(t * WAVE_HZ * 2 * Math.PI);
        const w2 = Math.cos(t * WAVE_HZ * 2.3 * 2 * Math.PI + 1);
        for (let i = 1; i <= WAVE_POINTS; i++) {
          const u = i / WAVE_POINTS;
          const d = f.amp * (Math.sin(Math.PI * u) * w1 + 0.35 * Math.sin(2 * Math.PI * u) * w2);
          ctx.lineTo(ax + dx * u + nx * d, ay + dy * u + ny * d);
        }
      } else {
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }

    // Note name, subtle, at the upper end.
    ctx.fillStyle = LABEL[pc]!;
    ctx.font = "11px ui-monospace, Consolas, monospace";
    const top = ay <= by ? { x: ax, y: ay } : { x: bx, y: by };
    ctx.fillText(noteName(s.midi), top.x + 8, top.y - 8);
  }

  private drawSparks(ctx: CanvasRenderingContext2D, dt: number): void {
    for (let k = 0; k < SPARKS; k++) {
      const life = this.slife[k]!;
      if (life <= 0) continue;
      const nl = life - dt;
      this.slife[k] = nl > 0 ? nl : 0;
      this.sx[k] = this.sx[k]! + this.svx[k]! * dt;
      this.sy[k] = this.sy[k]! + this.svy[k]! * dt;
      this.svx[k] = this.svx[k]! * (1 - 2.5 * dt);
      this.svy[k] = this.svy[k]! * (1 - 2.5 * dt);
      const sprite = this.sprites[this.sclass[k]!];
      if (!sprite || nl <= 0) continue;
      const a = nl / this.smax[k]!;
      const size = 8 + 22 * a;
      ctx.globalAlpha = a;
      ctx.drawImage(sprite, this.sx[k]! - size / 2, this.sy[k]! - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  private drawPreview(ctx: CanvasRenderingContext2D, model: HarpModel, shifts: ReadonlyMap<number, Vec2>): void {
    const p = model.preview;
    if (!p) return;
    const sa = shifts.get(p.handA) ?? ZERO;
    const sb = shifts.get(p.handB) ?? ZERO;
    const ax = p.a.x + sa.x;
    const ay = p.a.y + sa.y;
    const bx = p.b.x + sb.x;
    const by = p.b.y + sb.y;
    const cols = ["rgba(140,220,255,0.10)", "rgba(160,230,255,0.35)", "rgba(235,250,255,0.95)"];
    for (let layer = 0; layer < 3; layer++) {
      ctx.strokeStyle = cols[layer]!;
      ctx.lineWidth = WIDTHS[layer]!;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }

  private drawPinches(ctx: CanvasRenderingContext2D, model: HarpModel, shifts: ReadonlyMap<number, Vec2>): void {
    ctx.lineWidth = 2.5;
    for (const p of model.pinches) {
      const sh = shifts.get(p.handId) ?? ZERO;
      ctx.strokeStyle = p.mode === "grab" ? "rgba(255,215,120,0.95)" : p.mode === "create" ? "rgba(150,230,255,0.95)" : "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(p.point.x + sh.x, p.point.y + sh.y, p.mode === "grab" ? 16 : 12, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawClear(ctx: CanvasRenderingContext2D, model: HarpModel): void {
    const pr = model.clear.progress;
    if (pr < 0.03) return;
    const { x, y } = model.clear.point;
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.arc(x, y, 46, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,140,140,0.95)";
    ctx.beginPath();
    ctx.arc(x, y, 46, -Math.PI / 2, -Math.PI / 2 + pr * Math.PI * 2);
    ctx.stroke();
  }
}

const ZERO: Vec2 = { x: 0, y: 0 };
