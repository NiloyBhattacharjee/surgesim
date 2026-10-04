import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Model, dist } from "@surgesim/sdk";
import type { FileStore, Logger } from "@surgesim/platform";
import { EXIT_ASSERTION_FAILED, EXIT_INVALID_MODEL, EXIT_OK, EXIT_USAGE, parseAssertion, runCli } from "../src/main.js";

const examplesDir = fileURLToPath(new URL("../../../examples/", import.meta.url));

class MemoryFiles implements FileStore {
  files = new Map<string, string>();
  async readText(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error("ENOENT: " + path);
    return v;
  }
  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

function harness(initial: Record<string, string> = {}, importModule?: (path: string) => Promise<unknown>) {
  const fs = new MemoryFiles();
  for (const [k, v] of Object.entries(initial)) fs.files.set(k, v);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: (m) => stdout.push(m),
    warn: (m) => stderr.push(m),
    error: (m) => stderr.push(m),
  };
  let t = 0;
  const call = (args: string[]) => runCli(args, { fs, logger, clock: { nowMs: () => (t += 10) }, ...(importModule ? { importModule } : {}) });
  return { fs, stdout, stderr, call };
}

const exampleFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".json"));

describe("example models run end to end", () => {
  it("includes the required examples", () => {
    expect(exampleFiles).toEqual(expect.arrayContaining(["mm1.json", "mmc.json", "traffic-spike.json"]));
  });

  for (const file of exampleFiles) {
    it(`runs ${file}`, async () => {
      const h = harness({ [file]: readFileSync(join(examplesDir, file), "utf8") });
      const code = await h.call(["run", file, "--replications", "2", "--json", "out/r.json", "--timeseries", "out/ts.csv"]);
      expect(h.stderr).toEqual([]);
      expect(code).toBe(EXIT_OK);
      const report = h.stdout.join("\n");
      expect(report).toContain("Component");
      expect(report).toContain("Utilisation");
      expect(report).toContain("p99");
      const results = JSON.parse(h.fs.files.get("out/r.json")!);
      expect(results.settings.replications).toBe(2);
      expect(results.outputs.length).toBeGreaterThan(0);
      const csv = h.fs.files.get("out/ts.csv")!;
      expect(csv.split("\n")[0]).toMatch(/^replication,time_s,\S+\.\S+/);
      expect(csv.split("\n").length).toBeGreaterThan(10);
    });
  }

  it("traffic-spike shows the backlog growing during the spike and draining afterwards", async () => {
    const h = harness({ m: readFileSync(join(examplesDir, "traffic-spike.json"), "utf8") });
    expect(await h.call(["run", "m", "--replications", "1", "--json", "r"])).toBe(EXIT_OK);
    const ts = JSON.parse(h.fs.files.get("r")!).timeSeries.replications[0];
    const q: number[] = ts.values["queue.QueueLength"];
    const at = (s: number) => q[ts.times.indexOf(s)]!;
    expect(at(170)).toBeLessThan(50); // before the spike
    expect(at(300)).toBeGreaterThan(3000); // end of spike: thousands waiting
    expect(at(500)).toBeLessThan(50); // drained
  });
});

describe("error handling", () => {
  it("exits nonzero and lists all validation errors for an invalid model", async () => {
    const bad = {
      version: 1,
      settings: { duration: 10 },
      components: [
        { type: "Queue", name: "q", inputs: { maxLength: -3 } },
        { type: "Server", name: "s", inputs: {}, links: {} },
        { type: "Nope", name: "x" },
      ],
    };
    const h = harness({ "bad.json": JSON.stringify(bad) });
    const code = await h.call(["run", "bad.json"]);
    expect(code).toBe(EXIT_INVALID_MODEL);
    expect(h.stdout).toEqual([]);
    const err = h.stderr.join("\n");
    expect(err).toContain("failed validation with 4 errors");
    expect(err).toContain("[q.maxLength]");
    expect(err).toContain("[s.serviceTime]");
    expect(err).toContain("[s.queue]");
    expect(err).toContain("[x.type]");
  });

  it("reports malformed JSON, missing files and bad usage", async () => {
    const h = harness({ "broken.json": "{ nope" });
    expect(await h.call(["run", "broken.json"])).toBe(EXIT_INVALID_MODEL);
    expect(await h.call(["run", "missing.json"])).toBe(EXIT_USAGE);
    expect(await h.call([])).toBe(EXIT_USAGE);
    expect(await h.call(["run", "broken.json", "--seed", "x"])).toBe(EXIT_USAGE);
    expect(await h.call(["run", "broken.json", "--bogus"])).toBe(EXIT_USAGE);
    expect(h.stderr.join("\n")).toContain("not valid JSON");
  });

  it("prints schemas as JSON", async () => {
    const h = harness();
    expect(await h.call(["schema"])).toBe(EXIT_OK);
    const schemas = JSON.parse(h.stdout.join(""));
    expect(schemas.map((s: { type: string }) => s.type)).toEqual(
      expect.arrayContaining([
        "EntityGenerator",
        "Queue",
        "Server",
        "EntitySink",
        "MessageQueue",
        "WorkerPool",
        "RetryPolicy",
        "RateLimiter",
        "Autoscaler",
      ]),
    );
  });
});

