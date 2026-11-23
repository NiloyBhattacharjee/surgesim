import { describe, expect, it } from "vitest";
import { loadModel } from "../src/index.js";
import { out, run } from "./helpers.js";

type Comp = { type: string; name: string; inputs?: object; links?: object };

const model = (components: Comp[], settings: object = { duration: 20 }) => ({ version: 1, settings, components });
const gen = (name: string, next: string, inputs: object = { interArrivalTime: 1, maxNumber: 1 }): Comp => ({
  type: "EntityGenerator",
  name,
  inputs,
  links: { next },
});
const sink = (name: string): Comp => ({ type: "EntitySink", name });
const val = (r: ReturnType<typeof run>, id: string) => out(r, id).mean;
const errorsOf = (components: Comp[]) => {
  const res = loadModel(model(components));
  return res.ok ? [] : res.errors;
};

describe("MessageQueue: visibility timeout, redelivery and dead-letter queue", () => {
  const pipeline = (visibilityTimeout: number, poolInputs: object, poolLinks: object = {}, maxReceiveCount?: number) =>
    model([
      gen("gen", "mq"),
      {
        type: "MessageQueue",
        name: "mq",
        inputs: { visibilityTimeout, ...(maxReceiveCount ? { maxReceiveCount } : {}) },
        links: { deadLetter: "dlq" },
      },
      { type: "WorkerPool", name: "pool", inputs: { concurrency: 1, ...poolInputs }, links: { queue: "mq", next: "sink", ...poolLinks } },
      sink("sink"),
      sink("dlq"),
    ]);

  it("a timeout shorter than the work causes duplicate processing, then dead-lettering (hand timeline)", () => {
    // One message, service 5 s, visibility 2 s, maxReceiveCount 3.
    // receives at t=0,5,10; expiries at 2 (redeliver), 7 (redeliver), 12 (dead-letter).
    // The worker finishes at 5, 10, 15 every time with a stale ack, so the sink sees 3 copies.
    const r = run(pipeline(2, { serviceTime: 5 }, {}, 3));
    expect(val(r, "mq.NumberReceived")).toBe(3);
    expect(val(r, "mq.NumberRedelivered")).toBe(2);
    expect(val(r, "mq.NumberDeadLettered")).toBe(1);
    expect(val(r, "dlq.count")).toBe(1);
    expect(val(r, "pool.StaleAcks")).toBe(3);
    expect(val(r, "sink.count")).toBe(3);
  });

  it("a timeout longer than the work acks cleanly (and in-flight time is hand-calculable)", () => {
    const r = run(pipeline(10, { serviceTime: 5 }, {}, 3));
    expect(val(r, "mq.NumberReceived")).toBe(1);
    expect(val(r, "mq.NumberRedelivered")).toBe(0);
    expect(val(r, "pool.StaleAcks")).toBe(0);
    expect(val(r, "sink.count")).toBe(1);
    expect(val(r, "mq.AverageInFlight")).toBeCloseTo(5 / 20, 9); // 1 in flight on [0,5) of 20 s
    expect(val(r, "mq.Backlog")).toBe(0);
  });

  it("unacked failures are redelivered after the timeout, then dead-lettered", () => {
    // failureProbability 1, service 0.1, visibility 1: received at 0,1,2; third expiry at 3 dead-letters.
    const r = run(pipeline(1, { serviceTime: 0.1, failureProbability: 1 }, {}, 3));
    expect(val(r, "pool.NumberFailed")).toBe(3);
    expect(val(r, "mq.NumberReceived")).toBe(3);
    expect(val(r, "dlq.count")).toBe(1);
    expect(val(r, "sink.count")).toBe(0);
  });

  it("with an onFailure link a failure is acked, not redelivered", () => {
    const m = pipeline(1, { serviceTime: 0.1, failureProbability: 1 }, { onFailure: "failed" }, 3);
    m.components.push(sink("failed"));
    const r = run(m);
    expect(val(r, "failed.count")).toBe(1);
    expect(val(r, "mq.NumberRedelivered")).toBe(0);
    expect(val(r, "mq.NumberDeadLettered")).toBe(0);
    expect(val(r, "mq.Backlog")).toBe(0);
  });

  it("without a deadLetter link, exhausted messages are discarded and counted", () => {
    const m = pipeline(1, { serviceTime: 0.1, failureProbability: 1 }, {}, 2);
    delete (m.components[1] as Comp).links;
    const r = run(m);
    expect(val(r, "mq.NumberDeadLettered")).toBe(1);
    expect(val(r, "dlq.count")).toBe(0);
  });
});

