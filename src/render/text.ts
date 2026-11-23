// Text that can be read on ANY background (a white wall behind the player, or a dark room).
//
// The light effects are drawn with additive blending, which makes light-coloured text vanish on a bright picture. Labels are
// therefore drawn with normal blending, a dark outline under the light fill (like subtitles). The caller sets font and align.

/** Draws `text` at (x, y) with a dark outline. Leaves the composite mode and the line settings as they were. */
export function outlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fill: string,
  outline = "rgba(0,0,0,0.75)",
  outlineWidth = 3,
): void {
  const op = ctx.globalCompositeOperation;
  const width = ctx.lineWidth;
  const join = ctx.lineJoin;
  ctx.globalCompositeOperation = "source-over";
  ctx.lineJoin = "round";
  ctx.lineWidth = outlineWidth;
  ctx.strokeStyle = outline;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.globalCompositeOperation = op;
  ctx.lineWidth = width;
  ctx.lineJoin = join;
}
