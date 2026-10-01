import type { AssertionDefinition } from "../format/index.js";
import type { UnitCategory } from "../schema/index.js";

/** Settings actually used for a run (after CLI overrides). */
export interface RunSettingsUsed {
  duration: number;
  warmUp: number;
  seed: number;
  replications: number;
  ticksPerSecond: number;
}

/** Values of every output in one replication, keyed by output id "<component>.<OutputKey>"; null = undefined (NaN). */
export interface ReplicationResult {
  index: number;
  /** The seed this replication actually used (derived from the base seed and the index). */
  seed: number;
  eventsProcessed: number;
  outputs: Record<string, number | null>;
}

/** Cross-replication summary of one output. */
export interface OutputSummary {
  /** "<component>.<OutputKey>" */
  id: string;
  component: string;
  componentType: string;
  key: string;
  unit: UnitCategory;
  description: string;
  /** Number of replications with a defined value. */
  n: number;
  mean: number | null;
  stdDev: number | null;
  /** 95% confidence interval for the mean (Student t); null with fewer than 2 replications. */
  ci95: { low: number; high: number; halfWidth: number } | null;
}

/** Sampled series for one replication; `values[id][i]` is the value at `times[i]` seconds. */
export interface TimeSeriesReplication {
  replication: number;
  times: number[];
  values: Record<string, (number | null)[]>;
}

export interface TimeSeriesResult {
  interval: number;
  outputs: string[];
  replications: TimeSeriesReplication[];
}

/** The outcome of checking one assertion against the results. */
export interface AssertionResult {
  assertion: AssertionDefinition;
  /** The compared number, or null if it was undefined (e.g. no CI with one replication). */
  actual: number | null;
  passed: boolean;
  /** Human-readable one-liner, e.g. "sink.p99 (mean) = 1.84 <= 2". */
  message: string;
}

/** The full, JSON-serialisable result of running a model. Every renderer works from this. */
export interface RunResults {
  /** Version of this results structure. */
  resultsVersion: 1;
  modelName: string | null;
  settings: RunSettingsUsed;
  /** One entry per component output, in model order. */
  outputs: OutputSummary[];
  replications: ReplicationResult[];
  timeSeries?: TimeSeriesResult;
  /** Present when the model (or the caller) defined assertions. */
  assertions?: AssertionResult[];
}
