/** Error function (Abramowitz and Stegun 7.1.26, absolute error below 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
}

/** Standard normal cumulative distribution function. */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Approximate p-value of the Kolmogorov-Smirnov statistic `d` for `n` observations (asymptotic series with the
 * Stephens small-sample correction). When the distribution's parameters were estimated from the same data, as they
 * are here, the true p-value is larger than this, so it is only a rough guide.
 */
export function ksPValue(d: number, n: number): number {
  const lambda = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * d;
  if (lambda < 0.2) return 1;
  let sum = 0;
  for (let k = 1; k <= 100; k++) {
    const term = Math.exp(-2 * k * k * lambda * lambda);
    sum += (k % 2 === 1 ? 1 : -1) * term;
    if (term < 1e-12) break;
  }
  return Math.min(1, Math.max(0, 2 * sum));
}
