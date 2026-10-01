import { describe, expect, it } from "vitest";
import { Simulation, loadModel } from "../src/index.js";
import { load, out, queueingModel, run } from "./helpers.js";

const det = (v: number) => ({ dist: "constant", value: v });

describe("hand-calculable scenario (time-weighted averages)", () => {
  // arrivals at t=0 and t=1 (maxNumber 2), service 3s, one worker, run 10s.
  const model = {
    version: 1,
    settings: { duration: 10 },
    components: [
      { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: 1, maxNumber: 2 }, links: { next: "q" } },
      { type: "Queue", name: "q" },
      { type: "Server", name: "srv", inputs: { serviceTime: 3 }, links: { queue: "q", next: "sink" } },
      { type: "EntitySink", name: "sink" },
    ],
  };
  const r = run(model);
  it("queue length, wait, utilisation and time in system match hand calculation", () => {
    expect(out(r, "gen.NumberGenerated").mean).toBe(2);
    // length is 1 on [1,3) only: area 2 over 10s
    expect(out(r, "q.AverageQueueLength").mean).toBeCloseTo(0.2, 9);
    expect(out(r, "q.MaxQueueLength").mean).toBe(1);
    expect(out(r, "q.AverageQueueTime").mean).toBeCloseTo(1, 9); // waits 0 and 2
    expect(out(r, "srv.Utilisation").mean).toBeCloseTo(0.6, 9); // busy [0,6)
    expect(out(r, "sink.mean").mean).toBeCloseTo(4, 9); // 3 and 5
    expect(out(r, "sink.count").mean).toBe(2);
  });
});

describe("Queue maxLength", () => {
  // arrivals every 1s from t=0, service 10s, 1 worker, maxLength 3, stop at 9.5
  const m = queueingModel({ lambda: 1, service: det(10), duration: 9.5, maxLength: 3 });
  m.components[0] = { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: 1 } as never, links: { next: "queue" } };
  const r = run(m);
  it("drops only when full and counts them", () => {
    // arrivals t=0..9 (10): t=0 straight to the worker, t=1,2,3 fill the queue, t=4..9 (6) dropped
    expect(out(r, "gen.NumberGenerated").mean).toBe(10);
    expect(out(r, "queue.NumberDropped").mean).toBe(6);
    expect(out(r, "queue.QueueLength").mean).toBe(3);
    expect(out(r, "queue.MaxQueueLength").mean).toBe(3);
  });
  it("never drops when capacity is ample", () => {
    const big = queueingModel({ lambda: 1, service: det(10), duration: 9.5, maxLength: 100 });
    big.components[0] = m.components[0]!;
    expect(out(run(big), "queue.NumberDropped").mean).toBe(0);
  });
});

describe("EntityGenerator", () => {
  const gen = (inputs: object, duration = 1000) => ({
    version: 1,
    settings: { duration },
    components: [
      { type: "EntityGenerator", name: "gen", inputs, links: { next: "sink" } },
      { type: "EntitySink", name: "sink" },
    ],
  });

  it("interval mode honours firstArrivalTime and maxNumber", () => {
    const r = run(gen({ interArrivalTime: 2, firstArrivalTime: 5, maxNumber: 7 }));
    expect(out(r, "sink.count").mean).toBe(7);
    expect(run(gen({ interArrivalTime: 2, firstArrivalTime: 5 }, 10)).outputs.find((o) => o.id === "sink.count")!.mean).toBe(3); // 5,7,9
  });

  it("rateProfile arrival counts per segment match rate x length across replications", () => {
    const profile = [[0, 10], [100, 50], [200, 0], [300, 20]];
    const model = load(gen({ mode: "rateProfile", rateProfile: profile }, 400));
    const bounds = [100, 200, 300, 400];
    const expected = [1000, 5000, 0, 2000];
    const R = 30;
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < R; i++) {
      const sim = new Simulation(model, 1000 + i);
      let prev = 0;
      bounds.forEach((b, s) => {
        sim.kernel.runUntil(sim.kernel.secondsToTicks(b));
        const total = sim.readOutput("gen.NumberGenerated");
        counts[s]! += total - prev;
        prev = total;
      });
    }
    counts.forEach((total, s) => {
      const mean = total / R;
      const sd = Math.sqrt(expected[s]! / R); // Poisson: var = mean
      expect(Math.abs(mean - expected[s]!), `segment ${s}`).toBeLessThanOrEqual(4 * sd + 1e-9);
    });
    expect(counts[2]).toBe(0);
  });

  it("rateProfile produces nothing before the first segment starts", () => {
    const r = run(gen({ mode: "rateProfile", rateProfile: [[50, 100]] }, 50));
    expect(out(r, "sink.count").mean).toBe(0);
  });
});

