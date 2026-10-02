#!/usr/bin/env node
/**
 * Turns a service log (service-log.jsonl) into the inputs Chronon's calibration commands read:
 *
 *   arrivals.csv       one ISO timestamp per request            -> chronon fit-arrivals
 *   service_times.csv  processing time in ms (finish - start)   -> chronon fit --scale 0.001
 *   observed.json      measured latency / utilisation / queue   -> chronon calibrate --observed
 *
 *   node validation/real-system/summarize.mjs validation/real-system/runs/B/service-log.jsonl
 *
 * Everything is measured over the window [first arrival, first arrival + duration], because that is what a model
 * run of `duration` seconds measures: latencies of requests that finished in the window, and busy and waiting time
 * clipped to the window. `duration` defaults to the time from the first to the last arrival.
 * Output files go next to the log unless --out is given. Dependency-free; Node 20+.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    duration: { type: "string" }, // seconds
    capacity: { type: "string" }, // only needed if the log has no config line
    "skip-service": { type: "string", default: "20" }, // drop this many first service times (JIT warm-up)
    tolerance: { type: "string", default: "0.15" },
  },
});
const logPath = positionals[0];
if (!logPath) {
  console.error("usage: node summarize.mjs <service-log.jsonl> [--duration S] [--out DIR] [--skip-service N]");
  process.exit(2);
}
const outDir = opt.out ?? dirname(logPath);

let config = null;
const records = [];
for (const line of readFileSync(logPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (row.config) config = row.config;
  else records.push(row);
}
if (records.length === 0) throw new Error("the log has no requests");
const capacity = Number(opt.capacity ?? config?.capacity);
if (!(capacity > 0)) throw new Error("capacity unknown: pass --capacity (the log has no config line)");

records.sort((a, b) => a.arrived - b.arrived);
const t0 = records[0].arrived;
const lastArrival = records[records.length - 1].arrived;
const duration = Number(opt.duration ?? (lastArrival - t0) / 1000);
const tEnd = t0 + duration * 1000;

/** Length (ms) of the overlap between [a, b] and the measurement window. */
const overlap = (a, b) => Math.max(0, Math.min(b, tEnd) - Math.max(a, t0));

/** p-th percentile, linear interpolation between ranks (the same definition the engine uses). */
function percentile(sorted, p) {
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

const inWindow = records.filter((r) => r.finished <= tEnd);
const latencies = inWindow.map((r) => (r.finished - r.arrived) / 1000).sort((a, b) => a - b);
const meanLatency = latencies.reduce((s, x) => s + x, 0) / latencies.length;

let busyMs = 0;
let waitMs = 0;
for (const r of records) {
  busyMs += overlap(r.started, r.finished);
  waitMs += overlap(r.arrived, r.started);
}
const utilisation = busyMs / 1000 / (capacity * duration);
const averageQueueLength = waitMs / 1000 / duration;

const round = (x) => Number(x.toPrecision(4));
const observed = {
  tolerance: Number(opt.tolerance),
  periods: 1,
  metrics: {
    "sink.mean": round(meanLatency),
    "sink.p50": round(percentile(latencies, 50)),
    "sink.p95": round(percentile(latencies, 95)),
    "sink.p99": round(percentile(latencies, 99)),
    "server.Utilisation": round(utilisation),
    "queue.AverageQueueLength": round(averageQueueLength),
  },
};

const skip = Number(opt["skip-service"]);
const serviceMs = records.slice(skip).filter((r) => r.finished <= tEnd).map((r) => r.finished - r.started);
const arrivals = records.filter((r) => r.arrived <= tEnd).map((r) => new Date(r.arrived).toISOString());

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "arrivals.csv"), "timestamp\n" + arrivals.join("\n") + "\n");
writeFileSync(join(outDir, "service_times.csv"), "duration_ms\n" + serviceMs.map((x) => x.toFixed(3)).join("\n") + "\n");
writeFileSync(join(outDir, "observed.json"), JSON.stringify(observed, null, 2) + "\n");

console.log(`${records.length} requests; window ${duration.toFixed(1)} s; capacity ${capacity}`);
console.log(`${inWindow.length} finished in the window (${(inWindow.length / duration).toFixed(2)}/s)`);
if (config) console.log(`truth (from the log): service time lognormal mean ${config.mean}s sd ${config.sd}s`);
console.log(`measured service time: ${(serviceMs.reduce((s, x) => s + x, 0) / serviceMs.length / 1000).toFixed(4)} s mean over ${serviceMs.length} requests`);
console.log("observed:", observed.metrics);
console.log(`wrote arrivals.csv, service_times.csv, observed.json to ${outDir}`);
console.log(`model duration for this run: ${Math.floor(duration)} s`);
