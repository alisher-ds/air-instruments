// A SYNTHETIC render load for speed tests (Stage 0.7). It is NOT part of any instrument.
//
// Why it exists: the harp does not exist yet, so with the video moved out of the canvas the canvas has almost nothing
// to draw, and "render scale 0.5" could not show any difference. This draws what the harp will draw, in the way PLAN.md
// says to draw it (additive "lighter" blending, layered strokes for glow, pre-rendered sprites for sparks, no
// shadowBlur): 12 glowing strings with 3 stroke layers each, ~120 glow sprites and a few big soft blobs.
// Deterministic motion from the clock, no allocation per frame.

const STRINGS = 12;
const SPARKS = 120;
const BLOBS = 4;
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
  grad.addColorStop(0.25, "rgba(255,255,255,0.45)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, SPRITE, SPRITE);
  return c;
}

// Constant colour strings (no string building per frame).
const STRING_COLORS: Array<[string, string, string]> = Array.from({ length: STRINGS }, (_, i) => {
  const hue = Math.round((i / STRINGS) * 300);
  return [`hsla(${hue},100%,60%,0.07)`, `hsla(${hue},100%,65%,0.2)`, `hsla(${hue},100%,85%,0.9)`];
});
const STRING_WIDTHS = [26, 10, 3] as const;

export class TestLoad {
  private readonly sprite = makeSprite();

  draw(ctx: CanvasRenderingContext2D, nowMs: number, w: number, h: number): void {
    const t = nowMs / 1000;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";

    // Glowing strings: three layered strokes each (wide faint, medium, thin bright), gently vibrating.
    for (let i = 0; i < STRINGS; i++) {
      const x0 = w * (0.06 + (0.88 * i) / (STRINGS - 1));
      const x1 = x0 + Math.sin(t * 0.4 + i) * w * 0.04;
      const bend = Math.sin(t * (6 + i * 0.7) + i) * 10;
      const colors = STRING_COLORS[i]!;
      for (let layer = 0; layer < 3; layer++) {
        ctx.strokeStyle = colors[layer]!;
        ctx.lineWidth = STRING_WIDTHS[layer]!;
        ctx.beginPath();
        ctx.moveTo(x0, h * 0.12);
        ctx.quadraticCurveTo((x0 + x1) / 2 + bend, h * 0.5, x1, h * 0.88);
        ctx.stroke();
      }
    }

    // Sparks and big soft glows: pre-rendered sprite, many sizes.
    const sprite = this.sprite;
    if (sprite) {
      for (let i = 0; i < SPARKS; i++) {
        const a = i * 12.9898;
        const px = (Math.sin(a) * 0.5 + 0.5) * w;
        const py = (((Math.cos(a * 1.7) * 0.5 + 0.5) + t * (0.03 + (i % 7) * 0.01)) % 1) * h;
        const size = 24 + (i % 9) * 8;
        ctx.globalAlpha = 0.35 + 0.35 * Math.sin(t * 3 + i);
        ctx.drawImage(sprite, px - size / 2, py - size / 2, size, size);
      }
      for (let i = 0; i < BLOBS; i++) {
        const size = 260 + i * 60;
        ctx.globalAlpha = 0.18;
        ctx.drawImage(sprite, w * (0.2 + 0.2 * i) + Math.sin(t * 0.5 + i) * 40 - size / 2, h * 0.5 + Math.cos(t * 0.4 + i) * 60 - size / 2, size, size);
      }
    }
    ctx.restore();
  }
}