describe("assertions", () => {
  const model = (assertions?: unknown) =>
    JSON.stringify({
      version: 1,
      settings: { duration: 100, replications: 3, seed: 2 },
      components: [
        { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: 1 }, links: { next: "pool" } },
        { type: "WorkerPool", name: "pool", inputs: { concurrency: 5, serviceTime: 1 }, links: { next: "sink" } },
        { type: "EntitySink", name: "sink" },
      ],
      ...(assertions ? { assertions } : {}),
    });

  it("exits 0 and prints PASS lines when every assertion holds", async () => {
    const h = harness({ m: model([{ output: "sink.mean", op: "<=", value: 1.5 }]) });
    expect(await h.call(["run", "m", "--assert", "pool.NumberThrottled==0", "--assert", "sink.p99@max<2"])).toBe(EXIT_OK);
    const report = h.stdout.join("\n");
    expect(report).toContain("Assertions: 3 passed, 0 failed");
    expect(report).toContain("PASS  sink.mean (mean) = 1 <= 1.5");
  });

  it("exits 3 when a model assertion fails and says which", async () => {
    const h = harness({ m: model([{ output: "sink.mean", op: "<", value: 0.5, name: "fast enough" }]) });
    expect(await h.call(["run", "m"])).toBe(EXIT_ASSERTION_FAILED);
    expect(h.stdout.join("\n")).toContain("FAIL  fast enough: sink.mean (mean) = 1 violates < 0.5");
    expect(h.stderr.join("\n")).toContain("1 assertion(s) failed");
  });

  it("exits 3 for a failing --assert flag, and still writes the results file", async () => {
    const h = harness({ m: model() });
    expect(await h.call(["run", "m", "--assert", "sink.mean>10", "--json", "out/r.json"])).toBe(EXIT_ASSERTION_FAILED);
    const results = JSON.parse(h.fs.files.get("out/r.json")!);
    expect(results.assertions[0]).toMatchObject({ passed: false, actual: 1 });
  });

  it("rejects unparseable expressions and unknown outputs as usage errors", async () => {
    const h = harness({ m: model() });
    expect(await h.call(["run", "m", "--assert", "sink.mean ~ 2"])).toBe(EXIT_USAGE);
    expect(h.stderr.join("\n")).toContain("cannot parse assertion");
    const h2 = harness({ m: model() });
    expect(await h2.call(["run", "m", "--assert", "nope.x<1"])).toBe(EXIT_USAGE);
    expect(h2.stderr.join("\n")).toContain('unknown output "nope.x"');
  });

  it("an invalid assertion in the model is a validation error (exit 1)", async () => {
    const h = harness({ m: model([{ output: "nope.x", op: "<", value: 1 }]) });
    expect(await h.call(["run", "m"])).toBe(EXIT_INVALID_MODEL);
    expect(h.stderr.join("\n")).toContain("assertions[0].output");
  });

  it("parseAssertion handles statistics, scientific notation, negatives and all operators", () => {
    expect(parseAssertion("sink.p99<=2")).toEqual({ output: "sink.p99", op: "<=", value: 2 });
    expect(parseAssertion("a.b@ci95High >= -1.5e-3")).toEqual({ output: "a.b", op: ">=", value: -0.0015, statistic: "ci95High" });
    expect(parseAssertion("a.b==3")).toEqual({ output: "a.b", op: "==", value: 3 });
    expect(parseAssertion("a.b<3")).toEqual({ output: "a.b", op: "<", value: 3 });
    expect(typeof parseAssertion("a.b@median<3")).toBe("string");
    expect(typeof parseAssertion("a.b<")).toBe("string");
  });
});

