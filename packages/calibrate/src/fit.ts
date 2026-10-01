import type { DistributionSpec } from "@chronon-sim/engine";
import { ksPValue, normalCdf } from "./special.js";

/** The distribution families that can be fitted (the ones the model format supports). */
export type Family = "constant" | "exponential" | "lognormal" | "normal" | "uniform" | "triangular";

export const FAMILIES: readonly Family[] = ["constant", "exponential", "lognormal", "normal", "uniform", "triangular"];

/** One candidate distribution fitted to the data. */
export interface FitResult {
  family: Family;
  /** The fitted distribution, ready to paste into a model (seconds). */
  spec: DistributionSpec;
  /** Kolmogorov-Smirnov distance between the data and this distribution: 0 is a perfect match, smaller is better. */
  ks: number;
  /** Approximate p-value of `ks` (optimistic, because the parameters were fitted to this very data). */
  pValue: number;
}

export interface SampleFit {
  /** Number of usable (finite) observations. */
  n: number;
  mean: number;
  stdDev: number;
  /** Coefficient of variation: standard deviation divided by the mean. */
  cv: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  /** Fits that could be computed, best first. */
  fits: FitResult[];
  /** The best fit, or null when there is too little data to say. */
  best: FitResult | null;
  /** The KS distance below which the 5% critical value would not reject the fit (1.36 / sqrt(n)). */
  ksCritical: number;
  /** Things worth knowing: skipped families, a poor fit, too few samples. */
  warnings: string[];
}

export interface FitOptions {
  /** Restrict the candidates (default: all). */
  families?: readonly Family[];
}

const MIN_SAMPLES = 8;

/** The p-th percentile of sorted data by linear interpolation (the same definition the engine uses). */
function percentile(sorted: readonly number[], p: number): number {
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (rank - lo);
}

/** Kolmogorov-Smirnov distance between sorted data and a cumulative distribution function. */
function ksDistance(sorted: readonly number[], cdf: (x: number) => number): number {
  const n = sorted.length;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const f = Math.min(1, Math.max(0, cdf(sorted[i] as number)));
    d = Math.max(d, (i + 1) / n - f, f - i / n);
  }
  return d;
}

/**
 * Fit the supported distributions to measured values (seconds) and rank them by how well they match.
 *
 * Parameters are estimated from the data: the mean for exponential, the mean and spread of the logarithms for
 * lognormal (converted to the mean and standard deviation of the times themselves, which is how the model format
 * describes it), the mean and standard deviation for normal, the extremes for uniform, and the extremes plus a
 * mode estimated from the mean for triangular.
 */
export function fitSamples(values: readonly number[], options: FitOptions = {}): SampleFit {
  const warnings: string[] = [];
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < values.length) warnings.push(`${values.length - xs.length} non-finite value(s) were ignored.`);
  const n = xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  if (n === 0) {
    return { n, mean: NaN, stdDev: NaN, cv: NaN, min: NaN, max: NaN, p50: NaN, p95: NaN, p99: NaN, fits: [], best: null, ksCritical: NaN, warnings: [...warnings, "There are no usable values."] };
  }
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const stdDev = Math.sqrt(variance);
  const min = sorted[0] as number;
  const max = sorted[n - 1] as number;
  const result: SampleFit = {
    n,
    mean,
    stdDev,
    cv: mean !== 0 ? stdDev / Math.abs(mean) : NaN,
    min,
    max,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    fits: [],
    best: null,
    ksCritical: 1.36 / Math.sqrt(n),
    warnings,
  };
  if (n < MIN_SAMPLES) {
    warnings.push(`Only ${n} value(s): at least ${MIN_SAMPLES} are needed to compare distributions, and many more (hundreds) to trust the tail.`);
    return result;
  }

  const wanted = new Set(options.families ?? FAMILIES);
  const fits: FitResult[] = [];
  const add = (family: Family, spec: DistributionSpec, cdf: (x: number) => number) => {
    if (!wanted.has(family)) return;
    const ks = ksDistance(sorted, cdf);
    fits.push({ family, spec, ks, pValue: ksPValue(ks, n) });
  };

  const constant = stdDev <= 1e-9 * Math.max(1, Math.abs(mean));
  if (constant) {
    if (wanted.has("constant")) fits.push({ family: "constant", spec: { dist: "constant", value: mean }, ks: 0, pValue: 1 });
  } else {
    if (min >= 0) add("exponential", { dist: "exponential", mean }, (x) => 1 - Math.exp(-x / mean));
    else if (wanted.has("exponential")) warnings.push("Exponential was skipped: some values are negative.");

    if (min > 0) {
      const logs = xs.map(Math.log);
      const mu = logs.reduce((a, b) => a + b, 0) / n;
      const sigma2 = logs.reduce((a, b) => a + (b - mu) ** 2, 0) / n;
      const sigma = Math.sqrt(sigma2);
      const m = Math.exp(mu + sigma2 / 2);
      const s = m * Math.sqrt(Math.exp(sigma2) - 1);
      if (sigma > 0) add("lognormal", { dist: "lognormal", mean: m, stdDev: s }, (x) => (x <= 0 ? 0 : normalCdf((Math.log(x) - mu) / sigma)));
    } else if (wanted.has("lognormal")) warnings.push("Lognormal was skipped: it needs every value above zero.");

    add("normal", { dist: "normal", mean, stdDev }, (x) => normalCdf((x - mean) / stdDev));
    add("uniform", { dist: "uniform", min, max }, (x) => (x <= min ? 0 : x >= max ? 1 : (x - min) / (max - min)));

    const mode = Math.min(max, Math.max(min, 3 * mean - min - max));
    add("triangular", { dist: "triangular", min, mode, max }, (x) => {
      if (x <= min) return 0;
      if (x >= max) return 1;
      if (x <= mode) return mode === min ? 0 : (x - min) ** 2 / ((max - min) * (mode - min));
      return 1 - (max - x) ** 2 / ((max - min) * (max - mode));
    });
  }

  fits.sort((a, b) => a.ks - b.ks);
  result.fits = fits;
  result.best = fits[0] ?? null;
  if (result.best && result.best.ks > result.ksCritical * 1.5) {
    warnings.push(
      `No family fits well (the best, ${result.best.family}, has KS distance ${result.best.ks.toFixed(3)} against a 5% critical value of about ${result.ksCritical.toFixed(3)}). ` +
        "The data may be a mixture (for example fast cache hits plus slow misses). Fitting one distribution will misstate the tail.",
    );
  }
  if (result.best?.family === "normal" && mean < 3 * stdDev) {
    warnings.push("The best fit is normal, but the spread is large compared with the mean, so the model would draw negative times (they are clamped to zero).");
  }
  return result;
}
