import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";

/**
 * Cross-check against an independent simulator (SimPy, see validation/simpy_reference.py): the same scenarios run
 * through both, and every metric must agree statistically. Skipped, not failed, when Python or SimPy is missing.
 *
 * "Agree" means the difference of the two means is within 3.5 standard errors (plus 0.3% of the value, so metrics
 * with almost no variance are not judged on rounding). With a fixed seed the outcome is deterministic.
 */
const reference = fileURLToPath(new URL("../../../validation/simpy_reference.py", import.meta.url));

function findPython(): string | null {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["-c", "import simpy"], { timeout: 20_000, windowsHide: true, encoding: "utf8" });
    if (r.status === 0) return cmd;
  }
  return null;
}
const python = findPython();

interface Scenario {
  name: string;
  duration: number;
  warmUp: number;
  replications: number;
  seed: number;
  rateProfile: [number, number][];
  servers: number;
  service: { dist: "exponential"; mean: number } | { dist: "lognormal"; mean: number; stdDev: number };
  queueLimit?: number;
  /** Metrics to compare: [name, Surgesim output id, SimPy field]. */
  metrics: string[];
}

const COMMON = ["utilisation", "avgQueueLength", "avgQueueTime", "meanTime", "p50", "p95", "p99", "completed"];
const SCENARIOS: Scenario[] = [
  { name: "M/M/1, rho 0.8", duration: 20_000, warmUp: 2_000, replications: 10, seed: 11, rateProfile: [[0, 0.8]], servers: 1, service: { dist: "exponential", mean: 1 }, metrics: COMMON },
  { name: "M/M/5, rho 0.8", duration: 10_000, warmUp: 1_000, replications: 10, seed: 12, rateProfile: [[0, 4]], servers: 5, service: { dist: "exponential", mean: 1 }, metrics: COMMON },
  { name: "M/G/3, lognormal service (cv 0.5), rho 0.67", duration: 10_000, warmUp: 1_000, replications: 10, seed: 13, rateProfile: [[0, 2]], servers: 3, service: { dist: "lognormal", mean: 1, stdDev: 0.5 }, metrics: COMMON },
  { name: "M/G/2, heavy-tailed lognormal service (cv 2), rho 0.6", duration: 30_000, warmUp: 3_000, replications: 10, seed: 14, rateProfile: [[0, 1.2]], servers: 2, service: { dist: "lognormal", mean: 1, stdDev: 2 }, metrics: COMMON },
  { name: "M/M/2/20 under permanent overload (bounded queue drops)", duration: 5_000, warmUp: 500, replications: 10, seed: 15, rateProfile: [[0, 3]], servers: 2, service: { dist: "exponential", mean: 1 }, queueLimit: 20, metrics: [...COMMON, "maxQueueLength", "dropped", "arrived"] },
  { name: "Traffic spike (10/s, 50/s, 10/s) into 20 workers, lognormal service", duration: 600, warmUp: 0, replications: 10, seed: 16, rateProfile: [[0, 10], [180, 50], [300, 10]], servers: 20, service: { dist: "lognormal", mean: 0.5, stdDev: 0.25 }, metrics: [...COMMON, "maxQueueLength", "arrived"] },
];

/** Where each reference field lives in Surgesim's output ids. */
const SURGESIM_ID: Record<string, string> = {
  utilisation: "server.Utilisation",
  avgQueueLength: "queue.AverageQueueLength",
  maxQueueLength: "queue.MaxQueueLength",
  avgQueueTime: "queue.AverageQueueTime",
  meanTime: "sink.mean",
  p50: "sink.p50",
  p95: "sink.p95",
  p99: "sink.p99",
  completed: "sink.count",
  dropped: "queue.NumberDropped",
  arrived: "gen.NumberGenerated",
};

function stats(xs: number[]): { mean: number; se: number; n: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, se: Math.sqrt(variance / n), n };
}

function surgesimModel(s: Scenario) {
  return {
    version: 1,
    settings: { duration: s.duration, warmUp: s.warmUp, replications: s.replications, seed: s.seed },
    components: [
      { type: "EntityGenerator", name: "gen", inputs: { mode: "rateProfile", rateProfile: s.rateProfile }, links: { next: "queue" } },
      { type: "Queue", name: "queue", inputs: s.queueLimit === undefined ? {} : { maxLength: s.queueLimit } },
      { type: "Server", name: "server", inputs: { capacity: s.servers, serviceTime: s.service }, links: { queue: "queue", next: "sink" } },
      { type: "EntitySink", name: "sink" },
    ],
  };
}