describe("WorkerPool: cold starts", () => {
  const coldStartModel = (poolInputs: object) =>
    model(
      [
        gen("gen", "pool", { interArrivalTime: 10, maxNumber: 5 }),
        { type: "WorkerPool", name: "pool", inputs: { concurrency: 10, serviceTime: 1, coldStartTime: 2, ...poolInputs }, links: { next: "sink" } },
        sink("sink"),
      ],
      { duration: 100 },
    );

  it("instances that idle past idleTimeout go cold: every request pays the cold start", () => {
    // arrivals at 0,10,20,30,40; each finishes at +3 and is reclaimed after 5 s idle.
    const r = run(coldStartModel({ idleTimeout: 5 }));
    expect(val(r, "pool.ColdStarts")).toBe(5);
    expect(val(r, "sink.mean")).toBeCloseTo(3, 9);
  });

  it("a long idleTimeout keeps the instance warm after the first request", () => {
    const r = run(coldStartModel({ idleTimeout: 20 }));
    expect(val(r, "pool.ColdStarts")).toBe(1);
    expect(val(r, "sink.mean")).toBeCloseTo((3 + 4 * 1) / 5, 9);
  });

  it("initialWarm instances avoid the first cold start", () => {
    const r = run(coldStartModel({ idleTimeout: 20, initialWarm: 1 }));
    expect(val(r, "pool.ColdStarts")).toBe(0);
    expect(val(r, "sink.mean")).toBeCloseTo(1, 9);
  });

  it("concurrent requests each need their own instance", () => {
    // Three simultaneous arrivals, no warm instances: three cold starts, all finish at t=3.
    const r = run(
      model([
        gen("gen", "pool", { interArrivalTime: 0, maxNumber: 3 }),
        { type: "WorkerPool", name: "pool", inputs: { concurrency: 10, serviceTime: 1, coldStartTime: 2 }, links: { next: "sink" } },
        sink("sink"),
      ]),
    );
    expect(val(r, "pool.ColdStarts")).toBe(3);
    expect(val(r, "sink.mean")).toBeCloseTo(3, 9);
  });
});

describe("WorkerPool: throttling", () => {
  it("rejects pushed entities when all workers are busy and routes them to onThrottle", () => {
    // arrivals at t=0..4, 2 workers busy for 10 s: arrivals 0,1 start; 2,3,4 are throttled.
    const r = run(
      model(
        [
          gen("gen", "pool", { interArrivalTime: 1, maxNumber: 5 }),
          { type: "WorkerPool", name: "pool", inputs: { concurrency: 2, serviceTime: 10 }, links: { next: "sink", onThrottle: "rejects" } },
          sink("sink"),
          sink("rejects"),
        ],
        { duration: 30 },
      ),
    );
    expect(val(r, "pool.NumberThrottled")).toBe(3);
    expect(val(r, "pool.ThrottleFraction")).toBeCloseTo(0.6, 9);
    expect(val(r, "rejects.count")).toBe(3);
    expect(val(r, "sink.count")).toBe(2);
  });
});

/** Erlang-B: probability that all c servers are busy in an M/M/c/c loss system with offered load a. */
function erlangB(a: number, c: number): number {
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  return b;
}

describe("WorkerPool without a queue is an M/M/c/c loss system (Erlang-B)", () => {
  const lambda = 4;
  const c = 5;
  const a = lambda; // offered load = lambda / mu, mu = 1
  const B = erlangB(a, c);
  const r = run(
    model(
      [
        gen("gen", "pool", { interArrivalTime: { dist: "exponential", mean: 1 / lambda }, maxNumber: undefined }),
        { type: "WorkerPool", name: "pool", inputs: { concurrency: c, serviceTime: { dist: "exponential", mean: 1 } }, links: { next: "sink" } },
        sink("sink"),
      ],
      { duration: 20_000, warmUp: 2_000, replications: 20, seed: 4242 },
    ),
  );

  it("the formula matches the textbook value (c=5, a=4 -> B ~ 0.19907)", () => {
    expect(B).toBeCloseTo(0.19907, 5);
  });

  it("the 95% CI of the blocking fraction contains Erlang-B", () => {
    const o = out(r, "pool.ThrottleFraction");
    expect(o.ci95!.low).toBeLessThanOrEqual(B);
    expect(o.ci95!.high).toBeGreaterThanOrEqual(B);
  });

  it("the 95% CI of utilisation contains the carried load a(1-B)/c", () => {
    const o = out(r, "pool.Utilisation");
    const theory = (a * (1 - B)) / c;
    expect(o.ci95!.low).toBeLessThanOrEqual(theory);
    expect(o.ci95!.high).toBeGreaterThanOrEqual(theory);
  });
});

