// Harp drawing (Stage 2 polish). Cheap on purpose (PLAN.md "render must stay cheap": the render and MediaPipe share one
// GPU, so every drawn thing is counted): additive "lighter" blending, glow = layered strokes, sparks / node glows /
// pluck flashes = pre-rendered coloured sprites from fixed pools, all colour strings built once. No shadowBlur, nothing
// allocated per frame, no full-screen passes.
//
//  - A string is a glowing line with a soft glow node at each end and a faint shimmer while it rests. A pluck sets its
//    shape from where it was struck (the three lowest vibration modes, like a real string: struck near the middle it
//    swings in one big arc, near an end it ripples), brightens it, flashes the contact point, sends a ring outwards
//    and throws sparks. The wobble is SLOW (4 / 8 / 12 Hz): the real note cannot be drawn at 30 fps, and anything above
//    15 Hz would alias at the 30 fps render cap.
//  - While creating, a brighter line follows the pinch point(s); a ring marks each pinch; a grabbed string is thicker.
//  - Hand positions come at tracking rate (~14 fps), so things that follow a hand are drawn shifted ahead by `shifts`
//    (drawing only; the model never sees them).

import { noteName, pitchClass } from "../../audio/scales";
import type { Vec2 } from "../Instrument";
import type { HarpModel, HarpString } from "./model";

const LEVELS = 8; // brightness steps of the precomputed colours
const HUES = [0, 22, 45, 70, 110, 150, 175, 195, 220, 255, 285, 325]; // one per pitch class (C..B)
const WIDTHS = [20, 8, 2.4] as const;
const SPARKS = 96;
const RIPPLES = 24;
const SPRITE = 48;
const WAVE_POINTS = 24;
const MODES = 3;
const MODE_HZ = 4; // mode n wobbles at MODE_HZ * n (4, 8, 12 Hz)

