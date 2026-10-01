import { describe, expect, it } from "vitest";
import { evaluateAssertions, loadModel, runModel } from "../src/index.js";
import { load, out, run } from "./helpers.js";

type Comp = { type: string; name: string; inputs?: object; links?: object };
const model = (components: Comp[], settings: object = { duration: 20 }, extra: object = {}) => ({ version: 1, settings, components, ...extra });
const gen = (name: string, next: string, inputs: object): Comp => ({ type: "EntityGenerator", name, inputs, links: { next } });
const sink = (name: string): Comp => ({ type: "EntitySink", name });
const val = (r: ReturnType<typeof run>, id: string) => out(r, id).mean;

describe("cost", () => {
  it("WorkerPool: busy-seconds, provisioned-seconds and per-request charges (hand calculation)", () => {
    // 3 jobs at t=0, 5 s each, 4 workers, 10 s run: busy 15 s, provisioned 40 s, 3 requests.
    const r = run(
      model([
        gen("gen", "pool", { interArrivalTime: 0, maxNumber: 3 }),
        {
          type: "WorkerPool",
          name: "pool",
          inputs: { concurrency: 4, serviceTime: 5, costPerBusySecond: 0.01, costPerProvisionedSecond: 0.001, costPerRequest: 0.0001 },
          links: { next: "sink" },
        },
        sink("sink"),
      ], { duration: 10 }),
    );
    expect(val(r, "pool.Cost")).toBeCloseTo(15 * 0.01 + 40 * 0.001 + 3 * 0.0001, 9);
    expect(out(r, "pool.Cost").unit).toBe("cost");
  });

  it("costs default to zero", () => {
    const r = run(
      model([gen("gen", "pool", { interArrivalTime: 1, maxNumber: 3 }), { type: "WorkerPool", name: "pool", inputs: { concurrency: 1, serviceTime: 1 } }]),
    );
    expect(val(r, "pool.Cost")).toBe(0);
  });

  it("MessageQueue: every send, receive and delete is a billable request", () => {
    // 2 messages: 2 sends + 2 receives + 2 deletes = 6 requests at 0.4 per request -> 2.4.
    const r = run(
      model([
        gen("gen", "mq", { interArrivalTime: 1, maxNumber: 2 }),
        { type: "MessageQueue", name: "mq", inputs: { costPerMillionRequests: 400_000 } },
        { type: "WorkerPool", name: "pool", inputs: { concurrency: 1, serviceTime: 0.1 }, links: { queue: "mq", next: "sink" } },
        sink("sink"),
      ]),
    );
    expect(val(r, "mq.NumberRequests")).toBe(6);
    expect(val(r, "mq.Cost")).toBeCloseTo(2.4, 9);
  });

  it("warm-up resets cost accounting", () => {
    const m = (warmUp: number) =>
      model(
        [
          gen("gen", "pool", { interArrivalTime: 1 }),
          { type: "WorkerPool", name: "pool", inputs: { concurrency: 2, serviceTime: 0.5, costPerProvisionedSecond: 1 }, links: { next: "sink" } },
          sink("sink"),
        ],
        { duration: 100, warmUp },
      );
    expect(val(run(m(0)), "pool.Cost")).toBeCloseTo(200, 6); // 2 workers x 100 s
    expect(val(run(m(50)), "pool.Cost")).toBeCloseTo(100, 6); // only the last 50 s
  });
});