describe("WorkerPool holdUntilRelease and Release: synchronous calls", () => {
  /** Arrivals at t=0 and t=1.5 to "a" (1 worker, 1 s, holds), which calls "b" (1 worker, 2 s). */
  const callModel = (aNext: string, bNext: string, extra: Comp[] = []) =>
    model([
      gen("gen", "a", { interArrivalTime: 1.5, firstArrivalTime: 0, maxNumber: 2 }),
      { type: "WorkerPool", name: "a", inputs: { concurrency: 1, serviceTime: 1, holdUntilRelease: true }, links: { next: aNext } },
      { type: "WorkerPool", name: "b", inputs: { concurrency: 1, serviceTime: 2 }, links: { next: bNext } },
      { type: "Release", name: "rel", links: { next: "sink" } },
      sink("sink"),
      ...extra,
    ]);

  it("the caller's worker stays busy until the response is released (hand timeline)", () => {
    // a serves [0,1), then waits for b on [1,3): the t=1.5 arrival finds a's only worker held and is throttled.
    const r = run(callModel("b", "rel"));
    expect(val(r, "a.NumberThrottled")).toBe(1);
    expect(val(r, "a.HeldWorkers")).toBe(0);
    expect(val(r, "a.AverageBusyWorkers")).toBeCloseTo(3 / 20, 9);
    expect(val(r, "rel.NumberReleased")).toBe(1);
    expect(val(r, "sink.count")).toBe(1);
    expect(val(r, "sink.mean")).toBe(3);
  });

  it("a Release before the downstream call makes it asynchronous (hand timeline)", () => {
    // a is freed at t=1, so the t=1.5 arrival is served; b serves the first on [1,3) and the second on [3,5).
    const r = run(callModel("relB", "sink", [{ type: "Release", name: "relB", links: { next: "b" } }]));
    expect(val(r, "a.NumberThrottled")).toBe(0);
    expect(val(r, "b.NumberThrottled")).toBe(1);
    expect(val(r, "relB.NumberReleased")).toBe(2);
  });

  it("a validation error names Release.next when it points at something that is not a receiver", () => {
    expect(errorsOf([{ type: "Release", name: "rel", links: { next: "auto" } }, { type: "Autoscaler", name: "auto", inputs: { maxConcurrency: 2 }, links: { target: "rel" } }]).map((e) => e.key)).toContain("next");
  });

  it("the Autoscaler does not count held workers as busy (waiting uses no CPU)", () => {
    // a computes for 0.01 s per request then waits 5 s on b: its slots are nearly all held, almost never computing.
    const r = run(
      model(
        [
          gen("gen", "q", { interArrivalTime: { dist: "exponential", mean: 1 } }),
          { type: "Queue", name: "q" },
          { type: "WorkerPool", name: "a", inputs: { concurrency: 2, serviceTime: 0.01, holdUntilRelease: true }, links: { queue: "q", next: "b" } },
          { type: "WorkerPool", name: "b", inputs: { concurrency: 100, serviceTime: 5 }, links: { next: "rel" } },
          { type: "Release", name: "rel", links: { next: "sink" } },
          { type: "Autoscaler", name: "hpa", inputs: { targetUtilisation: 0.5, evaluationInterval: 10, minConcurrency: 2, maxConcurrency: 50 }, links: { target: "a" } },
          sink("sink"),
        ],
        { duration: 300, seed: 3 },
      ),
    );
    expect(val(r, "a.Utilisation")).toBeGreaterThan(0.95);
    expect(val(r, "hpa.ScaleOuts")).toBe(0);
    expect(val(r, "q.MaxQueueLength")).toBeGreaterThan(50);
  });

  // A holding pool without a queue that calls an uncongested pool is an M/G/c/c loss system whose service time is
  // its own plus the callee's. Erlang-B is insensitive to the service distribution, so it still applies.
  describe("a synchronous caller without a queue follows Erlang-B with service time sA + sB", () => {
    const lambda = 4;
    const c = 5;
    const a = lambda * (0.5 + 0.5);
    const B = erlangB(a, c);
    const r = run(
      model(
        [
          gen("gen", "a", { interArrivalTime: { dist: "exponential", mean: 1 / lambda } }),
          { type: "WorkerPool", name: "a", inputs: { concurrency: c, serviceTime: { dist: "exponential", mean: 0.5 }, holdUntilRelease: true }, links: { next: "b" } },
          { type: "WorkerPool", name: "b", inputs: { concurrency: 1000, serviceTime: { dist: "exponential", mean: 0.5 } }, links: { next: "rel" } },
          { type: "Release", name: "rel", links: { next: "sink" } },
          sink("sink"),
        ],
        { duration: 20_000, warmUp: 2_000, replications: 20, seed: 4243 },
      ),
    );

    it("the 95% CI of the caller's blocking fraction contains Erlang-B (c=5, a=4)", () => {
      const o = out(r, "a.ThrottleFraction");
      expect(o.ci95!.low).toBeLessThanOrEqual(B);
      expect(o.ci95!.high).toBeGreaterThanOrEqual(B);
      expect(val(r, "b.NumberThrottled")).toBe(0);
    });

    it("the 95% CI of the caller's utilisation, held workers included, contains a(1-B)/c", () => {
      const o = out(r, "a.Utilisation");
      const theory = (a * (1 - B)) / c;
      expect(o.ci95!.low).toBeLessThanOrEqual(theory);
      expect(o.ci95!.high).toBeGreaterThanOrEqual(theory);
    });
  });
});

