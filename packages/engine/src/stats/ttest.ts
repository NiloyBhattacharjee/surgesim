import type { SampleSummary } from "./summary.js";

/** ln Γ(x) for x > 0 (Lanczos approximation, g = 7; relative error below 1e-13). */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let sum = c[0] as number;
  for (let i = 1; i < 9; i++) sum += (c[i] as number) / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Continued fraction for the incomplete beta function (modified Lentz's method). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return h;
}

/** The regularised incomplete beta function I_x(a, b), for a, b > 0 and 0 <= x <= 1. */
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  // The fraction converges quickly when x < (a + 1) / (a + b + 2); otherwise use the symmetry relation.
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(x, a, b)) / a : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** The two-sided p-value of Student's t statistic: P(|T| >= |t|) with `df` degrees of freedom (any df > 0). */
export function tTwoSidedP(t: number, df: number): number {
  if (Number.isNaN(t) || !(df > 0)) return NaN;
  if (!Number.isFinite(t)) return 0;
  return regularizedBeta(df / (df + t * t), df / 2, 0.5);
}

/** The cumulative distribution function of Student's t distribution (any df > 0). */
export function tCdf(t: number, df: number): number {
  const tail = tTwoSidedP(t, df) / 2;
  return t > 0 ? 1 - tail : tail;
}

/** The `p` quantile of Student's t distribution (0 < p < 1, any df > 0), found by bisection. */
export function tQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1) || !(df > 0)) return NaN;
  if (p === 0.5) return 0;
  if (p < 0.5) return -tQuantile(1 - p, df);
  let lo = 0;
  let hi = 1;
  while (tCdf(hi, df) < p && hi < 1e12) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-13 * Math.max(1, hi); i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The numbers Welch's test needs from one sample (a `SampleSummary` or a results `OutputSummary` fits). */
export type SampleStats = Pick<SampleSummary, "n" | "mean" | "stdDev">;

/** The outcome of a two-sample t-test (Welch's or paired). */
export interface TTestResult {
  /** `b.mean - a.mean`. */
  diff: number;
  /** The t statistic (±Infinity when both samples have zero variance and different means). */
  t: number;
  /** Degrees of freedom (Welch–Satterthwaite, or pairs - 1 for a paired test). */
  df: number;
  /** Two-sided p-value for the hypothesis that the two true means are equal. */
  pValue: number;
  /** 95% confidence interval for the true difference of means. */
  ci95: { low: number; high: number };
}

/** The test result for difference `diff` with standard error `se`; `se` 0 means the difference is exact. */
function tResult(diff: number, se: number, df: number): TTestResult {
  if (se === 0) return { diff, t: diff === 0 ? 0 : diff > 0 ? Infinity : -Infinity, df, pValue: diff === 0 ? 1 : 0, ci95: { low: diff, high: diff } };
  const half = tQuantile(0.975, df) * se;
  return { diff, t: diff / se, df, pValue: tTwoSidedP(diff / se, df), ci95: { low: diff - half, high: diff + half } };
}

/**
 * Welch's two-sample t-test (unequal variances) for `b.mean - a.mean`, from per-sample summaries.
 * Returns null if either sample has fewer than 2 values. If neither sample varies, the difference is
 * exact: p is 1 when the means are equal and 0 when they are not.
 *
 * Replications of a simulation are independent draws, so the test is valid when the two runs use
 * different seeds. Runs that share a seed (common random numbers) are positively correlated, which makes
 * this test conservative (it reports larger p-values than a paired analysis would).
 */
export function welchTTest(a: SampleStats, b: SampleStats): TTestResult | null {
  if (a.n < 2 || b.n < 2 || a.mean === null || b.mean === null || a.stdDev === null || b.stdDev === null) return null;
  const va = (a.stdDev * a.stdDev) / a.n;
  const vb = (b.stdDev * b.stdDev) / b.n;
  const se2 = va + vb;
  const diff = b.mean - a.mean;
  if (!(se2 > 0)) return tResult(diff, 0, a.n + b.n - 2);
  // Welch-Satterthwaite df, written with variance shares so tiny variances cannot underflow to 0/0.
  const ra = va / se2;
  const rb = vb / se2;
  return tResult(diff, Math.sqrt(se2), 1 / ((ra * ra) / (a.n - 1) + (rb * rb) / (b.n - 1)));
}

/**
 * Paired t-test for `b[i] - a[i]`, where `a[i]` and `b[i]` belong together (the same replication seed, so
 * the runs share random numbers). It tests the mean of the per-pair differences, which removes the noise
 * the two runs have in common, so it detects smaller changes than Welch's test on the same data.
 * Returns null with fewer than 2 pairs, mismatched lengths, or any non-finite value. If every difference is
 * identical the change is exact: p is 1 when it is zero and 0 otherwise.
 *
 * Valid when the pairs are independent of one another, which holds for replications with different seeds.
 * If the runs happen to share no randomness the pairing buys nothing and costs about half the degrees of freedom.
 */
export function pairedTTest(a: readonly number[], b: readonly number[]): TTestResult | null {
  const n = a.length;
  if (n < 2 || b.length !== n) return null;
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = (b[i] as number) - (a[i] as number);
    if (!Number.isFinite(d)) return null;
    diffs.push(d);
  }
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const variance = diffs.reduce((s, d) => s + (d - mean) * (d - mean), 0) / (n - 1);
  // Differences that are equal up to rounding are treated as constant.
  const constant = !(Math.sqrt(variance) > 1e-12 * Math.max(1, Math.abs(mean)));
  return tResult(mean, constant ? 0 : Math.sqrt(variance / n), n - 1);
}

/**
 * Benjamini–Hochberg adjustment of p-values, controlling the false discovery rate when many outputs are
 * tested at once. Entries that are null (not testable) stay null and do not count as tests.
 * Rejecting where the adjusted value is below alpha keeps the expected share of false "differs" among
 * the reported differences at or below alpha.
 */
export function adjustPValues(pValues: readonly (number | null)[]): (number | null)[] {
  const tested = pValues.flatMap((p, i) => (p === null || Number.isNaN(p) ? [] : [{ p, i }]));
  tested.sort((x, y) => x.p - y.p);
  const m = tested.length;
  const out: (number | null)[] = pValues.map(() => null);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const item = tested[rank - 1] as { p: number; i: number };
    running = Math.min(running, (item.p * m) / rank);
    out[item.i] = running;
  }
  return out;
}
