/** One slice of the observation period and how many requests arrived in it. */
export interface ArrivalWindow {
  /** Seconds from the start of the data. */
  start: number;
  count: number;
  /** Arrivals per second in this window. */
  rate: number;
}

export interface ArrivalFit {
  /** Piecewise-constant arrival rate, ready for an EntityGenerator in rateProfile mode: [[startSeconds, perSecond], ...]. */
  rateProfile: [number, number][];
  /** Total arrivals divided by the observation period. */
  meanRate: number;
  /** Length of the observation period in seconds. */
  duration: number;
  arrivals: number;
  /** The raw per-window counts the profile was built from. */
  windows: ArrivalWindow[];
  /**
   * How much short-interval counts vary around the fitted profile, relative to Poisson arrivals (which the model
   * assumes). About 1 means Poisson-like. Well above 1 means bursty, and a Poisson model will understate queueing.
   * Measured around the fitted profile, so a rate change that the profile captures does not count as burstiness.
   */
  dispersionIndex: number;
  warnings: string[];
}

export interface ArrivalOptions {
  /** Width of the counting windows in seconds. Smaller windows follow changes faster but are noisier. */
  windowSeconds: number;
  /**
   * Neighbouring segments are merged when their rates differ by less than this fraction of the lower rate (default
   * 0.15), however statistically clear the difference is: a change that small is not worth modelling.
   */
  mergeTolerance?: number;
  /** Start of the observation period, in the same unit as the timestamps (default: the first arrival). */
  start?: number;
  /** End of the observation period (default: the last arrival). */
  end?: number;
}

/** Fewest arrivals per short bin, on average, for the dispersion estimate. */
const MIN_BIN_MEAN = 3;
/** The fraction of adjacent-bin differences discarded as outliers (rate steps and one-off bursts). */
const TRIM_FRACTION = 0.05;
/** The mean of a chi-square(1) variable after its largest 5% are discarded; undoes the bias of that trimming. */
const TRIMMED_CHI_SQUARE_MEAN = 0.76;
/** Cost of one more segment, in units of 2 x log-likelihood per unit of dispersion, per ln(number of windows). */
const PENALTY_PER_LN_WINDOW = 2.5;

/** Index of the first element of the sorted array that is >= value. */
function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Counts in short bins, used to judge how Poisson-like the arrivals are. The bins are short enough that a rate step
 * touches only one or two of them, and long enough that each holds a few arrivals on average. They do not depend on
 * the (possibly much longer) counting window the user chose.
 */
function shortBins(relative: readonly number[], duration: number, windowSeconds: number): { counts: number[]; length: number } {
  let width = Math.min(windowSeconds, duration / 100);
  if (relative.length > 0) width = Math.max(width, (MIN_BIN_MEAN * duration) / relative.length);
  const n = Math.max(1, Math.floor(duration / width));
  const length = duration / n;
  const counts = new Array<number>(n).fill(0);
  for (const t of relative) counts[Math.min(n - 1, Math.floor(t / length))]!++;
  return { counts, length };
}

/**
 * Dispersion estimated from the difference between neighbouring bins. For Poisson counts a and b,
 * (b - a)^2 / (a + b) averages exactly 1 whatever the rate, so the estimate is the same on a quiet and a busy stretch.
 * A rate step changes only the one pair of neighbours that straddles it, and the largest few ratios are discarded, so
 * a step cannot inflate the estimate. (Measuring the spread around one overall mean, as a plain variance does, counts
 * every step as burstiness; and using that to decide whether a step is real hides the step.)
 */
function stepProofDispersion(counts: readonly number[]): number {
  const ratios: number[] = [];
  for (let i = 1; i < counts.length; i++) {
    const a = counts[i - 1] as number;
    const b = counts[i] as number;
    if (a + b > 0) ratios.push((b - a) ** 2 / (a + b));
  }
  if (ratios.length < 10) return 1; // too little to say; assume Poisson
  ratios.sort((x, y) => x - y);
  const keep = Math.max(1, Math.floor(ratios.length * (1 - TRIM_FRACTION)));
  let sum = 0;
  for (let i = 0; i < keep; i++) sum += ratios[i] as number;
  return sum / keep / TRIMMED_CHI_SQUARE_MEAN;
}

/**
 * Best split of the window counts into constant-rate segments: the segmentation that minimises the Poisson deviance
 * (divided by the dispersion) plus a penalty per segment, found exactly with the PELT algorithm. It looks at the
 * whole series at once, so it does not depend on which window happens to come first. Returns the first window of
 * each segment.
 */
