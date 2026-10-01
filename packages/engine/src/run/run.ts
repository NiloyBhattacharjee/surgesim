import { createDefaultRegistry, type ComponentRegistry } from "../components/index.js";
import type { AssertionDefinition, ModelDefinition, TimeSeriesConfig } from "../format/index.js";
import { deriveSeed } from "../rng/index.js";
import { summarize } from "../stats/index.js";
import { evaluateAssertions } from "./assertions.js";
import type { OutputSummary, RunResults, TimeSeriesReplication } from "./results.js";
import { Simulation } from "./simulation.js";

/** Overrides applied on top of the model's own settings. */
export interface RunOptions {
  seed?: number;
  replications?: number;
  /** Sample these outputs over time, overriding the model's `timeSeries` setting. */
  timeSeries?: TimeSeriesConfig;
  /** Extra assertions to check in addition to the model's own. */
  assertions?: AssertionDefinition[];
  registry?: ComponentRegistry;
  /** Stop with a SimulationLimitError if this many events run at one instant (default 10 million): guards against zero-delay loops. */
  maxEventsPerTick?: number;
  /** Stop with a SimulationLimitError after this many events in one replication (default unlimited). */
  maxEvents?: number;
}

/**
 * The time series sampled by default when a caller asks for one but the model configures none:
 * every output flagged `series` (current-value outputs like QueueLength), ~200 samples per run.
 */
export function defaultTimeSeries(model: ModelDefinition, registry: ComponentRegistry = createDefaultRegistry()): TimeSeriesConfig {
  const outputs: string[] = [];
  for (const c of model.components) {
    for (const o of registry.get(c.type)?.schema.outputs ?? []) {
      if (o.series) outputs.push(`${c.name}.${o.key}`);
    }
  }
  return { interval: model.settings.duration / 200, outputs };
}

/** Replication `i` runs with a seed derived from the base seed and `i`. */
export function replicationSeed(baseSeed: number, index: number): number {
  return deriveSeed(baseSeed, index);
}

/**
 * Run all replications of a validated model and return the structured, JSON-serialisable results.
 */
export function runModel(model: ModelDefinition, options: RunOptions = {}): RunResults {
  const registry = options.registry ?? createDefaultRegistry();
  const seed = options.seed ?? model.settings.seed;
  const replications = options.replications ?? model.settings.replications;
  if (!Number.isInteger(replications) || replications < 1) throw new RangeError("replications must be a positive integer");
  const tsConfig = options.timeSeries ?? model.settings.timeSeries ?? null;

  const reps = [];
  const series: TimeSeriesReplication[] = [];
  for (let i = 0; i < replications; i++) {
    const sim = new Simulation(model, replicationSeed(seed, i), i, tsConfig, registry, {
      ...(options.maxEventsPerTick !== undefined ? { maxEventsPerTick: options.maxEventsPerTick } : {}),
      ...(options.maxEvents !== undefined ? { maxEvents: options.maxEvents } : {}),
    });
    const { result, timeSeries } = sim.runToEnd();
    reps.push(result);
    if (timeSeries) series.push(timeSeries);
  }

  const outputs: OutputSummary[] = [];
  for (const def of model.components) {
    const schema = (registry.get(def.type) as NonNullable<ReturnType<ComponentRegistry["get"]>>).schema;
    for (const o of schema.outputs) {
      const id = `${def.name}.${o.key}`;
      const s = summarize(reps.map((r) => r.outputs[id] ?? NaN));
      outputs.push({
        id,
        component: def.name,
        componentType: def.type,
        key: o.key,
        unit: o.unit,
        description: o.description,
        n: s.n,
        mean: s.mean,
        stdDev: s.stdDev,
        ci95: s.ci95,
      });
    }
  }

  const { duration, warmUp, ticksPerSecond } = model.settings;
  const results: RunResults = {
    resultsVersion: 1,
    modelName: model.name ?? null,
    settings: { duration, warmUp, seed, replications, ticksPerSecond },
    outputs,
    replications: reps,
    ...(tsConfig ? { timeSeries: { interval: tsConfig.interval, outputs: tsConfig.outputs, replications: series } } : {}),
  };
  const assertions = [...(model.assertions ?? []), ...(options.assertions ?? [])];
  if (assertions.length > 0) results.assertions = evaluateAssertions(results, assertions);
  return results;
}
