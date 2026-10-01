/**
 * Types of the JSON model format (version 1). This is the stable contract between model
 * authoring tools and engines; see docs/model-format.md. Nothing here is TypeScript-specific:
 * every field is plain JSON.
 */

export const MODEL_FORMAT_VERSION = 1;

/** Optional sampling of outputs over time (for backlog-over-time plots). */
export interface TimeSeriesConfig {
  /** Sampling interval in seconds. */
  interval: number;
  /** Output ids of the form "<componentName>.<OutputKey>". */
  outputs: string[];
}

/** Model-level settings, all times in seconds. */
export interface ModelSettings {
  /** Total simulated duration in seconds, including warm-up. */
  duration: number;
  /** Statistics are reset at this time. Default 0. */
  warmUp: number;
  /** Base seed. Default 1. */
  seed: number;
  /** Number of independent replications. Default 1. */
  replications: number;
  /** Simulation resolution. Default 1,000,000 (microseconds). */
  ticksPerSecond: number;
  timeSeries?: TimeSeriesConfig;
}

/** One component instance. */
export interface ComponentDefinition {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
  /** Link key -> target component name. */
  links: Record<string, string>;
  /** Optional RNG stream id; defaults to the component name. */
  stream?: string;
}

/** Comparison operators an assertion can use. */
export const ASSERTION_OPS = ["<", "<=", ">", ">=", "=="] as const;
export type AssertionOp = (typeof ASSERTION_OPS)[number];

/**
 * Which number of an output an assertion compares.
 * - `mean`: the mean across replications (default).
 * - `ci95High` / `ci95Low`: the ends of the 95% confidence interval (needs 2+ replications); use
 *   `ci95High` with `<=` to demand a limit holds even at the pessimistic end of the estimate.
 * - `min` / `max`: the smallest / largest value over replications (a worst-case gate).
 */
export const ASSERTION_STATISTICS = ["mean", "ci95Low", "ci95High", "min", "max"] as const;
export type AssertionStatistic = (typeof ASSERTION_STATISTICS)[number];

/** A capacity threshold checked after a run, e.g. "sink.p99 <= 2". */
export interface AssertionDefinition {
  /** Output id "<componentName>.<OutputKey>". */
  output: string;
  op: AssertionOp;
  /** Threshold, in the output's own unit (seconds, per-second, cost, count...). */
  value: number;
  /** Default "mean". */
  statistic?: AssertionStatistic;
  /** Optional human-readable label shown in reports. */
  name?: string;
}

/** A validated model. */
export interface ModelDefinition {
  version: number;
  name?: string;
  description?: string;
  settings: ModelSettings;
  components: ComponentDefinition[];
  /** Thresholds checked after the run; the CLI exits non-zero if any fail. */
  assertions?: AssertionDefinition[];
}