describe("WorkerPool cpuOversubscription: CPU throttling", () => {
  const pool = (inputs: object, rate: number, settings: object) =>
    run(
      model(
        [
          gen("gen", "q", { interArrivalTime: { dist: "exponential", mean: 1 / rate } }),
          { type: "Queue", name: "q" },
          { type: "WorkerPool", name: "p", inputs, links: { queue: "q", next: "sink" } },
          sink("sink"),
        ],
        settings,
      ),
    );

  it("stretches service by computing workers / concurrency x ratio (hand timeline)", () => {
    // 2 workers, ratio 4, 1 s service. t=0: 1 of 2 computing, stretch 2. t=0.5: 2 of 2, stretch 4.
    const r = run(
      model([
        gen("gen", "p", { interArrivalTime: 0.5, firstArrivalTime: 0, maxNumber: 2 }),
        { type: "WorkerPool", name: "p", inputs: { concurrency: 2, serviceTime: 1, cpuOversubscription: 4 }, links: { next: "sink" } },
        sink("sink"),
      ]),
    );
    expect(val(r, "sink.mean")).toBeCloseTo((2 + 4) / 2, 9);
    expect(val(r, "p.AverageCpuStretch")).toBeCloseTo(3, 9);
  });

  it("at 1 it changes nothing", () => {
    const settings = { duration: 200, seed: 7 };
    const base = pool({ concurrency: 3, serviceTime: { dist: "exponential", mean: 0.2 } }, 10, settings);
    const one = pool({ concurrency: 3, serviceTime: { dist: "exponential", mean: 0.2 }, cpuOversubscription: 1 }, 10, settings);
    expect(val(one, "sink.mean")).toBe(val(base, "sink.mean"));
    expect(val(one, "p.AverageCpuStretch")).toBe(1);
  });

  it("saturated throughput = concurrency / (service x ratio): 10 / (1 x 4) = 2.5/s", () => {
    const r = pool({ concurrency: 10, serviceTime: 1, cpuOversubscription: 4 }, 50, { duration: 2000, warmUp: 100, seed: 3 });
    expect(val(r, "p.NumberSucceeded")! / 1900).toBeCloseTo(2.5, 1);
    expect(val(r, "p.AverageCpuStretch")).toBeCloseTo(4, 2);
  });

  // One request alone uses the whole limit (ratio = slots), so each is stretched by everything already running. The mean
  // is M/M/1 processor sharing's, E[T] = E[S] / (1 - rho): E[T] = E[S](1 + E[N]) by PASTA, with S independent of N, and
  // E[N] = lambda E[T] by Little.
  describe("with ratio = slots it has the M/M/1-PS mean, E[T] = E[S] / (1 - rho)", () => {
    for (const rho of [0.5, 0.7]) {
      it(`rho = ${rho}`, () => {
        const r = pool({ concurrency: 500, serviceTime: { dist: "exponential", mean: 0.1 }, cpuOversubscription: 500 }, rho / 0.1, { duration: 20000, warmUp: 500, seed: 11, replications: 5 });
        const expected = 0.1 / (1 - rho);
        expect(Math.abs(val(r, "sink.mean")! - expected) / expected).toBeLessThan(0.03);
      });
    }
  });

  it("the Autoscaler sees CPU use capped at the limit: busy / ratio / target, not busy / target", () => {
    const saturated = (ratio: number) =>
      run(
        model(
          [
            gen("gen", "q", { interArrivalTime: 0.01 }),
            { type: "Queue", name: "q" },
            { type: "WorkerPool", name: "p", inputs: { concurrency: 40, serviceTime: 1, cpuOversubscription: ratio }, links: { queue: "q", next: "sink" } },
            { type: "Autoscaler", name: "hpa", inputs: { targetUtilisation: 0.5, evaluationInterval: 10, minConcurrency: 1, maxConcurrency: 400 }, links: { target: "p" } },
            sink("sink"),
          ],
          { duration: 15, seed: 1 },
        ),
      );
    // Arrivals fill the pool at 100/s, so over the first 10 s the mean busy is 40 less the ramp (40 x 0.4 / 2 / 10 = 0.8).
    expect(val(saturated(1), "hpa.DesiredConcurrency")).toBe(79); // ceil(39.2 / 0.5)
    // CPU stops at 40 / 4 = 10 workers' worth, reached after 0.1 s: ceil(9.95 / 0.5). Uncapped, this would also be 79.
    expect(val(saturated(4), "hpa.DesiredConcurrency")).toBe(20);
  });
});

