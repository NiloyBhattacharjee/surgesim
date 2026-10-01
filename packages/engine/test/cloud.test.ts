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

  const errorsOf = (components: Comp[]) => {
    const res = loadModel(model(components));
    return res.ok ? [] : res.errors;
  };

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
