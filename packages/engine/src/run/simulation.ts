import { createDefaultRegistry, type ComponentRegistry } from "../components/index.js";
import type { ModelDefinition, TimeSeriesConfig } from "../format/index.js";
import { Kernel, Priority } from "../kernel/index.js";
import type { LinkedComponent, MovingEntity, SimContext } from "../model/index.js";
import { Rng } from "../rng/index.js";
import type { ReplicationResult, TimeSeriesReplication } from "./results.js";

/** One instantiated replication of a model: kernel, components, warm-up and sampling wired up. */
export class Simulation {
  readonly kernel: Kernel;
  /** Components by name, in model order. */
  readonly components = new Map<string, LinkedComponent>();
  private readonly registry: ComponentRegistry;
  private readonly model: ModelDefinition;
  private readonly series: TimeSeriesReplication | null;
  private readonly seriesConfig: TimeSeriesConfig | null;

  /**
   * @param model a validated model (from `loadModel`)
   * @param seed the seed for this replication
   * @param index replication index (recorded in results)
   * @param timeSeries optional sampling configuration
   */
  constructor(
    model: ModelDefinition,
    readonly seed: number,
    readonly index = 0,
    timeSeries: TimeSeriesConfig | null = null,
    registry: ComponentRegistry = createDefaultRegistry(),
  ) {
    this.model = model;
    this.registry = registry;
    this.kernel = new Kernel(model.settings.ticksPerSecond);
    let nextId = 0;
    const kernel = this.kernel;
    const ctx: SimContext = {
      kernel,
      rng: (streamId) => new Rng(seed, streamId),
      createEntity: (): MovingEntity => ({ id: nextId++, createdAt: kernel.currentTick, attributes: {} }),
    };

    for (const def of model.components) {
      const cls = registry.get(def.type);
      if (!cls) throw new Error(`unknown component type ${def.type}`); // unreachable for validated models
      this.components.set(def.name, new cls(ctx, { name: def.name, stream: def.stream ?? def.name, inputs: def.inputs }));
    }
    for (const def of model.components) {
      const c = this.components.get(def.name) as LinkedComponent;
      for (const [key, target] of Object.entries(def.links)) {
        c.setLink(key, this.components.get(target) as LinkedComponent);
      }
    }
    for (const c of this.components.values()) c.start();

    const { warmUp, duration } = model.settings;
    if (warmUp > 0) {
      kernel.schedule(kernel.secondsToTicks(warmUp), Priority.HIGHEST, () => {
        for (const c of this.components.values()) c.resetStatistics();
      });
    }

    this.seriesConfig = timeSeries;
    this.series = timeSeries ? { replication: index, times: [], values: Object.fromEntries(timeSeries.outputs.map((o) => [o, []])) } : null;
    if (timeSeries) {
      const total = Math.floor(duration / timeSeries.interval + 1e-9);
      const sample = (i: number) => {
        this.recordSample();
        if (i < total) {
          const next = kernel.secondsToTicks((i + 1) * timeSeries.interval);
          kernel.schedule(next - kernel.currentTick, Priority.LOWEST, () => sample(i + 1));
        }
      };
      kernel.schedule(0, Priority.LOWEST, () => sample(0));
    }
  }

  /** Read one output by id "<component>.<OutputKey>" (NaN if unknown or undefined). */
  readOutput(id: string): number {
    const dot = id.lastIndexOf(".");
    const comp = this.components.get(id.slice(0, dot));
    const def = this.model.components.find((c) => c.name === id.slice(0, dot));
    const spec = def ? this.registry.get(def.type)?.schema.outputs.find((o) => o.key === id.slice(dot + 1)) : undefined;
    return comp && spec ? spec.get(comp) : NaN;
  }

  private recordSample(): void {
    const s = this.series as TimeSeriesReplication;
    s.times.push(this.kernel.currentSeconds);
    for (const id of (this.seriesConfig as TimeSeriesConfig).outputs) {
      const v = this.readOutput(id);
      (s.values[id] as (number | null)[]).push(Number.isFinite(v) ? v : null);
    }
  }

  /** Run to the model's duration and collect every output. */
  runToEnd(): { result: ReplicationResult; timeSeries: TimeSeriesReplication | null } {
    this.kernel.runUntil(this.kernel.secondsToTicks(this.model.settings.duration));
    const outputs: Record<string, number | null> = {};
    for (const def of this.model.components) {
      const schema = (this.registry.get(def.type) as NonNullable<ReturnType<ComponentRegistry["get"]>>).schema;
      const comp = this.components.get(def.name) as LinkedComponent;
      for (const o of schema.outputs) {
        const v = o.get(comp);
        outputs[`${def.name}.${o.key}`] = Number.isFinite(v) ? v : null;
      }
    }
    return {
      result: { index: this.index, seed: this.seed, eventsProcessed: this.kernel.eventsProcessed, outputs },
      timeSeries: this.series,
    };
  }
}
