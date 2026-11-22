// "At most ONE frame in flight" gate between the main thread and the tracking worker. Pure, no DOM.
//
// A queue would add latency: every waiting frame is older than the one after it. So there is no queue.
// If the worker is busy the caller simply does not send (it may remember that a newer frame is waiting and send the
// NEWEST one the moment the gate opens). A watchdog frees the gate if the worker never answers (lost message).

export class FrameGate {
  private busySince = -1;
  /** How many times the watchdog had to free a stuck gate. */
  timeouts = 0;

  constructor(private readonly timeoutMs = 2000) {}

  get busy(): boolean {
    return this.busySince >= 0;
  }

  /** True = the caller may send a frame now (and must call release() when the answer arrives or the send fails). */
  tryAcquire(nowMs: number): boolean {
    if (this.busySince >= 0) {
      if (nowMs - this.busySince <= this.timeoutMs) return false;
      this.timeouts++; // the answer never came: stop waiting for it
    }
    this.busySince = nowMs;
    return true;
  }

  release(): void {
    this.busySince = -1;
  }

  reset(): void {
    this.busySince = -1;
    this.timeouts = 0;
  }
}
