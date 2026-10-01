import { Component, ModelBuildError, type BuildProblem, type ComponentJson } from "./component.js";
import {
  SPECS,
  type AutoscalerProps,
  type EntityGeneratorProps,
  type EntitySinkProps,
  type MessageQueueProps,
  type OutputOf,
  type QueueProps,
  type RateLimiterProps,
  type RetryPolicyProps,
  type ServerProps,
  type WorkerPoolProps,
} from "./components.js";

/** Version of the JSON model format this SDK emits. */
export const MODEL_FORMAT_VERSION = 1;

/** Model-level settings. Times are seconds. */
export interface ModelOptions {
  /** Total simulated seconds, including warm-up. */
  duration: number;
  /** Statistics reset at this time (default 0). */
  warmUp?: number;
  seed?: number;
  replications?: number;
  ticksPerSecond?: number;
  description?: string;
}

export type AssertionOp = "<" | "<=" | ">" | ">=" | "==";
export type AssertionStatistic = "mean" | "ci95Low" | "ci95High" | "min" | "max";

/** The JSON model format (version 1), as emitted by {@link Model.toJSON}. */
export interface ModelJson {
  version: number;
  name: string;
  description?: string;
  settings: {
    duration: number;
    warmUp?: number;
    seed?: number;
    replications?: number;
    ticksPerSecond?: number;
    timeSeries?: { interval: number; outputs: string[] };
  };
  components: ComponentJson[];
  assertions?: { output: string; op: AssertionOp; value: number; statistic?: AssertionStatistic; name?: string }[];
}

/**
 * A system under construction. Add components with the builder methods, connect them with the
 * `next` / `queue` / ... props (or {@link Component.link} for cycles), then call {@link toJSON}.
 *
 * ```ts
 * const m = new Model("checkout", { duration: 600, replications: 5 });
 * const sink = m.entitySink("done");
 * const pool = m.workerPool("workers", { concurrency: 50, serviceTime: dist.lognormal(0.5, 0.25), next: sink });
 * m.entityGenerator("traffic", { interArrivalTime: dist.exponential(0.02), next: pool });
 * m.assert(sink.output("p99"), "<=", 2);
 * ```
 */
export class Model {
  private readonly components = new Map<string, Component<string>>();
  private readonly assertions: NonNullable<ModelJson["assertions"]> = [];
  private timeSeries: { interval: number; outputs: string[] } | undefined;

  constructor(
    readonly name: string,
    private readonly options: ModelOptions,
  ) {}

