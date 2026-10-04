/**
 * Value helpers for authoring models. Everything here produces plain JSON-compatible values that
 * match the model format (docs/model-format.md); nothing is TypeScript-specific.
 */

/** A distribution in the JSON model format. */
export type Distribution =
  | { dist: "constant"; value: number }
  | { dist: "uniform"; min: number; max: number }
  | { dist: "exponential"; mean: number }
  | { dist: "normal"; mean: number; stdDev: number }
  | { dist: "triangular"; min: number; mode: number; max: number }
  | { dist: "lognormal"; mean: number; stdDev: number }
  | { dist: "empirical"; points: [probability: number, value: number][] };

/** A number of seconds (a constant) or a distribution of seconds. */
export type Sampler = number | Distribution;

/** Builders for the distributions the format supports. All time parameters are in seconds. */
export const dist = {
  constant: (value: number): Distribution => ({ dist: "constant", value }),
  uniform: (min: number, max: number): Distribution => ({ dist: "uniform", min, max }),
  /** Exponential with the given mean (so rate = 1 / mean). */
  exponential: (mean: number): Distribution => ({ dist: "exponential", mean }),
  normal: (mean: number, stdDev: number): Distribution => ({ dist: "normal", mean, stdDev }),
  triangular: (min: number, mode: number, max: number): Distribution => ({ dist: "triangular", min, mode, max }),
  /** Lognormal parameterised by the mean and standard deviation of the variable itself (not its log). */
  lognormal: (mean: number, stdDev: number): Distribution => ({ dist: "lognormal", mean, stdDev }),
  /**
   * A measured distribution: `[cumulativeProbability, value]` points from `[0, min]` to `[1, max]`, interpolated
   * linearly, e.g. `dist.empirical([[0, 0.01], [0.5, 0.05], [0.99, 1.2], [1, 2.5]])`. `surgesim fit` prints one.
   */
  empirical: (points: ReadonlyArray<readonly [probability: number, value: number]>): Distribution => ({
    dist: "empirical",
    points: points.map(([p, v]) => [p, v]),
  }),
};

/** Readable units: each returns seconds, the format's only time unit. */
export const time = {
  ms: (v: number): number => v / 1000,
  seconds: (v: number): number => v,
  minutes: (v: number): number => v * 60,
  hours: (v: number): number => v * 3600,
};

/** Piecewise-constant arrival rate: `[[startSeconds, ratePerSecond], ...]`. */
export type RateProfile = ReadonlyArray<readonly [startSeconds: number, ratePerSecond: number]>;

/** A rate of `perSecond` events per second, as a mean inter-arrival time distribution. */
export function poissonArrivals(perSecond: number): Distribution {
  return dist.exponential(1 / perSecond);
}