function segmentCounts(counts: readonly number[], dispersion: number): number[] {
  const n = counts.length;
  const penalty = PENALTY_PER_LN_WINDOW * Math.log(Math.max(n, 3));
  const prefix = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] as number) + (counts[i] as number);
  /** -2 x the maximised Poisson log-likelihood of windows [a, b) as one segment, without the constant term. */
  const cost = (a: number, b: number): number => {
    const total = (prefix[b] as number) - (prefix[a] as number);
    return total > 0 ? (-2 * total * Math.log(total / (b - a))) / dispersion : 0;
  };
  const best = new Array<number>(n + 1).fill(0);
  const from = new Array<number>(n + 1).fill(0);
  let candidates = [0];
  for (let t = 1; t <= n; t++) {
    const values = candidates.map((a) => (best[a] as number) + cost(a, t));
    let bestValue = Infinity;
    let bestFrom = 0;
    values.forEach((v, k) => {
      if (v + penalty < bestValue) {
        bestValue = v + penalty;
        bestFrom = candidates[k] as number;
      }
    });
    best[t] = bestValue;
    from[t] = bestFrom;
    // PELT pruning: a start that is already worse than the best cannot become the best later.
    candidates = candidates.filter((_, k) => (values[k] as number) <= bestValue);
    candidates.push(t);
  }
  const starts: number[] = [];
  for (let t = n; t > 0; t = from[t] as number) starts.push(from[t] as number);
  return starts.reverse();
}

/**
 * Turn arrival timestamps (seconds) into a piecewise-constant rate profile.
 *
 * Arrivals are counted in equal windows and split into constant-rate segments by an optimal change-point search.
 * Ordinary noise does not produce a jagged profile, a real change (a spike, a daily cycle) does produce a new
 * segment, and changes smaller than `mergeTolerance` are ignored. The breakpoints are then placed from the raw
 * timestamps, not just at window edges, and the rates are the observed counts in each segment, so the profile
 * reproduces the observed number of arrivals exactly.
 *
 * How bursty the arrivals are is measured separately, on short bins and in a way a rate change cannot inflate, and is
 * used to widen the noise allowance so that bursts are not mistaken for rate changes.
 */
