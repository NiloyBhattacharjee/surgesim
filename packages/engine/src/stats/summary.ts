import { tQuantile } from "./ttest.js";

/** The 0.975 quantile of Student's t distribution with `df` (floored) degrees of freedom. */
export function tQuantile975(df: number): number {
  return df >= 1 ? tQuantile(0.975, Math.floor(df)) : NaN;
}

/** Summary of a sample of per-replication values. */
export interface SampleSummary {
  /** Number of finite values summarised. */
  n: number;
  /** Sample mean, or null if n = 0. */
  mean: number | null;
  /** Sample standard deviation, or null if n < 2. */
  stdDev: number | null;
  /** 95% confidence interval for the mean (Student t), or null if n < 2. */
  ci95: { low: number; high: number; halfWidth: number } | null;
}

/** Mean, standard deviation and 95% t-confidence interval of `values` (non-finite values ignored). */
export function summarize(values: readonly number[]): SampleSummary {
  const xs = values.filter((v) => Number.isFinite(v));
  const n = xs.length;
  if (n === 0) return { n, mean: null, stdDev: null, ci95: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, stdDev: null, ci95: null };
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const halfWidth = tQuantile975(n - 1) * (stdDev / Math.sqrt(n));
  return { n, mean, stdDev, ci95: { low: mean - halfWidth, high: mean + halfWidth, halfWidth } };
}
