// Fixed-size rolling window of numbers (ring buffer) with avg / p95 / max. Pure, no DOM.
// push() never allocates; summary() sorts a small copy, so call it a few times a second, not every frame.

export interface StatsSummary {
  count: number;
  last: number;
  avg: number;
  p95: number;
  max: number;
}

export class RollingStats {
  private readonly buf: Float64Array;
  private next = 0;
  private filled = 0;
  private lastValue = 0;

  constructor(readonly capacity = 120) {
    this.buf = new Float64Array(capacity);
  }

  push(v: number): void {
    this.buf[this.next] = v;
    this.next = (this.next + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
    this.lastValue = v;
  }

  get count(): number {
    return this.filled;
  }

  reset(): void {
    this.next = 0;
    this.filled = 0;
    this.lastValue = 0;
  }

  summary(): StatsSummary {
    const n = this.filled;
    if (n === 0) return { count: 0, last: 0, avg: 0, p95: 0, max: 0 };
    const sorted = this.buf.slice(0, n).sort(); // typed-array sort is numeric
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i]!;
    return {
      count: n,
      last: this.lastValue,
      avg: sum / n,
      p95: sorted[Math.min(n - 1, Math.floor(n * 0.95))]!,
      max: sorted[n - 1]!,
    };
  }
}