export function fitArrivalProfile(timestamps: readonly number[], options: ArrivalOptions): ArrivalFit {
  const warnings: string[] = [];
  const ts = timestamps.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (!(options.windowSeconds > 0)) throw new RangeError("windowSeconds must be greater than 0");
  if (ts.length < 2) throw new RangeError("at least two arrival timestamps are needed");
  const start = options.start ?? (ts[0] as number);
  const end = options.end ?? (ts[ts.length - 1] as number);
  const duration = end - start;
  if (!(duration > 0)) throw new RangeError("the observation period must have a positive length");

  const count = Math.max(1, Math.floor(duration / options.windowSeconds));
  const length = duration / count;
  const counts = new Array<number>(count).fill(0);
  // Arrival times inside the period, in seconds from its start, sorted.
  const relative: number[] = [];
  for (const t of ts) {
    if (t < start || t > end) continue;
    counts[Math.min(count - 1, Math.floor((t - start) / length))]!++;
    relative.push(t - start);
  }
  const inside = relative.length;
  const windows: ArrivalWindow[] = counts.map((c, i) => ({ start: i * length, count: c, rate: c / length }));

  // 1. How noisy is the traffic, independently of any rate changes?
  const bins = shortBins(relative, duration, options.windowSeconds);
  // Never assume the traffic is steadier than Poisson: that would only make the segmentation chase noise.
  const assumedDispersion = Math.max(1, stepProofDispersion(bins.counts));

  // 2. Optimal segmentation of the window counts, then drop differences too small to matter.
  interface Piece { first: number; end: number; counts: number }
  const starts = segmentCounts(counts, assumedDispersion);
  let pieces: Piece[] = starts.map((first, k) => {
    const last = starts[k + 1] ?? count;
    let total = 0;
    for (let i = first; i < last; i++) total += counts[i] as number;
    return { first, end: last, counts: total };
  });
  const tolerance = options.mergeTolerance ?? 0.15;
  const rateOf = (pc: Piece): number => pc.counts / ((pc.end - pc.first) * length);
  const relativeDifference = (a: Piece, b: Piece): number => {
    const low = Math.min(rateOf(a), rateOf(b));
    const high = Math.max(rateOf(a), rateOf(b));
    return low > 0 ? (high - low) / low : high > 0 ? Infinity : 0;
  };
  for (;;) {
    let at = -1;
    let smallest = Infinity;
    for (let i = 0; i + 1 < pieces.length; i++) {
      const d = relativeDifference(pieces[i] as Piece, pieces[i + 1] as Piece);
      if (d < smallest) {
        smallest = d;
        at = i;
      }
    }
    if (at < 0 || smallest > tolerance) break;
    const a = pieces[at] as Piece;
    const b = pieces[at + 1] as Piece;
    pieces = [...pieces.slice(0, at), { first: a.first, end: b.end, counts: a.counts + b.counts }, ...pieces.slice(at + 2)];
  }

  // 3. Breakpoints. Each starts at a window edge (the window where the rate changes). A window that straddles a step
  // mixes the two rates and looks like a segment of its own: a single window whose rate lies between its neighbours'
  // is removed, leaving a breakpoint somewhere inside it. Each breakpoint is then moved to the most likely time,
  // given the raw timestamps near it and the rates on either side.
  interface Edge { time: number; lo: number; hi: number }
  let edges: Edge[] = pieces.slice(1).map((pc) => ({ time: pc.first * length, lo: pc.first * length - length, hi: pc.first * length + length }));
  for (let i = 1; i < pieces.length - 1; i++) {
    const before = pieces[i - 1] as Piece;
    const here = pieces[i] as Piece;
    const after = pieces[i + 1] as Piece;
    const between = rateOf(here) > Math.min(rateOf(before), rateOf(after)) && rateOf(here) < Math.max(rateOf(before), rateOf(after));
    if (here.end - here.first === 1 && between) {
      const middle = (here.first + 0.5) * length;
      edges = [...edges.slice(0, i - 1), { time: middle, lo: middle - length, hi: middle + length }, ...edges.slice(i + 1)];
      pieces = [...pieces.slice(0, i), ...pieces.slice(i + 1)];
      i--;
    }
  }
  /** Rate of a segment from its whole windows, leaving out the window beside the breakpoint (it may straddle it). */
  const cleanRate = (pc: Piece, skipFirst: boolean, skipLast: boolean): number => {
    let first = pc.first + (skipFirst ? 1 : 0);
    let last = pc.end - (skipLast ? 1 : 0);
    if (last <= first) {
      first = pc.first;
      last = pc.end;
    }
    let total = 0;
    for (let i = first; i < last; i++) total += counts[i] as number;
    return total / ((last - first) * length);
  };
  const times = edges.map((edge, k) => {
    const lo = Math.max(edge.lo, k > 0 ? ((edges[k - 1] as Edge).time + edge.time) / 2 : 0);
    const hi = Math.min(edge.hi, k + 1 < edges.length ? (edge.time + (edges[k + 1] as Edge).time) / 2 : duration);
    const rateLeft = Math.max(cleanRate(pieces[k] as Piece, false, true), 1e-9);
    const rateRight = Math.max(cleanRate(pieces[k + 1] as Piece, true, false), 1e-9);
    const first = lowerBound(relative, lo);
    const inZone = lowerBound(relative, hi) - first;
    // Give the first j arrivals of the zone to the left rate and the rest to the right rate; keep the likeliest j.
    let bestLogLikelihood = -Infinity;
    let bestTime = Math.min(hi, Math.max(lo, edge.time));
    for (let j = 0; j <= inZone; j++) {
      const earliest = j === 0 ? lo : (relative[first + j - 1] as number);
      const latest = j === inZone ? hi : (relative[first + j] as number);
      const t = rateRight > rateLeft ? latest : earliest;
      const logLikelihood = j * Math.log(rateLeft) - rateLeft * (t - lo) + (inZone - j) * Math.log(rateRight) - rateRight * (hi - t);
      if (logLikelihood > bestLogLikelihood) {
        bestLogLikelihood = logLikelihood;
        bestTime = (earliest + latest) / 2;
      }
    }
    return bestTime;
  });

  // 4. The rates are the observed counts in each segment, so the profile reproduces the observed arrivals exactly.
  const bounds = [0, ...times, duration];
  const rateProfile: [number, number][] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const from = bounds[k] as number;
    const to = bounds[k + 1] as number;
    if (!(to - from > 1e-9)) continue;
    const arrivals = (k + 2 === bounds.length ? relative.length : lowerBound(relative, to)) - lowerBound(relative, from);
    rateProfile.push([Number(from.toPrecision(12)), arrivals / (to - from)]);
  }
  if (rateProfile.length === 0) rateProfile.push([0, inside / duration]);

  // 5. How far the short-bin counts stray from what the fitted profile expects (Pearson chi-square per degree of freedom).
  const expectedIn = (a: number, b: number): number => {
    let total = 0;
    rateProfile.forEach(([from, rate], k) => {
      const to = k + 1 < rateProfile.length ? (rateProfile[k + 1] as [number, number])[0] : duration;
      total += rate * Math.max(0, Math.min(b, to) - Math.max(a, from));
    });
    return total;
  };
  let chi = 0;
  bins.counts.forEach((c, i) => {
    const expected = expectedIn(i * bins.length, (i + 1) * bins.length);
    if (expected > 0) chi += (c - expected) ** 2 / expected;
  });
  const dof = bins.counts.length - rateProfile.length;
  const dispersionIndex = dof > 0 ? chi / dof : NaN;

  if (count < 5) warnings.push(`Only ${count} counting window(s): use a smaller window or more data to see how the rate changes.`);
  if (dof >= 8 && dispersionIndex > 1.5) {
    warnings.push(`Arrivals are burstier than Poisson (dispersion index ${dispersionIndex.toFixed(2)}, 1 would be Poisson). A model with Poisson arrivals will understate waiting and tail latency.`);
  } else if (dof >= 8 && dispersionIndex < 0.5) {
    warnings.push(`Arrivals are more regular than Poisson (dispersion index ${dispersionIndex.toFixed(2)}), as with timer-driven traffic. Poisson arrivals will overstate queueing.`);
  }
  if (inside < ts.length) warnings.push(`${ts.length - inside} timestamp(s) fell outside the observation period and were ignored.`);

  return { rateProfile, meanRate: inside / duration, duration, arrivals: inside, windows, dispersionIndex, warnings };
}
