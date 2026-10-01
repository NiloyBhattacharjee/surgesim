/** Two-sided 95% critical values of Student's t for df = 1..30. */
const T_975 = [
  12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.306, 2.2622, 2.2281, 2.201, 2.1788,
  2.1604, 2.1448, 2.1314, 2.1199, 2.1098, 2.1009, 2.093, 2.086, 2.0796, 2.0739, 2.0687, 2.0639,
  2.0595, 2.0555, 2.0518, 2.0484, 2.0452, 2.0423,
];

/** The 0.975 quantile of Student's t distribution with `df` degrees of freedom. */
export function tQuantile975(df: number): number {
  if (!(df >= 1)) return NaN;
  const d = Math.floor(df);
  if (d <= 30) return T_975[d - 1] as number;
  // Cornish–Fisher expansion around the normal quantile; error < 1e-4 for df > 30.
  const z = 1.959964;
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  return (
    z +
    (z3 + z) / (4 * d) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * d * d) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * d ** 3)
  );
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