describe("model modules (.ts/.js built with the SDK)", () => {
  const sdkModel = () => {
    const m = new Model("from sdk", { duration: 100, replications: 2, seed: 1 });
    const sink = m.entitySink("sink");
    const pool = m.workerPool("pool", { concurrency: 5, serviceTime: 1, next: sink });
    m.entityGenerator("gen", { interArrivalTime: dist.constant(1), next: pool });
    m.assert(sink.output("mean"), "<=", 1.5);
    return m;
  };

  it("runs a module whose default export is an SDK Model, including its assertions", async () => {
    const h = harness({}, async () => ({ default: sdkModel() }));
    expect(await h.call(["run", "model.ts"])).toBe(EXIT_OK);
    const out = h.stdout.join("\n");
    expect(out).toContain("Model: from sdk");
    expect(out).toContain("PASS  sink.mean (mean) = 1 <= 1.5");
  });

  it("accepts a named `model` export holding a plain model object", async () => {
    const plain = sdkModel().toJSON();
    const h = harness({}, async () => ({ model: plain }));
    expect(await h.call(["run", "model.mjs"])).toBe(EXIT_OK);
  });

  it("a module with no model export is an invalid model (exit 1)", async () => {
    const h = harness({}, async () => ({ other: 1 }));
    expect(await h.call(["run", "model.js"])).toBe(EXIT_INVALID_MODEL);
    expect(h.stderr.join("\n")).toContain("default export");
  });

  it("an SDK build error is reported with its structured problems (exit 1)", async () => {
    const a = new Model("a", { duration: 1 });
    const foreign = new Model("b", { duration: 1 }).entitySink("sink");
    a.entityGenerator("gen", { interArrivalTime: 1, next: foreign });
    const h = harness({}, async () => ({ default: a }));
    expect(await h.call(["run", "bad.ts"])).toBe(EXIT_INVALID_MODEL);
    expect(h.stderr.join("\n")).toContain("[gen.next]");
  });

  it("engine validation still applies to SDK models (exit 1)", async () => {
    const m = new Model("bad", { duration: 10 });
    m.workerPool("pool", { concurrency: 0, serviceTime: 1 });
    const h = harness({}, async () => ({ default: m }));
    expect(await h.call(["run", "bad.ts"])).toBe(EXIT_INVALID_MODEL);
    expect(h.stderr.join("\n")).toContain("[pool.concurrency] must be >= 1");
  });

  it("a host that cannot import modules gives a usage error", async () => {
    const h = harness();
    expect(await h.call(["run", "model.ts"])).toBe(EXIT_USAGE);
    expect(h.stderr.join("\n")).toContain("cannot run model modules");
  });

  it("an import failure is a usage error, with a hint for .ts files on old Node", async () => {
    const h = harness({}, async () => {
      throw Object.assign(new Error('Unknown file extension ".ts"'), { code: "ERR_UNKNOWN_FILE_EXTENSION" });
    });
    expect(await h.call(["run", "model.ts"])).toBe(EXIT_USAGE);
    expect(h.stderr.join("\n")).toContain("Node 22.18+");
  });

  it("compile prints or writes the JSON model", async () => {
    const h = harness({}, async () => ({ default: sdkModel() }));
    expect(await h.call(["compile", "model.ts"])).toBe(EXIT_OK);
    expect(JSON.parse(h.stdout.join("\n"))).toEqual(sdkModel().toJSON());
    const h2 = harness({}, async () => ({ default: sdkModel() }));
    expect(await h2.call(["compile", "model.ts", "--out", "out/model.json"])).toBe(EXIT_OK);
    expect(JSON.parse(h2.fs.files.get("out/model.json")!)).toEqual(sdkModel().toJSON());
  });

  it("compile refuses an invalid model instead of emitting it", async () => {
    const m = new Model("bad", { duration: 10 });
    m.workerPool("pool", { concurrency: 0, serviceTime: 1 });
    const h = harness({}, async () => ({ default: m }));
    expect(await h.call(["compile", "bad.ts"])).toBe(EXIT_INVALID_MODEL);
  });

  it("the TypeScript example compiles to the same model as the JSON example", async () => {
    const file = fileURLToPath(new URL("../../../examples/sdk/autoscaled-service.ts", import.meta.url));
    const h = harness({}, (path) => import(/* @vite-ignore */ path));
    expect(await h.call(["compile", file])).toBe(EXIT_OK);
    const compiled = JSON.parse(h.stdout.join("\n"));
    const expected = JSON.parse(readFileSync(join(examplesDir, "autoscaled-service.json"), "utf8"));
    const byName = (cs: { name: string }[]) => Object.fromEntries(cs.map((c) => [c.name, c]));
    expect({ ...compiled, components: byName(compiled.components) }).toEqual({ ...expected, components: byName(expected.components) });
  });
});

