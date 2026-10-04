import type { Rng } from "./rng.js";

/** Anything that can produce a number on demand: constants and random distributions alike. */
export interface SampleProvider {
  nextSample(): number;
}

/** JSON-serialisable description of a distribution. Mirrors the JSON model format. */
export type DistributionSpec =
  | { dist: "constant"; value: number }
  | { dist: "uniform"; min: number; max: number }
  | { dist: "exponential"; mean: number }
  | { dist: "normal"; mean: number; stdDev: number }
  | { dist: "triangular"; min: number; mode: number; max: number }
  | { dist: "lognormal"; mean: number; stdDev: number }
  | { dist: "empirical"; points: readonly (readonly [probability: number, value: number])[] };

/** A plain number (constant) or a distribution description. */
export type SamplerSpec = number | DistributionSpec;

/** Names of the supported distributions. */
export const DISTRIBUTION_NAMES = [
  "constant",
  "uniform",
  "exponential",
  "normal",
  "triangular",
  "lognormal",
  "empirical",
] as const;

/** Required parameters of each distribution (all numbers, except empirical's list of points). */
export const DISTRIBUTION_PARAMS: Record<(typeof DISTRIBUTION_NAMES)[number], readonly string[]> = {
  constant: ["value"],
  uniform: ["min", "max"],
  exponential: ["mean"],
  normal: ["mean", "stdDev"],
  triangular: ["min", "mode", "max"],
  lognormal: ["mean", "stdDev"],
  empirical: ["points"],
};

/** Always returns the same value. */
export class ConstantSampler implements SampleProvider {
  constructor(readonly value: number) {}
  nextSample(): number {
    return this.value;
  }
}

/** Uniform on [min, max). */
export class UniformSampler implements SampleProvider {
  constructor(
    private readonly rng: Rng,
    private readonly min: number,
    private readonly max: number,
  ) {}
  nextSample(): number {
    return this.min + (this.max - this.min) * this.rng.nextFloat();
  }
}

/** Exponential with the given mean (rate = 1 / mean). */
export class ExponentialSampler implements SampleProvider {
  constructor(
    private readonly rng: Rng,
    private readonly mean: number,
  ) {}
  nextSample(): number {
    return -this.mean * Math.log(this.rng.nextFloatOpen());
  }
}

/** Normal (Gaussian) via the Box–Muller transform. Can return negative values. */
export class NormalSampler implements SampleProvider {
  private spare: number | null = null;
  constructor(
    private readonly rng: Rng,
    private readonly mean: number,
    private readonly stdDev: number,
  ) {}
  /** A standard-normal variate. */
  nextStandard(): number {
    if (this.spare !== null) {
      const z = this.spare;
      this.spare = null;
      return z;
    }
    const r = Math.sqrt(-2 * Math.log(this.rng.nextFloatOpen()));
    const theta = 2 * Math.PI * this.rng.nextFloat();
    this.spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  }
  nextSample(): number {
    return this.mean + this.stdDev * this.nextStandard();
  }
}

/** Triangular on [min, max] with the given mode. */
export class TriangularSampler implements SampleProvider {
  constructor(
    private readonly rng: Rng,
    private readonly min: number,
    private readonly mode: number,
    private readonly max: number,
  ) {}
  nextSample(): number {
    const { min, mode, max } = this;
    if (max === min) return min;
    const u = this.rng.nextFloat();
    const fc = (mode - min) / (max - min);
    return u < fc
      ? min + Math.sqrt(u * (max - min) * (mode - min))
      : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }
}

/**
 * Lognormal parameterised by the mean and standard deviation of the lognormal variable itself
 * (not of its logarithm), which is how service times are usually described.
 */
export class LognormalSampler implements SampleProvider {
  private readonly normal: NormalSampler;
  private readonly mu: number;
  private readonly sigma: number;
  constructor(rng: Rng, mean: number, stdDev: number) {
    // sigma^2 = ln(1 + (stdDev/mean)^2). log1p keeps precision when the ratio is tiny. When the squared ratio
    // overflows (a subnormal mean, or an enormous stdDev) 1 + ratio^2 is just ratio^2, so use 2 ln(stdDev/mean)
    // computed from the two logs; the direct formula would give ln(Infinity) - Infinity = NaN.
    const ratioSquared = (stdDev / mean) ** 2;
    const sigmaSquared = Number.isFinite(ratioSquared) ? Math.log1p(ratioSquared) : 2 * (Math.log(stdDev) - Math.log(mean));
    this.sigma = Math.sqrt(sigmaSquared);
    this.mu = Math.log(mean) - 0.5 * sigmaSquared;
    this.normal = new NormalSampler(rng, 0, 1);
  }
  nextSample(): number {
    return Math.exp(this.mu + this.sigma * this.normal.nextStandard());
  }
}

/**
 * Inverse of a piecewise-linear cumulative distribution through measured (cumulative probability, value) points,
 * like JaamSim's ContinuousDistribution. The first probability is 0 (the minimum) and the last is 1 (the maximum),
 * so it never returns a value outside the measured range.
 */
