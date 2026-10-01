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
  | { dist: "lognormal"; mean: number; stdDev: number };

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
] as const;

/** Required numeric parameters of each distribution. */
export const DISTRIBUTION_PARAMS: Record<(typeof DISTRIBUTION_NAMES)[number], readonly string[]> = {
  constant: ["value"],
  uniform: ["min", "max"],
  exponential: ["mean"],
  normal: ["mean", "stdDev"],
  triangular: ["min", "mode", "max"],
  lognormal: ["mean", "stdDev"],
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
    const variance = (stdDev / mean) ** 2;
    this.sigma = Math.sqrt(Math.log(1 + variance));
    this.mu = Math.log(mean) - 0.5 * this.sigma * this.sigma;
    this.normal = new NormalSampler(rng, 0, 1);
  }
  nextSample(): number {
    return Math.exp(this.mu + this.sigma * this.normal.nextStandard());
  }
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
    if (!finite(spec[key])) problems.push(`${name}: "${key}" must be a finite number`);
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
  }
}