describe("RollingUpdate: replacing pods within maxSurge and maxUnavailable", () => {
  /** A pool of `pods` idle pods, and an update starting at t=10. Capacity is read from AverageConcurrency over 200 s. */
  const rollout = (pods: number, inputs: object, extra: Comp[] = [], podSize = 1) =>
    run(
      model(
        [
          { type: "WorkerPool", name: "p", inputs: { concurrency: pods * podSize, serviceTime: 1 } },
          { type: "RollingUpdate", name: "r", inputs: { at: 10, readinessDelay: 30, podSize, ...inputs }, links: { target: "p" } },
          ...extra,
        ],
        { duration: 200 },
      ),
    );
  /** Mean capacity over 200 s: pods for the whole run, less the pod-seconds lost during the update. */
  const capacity = (pods: number, lostPodSeconds: number) => pods - lostPodSeconds / 200;

  // Worked through Kubernetes' ReconcileNewReplicaSet / reconcileOldReplicaSets, one batch per readinessDelay (30 s):
  const cases: [string, number, object, number, number][] = [
    // surge 1, unavailable 1: 3 serving (of 4) until the last batch is ready; 2 batches
    ["maxSurge 1, maxUnavailable 1", 4, { maxSurge: 1, maxUnavailable: 1 }, 60, 1 * 60],
    // surge 0, unavailable 1: one at a time, always 3 serving; 4 batches
    ["maxSurge 0, maxUnavailable 1", 4, { maxUnavailable: 1 }, 120, 1 * 120],
    // surge 1, unavailable 0: never below 4; each old pod goes as a new one is ready; 4 batches
    ["maxSurge 1, maxUnavailable 0", 4, { maxSurge: 1 }, 120, 0],
    // Recreate: all gone at once, all back after one batch
    ["Recreate (maxUnavailableFraction 1)", 4, { maxUnavailableFraction: 1 }, 30, 4 * 30],
    // the 25% defaults on 4 pods are the first case
    ["25% / 25% on 4 pods", 4, { maxSurgeFraction: 0.25, maxUnavailableFraction: 0.25 }, 60, 1 * 60],
    // on 2 pods surge rounds up to 1 and unavailable down to 0
    ["25% / 25% on 2 pods", 2, { maxSurgeFraction: 0.25, maxUnavailableFraction: 0.25 }, 60, 0],
    // 0 and 0 still makes progress: Kubernetes sets maxUnavailable to 1
    ["both limits resolving to 0", 3, { maxUnavailableFraction: 0.1 }, 90, 1 * 90],
  ];
  for (const [label, pods, inputs, seconds, lost] of cases) {
    it(`${label}: takes ${seconds} s and loses ${lost} pod-seconds of capacity (hand timeline)`, () => {
      const r = rollout(pods, inputs);
      expect(val(r, "r.RolloutSeconds")).toBe(seconds);
      expect(val(r, "r.PodsReplaced")).toBe(pods);
      expect(val(r, "p.AverageConcurrency")).toBeCloseTo(capacity(pods, lost), 9);
      expect(val(r, "p.Concurrency")).toBe(pods);
    });
  }

  it("works in whole pods of podSize workers", () => {
    const r = rollout(4, { maxSurge: 1, maxUnavailable: 1 }, [], 10);
    expect(val(r, "r.RolloutSeconds")).toBe(60);
    expect(val(r, "p.AverageConcurrency")).toBeCloseTo(10 * capacity(4, 60), 9);
  });

  it("a removed pod finishes its running work, and requests wait while nothing can serve (Recreate timeline)", () => {
    // 1 pod, busy on [0, 15). Recreate at 10 removes it but its request finishes at 15. The arrival at 12 waits for the
    // new pod, ready at 40, and is done at 55.
    const r = run(
      model(
        [
          gen("gen", "q", { interArrivalTime: 12, firstArrivalTime: 0, maxNumber: 2 }),
          { type: "Queue", name: "q" },
          { type: "WorkerPool", name: "p", inputs: { concurrency: 1, serviceTime: 15 }, links: { queue: "q", next: "sink" } },
          { type: "RollingUpdate", name: "r", inputs: { at: 10, readinessDelay: 30, maxUnavailableFraction: 1 }, links: { target: "p" } },
          sink("sink"),
        ],
        { duration: 100 },
      ),
    );
    expect(val(r, "sink.count")).toBe(2);
    expect(val(r, "sink.mean")).toBeCloseTo((15 + (55 - 12)) / 2, 9);
  });

  it("the update has no effect before it starts, and reports no duration until it finishes", () => {
    const early = run(model([{ type: "WorkerPool", name: "p", inputs: { concurrency: 4, serviceTime: 1 } }, { type: "RollingUpdate", name: "r", inputs: { at: 90, readinessDelay: 30, maxSurge: 1 }, links: { target: "p" } }], { duration: 100 }));
    expect(val(early, "p.AverageConcurrency")).toBe(4);
    expect(val(early, "r.RolloutSeconds")).toBeNull();
    expect(val(early, "r.PodsReplaced")).toBe(0);
  });

  it("an Autoscaler keeps working from the pool's nominal size: the update does not read as a reason to scale", () => {
    // 20/s x 0.1 s = 2 busy workers, and at a 0.5 target that is 4 workers, however many are unavailable.
    const autoscaled = (extra: Comp[]) =>
      run(
        model(
          [
            gen("gen", "q", { interArrivalTime: 0.05 }),
            { type: "Queue", name: "q" },
            { type: "WorkerPool", name: "p", inputs: { concurrency: 4, serviceTime: 0.1 }, links: { queue: "q", next: "sink" } },
            { type: "Autoscaler", name: "a", inputs: { targetUtilisation: 0.5, evaluationInterval: 15, minConcurrency: 1, maxConcurrency: 8, scaleDownStabilisation: 300 }, links: { target: "p" } },
            sink("sink"),
            ...extra,
          ],
          { duration: 200 },
        ),
      );
    const r = autoscaled([{ type: "RollingUpdate", name: "r", inputs: { at: 50, readinessDelay: 10, maxSurge: 1, maxUnavailable: 1 }, links: { target: "p" } }]);
    expect(val(r, "a.ScaleOuts")).toBe(val(autoscaled([]), "a.ScaleOuts"));
    expect(val(r, "p.Concurrency")).toBe(4);
    expect(val(r, "r.PodsReplaced")).toBe(4);
  });

  it("a validation error names target when it is not a pool", () => {
    expect(errorsOf([{ type: "RollingUpdate", name: "r", inputs: { at: 1 }, links: { target: "s" } }, sink("s")]).map((e) => e.key)).toContain("target");
    expect(errorsOf([{ type: "RollingUpdate", name: "r", links: {} }]).map((e) => e.key)).toEqual(expect.arrayContaining(["at", "target"]));
  });
});

