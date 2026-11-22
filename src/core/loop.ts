// requestAnimationFrame loop with timing and an FPS counter. Runs at display rate (rendering).
// Tracking runs separately, once per new camera frame (see tracking.ts).

export class MainLoop {
  /** Smoothed frames per second. */
  fps = 0;
  private handle = 0;
  private last = 0;
  private running = false;

  constructor(private readonly tick: (dtSec: number, nowMs: number) => void) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    this.handle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    if (this.last > 0) {
      // Clamp so a long pause (hidden tab, breakpoint) is not seen as one huge step.
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      if (dt > 0) {
        const inst = 1 / dt;
        this.fps = this.fps === 0 ? inst : this.fps * 0.95 + inst * 0.05;
      }
      this.tick(dt, now);
    }
    this.last = now;
    this.handle = requestAnimationFrame(this.frame);
  };
}
