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
   * How much the counts vary around the fitted profile, relative to Poisson arrivals (which the model assumes).
   * About 1 means Poisson-like. Well above 1 means bursty, and a Poisson model will understate queueing.
   */
  dispersionIndex: number;
  warnings: string[];
}

export interface ArrivalOptions {
  /** Width of the counting windows in seconds. Smaller windows follow changes faster but are noisier. */
  windowSeconds: number;
  /**
   * Neighbouring windows are merged into one segment when their rates differ by less than this fraction (default
   * 0.15) or by less than three standard errors of a Poisson count, whichever is larger.
   */
  mergeTolerance?: number;
  /** Start of the observation period, in the same unit as the timestamps (default: the first arrival). */
  start?: number;
  /** End of the observation period (default: the last arrival). */
  end?: number;
}

/**
 * Turn arrival timestamps (seconds) into a piecewise-constant rate profile.
 *
 * Arrivals are counted in equal windows, then neighbouring windows whose rates are statistically
 * indistinguishable are merged, so ordinary noise does not produce a jagged profile but a real change
 * (a spike, a daily cycle) does produce a new segment.
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
  let inside = 0;
  for (const t of ts) {
    if (t < start || t > end) continue;
    counts[Math.min(count - 1, Math.floor((t - start) / length))]!++;
    inside++;
  }
  const windows: ArrivalWindow[] = counts.map((c, i) => ({ start: i * length, count: c, rate: c / length }));

  // Merge neighbouring windows whose rates cannot be told apart, comparing each with the running segment.
  // Real traffic is often burstier than Poisson, which makes counts vary more than a Poisson count would. Judging
  // differences by Poisson noise alone would then mistake bursts for rate changes and chop the data into jagged
  // segments (and make the dispersion look better than it is). So the noise allowance is widened by the dispersion
  // measured on the previous attempt (quasi-Poisson), and the segmentation is repeated until that settles.
  const tolerance = options.mergeTolerance ?? 0.15;
  interface Segment { first: number; last: number; counts: number; windows: number }
  const segment = (dispersion: number): Segment[] => {
    const segs: Segment[] = [{ first: 0, last: 0, counts: counts[0] as number, windows: 1 }];
    for (let i = 1; i < count; i++) {
      const seg = segs[segs.length - 1] as Segment;
      const segLength = seg.windows * length;
      const segRate = seg.counts / segLength;
      const rate = (counts[i] as number) / length;
      const pooled = (seg.counts + (counts[i] as number)) / (segLength + length);
      const standardError = Math.sqrt(dispersion * pooled * (1 / segLength + 1 / length));
      if (Math.abs(rate - segRate) <= Math.max(tolerance * segRate, 3 * standardError)) {
        seg.last = i;
        seg.counts += counts[i] as number;
        seg.windows++;
      } else {
        segs.push({ first: i, last: i, counts: counts[i] as number, windows: 1 });
      }
    }
    return segs;
  };
  /** Chi-square style statistic around the segment rates, per degree of freedom (1 for Poisson counts). */
  const measureDispersion = (segs: Segment[]): number => {
    let chi = 0;
    for (const seg of segs) {
      const expected = seg.counts / seg.windows;
      if (expected <= 0) continue;
      for (let i = seg.first; i <= seg.last; i++) chi += ((counts[i] as number) - expected) ** 2 / expected;
    }
    const dof = count - segs.length;
    return dof > 0 ? chi / dof : NaN;
  };

  let assumed = 1;
  let segments = segment(assumed);
  let dispersionIndex = measureDispersion(segments);
  for (let attempt = 0; attempt < 4 && Number.isFinite(dispersionIndex) && dispersionIndex > assumed * 1.1; attempt++) {
    assumed = dispersionIndex;
    segments = segment(assumed);
    dispersionIndex = measureDispersion(segments);
  }
  const dof = count - segments.length;

  // A window that straddles a step change mixes the two rates and looks like a segment of its own. Detect such a
  // single window whose rate lies between its neighbours' and place the breakpoint inside it, at the moment that
  // keeps its total count: rateLeft * x + rateRight * (length - x) = count.
  interface Piece { start: number; rate: number; windows: number }
  let pieces: Piece[] = segments.map((sg) => ({ start: sg.first * length, rate: sg.counts / (sg.windows * length), windows: sg.windows }));
  for (let i = 1; i < pieces.length - 1; i++) {
    const before = pieces[i - 1] as Piece;
    const here = pieces[i] as Piece;
    const after = pieces[i + 1] as Piece;
    const between = here.rate > Math.min(before.rate, after.rate) && here.rate < Math.max(before.rate, after.rate);
    if (here.windows === 1 && between && Math.abs(before.rate - after.rate) > 1e-12) {
      const x = (here.rate * length - after.rate * length) / (before.rate - after.rate);
      pieces = [...pieces.slice(0, i), ...pieces.slice(i + 1)];
      (pieces[i] as Piece).start = here.start + Math.min(length, Math.max(0, x));
      i--;
    }
  }
  const rateProfile = pieces.map((pc): [number, number] => [Number(pc.start.toPrecision(12)), pc.rate]);

  if (count < 5) warnings.push(`Only ${count} counting window(s): use a smaller window or more data to see how the rate changes.`);
  if (dof >= 8 && dispersionIndex > 1.5) {
    warnings.push(`Arrivals are burstier than Poisson (dispersion index ${dispersionIndex.toFixed(2)}, 1 would be Poisson). A model with Poisson arrivals will understate waiting and tail latency; consider a shorter window to capture the bursts as separate rate segments.`);
  } else if (dof >= 8 && dispersionIndex < 0.5) {
    warnings.push(`Arrivals are more regular than Poisson (dispersion index ${dispersionIndex.toFixed(2)}), as with timer-driven traffic. Poisson arrivals will overstate queueing.`);
  }
  if (inside < ts.length) warnings.push(`${ts.length - inside} timestamp(s) fell outside the observation period and were ignored.`);

  return { rateProfile, meanRate: inside / duration, duration, arrivals: inside, windows, dispersionIndex, warnings };
}
