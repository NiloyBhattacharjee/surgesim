#!/usr/bin/env node
/**
 * A tiny real queueing service, used as ground truth for validating Chronon Sim.
 *
 * It accepts HTTP requests, holds them in a FIFO queue, and serves at most `--capacity` of them at a time. Each
 * request "works" for a random lognormal time (a timer), then is answered. For every request it logs when it
 * arrived, when service started and when it finished, as one JSON object per line.
 *
 * The service-time distribution is printed at startup so you can compare it with what `chronon fit` recovers from
 * the logs. Chronon is never told it.
 *
 *   node validation/real-system/service.mjs --seed 1 --out validation/real-system/runs/A/service-log.jsonl
 *
 * It exits (and flushes its log) when `loadgen.mjs` finishes and calls /shutdown, or on Ctrl+C.
 * Dependency-free; Node 20+.
 */
import http from "node:http";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    port: { type: "string", default: "8123" },
    capacity: { type: "string", default: "4" },
    mean: { type: "string", default: "0.3" }, // mean service time, seconds
    sd: { type: "string", default: "0.15" }, // standard deviation of service time, seconds
    seed: { type: "string", default: "1" },
    out: { type: "string", default: "validation/real-system/runs/latest/service-log.jsonl" },
  },
});

const port = Number(opt.port);
const capacity = Number(opt.capacity);
const mean = Number(opt.mean);
const sd = Number(opt.sd);
const seed = Number(opt.seed);

/** Small seeded PRNG (mulberry32) so a run is repeatable. Returns uniform numbers in [0, 1). */
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);

// Lognormal with the requested mean and standard deviation: convert to the underlying normal's mu and sigma.
const sigma2 = Math.log(1 + (sd * sd) / (mean * mean));
const mu = Math.log(mean) - sigma2 / 2;
const sigma = Math.sqrt(sigma2);
function normal() {
  // Box-Muller; 1 - rand() avoids log(0).
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}
/** One service time in milliseconds. */
function serviceTimeMs() {
  return Math.exp(mu + sigma * normal()) * 1000;
}

/** Wall-clock time in epoch milliseconds, with sub-millisecond resolution. */
const now = () => performance.timeOrigin + performance.now();

mkdirSync(dirname(opt.out), { recursive: true });
const log = createWriteStream(opt.out);
log.write(JSON.stringify({ config: { capacity, mean, sd, seed } }) + "\n");

let nextId = 0;
let active = 0;
const waiting = []; // FIFO of { id, arrived, res }

function dispatch() {
  while (active < capacity && waiting.length > 0) {
    const job = waiting.shift();
    active++;
    const started = now();
    setTimeout(() => {
      const finished = now();
      log.write(JSON.stringify({ id: job.id, arrived: job.arrived, started, finished }) + "\n");
      job.res.end("ok");
      active--;
      dispatch();
    }, serviceTimeMs());
  }
}

function shutdown() {
  log.end(() => process.exit(0));
}

const server = http.createServer((req, res) => {
  if (req.url === "/shutdown") {
    res.end("bye", shutdown);
    return;
  }
  // Time the request is received is the arrival time, whatever the client did before it.
  waiting.push({ id: nextId++, arrived: now(), res });
  dispatch();
});
// Keep client connections open between requests so each request does not pay for a new connection.
server.keepAliveTimeout = 60_000;
server.listen(port, "127.0.0.1", () => {
  console.log(`service on http://127.0.0.1:${port}`);
  console.log(`  capacity ${capacity}, service time lognormal mean ${mean}s sd ${sd}s, seed ${seed}`);
  console.log(`  utilisation at 8 req/s would be ${((8 * mean) / capacity).toFixed(2)}`);
  console.log(`  logging to ${opt.out}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
