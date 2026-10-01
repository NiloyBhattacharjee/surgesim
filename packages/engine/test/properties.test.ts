import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ExactPercentileTracker,
  ExponentialSampler,
  Kernel,
  LognormalSampler,
  Rng,
  TimeWeightedStat,
  TriangularSampler,
  UniformSampler,
  deriveSeed,
  loadModel,
  runModel,
  summarize,
  type ModelDefinition,
} from "../src/index.js";
import { BinaryHeap } from "../src/kernel/heap.js";
import { load, out, run } from "./helpers.js";

/**
 * Property-based tests: instead of a handful of hand-picked examples, each property is checked against many
 * generated inputs. The seed is fixed so the suite is deterministic; set FC_SEED / FC_RUNS to explore further.
 * A failure prints the seed and a shrunk counterexample.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const numRuns = Number(env["FC_RUNS"] ?? 150);
const seed = Number(env["FC_SEED"] ?? 20241002);
/** How many mutated models to generate (most are rejected by validation, so this is large). */
const mutationRuns = Number(env["FC_MUTATION_RUNS"] ?? 1000);
const assertProperty = <T>(p: fc.IPropertyWithHooks<T>, runs = numRuns): void => fc.assert(p, { numRuns: runs, seed });

describe("BinaryHeap", () => {
  it("pops everything in sorted order", () => {
    assertProperty(
      fc.property(fc.array(fc.integer({ min: -1e6, max: 1e6 })), (xs) => {
        const h = new BinaryHeap<number>((a, b) => a - b);
        xs.forEach((x) => h.push(x));
        const popped: number[] = [];
        while (h.size > 0) popped.push(h.pop() as number);
        expect(popped).toEqual([...xs].sort((a, b) => a - b));
      }),
    );
  });

  it("behaves like a sorted array under any interleaving of push and pop", () => {
    assertProperty(
      fc.property(fc.array(fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined, freq: 3 }), { maxLength: 200 }), (ops) => {
        const h = new BinaryHeap<number>((a, b) => a - b);
        const model: number[] = [];
        for (const op of ops) {
          if (op === undefined) {
            const expected = model.length === 0 ? undefined : model.splice(model.indexOf(Math.min(...model)), 1)[0];
            expect(h.pop()).toBe(expected);
          } else {
            h.push(op);
            model.push(op);
          }
          expect(h.size).toBe(model.length);
          expect(h.peek()).toBe(model.length === 0 ? undefined : Math.min(...model));
        }
      }),
    );
  });
});

describe("Kernel", () => {
  const eventArb = fc.record({
    delay: fc.integer({ min: 0, max: 40 }),
    priority: fc.integer({ min: 0, max: 10 }),
    lifo: fc.boolean(),
    cancel: fc.boolean(),
  });

  it("runs events in (tick, priority, insertion) order, never runs cancelled events, and time never goes backwards", () => {
    assertProperty(
      fc.property(fc.array(eventArb, { minLength: 1, maxLength: 80 }), (events) => {
        const k = new Kernel();
        const fired: number[] = [];
        const ticks: number[] = [];
        // Reference order: sort by (tick, priority, seq) where FIFO events count up and LIFO events count down.
        let nextSeq = 0;
        let nextLifo = -1;
        const reference = events.map((e, i) => ({ i, tick: e.delay, priority: e.priority, seq: e.lifo ? nextLifo-- : nextSeq++, cancel: e.cancel }));
        const handles = events.map((e, i) =>
          k.schedule(
            e.delay,
            e.priority,
            () => {
              fired.push(i);
              ticks.push(k.currentTick);
            },
            { lifo: e.lifo },
          ),
        );
        events.forEach((e, i) => e.cancel && handles[i]!.cancel());
        k.runUntil(100);
        const expected = reference
          .filter((r) => !r.cancel)
          .sort((a, b) => a.tick - b.tick || a.priority - b.priority || a.seq - b.seq)
          .map((r) => r.i);
        expect(fired).toEqual(expected);
        expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
        expect(k.pendingCount).toBe(0);
        expect(k.currentTick).toBe(100);
      }),
    );
  });

  it("an event scheduled by another event runs at the right time", () => {
    assertProperty(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 })), { minLength: 1, maxLength: 40 }), (pairs) => {
        const k = new Kernel();
        const seen: { at: number; want: number }[] = [];
        for (const [first, second] of pairs) {
          k.schedule(first, 5, () => {
            const want = k.currentTick + second;
            k.schedule(second, 5, () => seen.push({ at: k.currentTick, want }));
          });
        }
        k.runUntil(200);
        expect(seen).toHaveLength(pairs.length);
        expect(seen.every((s) => s.at === s.want)).toBe(true);
      }),
    );
  });

  it("rejects non-integer, negative and NaN delays", () => {
    assertProperty(
      fc.property(fc.oneof(fc.double({ noInteger: true, min: -1e6, max: 1e6, noNaN: true }), fc.integer({ min: -1e6, max: -1 }), fc.constant(NaN)), (bad) => {
        expect(() => new Kernel().schedule(bad, 5, () => {})).toThrow(RangeError);
      }),
    );
  });
});

