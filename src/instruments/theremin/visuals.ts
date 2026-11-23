// Theremin drawing. Same cheap rules as the other instruments ("render must stay cheap"): additive blending, layered
// strokes, one pre-rendered sprite, one path for all guide lines, no shadowBlur, no full-screen pass, no per-frame allocation.
//
//  - Pitch guide lines: one faint horizontal line per scale note, at the height where the pitch hand plays it (through the
//    calibrated range), the note name at the right edge; the line of the note being played glows.
//  - A flowing wave between the two hands: its amplitude is the loudness, its number of waves follows the pitch, its colour
//    too, it flows at a speed that follows the pitch, and it trembles with the vibrato depth. It tapers to nothing at the hands.
//  - Hand markers: a glowing disc on the pitch hand with a tick on the active guide line (hollow when muted by a pinch), and
//    a vertical gauge next to the volume hand (below the dead zone it is empty).

import { noteName } from "../../audio/scales";
import { outlinedText } from "../../render/text";
import { scaleNotes } from "../../audio/scales";
import { ROOT_MIDI } from "../../audio/scales";
import { config } from "../../config";
import type { Vec2 } from "../Instrument";
import { PITCH_SEMITONES, type ThereminModel } from "./model";

const WAVE_POINTS = 56;
const SPRITE = 64;

function makeSprite(): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = SPRITE;
  c.height = SPRITE;
  const g = c.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.5)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, SPRITE, SPRITE);
  return c;
}

/** Colour strings per hue step (36 steps), built once: [wide glow, mid, core]. */
const HUES = Array.from({ length: 36 }, (_, i) => {
  const h = 190 + (i / 35) * 150; // cyan -> blue -> violet -> magenta as the pitch rises
  return [`hsla(${h},100%,60%,0.10)`, `hsla(${h},100%,65%,0.32)`, `hsla(${h},100%,86%,0.95)`] as const;
});
const WIDTHS = [18, 7, 2.4] as const;

export class ThereminView {
  private readonly sprite = makeSprite();
  private phase = 0;
  private lastT = 0;
  private notes = scaleNotes(config.thereminScale);
  private notesScale = config.thereminScale;
  private readonly wave = new Float32Array(WAVE_POINTS + 1);

  /** `shifts`: how far ahead (px) to draw the hand markers and the wave ends (the tracking frame is ~100 ms old). */
  render(
    ctx: CanvasRenderingContext2D,
    model: ThereminModel,
    nowMs: number,
    w: number,
    h: number,
    pitchShift: Vec2,
    volShift: Vec2,
  ): void {
    const dt = this.lastT > 0 ? Math.min(0.1, (nowMs - this.lastT) / 1000) : 0;
    this.lastT = nowMs;
    if (this.notesScale !== config.thereminScale) {
      this.notesScale = config.thereminScale;
      this.notes = scaleNotes(config.thereminScale);
    }
    const st = model.state;
    const cal = model.calibration.pitch;
    const yOf = (midi: number): number => (cal.lo - ((midi - ROOT_MIDI) / PITCH_SEMITONES) * (cal.lo - cal.hi)) * h;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // --- guide lines (one path) ---
    const active = Math.round(st.midi);
    // Each line is a dark thin line with a light thin line on it, so it shows on a white wall AND in a dark room.
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    for (const m of this.notes) {
      if (m === active && st.pitchHand) continue;
      const y = yOf(m);
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(225,236,255,0.6)";
    ctx.stroke();
    ctx.font = "600 12px ui-monospace, Consolas, monospace";
    ctx.textAlign = "right";
    for (const m of this.notes) outlinedText(ctx, noteName(m), w - 10, yOf(m) - 5, "rgba(235,242,255,0.95)");
    ctx.textAlign = "left";
    ctx.globalCompositeOperation = "lighter";

    const hueIdx = Math.max(0, Math.min(35, Math.round(st.tPitch * 35)));
    const colors = HUES[hueIdx]!;

    // The note being played: a brighter line.
    if (st.pitchHand) {
      const y = yOf(st.midi);
      ctx.strokeStyle = colors[1]!;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // --- the wave between the hands ---
    if (st.pitchHand && st.volHand) {
      const ax = st.volHand.x + volShift.x;
      const ay = st.volHand.y + volShift.y;
      const bx = st.pitchHand.x + pitchShift.x;
      const by = st.pitchHand.y + pitchShift.y;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const cycles = 2 + 10 * st.tPitch;
      this.phase += dt * (2 + 10 * st.tPitch) * 2 * Math.PI;
      const amp = st.gain > 0 ? 6 + 70 * Math.sqrt(st.gain) : 1.5;
      // vibrato makes the wave tremble a little
      const trem = 1 + (st.vibratoCents / 60) * 0.35 * Math.sin(nowMs / 1000 * st.vibratoHz * 2 * Math.PI);
      for (let i = 0; i <= WAVE_POINTS; i++) {
        const u = i / WAVE_POINTS;
        this.wave[i] = amp * trem * Math.sin(Math.PI * u) * Math.sin(u * cycles * 2 * Math.PI - this.phase);
      }
      const alpha = st.gain > 0 ? 1 : 0.25;
      ctx.globalAlpha = alpha;
      for (let layer = 0; layer < 3; layer++) {
        ctx.strokeStyle = colors[layer]!;
        ctx.lineWidth = WIDTHS[layer]! * (0.6 + 0.4 * Math.min(1, st.gain * 2));
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        for (let i = 1; i <= WAVE_POINTS; i++) {
          const u = i / WAVE_POINTS;
          ctx.lineTo(ax + dx * u + nx * this.wave[i]!, ay + dy * u + ny * this.wave[i]!);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // --- hand markers ---
    if (st.pitchHand) {
      const x = st.pitchHand.x + pitchShift.x;
      const y = st.pitchHand.y + pitchShift.y;
      if (this.sprite) {
        const size = st.muted ? 40 : 60 + 50 * st.gain;
        ctx.globalAlpha = st.muted ? 0.25 : 0.7;
        ctx.drawImage(this.sprite, x - size / 2, y - size / 2, size, size);
        ctx.globalAlpha = 1;
      }
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = st.muted ? "rgba(255,255,255,0.35)" : colors[2]!;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.stroke();
      // a tick on the guide line of the note that is playing
      const ny0 = yOf(st.midi);
      ctx.beginPath();
      ctx.moveTo(x - 34, ny0);
      ctx.lineTo(x + 34, ny0);
      ctx.stroke();
    }
    if (st.volHand) {
      const x = st.volHand.x + volShift.x;
      const y = st.volHand.y + volShift.y;
      const c = model.calibration.vol;
      const top = c.hi * h;
      const bottom = c.lo * h;
      const gx = Math.max(30, x - 80);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(190,215,255,0.18)";
      ctx.beginPath();
      ctx.moveTo(gx, top);
      ctx.lineTo(gx, bottom);
      ctx.stroke();
      ctx.strokeStyle = st.gain > 0 ? colors[2]! : "rgba(190,215,255,0.35)";
      ctx.beginPath();
      ctx.moveTo(gx, bottom);
      ctx.lineTo(gx, bottom - (bottom - top) * st.tVol);
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}
