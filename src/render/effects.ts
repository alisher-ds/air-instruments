// Shared drawing helpers for instruments. Stage 0 only has the bare minimum; glow sprites, particle pools and trails
// arrive with the harp (Stages 1-2). Rule: no per-frame shadowBlur on many objects.

export class Effects {
  /** Run `draw` with additive blending ("lighter") so overlapping lights add up instead of covering each other. */
  additive(ctx: CanvasRenderingContext2D, draw: () => void): void {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    draw();
    ctx.restore();
  }
}
