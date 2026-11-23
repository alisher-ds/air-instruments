// Doira drawing. Same rules as the harp ("render must stay cheap"): additive blending, layered strokes, pre-rendered
// sprites, fixed pools, no shadowBlur, no full-screen pass, nothing allocated per frame.
//
//  - The drum: a warm glowing rim (3 layered strokes), a faint skin glow, two faint inner rings and a ring of small
//    jingles that shake on a hard hit.
//  - A hit: a flash at the contact point (warm for the deep "bum", cool for the sharp "tak"), ripples spreading over the
//    skin (clipped to the drum), the rim flashes (more for tak), the skin pulses (more for bum).
//  - Palm markers show where each hand is (a bright ring = ready to hit, dim = must leave or slow down first).

import type { Vec2 } from "../Instrument";
import type { DoiraModel } from "./model";

const RIPPLES = 16;
const JINGLES = 12;
const SPRITE = 64;
const RIM_HUE = 36;
const BUM_HUE = 28;
const TAK_HUE = 190;

function sprite(hue: number, alpha = 1): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = SPRITE;
  c.height = SPRITE;
  const g = c.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
  grad.addColorStop(0, `hsla(${hue},100%,92%,${alpha})`);
  grad.addColorStop(0.3, `hsla(${hue},100%,62%,${0.55 * alpha})`);
  grad.addColorStop(1, `hsla(${hue},100%,50%,0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, SPRITE, SPRITE);
  return c;
}

const RIM_COLORS = (level: number): [string, string, string] => [
  `hsla(${RIM_HUE},100%,58%,${(0.06 + 0.16 * level).toFixed(3)})`,
  `hsla(${RIM_HUE},100%,62%,${(0.22 + 0.35 * level).toFixed(3)})`,
  `hsla(${RIM_HUE},100%,${Math.round(78 + 14 * level)}%,${(0.7 + 0.3 * level).toFixed(3)})`,
];
// 11 brightness steps, built once.
const RIM_STEPS = Array.from({ length: 11 }, (_, i) => RIM_COLORS(i / 10));
const GRAB_COLORS: [string, string, string] = ["rgba(255,215,120,0.18)", "rgba(255,215,120,0.5)", "rgba(255,240,190,0.95)"];
const WIDTHS = [22, 9, 2.6] as const;

export class DoiraView {
  private readonly skin = sprite(RIM_HUE, 0.9);
  private readonly warm = sprite(BUM_HUE);
  private readonly cool = sprite(TAK_HUE);
  private readonly dot = sprite(RIM_HUE);
  // ripple pool
  private readonly rx = new Float32Array(RIPPLES);
  private readonly ry = new Float32Array(RIPPLES);
  private readonly rage = new Float32Array(RIPPLES); // seconds, < 0 = free
  private readonly rpow = new Float32Array(RIPPLES);
  private readonly rzone = new Float32Array(RIPPLES);
  private nextRipple = 0;
  private rimFlash = 0;
  private pulse = 0;
  private pulseAge = 0;
  private zilShake = 0;
  private lastT = 0;

  constructor() {
    this.rage.fill(-1);
  }

  hit(point: Vec2, zone: number, velocity: number, soft: boolean): void {
    const r = this.nextRipple;
    this.nextRipple = (this.nextRipple + 1) % RIPPLES;
    this.rx[r] = point.x;
    this.ry[r] = point.y;
    this.rage[r] = 0;
    this.rpow[r] = soft ? velocity * 0.6 : velocity;
    this.rzone[r] = zone;
    this.rimFlash = Math.max(this.rimFlash, (0.35 + 0.65 * zone) * (soft ? 0.6 : 1) * (0.4 + 0.6 * velocity));
    this.pulse = Math.max(this.pulse, (1 - zone) * velocity * (soft ? 0.4 : 1));
    this.pulseAge = 0;
    if (!soft && velocity > 0.6) this.zilShake = 1;
  }

  /** `dragShift`: how far ahead to draw the drum while a hand is moving it (px), or null. */
  render(ctx: CanvasRenderingContext2D, model: DoiraModel, nowMs: number, dragShift: Vec2 | null): void {
    const dt = this.lastT > 0 ? Math.min(0.1, (nowMs - this.lastT) / 1000) : 0;
    this.lastT = nowMs;
    this.rimFlash *= Math.exp(-dt * 6);
    this.pulse *= Math.exp(-dt * 5);
    this.pulseAge += dt;
    this.zilShake *= Math.exp(-dt * 7);

    const c0 = model.center;
    const cx = c0.x + (dragShift?.x ?? 0);
    const cy = c0.y + (dragShift?.y ?? 0);
    const dragging = model.dragging.size > 0;
    const breathe = 1 + 0.012 * Math.sin(nowMs / 900);
    // The skin "gives" on a bum: a quick small radius wobble.
    const R = model.radius * breathe * (1 + 0.03 * this.pulse * Math.cos(this.pulseAge * 2 * Math.PI * 7));

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";

    // Skin glow.
    if (this.skin) {
      const size = R * 2.5;
      ctx.globalAlpha = 0.16 + 0.35 * this.pulse + 0.1 * this.rimFlash + (dragging ? 0.1 : 0);
      ctx.drawImage(this.skin, cx - size / 2, cy - size / 2, size, size);
      ctx.globalAlpha = 1;
    }

    // Faint inner rings (the skin's tension rings).
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,200,120,0.10)";
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2);
    ctx.moveTo(cx + R * 0.22, cy);
    ctx.arc(cx, cy, R * 0.22, 0, Math.PI * 2);
    ctx.stroke();

    // Ripples, clipped to the skin.
    this.drawRipples(ctx, dt, cx, cy, R);

    // Rim: three layers; brighter after a hit; gold-white while the drum is being moved.
    const level = Math.min(10, Math.round((0.3 + 0.7 * Math.min(1, this.rimFlash)) * 10));
    const colors = dragging ? GRAB_COLORS : RIM_STEPS[level]!;
    for (let layer = 0; layer < 3; layer++) {
      ctx.strokeStyle = colors[layer]!;
      ctx.lineWidth = WIDTHS[layer]! * (dragging ? 1.4 : 1 + 0.3 * this.rimFlash);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Jingles around the rim; they shake on a hard hit.
    if (this.dot) {
      const shake = this.zilShake * 7;
      for (let k = 0; k < JINGLES; k++) {
        const a = (k / JINGLES) * Math.PI * 2 + 0.3;
        const j = shake * Math.sin(nowMs / 25 + k * 2.1);
        const rr = R + 14 + j;
        const size = 9 + 8 * this.zilShake;
        ctx.globalAlpha = 0.45 + 0.55 * this.zilShake;
        ctx.drawImage(this.dot, cx + Math.cos(a) * rr - size / 2, cy + Math.sin(a) * rr - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
    }

    // Palm markers.
    ctx.lineWidth = 2;
    for (const info of model.handInfo.values()) {
      const dx = info.palm.x - cx;
      const dy = info.palm.y - cy;
      if (dx * dx + dy * dy > R * R * 3) continue; // only near the drum: no clutter
      ctx.strokeStyle = info.armed ? "rgba(255,230,170,0.55)" : "rgba(255,230,170,0.16)";
      ctx.beginPath();
      ctx.arc(info.palm.x, info.palm.y, 11, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawRipples(ctx: CanvasRenderingContext2D, dt: number, cx: number, cy: number, R: number): void {
    const LIFE = 0.6;
    let any = false;
    for (let r = 0; r < RIPPLES; r++) if (this.rage[r]! >= 0) any = true;
    if (!any) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2);
    ctx.clip();
    for (let r = 0; r < RIPPLES; r++) {
      const age = this.rage[r]!;
      if (age < 0) continue;
      const na = age + dt;
      if (na >= LIFE) {
        this.rage[r] = -1;
        continue;
      }
      this.rage[r] = na;
      const k = na / LIFE;
      const power = this.rpow[r]!;
      const zone = this.rzone[r]!;
      const flash = zone > 0.5 ? this.cool : this.warm;
      if (flash) {
        const size = (50 + 80 * power) * (1 - 0.4 * k);
        ctx.globalAlpha = (1 - k) * (0.55 + 0.45 * power);
        ctx.drawImage(flash, this.rx[r]! - size / 2, this.ry[r]! - size / 2, size, size);
      }
      ctx.globalAlpha = (1 - k) * 0.75;
      ctx.strokeStyle = zone > 0.5 ? "hsla(190,100%,80%,1)" : "hsla(34,100%,78%,1)";
      ctx.lineWidth = 2.5 * (1 - 0.6 * k);
      ctx.beginPath();
      ctx.arc(this.rx[r]!, this.ry[r]!, 10 + (R * 0.9 + 60 * power) * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}