describe("HTML reports and comparisons", () => {
  const modelJson = (workers: number, name = "report model") =>
    JSON.stringify({
      version: 1,
      name,
      settings: { duration: 200, replications: 3, seed: 4, timeSeries: { interval: 20, outputs: ["q.QueueLength", "pool.BusyWorkers"] } },
      components: [
        { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: { dist: "exponential", mean: 0.5 } }, links: { next: "q" } },
        { type: "Queue", name: "q" },
        { type: "WorkerPool", name: "pool", inputs: { concurrency: workers, serviceTime: { dist: "exponential", mean: 1 } }, links: { queue: "q", next: "sink" } },
        { type: "EntitySink", name: "sink" },
      ],
      assertions: [{ output: "sink.mean", op: "<", value: 1000 }],
    });

  it("run --html writes a self-contained report", async () => {
    const h = harness({ m: modelJson(3) });
    expect(await h.call(["run", "m", "--html", "out/report.html"])).toBe(EXIT_OK);
    const html = h.fs.files.get("out/report.html")!;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<h1>report model</h1>");
    expect(html).toContain("1 passed, 0 failed");
    expect(h.stdout.join("\n")).toContain("Wrote report to out/report.html");
  });

  it("report renders saved results (from --json) without re-running", async () => {
    const h = harness({ m: modelJson(3) });
    expect(await h.call(["run", "m", "--json", "out/r.json"])).toBe(EXIT_OK);
    const h2 = harness({ "r.json": h.fs.files.get("out/r.json")! });
    expect(await h2.call(["report", "r.json", "--html", "out/report.html", "--title", "Saved run"])).toBe(EXIT_OK);
    expect(h2.fs.files.get("out/report.html")).toContain("<h1>Saved run</h1>");
  });

  it("report without --html, with a missing file, or on an unsupported results file fails clearly", async () => {
    const h = harness({ m: modelJson(3), bad: JSON.stringify({ resultsVersion: 9, outputs: [], settings: {} }) });
    expect(await h.call(["report", "m"])).toBe(EXIT_USAGE);
    expect(h.stderr.join("\n")).toContain("needs --html");
    expect(await h.call(["report", "nope.json", "--html", "o.html"])).toBe(EXIT_USAGE);
    expect(await h.call(["report", "bad", "--html", "o.html"])).toBe(EXIT_INVALID_MODEL);
    expect(h.stderr.join("\n")).toContain("resultsVersion 1");
  });

  it("compare runs two models, summarises what differs and writes the HTML", async () => {
    const h = harness({ a: modelJson(3, "three"), b: modelJson(1, "one") });
    expect(await h.call(["compare", "a", "b", "--label-a", "3 workers", "--label-b", "1 worker", "--html", "out/cmp.html"])).toBe(EXIT_OK);
    const out = h.stdout.join("\n");
    expect(out).toContain("Compared 3 workers with 1 worker");
    expect(out).toMatch(/sink\.mean: [\d.]+ -> [\d.]+ \(\+[\d.]+%\)/);
    // The summary leads with the biggest relative change.
    const pcts = [...out.matchAll(/\(([+-][\d.e+]+)%\)/g)].map((m) => Math.abs(Number(m[1])));
    expect(pcts.length).toBeGreaterThan(1);
    expect(pcts).toEqual([...pcts].sort((x, y) => y - x));
    const html = h.fs.files.get("out/cmp.html")!;
    expect(html).toContain("<h1>3 workers vs 1 worker</h1>");
    expect(html).toContain("differs");
  });

  it("compare accepts saved results files and defaults labels to the file names", async () => {
    const run = async (model: string) => {
      const h = harness({ m: model });
      await h.call(["run", "m", "--json", "r.json"]);
      return h.fs.files.get("r.json")!;
    };
    const h = harness({ "base.json": await run(modelJson(3)), "candidate.json": await run(modelJson(1)) });
    expect(await h.call(["compare", "base.json", "candidate.json", "--html", "c.html"])).toBe(EXIT_OK);
    expect(h.fs.files.get("c.html")).toContain("<h1>base vs candidate</h1>");
  });

  it("compare disambiguates identical labels and needs exactly two inputs", async () => {
    const h = harness({ "x/m.json": modelJson(3), "y/m.json": modelJson(2) });
    expect(await h.call(["compare", "x/m.json", "y/m.json", "--html", "c.html"])).toBe(EXIT_OK);
    expect(h.fs.files.get("c.html")).toContain("m (A) vs m (B)");
    expect(await h.call(["compare", "x/m.json"])).toBe(EXIT_USAGE);
    expect(await h.call(["compare", "a", "b", "c"])).toBe(EXIT_USAGE);
  });

  it("compare --seed/--replications override the runs of model inputs", async () => {
    const h = harness({ a: modelJson(3), b: modelJson(1) });
    expect(await h.call(["compare", "a", "b", "--replications", "2", "--html", "c.html"])).toBe(EXIT_OK);
    expect(h.fs.files.get("c.html")).toContain("2 replications");
  });
});