describe("RetryPolicy: exponential backoff", () => {
  /** A blocker occupies the single worker; "gen" requests go through the RetryPolicy. */
  const retryModel = (retryInputs: object, poolService: number, requests: object = { interArrivalTime: 1, maxNumber: 1 }, duration = 50) =>
    model(
      [
        gen("blocker", "pool"),
        gen("gen", "retry", requests),
        { type: "RetryPolicy", name: "retry", inputs: retryInputs, links: { next: "pool", giveUp: "gaveUp" } },
        { type: "WorkerPool", name: "pool", inputs: { concurrency: 1, serviceTime: poolService }, links: { next: "sink", onThrottle: "retry" } },
        sink("sink"),
        sink("gaveUp"),
      ],
      { duration },
    );

  it("retries after 1 s then 2 s and succeeds once the worker frees up (hand timeline)", () => {
    // Blocker holds the worker on [0,2). Attempts at t=0 (throttled), 1 (throttled), 3 (accepted, done at 5).
    const r = run(retryModel({ maxAttempts: 4, baseDelay: 1, multiplier: 2, jitter: "none" }, 2));
    expect(val(r, "retry.NumberRequests")).toBe(1);
    expect(val(r, "retry.NumberAttempts")).toBe(3);
    expect(val(r, "retry.NumberRetries")).toBe(2);
    expect(val(r, "retry.NumberGivenUp")).toBe(0);
    expect(val(r, "retry.RetryAmplification")).toBe(3);
    expect(val(r, "sink.count")).toBe(2); // the blocker and the retried request
    // Blocker spent 2 s in the system; the retried request was created at 0 and done at 5: mean 3.5.
    expect(val(r, "sink.mean")).toBeCloseTo(3.5, 9);
  });

  it("gives up after maxAttempts: attempts at t=0,1,3,7, given up at t=7", () => {
    const r = run(retryModel({ maxAttempts: 4, baseDelay: 1, multiplier: 2, jitter: "none" }, 100));
    expect(val(r, "retry.NumberAttempts")).toBe(4);
    expect(val(r, "retry.NumberGivenUp")).toBe(1);
    expect(val(r, "gaveUp.count")).toBe(1);
    expect(val(r, "gaveUp.mean")).toBeCloseTo(7, 6);
  });

  it("maxDelay caps the backoff: delays 1,2,2 -> given up at t=5", () => {
    const r = run(retryModel({ maxAttempts: 4, baseDelay: 1, multiplier: 2, maxDelay: 2, jitter: "none" }, 100));
    expect(val(r, "gaveUp.mean")).toBeCloseTo(5, 6);
  });

  it("maxAttempts 1 never retries", () => {
    const r = run(retryModel({ maxAttempts: 1, jitter: "none" }, 100));
    expect(val(r, "retry.NumberRetries")).toBe(0);
    expect(val(r, "gaveUp.mean")).toBeCloseTo(0, 9);
  });

  describe("jitter (1000 requests, delays d = 1, 2, 4)", () => {
    const many = { interArrivalTime: 0.0001, maxNumber: 1000 };
    it("full jitter: each delay is U(0,d), so the mean total is 0.5 * 7 = 3.5", () => {
      const r = run(retryModel({ maxAttempts: 4, baseDelay: 1, multiplier: 2, jitter: "full" }, 100, many));
      expect(val(r, "gaveUp.count")).toBe(1000);
      expect(Math.abs(val(r, "gaveUp.mean")! - 3.5)).toBeLessThan(0.15);
      expect(val(r, "gaveUp.p99")!).toBeLessThanOrEqual(7);
    });
    it("equal jitter: each delay is U(d/2,d), so the mean total is 0.75 * 7 = 5.25", () => {
      const r = run(retryModel({ maxAttempts: 4, baseDelay: 1, multiplier: 2, jitter: "equal" }, 100, many));
      expect(Math.abs(val(r, "gaveUp.mean")! - 5.25)).toBeLessThan(0.15);
      expect(val(r, "gaveUp.p50")!).toBeGreaterThanOrEqual(3.5);
      expect(val(r, "gaveUp.p99")!).toBeLessThanOrEqual(7);
    });
  });
});

describe("RateLimiter: token bucket", () => {
  const limiterModel = (limiter: object, arrivals: object, duration = 200) =>
    model(
      [
        gen("gen", "limiter", arrivals),
        { type: "RateLimiter", name: "limiter", inputs: limiter, links: { next: "sink", onReject: "rejects" } },
        sink("sink"),
        sink("rejects"),
      ],
      { duration },
    );

  it("lets a burst through up to the bucket size, then rejects (10 arrivals in 9 ms, burst 5)", () => {
    const r = run(limiterModel({ rate: 1, burst: 5 }, { interArrivalTime: 0.001, maxNumber: 10 }));
    expect(val(r, "limiter.NumberAllowed")).toBe(5);
    expect(val(r, "limiter.NumberRejected")).toBe(5);
    expect(val(r, "limiter.RejectionFraction")).toBe(0.5);
    expect(val(r, "sink.count")).toBe(5);
    expect(val(r, "rejects.count")).toBe(5);
  });

  it("sustains exactly `rate` per second: 10/s offered, 5/s allowed, 100 s -> 500 allowed", () => {
    const r = run(limiterModel({ rate: 5, burst: 1 }, { interArrivalTime: 0.1, maxNumber: 1000 }));
    expect(val(r, "limiter.NumberAllowed")).toBe(500);
    expect(val(r, "limiter.NumberRejected")).toBe(500);
  });

  it("refills while idle but never beyond the bucket size", () => {
    // 3 arrivals at t=0 drain 3 of 3 tokens; at t=50 the bucket is full again (3), not 50.
    const r = run(
      model([
        { type: "EntityGenerator", name: "g1", inputs: { interArrivalTime: 0, maxNumber: 3 }, links: { next: "limiter" } },
        { type: "EntityGenerator", name: "g2", inputs: { interArrivalTime: 0, maxNumber: 5, firstArrivalTime: 50 }, links: { next: "limiter" } },
        { type: "RateLimiter", name: "limiter", inputs: { rate: 1, burst: 3 }, links: { next: "sink", onReject: "rejects" } },
        sink("sink"),
        sink("rejects"),
      ], { duration: 100 }),
    );
    expect(val(r, "limiter.NumberAllowed")).toBe(6); // 3 at t=0, 3 at t=50
    expect(val(r, "limiter.NumberRejected")).toBe(2);
  });

  it("a rate limiter in front of a worker pool bounds the load the pool sees", () => {
    const r = run(
      model(
        [
          gen("gen", "limiter", { interArrivalTime: { dist: "exponential", mean: 0.01 } }),
          { type: "RateLimiter", name: "limiter", inputs: { rate: 20, burst: 20 }, links: { next: "pool" } },
          { type: "WorkerPool", name: "pool", inputs: { concurrency: 1000, serviceTime: 0.5 }, links: { next: "sink" } },
          sink("sink"),
        ],
        { duration: 200, warmUp: 20 },
      ),
    );
    // Offered ~100/s, allowed ~20/s; by Little's law ~10 busy workers on average.
    expect(Math.abs(val(r, "pool.AverageBusyWorkers")! - 10)).toBeLessThan(1);
  });
});

