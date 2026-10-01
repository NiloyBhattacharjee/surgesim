/**
 * Collects observations and answers mean/percentile queries. Implementations may be exact or
 * approximate (e.g. a future t-digest or HDR histogram) behind this interface.
 */
export interface PercentileTracker {
  /** Record one observation. */
  add(value: number): void;
  /** Number of observations recorded. */
  readonly count: number;
  /** Arithmetic mean, or NaN if empty. */
  mean(): number;
  /** The p-th percentile for p in [0, 100], or NaN if empty. */
  percentile(p: number): number;
  /** Discard all observations. */
  reset(): void;
}

/** Exact tracker: stores every sample and sorts lazily at query time (linear interpolation). */
export class ExactPercentileTracker implements PercentileTracker {
  private samples: number[] = [];
  private sum = 0;
  private sorted = true;

  add(value: number): void {
    this.samples.push(value);
    this.sum += value;
    this.sorted = false;
  }

  get count(): number {
    return this.samples.length;
  }

  mean(): number {
    return this.samples.length === 0 ? NaN : this.sum / this.samples.length;
  }

  percentile(p: number): number {
    const n = this.samples.length;
    if (n === 0 || !(p >= 0 && p <= 100)) return NaN;
    if (!this.sorted) {
      this.samples.sort((a, b) => a - b);
      this.sorted = true;
    }
    const rank = (p / 100) * (n - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    const a = this.samples[lo] as number;
    const b = this.samples[hi] as number;
    return a + (b - a) * (rank - lo);
  }

  reset(): void {
    this.samples = [];
    this.sum = 0;
    this.sorted = true;
  }
}

/** Running count/mean/min/max of observations (no storage). */
export class Tally {
  count = 0;
  private sum = 0;
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;

  add(value: number): void {
    this.count++;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
  }

  mean(): number {
    return this.count === 0 ? NaN : this.sum / this.count;
  }

  reset(): void {
    this.count = 0;
    this.sum = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
  }
}