describe("surgesim import (CloudFormation / CDK)", () => {
  const template = readFileSync(join(examplesDir, "cloudformation", "orders-stack.template.json"), "utf8");

  it("writes a model file, then summarises what it mapped and what it assumed", async () => {
    const h = harness({ "stack.json": template });
    expect(await h.call(["import", "stack.json", "--out", "out/model.json", "--rate", "5", "--service-time", "0.3"])).toBe(EXIT_OK);
    const model = JSON.parse(h.fs.files.get("out/model.json")!);
    expect(model.components.some((c: { name: string }) => c.name === "OrdersQueue")).toBe(true);
    const out = h.stdout.join("\n");
    expect(out).toContain("Imported 5 resource(s)");
    expect(out).toContain('OrdersQueue1A2B3C4D (AWS::SQS::Queue) -> MessageQueue "OrdersQueue"');
    expect(out).toContain("Not modelled (ignored): ArchiveBucket1F2A3B4C");
    expect(out).toContain("Assumptions");
    expect(out).not.toContain("Traffic:"); // --rate was given
  });

  it("without --out the model goes to stdout as pure JSON and the summary goes to stderr", async () => {
    const h = harness({ "stack.json": template });
    expect(await h.call(["import", "stack.json"])).toBe(EXIT_OK);
    expect(() => JSON.parse(h.stdout.join("\n"))).not.toThrow();
    expect(h.stderr.join("\n")).toContain("Assumptions");
    expect(h.stderr.join("\n")).toContain("Traffic: 10 requests/second");
  });

  it("the imported model runs, and --entry limits where traffic arrives", async () => {
    const h = harness({ "stack.json": template });
    await h.call(["import", "stack.json", "--out", "m.json", "--entry", "OrdersQueue", "--duration", "120", "--replications", "2"]);
    const model = JSON.parse(h.fs.files.get("m.json")!);
    expect(model.components.filter((c: { name: string }) => c.name.startsWith("traffic-"))).toHaveLength(1);
    const h2 = harness({ "m.json": h.fs.files.get("m.json")! });
    expect(await h2.call(["run", "m.json"])).toBe(EXIT_OK);
    expect(h2.stdout.join("\n")).toContain("ProcessorFn");
  });

  it("--concurrency-per-task scales ECS capacity", async () => {
    const h = harness({ "stack.json": template });
    expect(await h.call(["import", "stack.json", "--out", "m.json", "--concurrency-per-task", "4"])).toBe(EXIT_OK);
    const model = JSON.parse(h.fs.files.get("m.json")!);
    expect(model.components.find((c: { name: string }) => c.name === "ApiService").inputs.concurrency).toBe(8); // 2 tasks x 4
  });

  it("explains that YAML is unsupported, and where to find the JSON template", async () => {
    const h = harness({ "stack.yaml": "AWSTemplateFormatVersion: '2010-09-09'\nResources:\n  Q:\n    Type: AWS::SQS::Queue\n" });
    expect(await h.call(["import", "stack.yaml"])).toBe(EXIT_INVALID_MODEL);
    expect(h.stderr.join("\n")).toContain("cdk.out");
  });

  it("rejects non-templates, missing files, bad numbers and bad usage", async () => {
    const h = harness({ "x.json": "{}" });
    expect(await h.call(["import", "x.json"])).toBe(EXIT_INVALID_MODEL);
    expect(h.stderr.join("\n")).toContain("Resources");
    expect(await h.call(["import", "missing.json"])).toBe(EXIT_USAGE);
    expect(await h.call(["import", "x.json", "--rate", "-3"])).toBe(EXIT_USAGE);
    expect(await h.call(["import", "x.json", "--service-time", "abc"])).toBe(EXIT_USAGE);
    expect(await h.call(["import", "x.json", "--concurrency-per-task", "0"])).toBe(EXIT_USAGE);
    expect(await h.call(["import"])).toBe(EXIT_USAGE);
  });
});