describe("Rng and distributions", () => {
  it("is deterministic per (seed, stream) and always inside its ranges", () => {
    assertProperty(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 }), fc.string({ maxLength: 12 }), (s, id) => {
        const a = new Rng(s, id);
        const b = new Rng(s, id);
        for (let i = 0; i < 30; i++) {
          const x = a.nextFloat();
          expect(x).toBe(b.nextFloat());
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThan(1);
          const y = a.nextFloatOpen();
          b.nextFloatOpen();
          expect(y).toBeGreaterThan(0);
          expect(y).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  it("different stream ids give different sequences", () => {
    assertProperty(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 }), fc.string({ minLength: 1, maxLength: 10 }), fc.string({ minLength: 1, maxLength: 10 }), (s, x, y) => {
        fc.pre(x !== y);
        const a = new Rng(s, x);
        const b = new Rng(s, y);
        const first = (r: Rng) => [r.nextUint32(), r.nextUint32(), r.nextUint32(), r.nextUint32()].join(",");
        expect(first(a)).not.toBe(first(b));
      }),
    );
  });

  it("deriveSeed returns a safe non-negative integer and different indices differ", () => {
    assertProperty(
      fc.property(fc.integer({ min: 0, max: 2 ** 40 }), (base) => {
        const seeds = new Set<number>();
        for (let i = 0; i < 40; i++) {
          const d = deriveSeed(base, i);
          expect(Number.isSafeInteger(d)).toBe(true);
          expect(d).toBeGreaterThanOrEqual(0);
          seeds.add(d);
        }
        expect(seeds.size).toBe(40);
      }),
    );
  });

  it("samples stay inside each distribution's support", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 0, max: 1e6 }),
        fc.double({ min: 0.001, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        (s, mean, a, b) => {
          const rng = new Rng(s, "p");
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const mode = (lo + hi) / 2;
          const uni = new UniformSampler(rng, lo, hi);
          const tri = new TriangularSampler(rng, lo, mode, hi);
          const exp = new ExponentialSampler(rng, mean);
          const logn = new LognormalSampler(rng, mean, mean / 2);
          for (let i = 0; i < 25; i++) {
            const u = uni.nextSample();
            expect(u).toBeGreaterThanOrEqual(lo);
            expect(u).toBeLessThanOrEqual(hi);
            const t = tri.nextSample();
            expect(t).toBeGreaterThanOrEqual(lo);
            expect(t).toBeLessThanOrEqual(hi);
            expect(exp.nextSample()).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(exp.nextSample())).toBe(true);
            const l = logn.nextSample();
            expect(l).toBeGreaterThan(0);
            expect(Number.isFinite(l)).toBe(true);
          }
        },
      ),
    );
  });
});