describe("Topic: fan-out", () => {
  const topic = (inputs: object, subscribers: unknown = ["a", "b"]): Comp => ({ type: "Topic", name: "topic", inputs, links: { subscribers } });

  it("delivers a copy to every subscriber, keeping the original creation time", () => {
    // 10 arrivals; subscriber b sits behind a 2 s constant service, so its time in system is exactly 2.
    const r = run(
      model([
        gen("gen", "topic", { interArrivalTime: 1, maxNumber: 10 }),
        topic({}, ["a", "pool"]),
        sink("a"),
        { type: "WorkerPool", name: "pool", inputs: { concurrency: 100, serviceTime: 2 }, links: { next: "b" } },
        sink("b"),
      ]),
    );
    expect(val(r, "topic.NumberPublished")).toBe(10);
    expect(val(r, "topic.NumberDelivered")).toBe(20);
    expect(val(r, "a.count")).toBe(10);
    expect(val(r, "a.mean")).toBe(0);
    expect(val(r, "b.count")).toBe(10);
    expect(val(r, "b.mean")).toBeCloseTo(2, 9);
  });

  it("filters each subscription with its own probability (binomial: 20000 x 0.3)", () => {
    const r = run(model([gen("gen", "topic", { interArrivalTime: 0.001, maxNumber: 20_000 }), topic({ filterProbabilities: [1, 0.3] }), sink("a"), sink("b")]));
    expect(val(r, "a.count")).toBe(20_000);
    // sd = sqrt(20000 * 0.3 * 0.7) ~ 65; allow 4 sd
    expect(Math.abs(val(r, "b.count")! - 6000)).toBeLessThan(260);
    expect(val(r, "topic.NumberFiltered")! + val(r, "b.count")!).toBe(20_000);
  });

  it("validates the subscriber list and one filter probability per subscriber", () => {
    const keysOf = (c: Comp) => errorsOf([c, sink("a"), sink("b")]).map((e) => `${e.key}: ${e.message}`);
    expect(keysOf(topic({ filterProbabilities: [0.5] }))[0]).toContain("filterProbabilities: must have one entry per subscribers target (2), got 1");
    expect(keysOf(topic({ filterProbabilities: [0.5, 2] }))[0]).toContain("entry 1 must be <= 1");
    expect(keysOf(topic({}, "a"))[0]).toContain("non-empty list");
    expect(keysOf(topic({}, []))[0]).toContain("non-empty list");
    expect(keysOf(topic({}, ["a", "a"]))[0]).toContain("same component twice");
    expect(keysOf(topic({}, ["a", "nope"]))[0]).toContain('no component named "nope"');
    expect(keysOf({ type: "Topic", name: "topic" })[0]).toContain("required link");
  });
});

describe("Branch: probabilistic routing", () => {
  const branch = (probabilities: unknown, targets: unknown = ["a", "b"]): Comp => ({ type: "Branch", name: "branch", inputs: { probabilities }, links: { targets } });

  it("routes each entity to exactly one target (binomial: 20000 x 0.3)", () => {
    const r = run(model([gen("gen", "branch", { interArrivalTime: 0.001, maxNumber: 20_000 }), branch([0.3, 0.7]), sink("a"), sink("b")]));
    expect(val(r, "branch.NumberRouted")).toBe(20_000);
    expect(val(r, "a.count")! + val(r, "b.count")!).toBe(20_000);
    // sd = sqrt(20000 * 0.3 * 0.7) ~ 65; allow 4 sd
    expect(Math.abs(val(r, "a.count")! - 6000)).toBeLessThan(260);
  });

  it("moves the entity instead of copying it, so latency downstream is end to end", () => {
    const r = run(
      model([
        gen("gen", "pool", { interArrivalTime: 1, maxNumber: 10 }),
        { type: "WorkerPool", name: "pool", inputs: { concurrency: 100, serviceTime: 2 }, links: { next: "branch" } },
        branch([0, 1]),
        sink("a"),
        sink("b"),
      ]),
    );
    expect(val(r, "a.count")).toBe(0);
    expect(val(r, "b.count")).toBe(10);
    expect(val(r, "b.mean")).toBeCloseTo(2, 9);
  });

  it("validates one probability per target, adding up to 1", () => {
    const keysOf = (c: Comp) => errorsOf([c, sink("a"), sink("b")]).map((e) => `${e.key}: ${e.message}`);
    expect(keysOf(branch([0.6, 0.3]))[0]).toContain("probabilities: entries must add up to 1, got 0.9");
    expect(keysOf(branch([1]))[0]).toContain("must have one entry per targets target (2), got 1");
    expect(keysOf(branch([1.5, -0.5]))[0]).toContain("entry 0 must be <= 1");
    expect(keysOf({ type: "Branch", name: "branch", links: { targets: ["a"] } })[0]).toContain("probabilities: required input is missing");
    expect(errorsOf([branch([0.1, 0.2, 0.7], ["a", "b", "a2"]), sink("a"), sink("b"), sink("a2")])).toEqual([]);
  });
});