describe("model module load errors give actionable hints", () => {
  const failing = (message: string) => async () => {
    throw new Error(message);
  };

  it("an ES module in a CommonJS project says to use .mts or set type: module (TypeScript)", async () => {
    const h = harness({}, failing("Cannot use import statement outside a module"));
    expect(await h.call(["run", "model.ts"])).toBe(EXIT_USAGE);
    expect(h.stderr.join("\n")).toContain('Rename the file to .mts, or add "type": "module"');
  });

  it("and says to use .mjs for JavaScript", async () => {
    const h = harness({}, failing("Cannot use import statement outside a module"));
    expect(await h.call(["run", "model.js"])).toBe(EXIT_USAGE);
    expect(h.stderr.join("\n")).toContain('Rename the file to .mjs, or add "type": "module"');
  });

  it("other import errors get no misleading hint", async () => {
    const h = harness({}, failing("Cannot find package 'left-pad'"));
    expect(await h.call(["run", "model.mjs"])).toBe(EXIT_USAGE);
    expect(h.stderr.join("\n")).not.toContain("Rename the file");
  });
});

describe("models that can never finish", () => {
  const stuck = JSON.stringify({
    version: 1,
    settings: { duration: 10 },
    components: [
      { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: 0 }, links: { next: "sink" } },
      { type: "EntitySink", name: "sink" },
    ],
  });

  it("run reports a readable error and exits 1 instead of crashing (this model used to spin until it ran out of memory)", async () => {
    const h = harness({ m: stuck });
    expect(await h.call(["run", "m"])).toBe(EXIT_INVALID_MODEL);
    const err = h.stderr.join("\n");
    expect(err).toContain("the simulation could not finish");
    expect(err).toContain("without the clock advancing");
    expect(err).toContain("interArrivalTime");
    expect(err).not.toMatch(/\bat \w+.*\.js:\d+/); // no stack trace
  }, 60_000);

  it("compare reports it the same way for either side", async () => {
    const ok = JSON.stringify({ version: 1, settings: { duration: 10 }, components: [{ type: "EntityGenerator", name: "g", inputs: { interArrivalTime: 1 }, links: { next: "s" } }, { type: "EntitySink", name: "s" }] });
    const h = harness({ a: ok, b: stuck });
    expect(await h.call(["compare", "a", "b"])).toBe(EXIT_INVALID_MODEL);
    expect(h.stderr.join("\n")).toContain("b: the simulation could not finish");
  }, 60_000);

  it("a generator that stops (maxNumber) with zero gaps is fine: simultaneous arrivals are legitimate", async () => {
    const burst = JSON.stringify({ version: 1, settings: { duration: 10 }, components: [{ type: "EntityGenerator", name: "g", inputs: { interArrivalTime: 0, maxNumber: 5000 }, links: { next: "s" } }, { type: "EntitySink", name: "s" }] });
    const h = harness({ m: burst });
    expect(await h.call(["run", "m"])).toBe(EXIT_OK);
  });
});