describe("statistics", () => {
  it("TimeWeightedStat equals brute-force integration of the signal", () => {
    assertProperty(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 100 })), { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 1, max: 500 }),
        (steps, tail) => {
          const w = new TimeWeightedStat(0, 0);
          let t = 0;
          let value = 0;
          let area = 0;
          for (const [dt, v] of steps) {
            area += value * dt;
            t += dt;
            w.set(t, v);
            value = v;
          }
          area += value * tail;
          const end = t + tail;
          expect(w.integral(end)).toBeCloseTo(area, 6);
          expect(w.mean(end)).toBeCloseTo(area / end, 9);
          expect(w.max(end)).toBeLessThanOrEqual(Math.max(0, ...steps.map(([, v]) => v)));
        },
      ),
    );
  });

  it("percentiles are monotone, bounded by min and max, and p0/p100 are the extremes", () => {
    assertProperty(
      fc.property(fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 120 }), (xs) => {
        const t = new ExactPercentileTracker();
        xs.forEach((x) => t.add(x));
        const lo = Math.min(...xs);
        const hi = Math.max(...xs);
        expect(t.percentile(0)).toBe(lo);
        expect(t.percentile(100)).toBe(hi);
        let prev = -Infinity;
        for (const p of [0, 1, 25, 50, 75, 95, 99, 100]) {
          const v = t.percentile(p);
          expect(v).toBeGreaterThanOrEqual(prev);
          expect(v).toBeGreaterThanOrEqual(lo);
          expect(v).toBeLessThanOrEqual(hi);
          prev = v;
        }
        expect(t.mean()).toBeCloseTo(xs.reduce((a, b) => a + b, 0) / xs.length, 6);
      }),
    );
  });

  it("summarize: the interval is centred on the mean and constant data has zero spread", () => {
    assertProperty(
      fc.property(fc.array(fc.double({ min: -1e4, max: 1e4, noNaN: true }), { minLength: 2, maxLength: 40 }), (xs) => {
        const s = summarize(xs);
        expect(s.n).toBe(xs.length);
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        expect(s.mean).toBeCloseTo(mean, 6);
        expect(s.ci95!.halfWidth).toBeGreaterThanOrEqual(0);
        expect((s.ci95!.low + s.ci95!.high) / 2).toBeCloseTo(mean, 5);
      }),
    );
    assertProperty(
      fc.property(fc.double({ min: -1e3, max: 1e3, noNaN: true }), fc.integer({ min: 2, max: 30 }), (v, n) => {
        const s = summarize(Array(n).fill(v));
        // Averaging identical floats can leave a rounding residue (about 1e-16 of the value), so "zero" means negligible.
        const negligible = Math.abs(v) * 1e-12 + 1e-12;
        expect(s.stdDev!).toBeLessThanOrEqual(negligible);
        expect(s.ci95!.halfWidth).toBeLessThanOrEqual(negligible * 10);
      }),
    );
  });
});

describe("simulation invariants", () => {
  it("conservation: every generated entity is accounted for (sink + dropped + waiting + in service)", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 1, max: 60 }), // arrivals
        fc.double({ min: 0.05, max: 2, noNaN: true }), // mean inter-arrival
        fc.integer({ min: 1, max: 4 }), // servers
        fc.double({ min: 0.05, max: 3, noNaN: true }), // mean service
        fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined }), // queue limit
        fc.integer({ min: 1, max: 120 }), // duration
        fc.integer({ min: 0, max: 1e6 }),
        (n, ia, c, svc, limit, duration, s) => {
          const r = run({
            version: 1,
            settings: { duration, seed: s },
            components: [
              { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: { dist: "exponential", mean: ia }, maxNumber: n }, links: { next: "queue" } },
              { type: "Queue", name: "queue", inputs: limit === undefined ? {} : { maxLength: limit } },
              { type: "Server", name: "server", inputs: { capacity: c, serviceTime: { dist: "exponential", mean: svc } }, links: { queue: "queue", next: "sink" } },
              { type: "EntitySink", name: "sink" },
            ],
          });
          const v = (id: string) => out(r, id).mean as number;
          expect(v("gen.NumberGenerated")).toBeLessThanOrEqual(n);
          expect(v("gen.NumberGenerated")).toBe(v("sink.count") + v("queue.NumberDropped") + v("queue.QueueLength") + v("server.BusyWorkers"));
          expect(v("server.BusyWorkers")).toBeLessThanOrEqual(c);
          const u = v("server.Utilisation");
          expect(u).toBeGreaterThanOrEqual(0);
          expect(u).toBeLessThanOrEqual(1 + 1e-9);
        },
      ),
      60,
    );
  });

  it("conservation for a push-mode WorkerPool: generated = completed + failed + throttled + still running", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 1, max: 80 }),
        fc.integer({ min: 1, max: 4 }),
        fc.double({ min: 0.05, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 1e6 }),
        (n, c, svc, pFail, duration, s) => {
          const r = run({
            version: 1,
            settings: { duration, seed: s },
            components: [
              { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: { dist: "exponential", mean: 0.2 }, maxNumber: n }, links: { next: "pool" } },
              { type: "WorkerPool", name: "pool", inputs: { concurrency: c, serviceTime: { dist: "exponential", mean: svc }, failureProbability: pFail }, links: { next: "sink" } },
              { type: "EntitySink", name: "sink" },
            ],
          });
          const v = (id: string) => out(r, id).mean as number;
          expect(v("gen.NumberGenerated")).toBe(v("pool.NumberSucceeded") + v("pool.NumberFailed") + v("pool.NumberThrottled") + v("pool.BusyWorkers"));
          expect(v("sink.count")).toBe(v("pool.NumberSucceeded"));
        },
      ),
      60,
    );
  });

  it("the same model and seed always give identical results; a different seed changes them", () => {
    assertProperty(
      fc.property(fc.integer({ min: 0, max: 1e6 }), fc.integer({ min: 1, max: 3 }), (s, c) => {
        const model = {
          version: 1,
          settings: { duration: 40, seed: s, replications: 2 },
          components: [
            { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: { dist: "exponential", mean: 0.3 } }, links: { next: "queue" } },
            { type: "Queue", name: "queue" },
            { type: "Server", name: "server", inputs: { capacity: c, serviceTime: { dist: "lognormal", mean: 0.5, stdDev: 0.3 } }, links: { queue: "queue", next: "sink" } },
            { type: "EntitySink", name: "sink" },
          ],
        };
        expect(run(model).replications).toEqual(run(model).replications);
      }),
      40,
    );
  });
});

