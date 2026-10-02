import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultRegistry, loadModel, runModel } from "@surgesim/engine";
import { Model, ModelBuildError, SPECS, dist, poissonArrivals, time } from "../src/index.js";

const example = (file: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../examples/${file}`, import.meta.url)), "utf8"));

describe("compiles to exactly the JSON the hand-written examples contain", () => {
  it("M/M/1 (examples/mm1.json)", () => {
    const m = new Model("M/M/1 queue (lambda=0.8, mu=1)", {
      description: "Classic M/M/1. Theory: utilisation 0.8, Lq 3.2, Wq 4.0, W 5.0.",
      duration: 50000,
      warmUp: 5000,
      seed: 42,
      replications: 10,
    });
    const arrivals = m.entityGenerator("arrivals", { interArrivalTime: dist.exponential(1.25) });
    const queue = m.queue("queue");
    const sink = m.entitySink("sink");
    arrivals.link("next", queue);
    m.server("server", { capacity: 1, serviceTime: dist.exponential(1), queue, next: sink });
    const json = m.toJSON();
    const expected = example("mm1.json") as { components: { name: string }[] };
    const byName = (cs: { name: string }[]) => Object.fromEntries(cs.map((c) => [c.name, c]));
    // The example lists the sink last; component order is not significant, so compare by name.
    expect({ ...json, components: byName(json.components) }).toEqual({ ...expected, components: byName(expected.components) });
  });

  it("traffic spike with a time series (examples/traffic-spike.json)", () => {
    const m = new Model("Traffic spike: 50/s -> 250/s for 2 minutes", {
      description:
        "Capacity 100 workers x ~2/s each = ~200/s. The spike exceeds capacity, so the backlog grows for 120 s and then drains.",
      duration: 600,
      warmUp: 0,
      seed: 7,
      replications: 5,
    });
    const traffic = m.entityGenerator("traffic", {
      mode: "rateProfile",
      rateProfile: [[0, 50], [180, 250], [300, 50]],
    });
    const queue = m.queue("queue");
    const sink = m.entitySink("sink");
    traffic.link("next", queue);
    const server = m.server("server", { capacity: 100, serviceTime: dist.lognormal(0.5, 0.25), queue, next: sink });
    m.sampleEvery(5, [queue.output("QueueLength"), server.output("BusyWorkers")]);
    const json = m.toJSON();
    const expected = example("traffic-spike.json") as { components: { name: string }[] };
    const byName = (cs: { name: string }[]) => Object.fromEntries(cs.map((c) => [c.name, c]));
    expect({ ...json, components: byName(json.components) }).toEqual({ ...expected, components: byName(expected.components) });
  });
});

describe("an SDK-built model is a valid, runnable model", () => {
  const build = () => {
    const m = new Model("api", { duration: 300, replications: 3, seed: 9 });
    const ok = m.entitySink("ok");
    const failed = m.entitySink("failed");
    const dlq = m.entitySink("dlq");
    const orders = m.messageQueue("orders", { visibilityTimeout: time.seconds(20), maxReceiveCount: 3, deadLetter: dlq });
    const retry = m.retryPolicy("retry", { maxAttempts: 4, baseDelay: time.ms(250), jitter: "full", giveUp: failed });
    const pool = m.workerPool("pool", {
      concurrency: 20,
      serviceTime: dist.lognormal(0.4, 0.2),
      coldStartTime: dist.constant(1),
      idleTimeout: time.minutes(1),
      failureProbability: 0.05,
      queue: orders,
      next: ok,
      onFailure: retry,
    });
    const limiter = m.rateLimiter("limiter", { rate: 60, burst: 100, next: retry });
    retry.link("next", orders); // a forward reference / cycle: set after both exist
    m.autoscaler("scaler", { maxConcurrency: 80, targetUtilisation: 0.6, target: pool });
    m.entityGenerator("traffic", { interArrivalTime: poissonArrivals(30), next: limiter });
    m.assert(ok.output("p99"), "<=", 60, { name: "p99" });
    m.assert(pool.output("NumberThrottled"), "==", 0, { statistic: "max" });
    m.sampleEvery(10, [orders.output("Backlog"), pool.output("Concurrency")]);
    return m;
  };

  it("passes the engine's validation with no errors and runs", () => {
    const loaded = loadModel(build().toJSON());
    expect(loaded.ok ? [] : loaded.errors).toEqual([]);
    if (!loaded.ok) return;
    const results = runModel(loaded.model);
    expect(results.assertions).toHaveLength(2);
    expect(results.timeSeries?.outputs).toEqual(["orders.Backlog", "pool.Concurrency"]);
    expect(results.outputs.find((o) => o.id === "ok.count")!.mean).toBeGreaterThan(1000);
  });

  it("round-trips through a JSON string unchanged", () => {
    const m = build();
    expect(JSON.parse(m.stringify())).toEqual(m.toJSON());
  });

  it("emits no empty inputs/links objects and drops undefined props", () => {
    const m = new Model("t", { duration: 1 });
    m.queue("q", { maxLength: undefined });
    expect(m.toJSON().components).toEqual([{ type: "Queue", name: "q" }]);
  });

  it("is deterministic with the same seed (SDK models behave like their JSON)", () => {
    const run = () => runModel((loadModel(build().toJSON()) as { ok: true; model: never }).model);
    expect(run().replications).toEqual(run().replications);
  });
});

describe("authoring errors are structured, not bare strings", () => {
  it("rejects unknown properties immediately, naming the valid ones", () => {
    const m = new Model("t", { duration: 1 });
    let error: unknown;
    try {
      m.workerPool("pool", { concurrency: 1, serviceTime: 1, concurency: 3 } as never);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ModelBuildError);
    const problems = (error as ModelBuildError).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ component: "pool", key: "concurency" });
    expect(problems[0]!.message).toContain("concurrency");
  });

  it("rejects duplicate names", () => {
    const m = new Model("t", { duration: 1 });
    m.queue("q");
    expect(() => m.queue("q")).toThrow(ModelBuildError);
    expect(() => m.custom("Queue", "q")).toThrow(ModelBuildError);
  });

  it("toJSON reports links to components from another model", () => {
    const a = new Model("a", { duration: 1 });
    const b = new Model("b", { duration: 1 });
    const foreign = b.entitySink("sink");
    a.entityGenerator("gen", { interArrivalTime: 1, next: foreign });
    let error: unknown;
    try {
      a.toJSON();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ModelBuildError);
    expect((error as ModelBuildError).problems[0]).toMatchObject({ component: "gen", key: "next" });
  });

  it("semantic mistakes are left to the engine's loader, which reports them structurally", () => {
    const m = new Model("t", { duration: 10 });
    m.workerPool("pool", { concurrency: 0, serviceTime: 1 });
    const loaded = loadModel(m.toJSON());
    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? [] : loaded.errors).toEqual([{ component: "pool", key: "concurrency", message: "must be >= 1" }]);
  });
});

describe("the SDK cannot drift from the engine's schemas", () => {
  const schemas = createDefaultRegistry().schemas();

  it("covers every component type the engine registers", () => {
    expect(Object.keys(SPECS).sort()).toEqual(schemas.map((s) => s.type).sort());
  });

  for (const schema of createDefaultRegistry().schemas()) {
    it(`${schema.type}: input, link and output keys match`, () => {
      const spec = SPECS[schema.type as keyof typeof SPECS];
      expect([...spec.inputs].sort()).toEqual(schema.inputs.map((i) => i.key).sort());
      expect([...spec.links].sort()).toEqual(schema.links.map((l) => l.key).sort());
      expect([...spec.outputs].sort()).toEqual(schema.outputs.map((o) => o.key).sort());
    });
  }
});

describe("types (checked by tsc, run as no-ops)", () => {
  it("rejects wrong output keys and missing required props at compile time", () => {
    const m = new Model("t", { duration: 1 });
    const sink = m.entitySink("sink");
    // @ts-expect-error "p98" is not an output of EntitySink
    sink.output("p98");
    // @ts-expect-error concurrency and serviceTime are required
    expect(() => m.workerPool("pool", {})).not.toThrow();
    // @ts-expect-error jitter must be one of none | full | equal
    m.retryPolicy("retry", { jitter: "wild" });
  });
});

describe("value helpers", () => {
  it("builders match the format's distribution objects", () => {
    expect(dist.constant(2)).toEqual({ dist: "constant", value: 2 });
    expect(dist.uniform(1, 2)).toEqual({ dist: "uniform", min: 1, max: 2 });
    expect(dist.normal(1, 2)).toEqual({ dist: "normal", mean: 1, stdDev: 2 });
    expect(dist.triangular(1, 2, 3)).toEqual({ dist: "triangular", min: 1, mode: 2, max: 3 });
    expect(poissonArrivals(4)).toEqual({ dist: "exponential", mean: 0.25 });
  });

  it("time helpers return seconds", () => {
    expect([time.ms(250), time.seconds(3), time.minutes(2), time.hours(1)]).toEqual([0.25, 3, 120, 3600]);
  });
});
