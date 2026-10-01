import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileStore, Logger } from "@chronon-sim/platform";
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

function harness(initial: Record<string, string> = {}) {
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
  const call = (args: string[]) => runCli(args, { fs, logger, clock: { nowMs: () => (t += 10) } });
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
