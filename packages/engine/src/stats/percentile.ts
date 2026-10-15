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

/**
 * Approximate tracker in constant memory: a merging t-digest (Dunning & Ertl, "Computing extremely accurate
 * quantiles using t-digests", 2019) with the k2 scale function, which keeps centroids small in the tails so p99/p99.9
 * stay accurate. Percentiles use the same convention as {@link ExactPercentileTracker} (rank p/100 * (n - 1),
 * linear interpolation), and while every centroid holds one sample the answers are identical to it.
 * Count, mean, min and max are exact.
 */
export class StreamingPercentileTracker implements PercentileTracker {
  private means: number[] = [];
  private weights: number[] = [];
  private buffer: number[] = [];
  private n = 0;
  private sum = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = Number.NEGATIVE_INFINITY;

  /** @param compression the t-digest delta: fewer than this many centroids are kept; larger is more accurate. */
  constructor(private readonly compression = 200) {}

  add(value: number): void {
    this.buffer.push(value);
    this.n++;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    if (this.buffer.length >= 10 * this.compression) this.merge();
  }

  get count(): number {
    return this.n;
  }

  mean(): number {
    return this.n === 0 ? NaN : this.sum / this.n;
  }

  percentile(p: number): number {
    const n = this.n;
    if (n === 0 || !(p >= 0 && p <= 100)) return NaN;
    this.merge();
    const rank = (p / 100) * (n - 1);
    // A centroid of weight w whose samples start at 0-based rank s is centred at rank s + (w - 1) / 2.
    // Interpolate between centres, and between the extreme centres and the exact min (rank 0) / max (rank n - 1).
    let prevRank = 0;
    let prevValue = this.min;
    let start = 0;
    for (let i = 0; i < this.means.length; i++) {
      const w = this.weights[i] as number;
      const centre = start + (w - 1) / 2;
      const m = this.means[i] as number;
      if (rank <= centre) return between(prevRank, prevValue, centre, m, rank);
      prevRank = centre;
      prevValue = m;
      start += w;
    }
    return between(prevRank, prevValue, n - 1, this.max, rank);
  }

  reset(): void {
    this.means = [];
    this.weights = [];
    this.buffer = [];
    this.n = 0;
    this.sum = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
  }

  /** Fold the buffer into the centroids: sort everything by mean, then merge neighbours while the k2 size bound allows. */
  private merge(): void {
    if (this.buffer.length === 0) return;
    const items: [number, number][] = this.means.map((m, i) => [m, this.weights[i] as number]);
    for (const v of this.buffer) items.push([v, 1]);
    items.sort((a, b) => a[0] - b[0]);
    this.buffer = [];
    const total = this.n;
    const d = this.compression;
    // k2(q) = d / Z * ln(q / (1 - q)), Z = 4 ln(n / d) + 24; a centroid may span at most one unit of k.
    // Centroid size goes as q(1 - q), so the tails stay fine-grained.
    const scale = d / (4 * Math.log(Math.max(total / d, 1)) + 24);
    const qLimit = (q: number): number => 1 / (1 + Math.exp(-(Math.log(q / (1 - q)) + 1 / scale)));
    const means: number[] = [];
    const weights: number[] = [];
    let [curMean, curWeight] = items[0] as [number, number];
    let soFar = 0;
    let limit = total * qLimit(0);
    for (let i = 1; i < items.length; i++) {
      const [m, w] = items[i] as [number, number];
      if (soFar + curWeight + w <= limit) {
        curWeight += w;
        curMean += ((m - curMean) * w) / curWeight;
      } else {
        means.push(curMean);
        weights.push(curWeight);
        soFar += curWeight;
        limit = total * qLimit(soFar / total);
        curMean = m;
        curWeight = w;
      }
    }
    means.push(curMean);
    weights.push(curWeight);
    this.means = means;
    this.weights = weights;
  }
}

/** Linear interpolation from (r0, v0) to (r1, v1) at r; exactly v1 at r1 (no cancellation error). */
function between(r0: number, v0: number, r1: number, v1: number, r: number): number {
  return r === r1 ? v1 : v0 + ((v1 - v0) * (r - r0)) / (r1 - r0);
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