describe("Autoscaler", () => {
  const scaled = (autoscaler: object, extra: Partial<{ arrival: object; service: object; duration: number; poolInputs: object; series: boolean }> = {}) =>
    model(
      [
        gen("gen", "q", extra.arrival ?? { interArrivalTime: 0.1 }),
        { type: "Queue", name: "q" },
        { type: "WorkerPool", name: "pool", inputs: { concurrency: 1, serviceTime: extra.service ?? 1, ...(extra.poolInputs ?? {}) }, links: { queue: "q", next: "sink" } },
        sink("sink"),
        { type: "Autoscaler", name: "scaler", inputs: { maxConcurrency: 100, ...autoscaler }, links: { target: "pool" } },
      ],
      {
        duration: extra.duration ?? 100,
        ...(extra.series ? { timeSeries: { interval: 1, outputs: ["pool.Concurrency", "scaler.DesiredConcurrency"] } } : {}),
      },
    );
  const series = (r: ReturnType<typeof run>, id: string) => r.timeSeries!.replications[0]!.values[id]!;

  it("scale-out takes effect after scaleUpDelay (first decision at t=10 -> desired 2, applied at t=15)", () => {
    // 10/s offered, 1 s service, 1 worker: saturated, so avg busy over [0,10] is exactly 1 -> ceil(1/0.5) = 2.
    const r = run(scaled({ targetUtilisation: 0.5, evaluationInterval: 10, scaleUpDelay: 5 }, { series: true }));
    expect(series(r, "pool.Concurrency")[14]).toBe(1);
    expect(series(r, "pool.Concurrency")[16]).toBe(2);
    expect(series(r, "scaler.DesiredConcurrency")[10]).toBe(2);
  });

  it("never exceeds maxConcurrency and never goes below minConcurrency", () => {
    const r = run(scaled({ targetUtilisation: 0.5, evaluationInterval: 5, maxConcurrency: 6, minConcurrency: 3 }, { series: true }));
    const c = series(r, "pool.Concurrency") as number[];
    expect(Math.max(...c)).toBe(6);
    expect(c.every((v) => v >= 1)).toBe(true);
    const idle = run(scaled({ targetUtilisation: 0.5, evaluationInterval: 5, maxConcurrency: 6, minConcurrency: 3, scaleDownCooldown: 0 }, { arrival: { interArrivalTime: 1000 }, series: true }));
    const ci = series(idle, "pool.Concurrency") as number[];
    expect(ci[ci.length - 1]).toBe(3); // an idle pool scales in to the minimum
  });

  it("converges to ceil(load / targetUtilisation): 10 busy at target 0.5 -> about 20 workers, utilisation about 0.5", () => {
    // Poisson 10/s, service 1 s -> offered load a = 10 busy workers on average (M/M/inf-like once capacity is ample).
    const r = run(
      scaled(
        { targetUtilisation: 0.5, evaluationInterval: 30, scaleDownCooldown: 60 },
        { arrival: { interArrivalTime: { dist: "exponential", mean: 0.1 } }, service: { dist: "exponential", mean: 1 }, duration: 6000 },
      ),
      { replications: 5, seed: 8 },
    );
    const avg = val(r, "pool.AverageConcurrency")!;
    expect(avg).toBeGreaterThan(17);
    expect(avg).toBeLessThan(27);
    expect(val(r, "pool.Utilisation")!).toBeGreaterThan(0.38);
    expect(val(r, "pool.Utilisation")!).toBeLessThan(0.58);
  });

  it("scale-in waits for the cooldown", () => {
    const base = { targetUtilisation: 0.5, evaluationInterval: 10, maxConcurrency: 20, minConcurrency: 1 };
    // Burst of work early, then nothing: capacity must shrink, but not before the cooldown elapses.
    const work = { arrival: { interArrivalTime: 0.1, maxNumber: 300 }, duration: 400, series: true };
    const slow = series(run(scaled({ ...base, scaleDownCooldown: 200 }, work)), "pool.Concurrency") as number[];
    const fast = series(run(scaled({ ...base, scaleDownCooldown: 0 }, work)), "pool.Concurrency") as number[];
    // Capacity doubles 1,2,4,8,16 and hits the cap of 20 at t=50 (the last scaling change).
    expect(slow[50]).toBe(20);
    expect(fast[50]).toBe(20);
    // The 30 s burst is over by t=60: with no cooldown capacity is shed at the next evaluation...
    expect(fast[60]).toBe(1);
    // ...but with a 200 s cooldown it is held until 50 + 200 = 250 s.
    expect(slow[249]).toBe(20);
    expect(slow[251]).toBe(1);
  });

  it("autoscaling relieves an overloaded pool: lower mean time in system than a fixed single worker", () => {
    const fixed = run(model([gen("gen", "q", { interArrivalTime: 0.2 }), { type: "Queue", name: "q" }, { type: "WorkerPool", name: "pool", inputs: { concurrency: 1, serviceTime: 1 }, links: { queue: "q", next: "sink" } }, sink("sink")], { duration: 200 }));
    const auto = run(scaled({ targetUtilisation: 0.6, evaluationInterval: 10 }, { arrival: { interArrivalTime: 0.2 }, duration: 200 }));
    expect(val(auto, "sink.mean")!).toBeLessThan(val(fixed, "sink.mean")! / 3);
    expect(val(auto, "scaler.ScaleOuts")!).toBeGreaterThan(0);
  });

  it("provisioned cost follows the autoscaled concurrency", () => {
    const r = run(scaled({ targetUtilisation: 0.5, evaluationInterval: 10 }, { poolInputs: { costPerProvisionedSecond: 1 } }));
    // Cost is the integral of concurrency over time: at least 1 worker for 100 s, strictly more once it scaled out.
    expect(val(r, "pool.Cost")!).toBeGreaterThan(100);
    expect(val(r, "pool.Cost")!).toBeCloseTo(val(r, "pool.AverageConcurrency")! * 100, 6);
  });

  it("requires a target link to a scalable component and a maxConcurrency", () => {
    const bad = loadModel(model([{ type: "Autoscaler", name: "s", inputs: {}, links: {} }]));
    expect(bad.ok).toBe(false);
    const wrongTarget = loadModel(model([{ type: "Autoscaler", name: "s", inputs: { maxConcurrency: 5 }, links: { target: "q" } }, { type: "Queue", name: "q" }]));
    expect(wrongTarget.ok ? [] : wrongTarget.errors.map((e) => e.message).join(" ")).toContain("scalable");
  });
});