export class EmpiricalSampler implements SampleProvider {
  private readonly p: number[];
  private readonly x: number[];
  constructor(
    private readonly rng: Rng,
    points: readonly (readonly [number, number])[],
  ) {
    this.p = points.map((pt) => pt[0]);
    this.x = points.map((pt) => pt[1]);
  }
  nextSample(): number {
    const { p, x } = this;
    const u = this.rng.nextFloat();
    // Find p[lo] <= u < p[hi]; p[0] = 0 and p[last] = 1 bracket every u in [0, 1).
    let lo = 0;
    let hi = p.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((p[mid] as number) <= u) lo = mid;
      else hi = mid;
    }
    const p0 = p[lo] as number;
    const x0 = x[lo] as number;
    return x0 + ((x[hi] as number) - x0) * ((u - p0) / ((p[hi] as number) - p0));
  }
}

/** Problems with an empirical distribution's `points`; empty when valid. */
function validatePoints(points: unknown): string[] {
  if (!Array.isArray(points) || points.length < 2) {
    return ['empirical: "points" must be an array of at least 2 [probability, value] pairs'];
  }
  for (let i = 0; i < points.length; i++) {
    const pt: unknown = points[i];
    if (!Array.isArray(pt) || pt.length !== 2 || !finite(pt[0]) || !finite(pt[1])) {
      return [`empirical: point ${i} must be a [probability, value] pair of finite numbers`];
    }
    if (i > 0) {
      const prev = points[i - 1] as [number, number];
      if (!(pt[0] > prev[0])) return [`empirical: point ${i}: probabilities must be strictly increasing`];
      if (pt[1] < prev[1]) return [`empirical: point ${i}: values must not decrease`];
    }
  }
  const problems: string[] = [];
  if ((points[0] as number[])[0] !== 0) problems.push("empirical: the first probability must be 0 (the minimum value)");
  if ((points[points.length - 1] as number[])[0] !== 1) problems.push("empirical: the last probability must be 1 (the maximum value)");
  return problems;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate a raw (untrusted, e.g. parsed JSON) sampler spec.
 * @returns human-readable problems; empty when the spec is valid
 */
export function validateSamplerSpec(spec: unknown): string[] {
  if (finite(spec)) return [];
  if (!isRecord(spec)) {
    return ["expected a number or a distribution object such as {\"dist\": \"exponential\", \"mean\": 1}"];
  }
  const name = spec["dist"];
  if (typeof name !== "string" || !(DISTRIBUTION_NAMES as readonly string[]).includes(name)) {
    return [`"dist" must be one of ${DISTRIBUTION_NAMES.join(", ")}`];
  }
  const params = DISTRIBUTION_PARAMS[name as keyof typeof DISTRIBUTION_PARAMS];
  const problems: string[] = [];
  for (const key of params) {
    if (name !== "empirical" && !finite(spec[key])) problems.push(`${name}: "${key}" must be a finite number`);
  }
  for (const key of Object.keys(spec)) {
    if (key !== "dist" && !params.includes(key)) problems.push(`${name}: unknown parameter "${key}"`);
  }
  if (problems.length > 0) return problems;
  const p = spec as Record<string, number>;
  const get = (k: string) => p[k] as number;
  switch (name) {
    case "uniform":
      if (get("min") > get("max")) problems.push("uniform: min must be <= max");
      break;
    case "exponential":
      if (!(get("mean") > 0)) problems.push("exponential: mean must be > 0");
      break;
    case "normal":
      if (get("stdDev") < 0) problems.push("normal: stdDev must be >= 0");
      break;
    case "triangular":
      if (!(get("min") <= get("mode") && get("mode") <= get("max"))) {
        problems.push("triangular: requires min <= mode <= max");
      }
      break;
    case "lognormal":
      if (!(get("mean") > 0)) problems.push("lognormal: mean must be > 0");
      if (get("stdDev") < 0) problems.push("lognormal: stdDev must be >= 0");
      break;
    case "empirical":
      problems.push(...validatePoints(spec["points"]));
      break;
  }
  return problems;
}

/** Theoretical mean of a validated spec (used for documentation and sanity tests). */
export function samplerMean(spec: SamplerSpec): number {
  if (typeof spec === "number") return spec;
  switch (spec.dist) {
    case "constant":
      return spec.value;
    case "uniform":
      return (spec.min + spec.max) / 2;
    case "exponential":
    case "normal":
    case "lognormal":
      return spec.mean;
    case "triangular":
      return (spec.min + spec.mode + spec.max) / 3;
    case "empirical": {
      // Each segment is uniform between its two points, so it contributes its probability times its midpoint.
      let m = 0;
      for (let i = 1; i < spec.points.length; i++) {
        const [p0, x0] = spec.points[i - 1] as readonly [number, number];
        const [p1, x1] = spec.points[i] as readonly [number, number];
        m += (p1 - p0) * (x0 + x1) / 2;
      }
      return m;
    }
  }
}

/** Build a {@link SampleProvider} from a validated spec, drawing from `rng`. */
export function createSampler(spec: SamplerSpec, rng: Rng): SampleProvider {
  if (typeof spec === "number") return new ConstantSampler(spec);
  switch (spec.dist) {
    case "constant":
      return new ConstantSampler(spec.value);
    case "uniform":
      return new UniformSampler(rng, spec.min, spec.max);
    case "exponential":
      return new ExponentialSampler(rng, spec.mean);
    case "normal":
      return new NormalSampler(rng, spec.mean, spec.stdDev);
    case "triangular":
      return new TriangularSampler(rng, spec.min, spec.mode, spec.max);
    case "lognormal":
      return new LognormalSampler(rng, spec.mean, spec.stdDev);
    case "empirical":
      return new EmpiricalSampler(rng, spec.points);
  }
}
