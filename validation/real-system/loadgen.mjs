#!/usr/bin/env node
/**
 * Load generator for service.mjs: sends requests with Poisson arrivals (random exponential gaps) following a plan
 * of "rate x seconds" phases, e.g. 8x300,11x120,8x180 = 8 req/s for 300 s, then 11 req/s for 120 s, then 8 req/s
 * for 180 s.
 *
 *   node validation/real-system/loadgen.mjs --seed 101 --plan 8x300,11x120,8x180
 *
 * Run it as its own process, so it does not compete with the service for the event loop. When every response is
 * back it asks the service to flush its log and exit. The arrival times used later come from the service's own
 * log, not from here, so any timer lateness in this script is measured rather than hidden.
 * Dependency-free; Node 20+.
 */
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8123" },
    plan: { type: "string", default: "8x300,11x120,8x180" },
    seed: { type: "string", default: "101" },
    "no-shutdown": { type: "boolean", default: false },
  },
});

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(opt.seed));

/** Parse "8x300,11x120" into [{ rate: 8, seconds: 300 }, ...]. */
const phases = opt.plan.split(",").map((p) => {
  const [rate, seconds] = p.split("x").map(Number);
  if (!(rate > 0) || !(seconds > 0)) throw new Error(`bad plan segment "${p}" (expected RATExSECONDS)`);
  return { rate, seconds };
});

/**
 * Pre-compute every arrival time (seconds from the start). Within a phase the gaps are exponential. At a phase
 * boundary we simply start a fresh gap with the new rate, which is exact because exponential gaps are memoryless.
 */
const schedule = [];
let phaseStart = 0;
for (const { rate, seconds } of phases) {
  const phaseEnd = phaseStart + seconds;
  let t = phaseStart;
  for (;;) {
    t += -Math.log(1 - rand()) / rate;
    if (t >= phaseEnd) break;
    schedule.push(t);
  }
  phaseStart = phaseEnd;
}
const totalSeconds = phaseStart;

const target = new URL(opt.url);
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
let sent = 0;
let done = 0;
let failed = 0;

function send() {
  sent++;
  const req = http.request({ host: target.hostname, port: target.port, path: "/", agent }, (res) => {
    res.resume();
    res.on("end", () => done++);
  });
  req.on("error", () => failed++);
  req.end();
}

console.log(`plan ${opt.plan}: ${schedule.length} requests over ${totalSeconds} s`);
const start = performance.now();
let nextReport = 30;
for (const t of schedule) {
  const wait = start + t * 1000 - performance.now();
  if (wait > 1) await sleep(wait);
  send();
  if (t >= nextReport) {
    console.log(`  t=${Math.round(t)} s: sent ${sent}, answered ${done}`);
    nextReport += 30;
  }
}

// Let the backlog drain: every request that was sent gets an answer (or an error).
while (done + failed < sent) await sleep(100);
console.log(`finished: sent ${sent}, answered ${done}, failed ${failed}`);
if (failed > 0) console.log("WARNING: some requests failed; this run's data is not trustworthy.");

if (!opt["no-shutdown"]) {
  await new Promise((resolve) => http.get({ host: target.hostname, port: target.port, path: "/shutdown", agent }, (r) => { r.resume(); r.on("end", resolve); }).on("error", resolve));
  console.log("asked the service to flush its log and exit");
}
agent.destroy();