describe("assertions", () => {
  const base = (assertions: unknown, replications = 5) =>
    model(
      [
        gen("gen", "pool", { interArrivalTime: { dist: "exponential", mean: 0.5 } }),
        { type: "WorkerPool", name: "pool", inputs: { concurrency: 100, serviceTime: 1 }, links: { next: "sink" } },
        sink("sink"),
      ],
      { duration: 200, replications, seed: 3 },
      { assertions },
    );

  it("pass and fail with readable messages", () => {
    const r = run(base([{ output: "sink.mean", op: "<=", value: 1.0000001 }, { output: "sink.mean", op: ">", value: 5, name: "slow enough" }]));
    expect(r.assertions!.map((a) => a.passed)).toEqual([true, false]);
    expect(r.assertions![0]!.message).toBe("sink.mean (mean) = 1 <= 1");
    expect(r.assertions![1]!.message).toBe("slow enough: sink.mean (mean) = 1 violates > 5");
  });

  it("statistics: ci95High is pessimistic, min/max look at individual replications", () => {
    const r = run(base([
      { output: "gen.NumberGenerated", op: "<=", value: 1e9, statistic: "ci95High" },
      { output: "gen.NumberGenerated", statistic: "min", op: ">", value: 300 },
      { output: "gen.NumberGenerated", statistic: "max", op: "<", value: 500 },
    ]));
    expect(r.assertions!.every((a) => a.passed)).toBe(true);
    const gens = r.replications.map((x) => x.outputs["gen.NumberGenerated"] as number);
    expect(r.assertions![1]!.actual).toBe(Math.min(...gens));
    expect(r.assertions![2]!.actual).toBe(Math.max(...gens));
    const o = out(r, "gen.NumberGenerated");
    expect(evaluateAssertions(r, [{ output: "gen.NumberGenerated", op: "==", value: o.ci95!.high, statistic: "ci95High" }])[0]!.passed).toBe(true);
  });

  it("an assertion on an undefined value fails instead of passing silently", () => {
    const r = run(base([{ output: "sink.mean", op: "<", value: 100, statistic: "ci95High" }], 1)); // 1 replication: no CI
    expect(r.assertions![0]!.passed).toBe(false);
    expect(r.assertions![0]!.actual).toBeNull();
    expect(r.assertions![0]!.message).toContain("undefined");
  });

  it("extra assertions passed as run options are appended to the model's", () => {
    const m = load(base([{ output: "sink.mean", op: "<", value: 5 }]));
    const r = runModel(m, { assertions: [{ output: "gen.NumberGenerated", op: ">", value: 0 }] });
    expect(r.assertions).toHaveLength(2);
  });

  it("no assertions means no assertions field in the results", () => {
    expect(run(base(undefined)).assertions).toBeUndefined();
  });

  it("the loader reports every problem with the assertion index", () => {
    const res = loadModel(base([
      { output: "nope.x", op: "<", value: 1 },
      { output: "sink.mean", op: "=<", value: 1 },
      { output: "sink.mean", op: "<", value: "1" },
      { output: "sink.mean", op: "<", value: 1, statistic: "median" },
      { output: "sink.mean", op: "<", value: 1, extra: true },
    ]));
    expect(res.ok).toBe(false);
    const keys = res.ok ? [] : res.errors.map((e) => e.key);
    expect(keys).toEqual(["assertions[0].output", "assertions[1].op", "assertions[2].value", "assertions[3].statistic", "assertions[4].extra"]);
    expect(loadModel(base("nope")).ok).toBe(false);
  });
});