describe("calibration workflow (synthetic monitoring export with a known ground truth)", () => {
  const dir = join(examplesDir, "calibration");
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  const files = () => ({ "service.csv": read("service_times.csv"), "arrivals.csv": read("arrivals.csv"), "model.json": read("model.json"), "observed.json": read("observed.json") });

  // The ground truth behind the data (see validation/make_calibration_example.py):
  // 8 workers, lognormal service mean 0.35 s and sd 0.20 s, arrivals 8/s, then 20/s from 300 s, then 8/s from 600 s.

  it("fit recovers the service-time distribution: lognormal, mean 0.35 and sd 0.20, from milliseconds", async () => {
    const h = harness(files());
    expect(await h.call(["fit", "service.csv", "--scale", "0.001"])).toBe(EXIT_OK);
    const out = h.stdout.join("\n");
    expect(out).toContain("Read 10961 values from duration_ms, multiplied by 0.001");
    const best = /Use in a model[^\n]*\n\s*(\{[^\n]*\})/.exec(out);
    expect(best).not.toBeNull();
    const spec = JSON.parse(best![1]!) as { dist: string; mean: number; stdDev: number };
    expect(spec.dist).toBe("lognormal");
    expect(Math.abs(spec.mean / 0.35 - 1)).toBeLessThan(0.03);
    expect(Math.abs(spec.stdDev / 0.2 - 1)).toBeLessThan(0.08);
    // lognormal is listed first, ahead of every other family
    expect(out.indexOf("lognormal")).toBeLessThan(out.indexOf("normal  "));
  });

  it("fit suggests the empirical distribution for a hit/miss mixture, and a model accepts it as printed", async () => {
    // Every tenth request misses the cache (0.6-1 s); the rest hit (40-60 ms)
    const ms = Array.from({ length: 3000 }, (_, i) => (i % 10 === 0 ? 600 + (400 * (i % 89)) / 89 : 40 + (20 * (i % 97)) / 97));
    const h = harness({ "mixed.csv": `ms\n${ms.join("\n")}\n` });
    expect(await h.call(["fit", "mixed.csv", "--scale", "0.001"])).toBe(EXIT_OK);
    const out = h.stdout.join("\n");
    const spec = JSON.parse(/the measured distribution:\n\s*(\{[^\n]*\})/.exec(out)![1]!) as { dist: string; points: [number, number][] };
    expect(spec.dist).toBe("empirical");
    expect(spec.points[0]![0]).toBe(0);
    expect(spec.points.at(-1)).toEqual([1, 0.9955]); // the largest value, 995.5 ms
    expect(out).toContain("The closest family, simpler but it misstates the tail");

    const model = {
      version: 1,
      settings: { duration: 300, replications: 2, seed: 1 },
      components: [
        { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: { dist: "exponential", mean: 0.1 } }, links: { next: "q" } },
        { type: "Queue", name: "q" },
        { type: "Server", name: "s", inputs: { capacity: 4, serviceTime: spec }, links: { queue: "q", next: "sink" } },
        { type: "EntitySink", name: "sink" },
      ],
    };
    h.fs.files.set("m.json", JSON.stringify(model));
    expect(await h.call(["run", "m.json"])).toBe(EXIT_OK);
  });

  it("fit --family empirical prints the measured distribution even when a family fits", async () => {
    const h = harness(files());
    expect(await h.call(["fit", "service.csv", "--scale", "0.001", "--family", "empirical"])).toBe(EXIT_OK);
    const out = h.stdout.join("\n");
    expect(out).not.toContain("Candidate fits");
    expect(out).toMatch(/the measured distribution:\n\s*\{"dist":"empirical","points":\[\[0,/);
  });

  it("fit-arrivals recovers the spike: three segments, breakpoints near 300 s and 600 s, rates near 8, 20, 8", async () => {
    const h = harness(files());
    expect(await h.call(["fit-arrivals", "arrivals.csv", "--window", "30"])).toBe(EXIT_OK);
    const out = h.stdout.join("\n");
    const profile = JSON.parse(/"rateProfile": (\[\[.*\]\])/.exec(out)![1]!) as [number, number][];
    expect(profile).toHaveLength(3);
    expect(Math.abs(profile[1]![0] - 300)).toBeLessThan(10);
    expect(Math.abs(profile[2]![0] - 600)).toBeLessThan(10);
    expect(Math.abs(profile[0]![1] / 8 - 1)).toBeLessThan(0.05);
    expect(Math.abs(profile[1]![1] / 20 - 1)).toBeLessThan(0.05);
    expect(Math.abs(profile[2]![1] / 8 - 1)).toBeLessThan(0.05);
    expect(out).toContain("Dispersion index");
  });

  it("a model built from those fitted inputs is consistent with what the system measured (exit 0)", async () => {
    const h = harness(files());
    expect(await h.call(["calibrate", "model.json", "--observed", "observed.json"])).toBe(EXIT_OK);
    const out = h.stdout.join("\n");
    expect(out).toContain("6 match, 0 close, 0 off, 0 missing");
    expect(out).toContain("consistent with the observations");
    expect(out).toContain("cannot be detected"); // it says how small an error it could miss
  });

  it("a model with too few workers is caught (exit 3)", async () => {
    const wrong = JSON.parse(read("model.json"));
    wrong.components[2].inputs.capacity = 6;
    const h = harness({ ...files(), "wrong.json": JSON.stringify(wrong) });
    expect(await h.call(["calibrate", "wrong.json", "--observed", "observed.json"])).toBe(EXIT_ASSERTION_FAILED);
    expect(h.stdout.join("\n")).toMatch(/6 off|[4-6] off/);
    expect(h.stdout.join("\n")).toContain("not consistent with the observations");
  });

  it("a model whose service times are 30% too slow is caught (exit 3)", async () => {
    const wrong = JSON.parse(read("model.json"));
    wrong.components[2].inputs.serviceTime = { dist: "lognormal", mean: 0.455, stdDev: 0.26 };
    const h = harness({ ...files(), "wrong.json": JSON.stringify(wrong) });
    expect(await h.call(["calibrate", "wrong.json", "--observed", "observed.json"])).toBe(EXIT_ASSERTION_FAILED);
  });

  it("even a one-worker error (7 instead of 8) is caught", async () => {
    const wrong = JSON.parse(read("model.json"));
    wrong.components[2].inputs.capacity = 7;
    const h = harness({ ...files(), "wrong.json": JSON.stringify(wrong) });
    expect(await h.call(["calibrate", "wrong.json", "--observed", "observed.json"])).toBe(EXIT_ASSERTION_FAILED);
  });

  it("--sensitivity shows how far the results move when the inputs are off, and more traffic means worse results", async () => {
    const h = harness(files());
    expect(await h.call(["calibrate", "model.json", "--observed", "observed.json", "--sensitivity", "5", "--replications", "8"])).toBe(EXIT_OK);
    const out = h.stdout.join("\n");
    expect(out).toContain("Sensitivity: the arrival rate off by 5% in each direction");
    expect(out).toContain("Sensitivity: every service time off by 5% in each direction");
    const row = /^queue\.AverageQueueLength\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/m.exec(out.split("Sensitivity: the arrival rate")[1]!);
    expect(row).not.toBeNull();
    const [low, mid, high] = [Number(row![1]), Number(row![2]), Number(row![3])];
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("calibrate reports mistakes clearly", async () => {
    const h = harness(files());
    expect(await h.call(["calibrate", "model.json"])).toBe(EXIT_USAGE);
    expect(h.stderr.join("\n")).toContain("needs --observed");
    const h2 = harness({ ...files(), "bad.json": "{not json" });
    expect(await h2.call(["calibrate", "model.json", "--observed", "bad.json"])).toBe(EXIT_INVALID_MODEL);
    const h3 = harness({ ...files(), "shape.json": JSON.stringify({ nothing: 1 }) });
    expect(await h3.call(["calibrate", "model.json", "--observed", "shape.json"])).toBe(EXIT_INVALID_MODEL);
    expect(h3.stderr.join("\n")).toContain('"metrics"');
    const h4 = harness({ ...files(), "ids.json": JSON.stringify({ metrics: { "nope.x": 1, "sink.p99": 1 } }) });
    expect(await h4.call(["calibrate", "model.json", "--observed", "ids.json"])).toBe(EXIT_USAGE);
    expect(h4.stderr.join("\n")).toContain("nope.x");
    const h5 = harness({ ...files(), "val.json": JSON.stringify({ metrics: { "sink.p99": "fast" } }) });
    expect(await h5.call(["calibrate", "model.json", "--observed", "val.json"])).toBe(EXIT_INVALID_MODEL);
    expect(await h.call(["calibrate", "missing.json", "--observed", "observed.json"])).toBe(EXIT_USAGE);
  });

  it("fit and fit-arrivals report bad data and bad flags clearly", async () => {
    const h = harness({ ...files(), "words.csv": "name\nfoo\nbar\n", "few.csv": "v\n1\n2\n3\n", "dates.csv": "timestamp\n2024-01-01T00:00:00Z\n2024-01-01T00:00:00Z\n" });
    expect(await h.call(["fit", "words.csv"])).toBe(EXIT_USAGE);
    expect(h.stderr.join("\n")).toContain("no column of numbers");
    expect(await h.call(["fit", "few.csv"])).toBe(EXIT_USAGE); // too little data for a verdict
    expect(h.stderr.join("\n")).toContain("at least 8");
    expect(await h.call(["fit", "service.csv", "--column", "nope"])).toBe(EXIT_USAGE);
    expect(await h.call(["fit", "service.csv", "--family", "weibull"])).toBe(EXIT_USAGE);
    expect(await h.call(["fit", "service.csv", "--scale", "-1"])).toBe(EXIT_USAGE);
    expect(await h.call(["fit", "missing.csv"])).toBe(EXIT_USAGE);
    expect(await h.call(["fit-arrivals", "arrivals.csv"])).toBe(EXIT_USAGE); // --window is required
    expect(h.stderr.join("\n")).toContain("--window");
    expect(await h.call(["fit-arrivals", "dates.csv", "--window", "10"])).toBe(EXIT_USAGE); // zero-length period
    expect(await h.call(["fit", "service.csv", "--scale", "0.001", "--family", "exponential"])).toBe(EXIT_OK);
  });
});