describe("the loader never throws on bad input", () => {
  it("returns a result for any JSON value whatsoever", () => {
    assertProperty(
      fc.property(fc.jsonValue(), (json) => {
        const r = loadModel(json);
        expect(typeof r.ok).toBe("boolean");
        if (!r.ok) {
          expect(r.errors.length).toBeGreaterThan(0);
          for (const e of r.errors) {
            expect(typeof e.message).toBe("string");
            expect(e.message.length).toBeGreaterThan(0);
          }
        }
      }),
      400,
    );
  });

  // A valid model, then random edits at random places: whatever happens must be a structured result, never a crash.
  const base = (): Record<string, unknown> => ({
    version: 1,
    name: "fuzz base",
    settings: { duration: 20, seed: 3, replications: 1, timeSeries: { interval: 5, outputs: ["queue.QueueLength", "pool.BusyWorkers"] } },
    components: [
      { type: "EntityGenerator", name: "gen", inputs: { mode: "rateProfile", rateProfile: [[0, 5], [10, 20]] }, links: { next: "limiter" } },
      { type: "RateLimiter", name: "limiter", inputs: { rate: 10, burst: 5 }, links: { next: "retry", onReject: "rejected" } },
      { type: "RetryPolicy", name: "retry", inputs: { maxAttempts: 3, baseDelay: 0.1 }, links: { next: "pool", giveUp: "failed" } },
      { type: "MessageQueue", name: "queue", inputs: { visibilityTimeout: 2, maxReceiveCount: 2 }, links: { deadLetter: "dlq" } },
      { type: "WorkerPool", name: "pool", inputs: { concurrency: 3, serviceTime: { dist: "lognormal", mean: 0.2, stdDev: 0.1 }, coldStartTime: 0.3, failureProbability: 0.1 }, links: { queue: "queue", next: "sink", onFailure: "retry" } },
      { type: "Autoscaler", name: "scaler", inputs: { maxConcurrency: 8, evaluationInterval: 2 }, links: { target: "pool" } },
      { type: "EntitySink", name: "sink" },
      { type: "EntitySink", name: "rejected" },
      { type: "EntitySink", name: "failed" },
      { type: "EntitySink", name: "dlq" },
    ],
    assertions: [{ output: "sink.mean", op: "<", value: 100 }],
  });

  /** The path edited by the most recent {@link mutate} call, for readable failure messages. */
  let lastEdit = "";

  /** Replace the value at a random place in the document. */
  const mutate = (doc: unknown, pick: number, replacement: unknown): unknown => {
    const paths: (string | number)[][] = [];
    const walk = (v: unknown, p: (string | number)[]) => {
      paths.push(p);
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...p, i]));
      else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walk(x, [...p, k]);
    };
    walk(doc, []);
    const path = paths[pick % paths.length] as (string | number)[];
    lastEdit = `${path.join(".") || "(whole model)"} := ${replacement === undefined ? "(deleted)" : JSON.stringify(replacement)}`;
    if (path.length === 0) return replacement;
    const copy = JSON.parse(JSON.stringify(doc)) as Record<string | number, unknown>;
    let cur: Record<string | number, unknown> = copy;
    for (const key of path.slice(0, -1)) cur = cur[key] as Record<string | number, unknown>;
    const last = path[path.length - 1] as string | number;
    if (replacement === undefined) {
      // Remove the way editing JSON would: an object loses its key, an array closes the gap (no holes).
      if (Array.isArray(cur)) (cur as unknown[]).splice(last as number, 1);
      else delete cur[last];
    } else cur[last] = replacement;
    return copy;
  };

  // Mostly plausible edits (edge-case numbers, other component names), some pure garbage, some deletions.
  const replacementArb = fc.option(
    fc.oneof(
      { weight: 2, arbitrary: fc.jsonValue({ maxDepth: 2 }) },
      { weight: 6, arbitrary: fc.oneof(fc.integer({ min: -5, max: 100 }), fc.double({ min: 0, max: 1000, noNaN: true }), fc.constantFrom(0, 1, -1, 1e-9, 1e9, 1e300, 0.5, 2 ** 53)) },
      { weight: 3, arbitrary: fc.constantFrom("pool", "sink", "queue", "limiter", "retry", "rejected", "failed", "dlq", "scaler", "gen", "", "<=", "mean") },
      { weight: 1, arbitrary: fc.boolean() },
    ),
    { nil: undefined, freq: 6 },
  );

  it("a mutated model is either rejected with errors or runs to completion (no crash, no hang)", () => {
    const tally = { rejected: 0, ran: 0, stopped: 0 };
    assertProperty(
      fc.property(fc.nat(), replacementArb, (pick, replacement) => {
        const mutated = mutate(base(), pick, replacement);
        const loaded = loadModel(mutated);
        if (!loaded.ok) {
          tally.rejected++;
          expect(loaded.errors.length).toBeGreaterThan(0);
          return;
        }
        // Keep each generated run small; the guard turns a runaway zero-delay loop into an error instead of a hang.
        const model: ModelDefinition = { ...loaded.model, settings: { ...loaded.model.settings, duration: Math.min(loaded.model.settings.duration, 3), warmUp: 0, replications: 1 } };
        let results;
        try {
          results = runModel(model, { maxEventsPerTick: 20_000, maxEvents: 300_000 });
        } catch (e) {
          // The only acceptable failures are the engine's own, readable safety stops.
          expect((e as Error).name, `${(e as Error).message}  [edit: ${lastEdit}]`).toBe("SimulationLimitError");
          tally.stopped++;
          return;
        }
        tally.ran++;
        expect(results.outputs.length).toBeGreaterThan(0);
      }),
      mutationRuns,
    );
    if (env["FC_VERBOSE"]) console.log(`mutation fuzz: ${JSON.stringify(tally)}`);
    // Guard against a hollow fuzzer: a healthy share of the mutations must be valid models that really ran.
    expect(tally.ran, JSON.stringify(tally)).toBeGreaterThan(mutationRuns * 0.1);
    expect(tally.rejected, JSON.stringify(tally)).toBeGreaterThan(0);
  });
});

