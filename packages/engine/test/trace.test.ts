import { describe, expect, it } from "vitest";
import { loadModel, runModel, type TraceEvent } from "../src/index.js";

const load = (components: object[], settings: object = { duration: 20 }) => {
  const r = loadModel({ version: 1, settings, components });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.model;
};
const traced = (model: ReturnType<typeof load>, options: object = {}) => {
  const events: TraceEvent[] = [];
  const results = runModel(model, { ...options, trace: (e) => events.push(e) });
  return { events, results };
};

describe("RunOptions.trace: following entities through the model", () => {
  it("reports every component each entity enters, in order (hand timeline)", () => {
    // Arrivals at t=0 and t=1, one server taking 3 s: entity 0 is served 0-3, entity 1 waits until 3 and is served 3-6.
    const model = load([
      { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: 1, maxNumber: 2 }, links: { next: "q" } },
      { type: "Queue", name: "q" },
      { type: "Server", name: "server", inputs: { serviceTime: 3 }, links: { queue: "q", next: "done" } },
      { type: "EntitySink", name: "done" },
    ]);
    const { events } = traced(model, { replications: 1 });
    expect(events.map(({ entity, component, time }) => [entity, component, time])).toEqual([
      [0, "gen", 0], [0, "q", 0], [0, "server", 0],
      [1, "gen", 1], [1, "q", 1],
      [0, "done", 3], [1, "server", 3],
      [1, "done", 6],
    ]);
    expect(events.every((e) => e.replication === 0 && e.createdAt === e.entity)).toBe(true);
  });

  const pipeline = load(
    [
      { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: { dist: "exponential", mean: 0.5 } }, links: { next: "q" } },
      { type: "Queue", name: "q" },
      { type: "WorkerPool", name: "pool", inputs: { concurrency: 2, serviceTime: { dist: "exponential", mean: 0.8 } }, links: { queue: "q", next: "split" } },
      { type: "Branch", name: "split", inputs: { probabilities: [0.3, 0.7] }, links: { targets: ["a", "b"] } },
      { type: "EntitySink", name: "a" },
      { type: "EntitySink", name: "b" },
    ],
    { duration: 300, warmUp: 0, replications: 2 },
  );

  it("does not change any result", () => {
    const plain = runModel(pipeline);
    const { results } = traced(pipeline);
    expect(results.outputs).toEqual(plain.outputs);
  });

  it("each sink's trace count is its count, in every replication", () => {
    const { events, results } = traced(pipeline);
    for (const rep of [0, 1]) {
      for (const sink of ["a", "b"]) {
        const n = events.filter((e) => e.replication === rep && e.component === sink).length;
        expect(n).toBe(results.replications[rep]!.outputs[`${sink}.count`]);
      }
    }
    // Times never go backwards within a replication.
    const rep0 = events.filter((e) => e.replication === 0).map((e) => e.time);
    expect(rep0.every((t, i) => i === 0 || t >= rep0[i - 1]!)).toBe(true);
  });

  it("shows retries: an entity that always fails enters the RetryPolicy once per attempt, plus once to give up", () => {
    const model = load([
      { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: 1, maxNumber: 1 }, links: { next: "retry" } },
      { type: "RetryPolicy", name: "retry", inputs: { maxAttempts: 3, baseDelay: 0.1, jitter: "none" }, links: { next: "pool", giveUp: "lost" } },
      { type: "WorkerPool", name: "pool", inputs: { concurrency: 1, serviceTime: 1, failureProbability: 1 }, links: { onFailure: "retry" } },
      { type: "EntitySink", name: "lost" },
    ]);
    const path = traced(model, { replications: 1 }).events.map((e) => e.component);
    expect(path).toEqual(["gen", "retry", "pool", "retry", "pool", "retry", "pool", "retry", "lost"]);
  });

  it("a Topic's copies get new ids but keep the original's creation time", () => {
    const model = load([
      { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: 1, firstArrivalTime: 2, maxNumber: 1 }, links: { next: "topic" } },
      { type: "Topic", name: "topic", links: { subscribers: ["x", "y"] } },
      { type: "EntitySink", name: "x" },
      { type: "EntitySink", name: "y" },
    ]);
    const atSinks = traced(model, { replications: 1 }).events.filter((e) => e.component === "x" || e.component === "y");
    expect(atSinks.map((e) => e.entity)).toEqual([1, 2]);
    expect(atSinks.every((e) => e.createdAt === 2 && e.time === 2)).toBe(true);
  });
});