/** GLOW[pitchClass][level][layer] -> CSS colour. Built once. */
const GLOW: string[][][] = HUES.map((h) =>
  Array.from({ length: LEVELS }, (_, l) => {
    const k = l / (LEVELS - 1);
    return [
      `hsla(${h},100%,58%,${(0.05 + 0.14 * k).toFixed(3)})`,
      `hsla(${h},100%,62%,${(0.2 + 0.32 * k).toFixed(3)})`,
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
    grad.addColorStop(0, `hsla(${h},100%,92%,1)`);
    grad.addColorStop(0.25, `hsla(${h},100%,68%,0.6)`);
    grad.addColorStop(1, `hsla(${h},100%,50%,0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE, SPRITE);
    return c;
  });
}

interface StringFx {
  /** Amplitude of each vibration mode, px. */
  amp: [number, number, number];
  /** 0..1 brightness boost after a pluck / creation. */
  flash: number;
  /** Seconds since the pluck, for the wobble phase (so every pluck starts the swing at its largest). */
  age: number;
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
  // ring + flash pool, one entry per pluck
  private readonly rx = new Float32Array(RIPPLES);
  private readonly ry = new Float32Array(RIPPLES);
  private readonly rage = new Float32Array(RIPPLES); // seconds since the pluck, < 0 = free
  private readonly rpow = new Float32Array(RIPPLES);
  private readonly rclass = new Uint8Array(RIPPLES);
  private nextRipple = 0;
  private lastT = 0;
  /** Text shown for a moment (limits, hints). */
  toast = "";
  private toastUntil = 0;

  constructor() {
    this.rage.fill(-1);
  }

  /** `along` = where on the string it was struck (0..1). */
  pluck(s: HarpString, strength: number, contact: Vec2, along: number): void {
    const f = this.fxOf(s.id);
    const u = Math.min(0.98, Math.max(0.02, along));
    const a = 5 + 15 * strength;
    // The strike position shapes the vibration: mode n gets sin(n pi u) / n^1.4 (a real string's spectrum).
    for (let n = 1; n <= MODES; n++) {
      f.amp[n - 1] = Math.max(f.amp[n - 1]!, (a * Math.abs(Math.sin(n * Math.PI * u))) / Math.pow(n, 1.4));
    }
    f.flash = 1;
    f.age = 0;
    const pc = pitchClass(s.midi);

    const r = this.nextRipple;
    this.nextRipple = (this.nextRipple + 1) % RIPPLES;
    this.rx[r] = contact.x;
    this.ry[r] = contact.y;
    this.rage[r] = 0;
    this.rpow[r] = strength;
    this.rclass[r] = pc;

    const n = 5 + Math.round(9 * strength);
    for (let i = 0; i < n; i++) {
      const k = this.nextSpark;
      this.nextSpark = (this.nextSpark + 1) % SPARKS;
      const ang = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 190 * (0.4 + strength);
      this.sx[k] = contact.x;
      this.sy[k] = contact.y;
      this.svx[k] = Math.cos(ang) * sp;
      this.svy[k] = Math.sin(ang) * sp - 25; // a slight upward drift: light rises
      this.smax[k] = this.slife[k] = 0.35 + Math.random() * 0.5;
      this.sclass[k] = pc;
    }
  }

  flash(id: number, level: number): void {
    const f = this.fxOf(id);
    f.flash = Math.max(f.flash, level);
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
      f = { amp: [0, 0, 0], flash: 0, age: 0 };
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

    this.drawRipples(ctx, dt);
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
    f.age += dt;
    // Each higher mode dies faster (the string settles into one slow swing).
    let moving = false;
    for (let n = 0; n < MODES; n++) {
      f.amp[n] = f.amp[n]! * Math.exp(-dt * (2.0 + 1.4 * n));
      if (f.amp[n]! < 0.12) f.amp[n] = 0;
      else moving = true;
    }
    f.flash *= Math.exp(-dt * 3.2);
    const pc = pitchClass(s.midi);
    // A resting string shimmers very slightly, so the scene is alive without a single full-screen effect.
    const shimmer = 0.045 * Math.sin(t * 1.3 + s.id * 1.7);
    const level = Math.max(0, Math.min(LEVELS - 1, Math.round((0.3 + shimmer + 0.7 * f.flash + (grabbed ? 0.4 : 0)) * (LEVELS - 1))));
    const colors = GLOW[pc]![level]!;
    const ox = shift?.x ?? 0;
    const oy = shift?.y ?? 0;
    const ax = s.a.x + ox;
    const ay = s.a.y + oy;
    const bx = s.b.x + ox;
    const by = s.b.y + oy;
    const widthK = (grabbed ? 1.5 : 1) * (1 + 0.25 * f.flash);

    // Displacement of the wave at each point is the same for the three glow layers: compute it once.
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    let wave: Float32Array | null = null;
    if (moving) {
      wave = this.wave;
      const c1 = f.amp[0]! * Math.cos(2 * Math.PI * MODE_HZ * f.age);
      const c2 = f.amp[1]! * Math.cos(2 * Math.PI * MODE_HZ * 2 * f.age + 0.6);
      const c3 = f.amp[2]! * Math.cos(2 * Math.PI * MODE_HZ * 3 * f.age + 1.2);
      for (let i = 0; i <= WAVE_POINTS; i++) {
        const u = i / WAVE_POINTS;
        wave[i] = c1 * Math.sin(Math.PI * u) + c2 * Math.sin(2 * Math.PI * u) + c3 * Math.sin(3 * Math.PI * u);
      }
    }

    for (let layer = 0; layer < 3; layer++) {
      ctx.strokeStyle = colors[layer]!;
      ctx.lineWidth = WIDTHS[layer]! * widthK;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      if (wave) {
        for (let i = 1; i <= WAVE_POINTS; i++) {
          const u = i / WAVE_POINTS;
          ctx.lineTo(ax + dx * u + nx * wave[i]!, ay + dy * u + ny * wave[i]!);
        }
      } else {
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }

    // Soft glow nodes at both ends (a string is anchored there), bigger right after a pluck.
    const sprite = this.sprites[pc];
    if (sprite) {
      const size = 26 + 22 * f.flash + (grabbed ? 12 : 0);
      ctx.globalAlpha = 0.55 + 0.45 * f.flash;
      ctx.drawImage(sprite, ax - size / 2, ay - size / 2, size, size);
      ctx.drawImage(sprite, bx - size / 2, by - size / 2, size, size);
      ctx.globalAlpha = 1;
    }

    // Note name, subtle, at the upper end.
    ctx.fillStyle = LABEL[pc]!;
    ctx.font = "11px ui-monospace, Consolas, monospace";
    const top = ay <= by ? { x: ax, y: ay } : { x: bx, y: by };
    ctx.fillText(noteName(s.midi), top.x + 12, top.y - 10);
  }

  private readonly wave = new Float32Array(WAVE_POINTS + 1);

  /** The flash at the contact point and the ring that spreads from it. */
  private drawRipples(ctx: CanvasRenderingContext2D, dt: number): void {
    const LIFE = 0.55;
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
      const pc = this.rclass[r]!;
      const power = this.rpow[r]!;
      const sprite = this.sprites[pc];
      if (sprite) {
        const size = (40 + 60 * power) * (1 - k * 0.5);
        ctx.globalAlpha = (1 - k) * (0.6 + 0.4 * power);
        ctx.drawImage(sprite, this.rx[r]! - size / 2, this.ry[r]! - size / 2, size, size);
      }
      ctx.globalAlpha = (1 - k) * 0.7;
      ctx.strokeStyle = GLOW[pc]![LEVELS - 1]![2]!;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.rx[r]!, this.ry[r]!, 8 + (30 + 50 * power) * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
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
      this.svy[k] = this.svy[k]! * (1 - 2.5 * dt) - 30 * dt; // slowly rising
      const sprite = this.sprites[this.sclass[k]!];
      if (!sprite || nl <= 0) continue;
      const a = nl / this.smax[k]!;
      const size = 8 + 20 * a;
      ctx.globalAlpha = a * a;
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