  private make<Out extends string>(
    type: keyof typeof SPECS,
    name: string,
    props: object,
  ): Component<Out> {
    const spec = SPECS[type] as { inputs: readonly string[]; links: readonly string[] };
    const problems: BuildProblem[] = [];
    if (this.components.has(name)) problems.push({ component: name, key: "name", message: "duplicate component name" });
    if (name.trim() === "") problems.push({ component: name, key: "name", message: "must be a non-empty string" });

    const inputs: Record<string, unknown> = {};
    const links: [string, Component<string>][] = [];
    let stream: string | undefined;
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined) continue;
      if (key === "stream") stream = value as string;
      else if (spec.links.includes(key)) links.push([key, value as Component<string>]);
      else if (spec.inputs.includes(key)) inputs[key] = value;
      else problems.push({ component: name, key, message: `unknown property for ${type} (inputs: ${spec.inputs.join(", ") || "none"}; links: ${spec.links.join(", ") || "none"})` });
    }
    if (problems.length > 0) throw new ModelBuildError(problems);

    const component = new Component<Out>(type, name, inputs, stream);
    for (const [key, target] of links) component.link(key, target);
    this.components.set(name, component);
    return component;
  }

  /** Arrivals: a fixed or random inter-arrival time, or a piecewise-constant Poisson rate profile. */
  entityGenerator(name: string, props: EntityGeneratorProps = {}): Component<OutputOf<"EntityGenerator">> {
    return this.make("EntityGenerator", name, props);
  }

  /** FIFO queue with an optional maximum length. */
  queue(name: string, props: QueueProps = {}): Component<OutputOf<"Queue">> {
    return this.make("Queue", name, props);
  }

  /** `capacity` parallel workers pulling from a Queue. */
  server(name: string, props: ServerProps): Component<OutputOf<"Server">> {
    return this.make("Server", name, props);
  }

  /** Consumes entities and records their time in system. */
  entitySink(name: string, props: EntitySinkProps = {}): Component<OutputOf<"EntitySink">> {
    return this.make("EntitySink", name, props);
  }

  /** SQS-style queue: visibility timeout, redelivery, dead-letter queue. */
  messageQueue(name: string, props: MessageQueueProps = {}): Component<OutputOf<"MessageQueue">> {
    return this.make("MessageQueue", name, props);
  }

  /** Concurrency-limited workers with cold starts, throttling and failures. */
  workerPool(name: string, props: WorkerPoolProps): Component<OutputOf<"WorkerPool">> {
    return this.make("WorkerPool", name, props);
  }

  /** Retries failed attempts with exponential backoff and jitter. */
  retryPolicy(name: string, props: RetryPolicyProps = {}): Component<OutputOf<"RetryPolicy">> {
    return this.make("RetryPolicy", name, props);
  }

  /** Token-bucket rate limiter. */
  rateLimiter(name: string, props: RateLimiterProps): Component<OutputOf<"RateLimiter">> {
    return this.make("RateLimiter", name, props);
  }

  /** Target-tracking autoscaler for a WorkerPool. */
  autoscaler(name: string, props: AutoscalerProps): Component<OutputOf<"Autoscaler">> {
    return this.make("Autoscaler", name, props);
  }

  /**
   * Add a component of any type, including ones registered with a custom engine registry. Prefer the typed
   * builder methods for the built-in types.
   */
  custom(type: string, name: string, inputs: Record<string, unknown> = {}, links: Record<string, Component<string>> = {}): Component<string> {
    if (this.components.has(name)) throw new ModelBuildError([{ component: name, key: "name", message: "duplicate component name" }]);
    const c = new Component(type, name, inputs);
    for (const [key, target] of Object.entries(links)) c.link(key, target);
    this.components.set(name, c);
    return c;
  }

  /**
   * Require a threshold to hold after the run (the CLI exits with code 3 otherwise).
   * @param output an id from `component.output("p99")`
   */
  assert(
    output: string,
    op: AssertionOp,
    value: number,
    options: { statistic?: AssertionStatistic; name?: string } = {},
  ): this {
    this.assertions.push({ output, op, value, ...(options.statistic ? { statistic: options.statistic } : {}), ...(options.name ? { name: options.name } : {}) });
    return this;
  }

  /** Sample these outputs every `intervalSeconds`, for backlog-over-time plots. */
  sampleEvery(intervalSeconds: number, outputs: readonly string[]): this {
    this.timeSeries = { interval: intervalSeconds, outputs: [...outputs] };
    return this;
  }

  /**
   * Compile to the JSON model format.
   * @throws ModelBuildError if a link points at a component that is not in this model
   */
  toJSON(): ModelJson {
    const problems: BuildProblem[] = [];
    for (const c of this.components.values()) {
      for (const [key, target] of c.links) {
        if (this.components.get(target.name) !== target) {
          problems.push({ component: c.name, key, message: `links to "${target.name}", which is not a component of this model` });
        }
      }
    }
    if (problems.length > 0) throw new ModelBuildError(problems);

    const { description, duration, warmUp, seed, replications, ticksPerSecond } = this.options;
    return {
      version: MODEL_FORMAT_VERSION,
      name: this.name,
      ...(description !== undefined ? { description } : {}),
      settings: {
        duration,
        ...(warmUp !== undefined ? { warmUp } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(replications !== undefined ? { replications } : {}),
        ...(ticksPerSecond !== undefined ? { ticksPerSecond } : {}),
        ...(this.timeSeries ? { timeSeries: this.timeSeries } : {}),
      },
      components: [...this.components.values()].map((c) => c.toJSON()),
      ...(this.assertions.length > 0 ? { assertions: this.assertions } : {}),
    };
  }

  /** The model as a JSON string. */
  stringify(space: number | string = 2): string {
    return JSON.stringify(this.toJSON(), null, space);
  }
}
