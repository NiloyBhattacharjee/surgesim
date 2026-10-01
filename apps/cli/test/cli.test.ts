import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileStore, Logger } from "@chronon-sim/platform";
import { EXIT_INVALID_MODEL, EXIT_OK, EXIT_USAGE, runCli } from "../src/main.js";

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
    expect(schemas.map((s: { type: string }) => s.type)).toEqual([
      "EntityGenerator",
      "Queue",
      "Server",
      "EntitySink",
      "MessageQueue",
      "WorkerPool",
      "RetryPolicy",
      "RateLimiter",
    ]);
  });
});
