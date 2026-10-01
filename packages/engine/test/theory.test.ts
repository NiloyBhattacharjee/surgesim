import { describe, expect, it } from "vitest";
import { out, queueingModel, run } from "./helpers.js";

function expectCiContains(r: ReturnType<typeof run>, id: string, theory: number) {
  const o = out(r, id);
  expect(o.ci95, `${id} CI`).not.toBeNull();
  const { low, high } = o.ci95!;
  expect(low, `${id}: CI [${low}, ${high}] vs theory ${theory}`).toBeLessThanOrEqual(theory);
  expect(high, `${id}: CI [${low}, ${high}] vs theory ${theory}`).toBeGreaterThanOrEqual(theory);
}

describe("M/M/1 validation (lambda=0.8, mu=1)", () => {
  const r = run(
    queueingModel({ lambda: 0.8, service: { dist: "exponential", mean: 1 }, duration: 60_000, warmUp: 5_000, replications: 20, seed: 2024 }),
  );

  it("95% CIs contain the theoretical utilisation, Lq, Wq and W", () => {
    expectCiContains(r, "server.Utilisation", 0.8);
    expectCiContains(r, "queue.AverageQueueLength", 3.2);
    expectCiContains(r, "queue.AverageQueueTime", 4.0);
    expectCiContains(r, "sink.mean", 5.0);
  });

  it("time in system is exponential with rate 0.2 (p50, p95, p99)", () => {
    expect(out(r, "sink.p50").mean!).toBeCloseTo(3.466, 0); // within 0.5
    expect(Math.abs(out(r, "sink.p50").mean! - 3.466) / 3.466).toBeLessThan(0.03);
    expect(Math.abs(out(r, "sink.p95").mean! - 14.979) / 14.979).toBeLessThan(0.04);
    expect(Math.abs(out(r, "sink.p99").mean! - 23.026) / 23.026).toBeLessThan(0.06);
  });
});

describe("M/M/c validation (lambda=4, mu=1, c=5)", () => {
  const r = run(
    queueingModel({ lambda: 4, service: { dist: "exponential", mean: 1 }, capacity: 5, duration: 20_000, warmUp: 2_000, replications: 20, seed: 99 }),
  );

  it("95% CIs contain utilisation 0.8, Lq 2.2165, Wq 0.5541, W 1.5541", () => {
    expectCiContains(r, "server.Utilisation", 0.8);
    expectCiContains(r, "queue.AverageQueueLength", 2.2165);
    expectCiContains(r, "queue.AverageQueueTime", 0.5541);
    expectCiContains(r, "sink.mean", 1.5541);
  });
});
