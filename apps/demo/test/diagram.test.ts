import { loadModel } from "@surgesim/engine";
import { describe, expect, it } from "vitest";
import { SCHEMAS, addComponent, canLink, layout, removeComponent, renameComponent, setLink, type Model } from "../src/diagram.js";

const base = (): Model => ({ version: 1, settings: { duration: 60 }, components: [] }) as Model;

describe("diagram model edits", () => {
  it("a model built only by adding and linking components validates", () => {
    const m = base();
    const gen = addComponent(m, "EntityGenerator");
    const q = addComponent(m, "Queue");
    const srv = addComponent(m, "Server");
    const sink = addComponent(m, "EntitySink");
    setLink(m, gen, "next", q);
    setLink(m, srv, "queue", q);
    setLink(m, srv, "next", sink);
    expect(loadModel(m).ok).toBe(true);
    expect(layout(m)).toEqual(new Map([[gen, [0, 0]], [q, [1, 0]], [srv, [2, 0]], [sink, [3, 0]]]));
  });

  it("every component type gets starter inputs that validate", () => {
    const m = base();
    addComponent(m, "WorkerPool");
    addComponent(m, "WorkerPool");
    const scaler = addComponent(m, "Autoscaler");
    setLink(m, scaler, "target", "workers");
    for (const t of ["EntityGenerator", "Queue", "Server", "EntitySink", "MessageQueue", "RetryPolicy", "RateLimiter"]) addComponent(m, t);
    const r = loadModel(m);
    // Unlinked components may fail validation (e.g. Server needs a queue), but never because of an input.
    const inputKeys = new Set(SCHEMAS.flatMap((s) => s.inputs.map((i) => i.key)));
    expect(r.ok ? [] : r.errors.filter((e) => e.key === null || inputKeys.has(e.key))).toEqual([]);
    expect(m.components!.map((c) => c.name).slice(0, 2)).toEqual(["workers", "workers2"]);
  });

  it("canLink follows the schema roles", () => {
    expect(canLink("Server", "queue", "Queue")).toBe(true);
    expect(canLink("Server", "queue", "MessageQueue")).toBe(false); // Server needs role "queue", MessageQueue is only "pullable"
    expect(canLink("WorkerPool", "queue", "MessageQueue")).toBe(true);
    expect(canLink("Autoscaler", "target", "WorkerPool")).toBe(true);
    expect(canLink("Autoscaler", "target", "Server")).toBe(false);
    expect(canLink("EntityGenerator", "next", "EntityGenerator")).toBe(false);
  });

  it("a topic's subscribers link is a list: linking adds or toggles, rename and remove edit the list", () => {
    const m = base();
    const t = addComponent(m, "Topic");
    const a = addComponent(m, "EntitySink");
    const b = addComponent(m, "EntitySink");
    setLink(m, t, "subscribers", a);
    setLink(m, t, "subscribers", b);
    const topic = m.components!.find((c) => c.name === t)!;
    expect(topic.links).toEqual({ subscribers: [a, b] });
    renameComponent(m, a, "audit");
    expect(topic.links).toEqual({ subscribers: ["audit", b] });
    setLink(m, t, "subscribers", b); // linking an existing subscriber again removes it
    expect(topic.links).toEqual({ subscribers: ["audit"] });
    removeComponent(m, "audit");
    expect(topic.links).toEqual({});
  });

  it("rename and remove keep links, time series and assertions consistent", () => {
    const m = base();
    const q = addComponent(m, "Queue");
    const s = addComponent(m, "Server");
    setLink(m, s, "queue", q);
    m.settings = { timeSeries: { outputs: [`${q}.QueueLength`] } };
    m.assertions = [{ output: `${q}.AverageQueueLength` }];
    renameComponent(m, q, "jobs");
    expect(m.components![1]!.links).toEqual({ queue: "jobs" });
    expect(m.settings.timeSeries!.outputs).toEqual(["jobs.QueueLength"]);
    expect(m.assertions[0]!.output).toBe("jobs.AverageQueueLength");
    removeComponent(m, "jobs");
    expect(m.components!.map((c) => c.name)).toEqual([s]);
    expect(m.components![0]!.links).toEqual({});
    expect(m.settings.timeSeries!.outputs).toEqual([]);
    expect(m.assertions).toEqual([]);
  });
});
