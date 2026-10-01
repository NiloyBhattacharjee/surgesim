import { loadModel, runModel, type ModelDefinition, type OutputSummary, type RunOptions, type RunResults } from "../src/index.js";

export function load(json: unknown): ModelDefinition {
  const r = loadModel(json);
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r.model;
}

export function run(json: unknown, options?: RunOptions): RunResults {
  return runModel(load(json), options);
}

export function out(results: RunResults, id: string): OutputSummary {
  const o = results.outputs.find((x) => x.id === id);
  if (!o) throw new Error(`no output ${id}`);
  return o;
}

/** Generator -> queue -> server -> sink, with Poisson arrivals and the given service time spec. */
export function queueingModel(opts: {
  lambda: number;
  service: unknown;
  capacity?: number;
  duration: number;
  warmUp?: number;
  replications?: number;
  seed?: number;
  maxLength?: number;
}) {
  return {
    version: 1,
    settings: {
      duration: opts.duration,
      warmUp: opts.warmUp ?? 0,
      replications: opts.replications ?? 1,
      seed: opts.seed ?? 1,
    },
    components: [
      { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: { dist: "exponential", mean: 1 / opts.lambda } }, links: { next: "queue" } },
      { type: "Queue", name: "queue", inputs: opts.maxLength !== undefined ? { maxLength: opts.maxLength } : {} },
      { type: "Server", name: "server", inputs: { capacity: opts.capacity ?? 1, serviceTime: opts.service }, links: { queue: "queue", next: "sink" } },
      { type: "EntitySink", name: "sink" },
    ],
  };
}