describe("cloud components: composition, determinism and validation", () => {
  const stormy = model(
    [
      gen("gen", "retry", { mode: "rateProfile", rateProfile: [[0, 30]] }),
      { type: "RetryPolicy", name: "retry", inputs: { maxAttempts: 5, baseDelay: 0.2 }, links: { next: "pool", giveUp: "lost" } },
      {
        type: "WorkerPool",
        name: "pool",
        inputs: { concurrency: 5, serviceTime: { dist: "exponential", mean: 0.2 }, failureProbability: 0.1 },
        links: { next: "sink", onThrottle: "retry", onFailure: "retry" },
      },
      sink("sink"),
      sink("lost"),
    ],
    { duration: 100, replications: 3, seed: 5 },
  );

  it("is deterministic for a fixed seed", () => {
    expect(run(stormy).replications).toEqual(run(stormy).replications);
  });

  it("conserves requests: every fresh request either succeeds or is given up (or is still in flight)", () => {
    const r = run(stormy, { replications: 1 });
    const requests = val(r, "retry.NumberRequests")!;
    const done = val(r, "sink.count")! + val(r, "lost.count")!;
    expect(done).toBeLessThanOrEqual(requests);
    expect(requests - done).toBeLessThan(0.05 * requests); // only a few still retrying at the end
    expect(val(r, "retry.RetryAmplification")!).toBeGreaterThan(1);
  });

  it("WorkerPool requires concurrency and serviceTime", () => {
    const errs = errorsOf([{ type: "WorkerPool", name: "pool" }]);
    expect(errs.map((e) => e.key).sort()).toEqual(["concurrency", "serviceTime"]);
  });

  it("MessageQueue rejects a zero visibility timeout and RetryPolicy requires next", () => {
    expect(errorsOf([{ type: "MessageQueue", name: "mq", inputs: { visibilityTimeout: 0 } }])[0]?.key).toBe("visibilityTimeout");
    expect(errorsOf([{ type: "RetryPolicy", name: "r" }]).map((e) => e.key)).toContain("next");
  });

  it("link roles are enforced: WorkerPool.queue needs a pullable, Server.queue still needs a Queue", () => {
    const poolOnSink = errorsOf([{ type: "WorkerPool", name: "p", inputs: { concurrency: 1, serviceTime: 1 }, links: { queue: "s" } }, sink("s")]);
    expect(poolOnSink[0]?.message).toContain("pullable");
    const serverOnMq = errorsOf([
      { type: "Server", name: "srv", inputs: { serviceTime: 1 }, links: { queue: "mq" } },
      { type: "MessageQueue", name: "mq" },
    ]);
    expect(serverOnMq[0]?.message).toContain("queue");
  });

  it("a WorkerPool can pull from a plain Queue too", () => {
    const r = run(
      model([
        gen("gen", "q", { interArrivalTime: 1, maxNumber: 4 }),
        { type: "Queue", name: "q" },
        { type: "WorkerPool", name: "pool", inputs: { concurrency: 1, serviceTime: 3 }, links: { queue: "q", next: "sink" } },
        sink("sink"),
      ]),
    );
    expect(val(r, "sink.count")).toBe(4); // arrivals 0..3, serial service of 3 s each finishes by t=12 < 20
    expect(val(r, "pool.NumberSucceeded")).toBe(4);
  });
});

describe("CostTotal: one output for a whole budget", () => {
  const costed = (settings?: object) =>
    model(
      [
        gen("gen", "mq", { interArrivalTime: 1, maxNumber: 10 }),
        { type: "MessageQueue", name: "mq", inputs: { costPerMillionRequests: 1_000_000 } },
        { type: "WorkerPool", name: "pool", inputs: { concurrency: 1, serviceTime: 2, costPerRequest: 100, costPerBusySecond: 10 }, links: { queue: "mq", next: "sink" } },
        sink("sink"),
        { type: "CostTotal", name: "total", links: { sources: ["mq", "pool"] } },
      ],
      settings,
    );

  it("adds up its sources' Cost (hand total)", () => {
    // 10 messages, one worker, 2 s each: the last finishes at t=20 (duration 40).
    // pool: 10 x 100 + 20 busy s x 10 = 1200; mq: 10 sends + 10 receives + 10 deletes at 1 each = 30.
    const r = run(costed({ duration: 40 }));
    expect(val(r, "pool.Cost")).toBeCloseTo(1200, 6);
    expect(val(r, "mq.Cost")).toBeCloseTo(30, 6);
    expect(val(r, "total.Cost")).toBeCloseTo(1230, 6);
  });

  it("follows the warm-up window of its sources", () => {
    const r = run(costed({ duration: 40, warmUp: 9 }));
    expect(val(r, "total.Cost")).toBeLessThan(1230);
    expect(val(r, "total.Cost")).toBeCloseTo(val(r, "pool.Cost")! + val(r, "mq.Cost")!, 6);
  });

  it("only links to components with a Cost", () => {
    const errors = errorsOf([sink("s"), { type: "CostTotal", name: "total", links: { sources: ["s"] } }]);
    expect(errors).toEqual([expect.objectContaining({ component: "total", key: "sources" })]);
  });
});
