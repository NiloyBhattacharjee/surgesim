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

/** A validated model. */
export interface ModelDefinition {
  version: number;
  name?: string;
  description?: string;
  settings: ModelSettings;
  components: ComponentDefinition[];
}
