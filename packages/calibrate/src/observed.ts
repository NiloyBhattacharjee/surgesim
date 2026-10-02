import { tQuantile975, type RunResults } from "@surgesim/engine";

/** A measured value, optionally with the range it was measured within and its own tolerance. */
export type ObservedMetric = number | { value: number; low?: number; high?: number; tolerance?: number };

/** What was measured on the real system, by output id ("sink.p99", "pool.Utilisation", ...). */
export interface ObservedMetrics {
  /** Default tolerance for "close" (a fraction, default 0.1 meaning 10%). */
  tolerance?: number;
  /**
   * How many independent periods (days, runs) the measurements average over. Default 1: each number is one
   * period's value, which varies from period to period. Averaging over more periods makes the real value steadier,
   * so the model's expected range for it narrows.
   */
  periods?: number;
  metrics: Record<string, ObservedMetric>;
}

/**
 * - `match`: the observation lies inside the range the model expects for one measurement (its 95% prediction
 *   interval), or the observed range overlaps it. The real system could plausibly have produced this.
 * - `close`: outside that range, but within the tolerance of the model's mean.
 * - `off`: further away than the tolerance.
 * - `missing`: the model has no such output, or it has no value.
 */
export type Verdict = "match" | "close" | "off" | "missing";

export interface ComparisonRow {
  id: string;
  observed: number;
  observedLow: number | null;
  observedHigh: number | null;
  /** The model's mean across replications. */
  model: number | null;
  /** The range in which 95% of single measurements of this output are expected to fall, according to the model. */
  expectedLow: number | null;
  expectedHigh: number | null;
  /** (model - observed) / |observed|, or null when it cannot be computed. */
  relativeError: number | null;
  tolerance: number;
  verdict: Verdict;
}

export interface Comparison {
  rows: ComparisonRow[];
  /** True when no row is `off` or `missing`. */
  passed: boolean;
  counts: Record<Verdict, number>;
  /**
   * The widest expected range as a fraction of the model's value. Differences smaller than this cannot be told
   * apart from ordinary period-to-period variation using the data given.
   */
  widestRelativeRange: number | null;
}

/**
 * Compare a model's results with measurements from the real system.
 *
 * A measurement is one sample of a noisy quantity: tomorrow's p99 will differ from today's even if nothing
 * changed. So the question is not "does the model's average equal this number?" (with enough replications it
 * never would) but "is this number plausible for the model?". The model answers with the spread of its own
 * replications: a 95% prediction interval, `mean ± t * sd * sqrt(1/periods + 1/replications)`.
 *
 * Consequence: one period of data can only expose errors larger than that interval. Smaller errors are real but
 * undetectable from a single observation; more periods narrow the interval.
 */
export function compareToObserved(results: RunResults, observed: ObservedMetrics, defaults: { tolerance?: number } = {}): Comparison {
  const baseTolerance = observed.tolerance ?? defaults.tolerance ?? 0.1;
  const periods = Math.max(1, observed.periods ?? 1);
  let widest: number | null = null;
  const rows: ComparisonRow[] = Object.entries(observed.metrics).map(([id, raw]) => {
    const m = typeof raw === "number" ? { value: raw } : raw;
    const tolerance = (typeof raw === "number" ? undefined : raw.tolerance) ?? baseTolerance;
    const out = results.outputs.find((o) => o.id === id);
    const model = out?.mean ?? null;
    const row: ComparisonRow = {
      id,
      observed: m.value,
      observedLow: typeof raw === "number" ? null : (raw.low ?? null),
      observedHigh: typeof raw === "number" ? null : (raw.high ?? null),
      model,
      expectedLow: null,
      expectedHigh: null,
      relativeError: null,
      tolerance,
      verdict: "missing",
    };
    if (model === null || out === undefined) return row;

    if (out.n >= 2 && out.stdDev !== null) {
      const half = tQuantile975(out.n - 1) * out.stdDev * Math.sqrt(1 / periods + 1 / out.n);
      row.expectedLow = model - half;
      row.expectedHigh = model + half;
      if (model !== 0) widest = Math.max(widest ?? 0, half / Math.abs(model));
    }
    const scale = Math.max(Math.abs(m.value), 1e-12);
    row.relativeError = (model - m.value) / scale;
    const obsLow = row.observedLow ?? m.value;
    const obsHigh = row.observedHigh ?? m.value;
    const lo = row.expectedLow ?? model;
    const hi = row.expectedHigh ?? model;
    if (obsLow <= hi && lo <= obsHigh) row.verdict = "match";
    else if (Math.abs(row.relativeError) <= tolerance) row.verdict = "close";
    else row.verdict = "off";
    return row;
  });
  const counts: Record<Verdict, number> = { match: 0, close: 0, off: 0, missing: 0 };
  for (const r of rows) counts[r.verdict]++;
  return { rows, passed: counts.off === 0 && counts.missing === 0, counts, widestRelativeRange: widest };
}