describe("warm-up and time series", () => {
  const model = {
    version: 1,
    settings: { duration: 100, warmUp: 50, timeSeries: { interval: 10, outputs: ["q.QueueLength"] } },
    components: [
      { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: 1 }, links: { next: "q" } },
      { type: "Queue", name: "q" },
      { type: "Server", name: "srv", inputs: { serviceTime: 2 }, links: { queue: "q", next: "sink" } },
      { type: "EntitySink", name: "sink" },
    ],
  };
  const r = run(model);
  it("resets statistics at warmUp", () => {
    // generator count restarts at t=50: arrivals at 50..100 inclusive
    expect(out(r, "gen.NumberGenerated").mean).toBe(51);
  });
  it("samples series every interval, from t=0 to the end, with backlog growth", () => {
    const ts = r.timeSeries!.replications[0]!;
    expect(ts.times).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    const q = ts.values["q.QueueLength"]!;
    expect(q).toHaveLength(11);
    expect(q[10]!).toBeGreaterThan(q[1]!); // arrivals 1/s vs service 0.5/s: backlog grows
  });
});

describe("determinism and stream isolation", () => {
  const chains = (stream1?: string) => ({
    version: 1,
    settings: { duration: 500, replications: 3, seed: 7 },
    components: [
      { type: "EntityGenerator", name: "g1", ...(stream1 ? { stream: stream1 } : {}), inputs: { interArrivalTime: { dist: "exponential", mean: 1 } }, links: { next: "q1" } },
      { type: "Queue", name: "q1" },
      { type: "Server", name: "s1", inputs: { serviceTime: { dist: "lognormal", mean: 0.7, stdDev: 0.3 } }, links: { queue: "q1", next: "k1" } },
      { type: "EntitySink", name: "k1" },
      { type: "EntityGenerator", name: "g2", inputs: { interArrivalTime: { dist: "exponential", mean: 1 } }, links: { next: "q2" } },
      { type: "Queue", name: "q2" },
      { type: "Server", name: "s2", inputs: { serviceTime: { dist: "lognormal", mean: 0.7, stdDev: 0.3 } }, links: { queue: "q2", next: "k2" } },
      { type: "EntitySink", name: "k2" },
    ],
  });
  const byComponent = (res: ReturnType<typeof run>, comps: string[]) =>
    res.replications.map((rep) => Object.fromEntries(Object.entries(rep.outputs).filter(([id]) => comps.includes(id.split(".")[0]!))));

  it("same model and seed give bit-identical results", () => {
    const a = JSON.stringify(run(chains()));
    const b = JSON.stringify(run(chains()));
    expect(a).toBe(b);
  });

  it("different seeds give different results", () => {
    expect(JSON.stringify(run(chains()))).not.toBe(JSON.stringify(run(chains(), { seed: 8 })));
  });

  it("changing one component's stream leaves the other chain's samples unchanged", () => {
    const base = run(chains());
    const changed = run(chains("another-stream"));
    expect(byComponent(changed, ["g2", "q2", "s2", "k2"])).toEqual(byComponent(base, ["g2", "q2", "s2", "k2"]));
    expect(byComponent(changed, ["g1", "k1"])).not.toEqual(byComponent(base, ["g1", "k1"]));
  });

  it("adding an unrelated component does not shift existing components' numbers", () => {
    const base = chains();
    const extended = chains();
    extended.components.push({ type: "EntityGenerator", name: "g3", inputs: { interArrivalTime: { dist: "exponential", mean: 3 } }, links: { next: "k1" } } as never);
    // g3 feeds k1, so only compare the untouched chain 2
    expect(byComponent(run(extended), ["g2", "k2"])).toEqual(byComponent(run(base), ["g2", "k2"]));
  });
});

describe("loadModel validation", () => {
  it("returns all errors at once as structured data", () => {
    const r = loadModel({
      version: 2,
      settings: { duration: -1, replications: 0 },
      components: [
        { type: "Queue", name: "q", inputs: { maxLength: 0 } },
        { type: "Server", name: "s", inputs: {}, links: { queue: "nope" } },
        { type: "Server", name: "s", inputs: { serviceTime: 1 }, links: { queue: "q", next: "q2" } },
        { type: "Mystery", name: "m" },
        { type: "EntityGenerator", name: "g", inputs: { mode: "rateProfile" }, links: { next: "s" } },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const where = r.errors.map((e) => `${e.component ?? "-"}:${e.key ?? "-"}`);
    for (const expected of [
      "-:version",
      "-:settings.duration",
      "-:settings.replications",
      "q:maxLength",
      "s:serviceTime",
      "s:queue",
      "s:name",
      "m:type",
      "g:rateProfile",
      "g:next",
    ]) {
      expect(where, expected).toContain(expected);
    }
    expect(r.errors.every((e) => typeof e.message === "string" && e.message.length > 0)).toBe(true);
  });

  it("rejects bad link targets by role and unknown time series outputs", () => {
    const r = loadModel({
      version: 1,
      settings: { duration: 10, timeSeries: { interval: 1, outputs: ["q.Nope"] } },
      components: [
        { type: "Queue", name: "q" },
        { type: "Server", name: "s", inputs: { serviceTime: 1 }, links: { queue: "s" } },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.key)).toEqual(expect.arrayContaining(["queue", "settings.timeSeries.outputs"]));
  });

  it("accepts a non-object", () => {
    expect(loadModel(42).ok).toBe(false);
    expect(loadModel(null).ok).toBe(false);
  });
});
