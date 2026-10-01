import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultRegistry, loadModel, runModel } from "@chronon-sim/engine";
import { Model, dist, poissonArrivals, time } from "../src/index.js";

/**
 * Cross-language tests: the Python SDK and the TypeScript SDK both compile to the same JSON contract, and
 * the engine accepts what Python produces. Skipped (not failed) on machines without Python.
 */
const pythonDir = fileURLToPath(new URL("../../../sdks/python/", import.meta.url));

function findPython(): string | null {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["--version"], { timeout: 10_000, windowsHide: true, encoding: "utf8" });
    if (r.status === 0) return cmd;
  }
  return null;
}
const python = findPython();

function runPython(script: string): string {
  const r = spawnSync(python as string, [script], { cwd: pythonDir, timeout: 30_000, windowsHide: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`python ${script} failed:\n${r.stderr}`);
  return r.stdout;
}

describe.skipIf(python === null)("Python SDK (cross-language)", () => {
  it("its declared input, link and output keys match the engine's schemas exactly", () => {
    const specs = JSON.parse(runPython("tools/dump_specs.py")) as Record<string, { inputs: string[]; links: string[]; outputs: string[] }>;
    const schemas = createDefaultRegistry().schemas();
    expect(Object.keys(specs).sort()).toEqual(schemas.map((s) => s.type).sort());
    for (const schema of schemas) {
      const spec = specs[schema.type]!;
      expect([...spec.inputs].sort(), `${schema.type} inputs`).toEqual(schema.inputs.map((i) => i.key).sort());
      expect([...spec.links].sort(), `${schema.type} links`).toEqual(schema.links.map((l) => l.key).sort());
      expect([...spec.outputs].sort(), `${schema.type} outputs`).toEqual(schema.outputs.map((o) => o.key).sort());
    }
  });

  const fromPython = () => JSON.parse(runPython("tools/emit_orders_model.py"));

  it("a model built in Python is accepted by the engine and runs", () => {
    const loaded = loadModel(fromPython());
    expect(loaded.ok ? [] : loaded.errors).toEqual([]);
    if (!loaded.ok) return;
    const results = runModel(loaded.model);
    expect(results.assertions).toHaveLength(2);
    expect(results.timeSeries?.outputs).toEqual(["orders.Backlog", "pool.Concurrency"]);
    expect(results.outputs.find((o) => o.id === "ok.count")!.mean).toBeGreaterThan(1000);
  });

  it("the same model built with the TypeScript SDK is identical, JSON for JSON", () => {
    const m = new Model("orders (python)", { duration: 300, warmUp: 30, replications: 3, seed: 9, description: "Built with the Python SDK" });
    const ok = m.entitySink("ok");
    const failed = m.entitySink("failed");
    const dlq = m.entitySink("dlq");
    const orders = m.messageQueue("orders", { visibilityTimeout: 20, maxReceiveCount: 3, deadLetter: dlq });
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
    retry.link("next", orders);
    m.autoscaler("scaler", { maxConcurrency: 80, targetUtilisation: 0.6, target: pool });
    m.entityGenerator("traffic", { interArrivalTime: poissonArrivals(30), next: limiter });
    m.assert(ok.output("p99"), "<=", 60, { name: "p99" });
    m.assert(pool.output("NumberThrottled"), "==", 0, { statistic: "max" });
    m.sampleEvery(10, [orders.output("Backlog"), pool.output("Concurrency")]);

    expect(fromPython()).toEqual(JSON.parse(JSON.stringify(m.toJSON())));
  });

  it("runs identically whichever SDK built it (the engine only sees the JSON)", () => {
    const loaded = loadModel(fromPython());
    if (!loaded.ok) throw new Error("invalid");
    const a = runModel(loaded.model);
    const b = runModel(loaded.model);
    expect(a.replications).toEqual(b.replications);
  });
});