interface Row {
  scenario: string;
  metric: string;
  surgesim: { mean: number; se: number };
  simpy: { mean: number; se: number };
  z: number;
  agree: boolean;
}
const rows: Row[] = [];

/**
 * Run a scenario through both simulators and compare every metric. `surgesimService` lets a test feed Surgesim a
 * deliberately different service distribution than the reference, to prove the comparison can tell them apart.
 */
function compareScenario(s: Scenario, surgesimService: Scenario["service"] = s.service): { rows: Row[]; disagreements: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "surgesim-xcheck-"));
  try {
    const file = join(dir, "scenario.json");
    writeFileSync(file, JSON.stringify({ ...s, metrics: undefined }));
    const r = spawnSync(python as string, [reference, file], { timeout: 180_000, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`reference simulator failed:
${r.stderr}`);
    const ref = JSON.parse(r.stdout) as { replications: Record<string, number | null>[] };

    const surgesim = run(surgesimModel({ ...s, service: surgesimService }));
    const out: Row[] = [];
    const disagreements: string[] = [];
    for (const metric of s.metrics) {
      const a = surgesim.replications.map((rep) => rep.outputs[SURGESIM_ID[metric] as string]).filter((v): v is number => typeof v === "number");
      const b = ref.replications.map((rep) => rep[metric]).filter((v): v is number => typeof v === "number");
      expect(a.length, `${metric}: Surgesim replications with a value`).toBe(s.replications);
      expect(b.length, `${metric}: SimPy replications with a value`).toBe(s.replications);
      const A = stats(a);
      const B = stats(b);
      const se = Math.sqrt(A.se ** 2 + B.se ** 2);
      const diff = Math.abs(A.mean - B.mean);
      const allowed = 3.5 * se + 0.003 * Math.abs(B.mean);
      const z = se > 0 ? diff / se : diff === 0 ? 0 : Infinity;
      const agree = diff <= allowed;
      out.push({ scenario: s.name, metric, surgesim: A, simpy: B, z, agree });
      if (!agree) disagreements.push(`${metric}: Surgesim ${A.mean.toPrecision(5)} (se ${A.se.toPrecision(2)}) vs SimPy ${B.mean.toPrecision(5)} (se ${B.se.toPrecision(2)}), z=${z.toFixed(2)}`);
    }
    return { rows: out, disagreements };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(python === null)("agrees with an independent simulator (SimPy)", () => {
  for (const s of SCENARIOS) {
    it(s.name, () => {
      const result = compareScenario(s);
      rows.push(...result.rows);
      expect(result.disagreements, result.disagreements.join("; ")).toEqual([]);
    }, 240_000);
  }

  it("has teeth: a service time only 4% too slow is detected as a disagreement", () => {
    const base = SCENARIOS[0] as Scenario; // M/M/1, rho 0.8
    const slower = compareScenario(base, { dist: "exponential", mean: 1.04 });
    expect(slower.disagreements.length, "a 4% error should be visible in at least one metric").toBeGreaterThan(0);
    // ...while the identical model is accepted (the test above), so the check is neither blind nor trigger-happy.
    const utilisation = slower.rows.find((r) => r.metric === "utilisation")!;
    expect(utilisation.surgesim.mean).toBeGreaterThan(utilisation.simpy.mean);
  }, 240_000);

  it("prints the comparison table when asked (CROSSCHECK_REPORT=<file> writes it as JSON)", () => {
    const out = process.env["CROSSCHECK_REPORT"];
    if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
    if (process.env["CROSSCHECK_VERBOSE"]) {
      for (const r of rows) console.log(`${r.scenario} | ${r.metric.padEnd(15)} surgesim ${r.surgesim.mean.toPrecision(5).padStart(10)}  simpy ${r.simpy.mean.toPrecision(5).padStart(10)}  z=${r.z.toFixed(2)} ${r.agree ? "ok" : "DISAGREE"}`);
    }
    expect(rows.length).toBeGreaterThan(0);
  });
});