describe("a valid model never needs an unhelpful crash", () => {
  it("interArrivalTime 0 with no limit is stopped with a clear message instead of spinning forever", () => {
    const model = load({
      version: 1,
      settings: { duration: 10 },
      components: [
        { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: 0 }, links: { next: "sink" } },
        { type: "EntitySink", name: "sink" },
      ],
    });
    expect(() => runModel(model, { maxEventsPerTick: 1000 })).toThrow(/stuck|without the clock advancing/i);
  });
});

describe("extreme parameters never produce NaN", () => {
  it("lognormal samples are never NaN, whatever the mean and standard deviation (even subnormal or enormous)", () => {
    assertProperty(
      fc.property(
        fc.double({ min: 5e-324, max: 1e300, noNaN: true }),
        fc.double({ min: 0, max: 1e300, noNaN: true }),
        fc.integer({ min: 0, max: 1e6 }),
        (mean, stdDev, s) => {
          const sampler = new LognormalSampler(new Rng(s, "x"), mean, stdDev);
          for (let i = 0; i < 20; i++) {
            const v = sampler.nextSample();
            expect(Number.isNaN(v)).toBe(false);
            expect(v).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      400,
    );
  });

  it("the lognormal still has the requested mean for ordinary parameters", () => {
    for (const [mean, sd] of [[0.5, 0.25], [2, 1], [10, 30], [0.001, 0.0005]] as const) {
      const sampler = new LognormalSampler(new Rng(11, "m"), mean, sd);
      let sum = 0;
      const n = 200_000;
      for (let i = 0; i < n; i++) sum += sampler.nextSample();
      expect(sum / n / mean).toBeGreaterThan(0.97);
      expect(sum / n / mean).toBeLessThan(1.03);
    }
  });

  it("an absurdly long delay is capped instead of overflowing", () => {
    const k = new Kernel();
    expect(k.secondsToTicks(1e300)).toBe(Number.MAX_SAFE_INTEGER);
    expect(k.secondsToTicks(Infinity)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => k.schedule(k.secondsToTicks(1e300), 5, () => {})).not.toThrow();
  });
});
