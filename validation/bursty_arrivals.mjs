// Reproduces the bursty-arrivals table in docs/calibration.md. Run after `pnpm build`:
//   node validation/bursty_arrivals.mjs
//
// Ground truth, independent of the engine (own PRNG, own queue): clusters of requests start as a Poisson process,
// each cluster has a geometric number of requests (mean 3) spaced 50 ms apart, so arrival counts have a dispersion
// index of 2 * 3 - 1 = 5 in bins much longer than a cluster. They go to a FIFO queue in front of 4 workers with
// exponential service times at 80% utilisation. fit-arrivals' fitter measures the first hour; the engine then runs
// the fitted profile with Poisson arrivals and with the measured dispersionIndex. One hour's p99 varies a lot under
// bursty load, hence 40 replications. Last, the same clusters with no gaps are exactly the engine's batch model, so
// the engine with dispersionIndex 5 must agree with that ground truth within the confidence intervals (exit 1 if not).
import { loadModel, runModel } from "../packages/engine/dist/index.js";
import { fitArrivalProfile } from "../packages/calibrate/dist/index.js";

const WORKERS = 4, SERVICE_MEAN = 0.25, UTILISATION = 0.8, CLUSTER_MEAN = 3, GAP = 0.05;
const DURATION = 3600, REPLICATIONS = 40, SEED = 20261004;
const RATE = (UTILISATION * WORKERS) / SERVICE_MEAN; // requests per second
const THEORY = 2 * CLUSTER_MEAN - 1;

/** mulberry32: a small PRNG unrelated to the engine's. Returns floats in (0, 1). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
}

function groundTruth(seed, gap) {
  const u = prng(seed);
  const arrivals = [];
  for (let t = -Math.log(u()) * CLUSTER_MEAN / RATE; t < DURATION; t -= Math.log(u()) * CLUSTER_MEAN / RATE) {
    const size = 1 + Math.floor(Math.log(u()) / Math.log1p(-1 / CLUSTER_MEAN));
    for (let k = 0; k < size; k++) arrivals.push(t + k * gap);
  }
  arrivals.sort((a, b) => a - b);
  // FIFO with identical workers: each request in arrival order takes whichever worker frees up first.
  const free = new Array(WORKERS).fill(0);
  const latencies = [];
  for (const a of arrivals) {
    let w = 0;
    for (let i = 1; i < WORKERS; i++) if (free[i] < free[w]) w = i;
    free[w] = Math.max(a, free[w]) - Math.log(u()) * SERVICE_MEAN;
    if (free[w] <= DURATION) latencies.push(free[w] - a);
  }
  latencies.sort((a, b) => a - b);
  const mean = latencies.reduce((s, x) => s + x, 0) / latencies.length;
  return { arrivals: arrivals.filter((t) => t < DURATION), mean, p99: latencies[Math.ceil(0.99 * latencies.length) - 1] };
}

function engine(inputs) {
  const loaded = loadModel({
    version: 1,
    settings: { duration: DURATION, replications: REPLICATIONS, seed: SEED },
    components: [
      { type: "EntityGenerator", name: "traffic", inputs, links: { next: "queue" } },
      { type: "Queue", name: "queue" },
      { type: "Server", name: "workers", inputs: { capacity: WORKERS, serviceTime: { dist: "exponential", mean: SERVICE_MEAN } }, links: { queue: "queue", next: "sink" } },
      { type: "EntitySink", name: "sink" },
    ],
  });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const outputs = runModel(loaded.model).outputs;
  const get = (id) => outputs.find((o) => o.id === id);
  return { mean: get("sink.mean").mean, p99: get("sink.p99").mean, p99ci: get("sink.p99").ci95.halfWidth };
}

/** Mean and 95% confidence half-width across replications. */
function summary(xs) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  return { m, ci: (2.023 * sd) / Math.sqrt(xs.length) }; // t quantile for 39 degrees of freedom
}

const truths = Array.from({ length: REPLICATIONS }, (_, r) => groundTruth(SEED + r, GAP));
const fits = truths.map((t) => fitArrivalProfile(t.arrivals, { windowSeconds: 60, start: 0, end: DURATION }));
const fit = fits[0];
const truthMean = summary(truths.map((t) => t.mean)).m;
const truthP99 = summary(truths.map((t) => t.p99));
const poisson = engine({ mode: "rateProfile", rateProfile: fit.rateProfile });
const bursty = engine({ mode: "rateProfile", rateProfile: fit.rateProfile, dispersionIndex: fit.dispersionIndex });
const errors = fits.map((f) => Math.abs(f.dispersionIndex / THEORY - 1)).sort((a, b) => a - b);

const s = (x) => x.toFixed(3);
const pct = (x, ref) => `${x >= ref ? "+" : "−"}${Math.abs(Math.round((x / ref - 1) * 100))}%`;
console.log(`Rate ${RATE}/s. Index fitted from the first hour: ${fit.dispersionIndex.toFixed(2)} (theory ${THEORY}), ${fit.rateProfile.length} profile segment(s).`);
console.log(`Index error vs theory over ${REPLICATIONS} independent hours: median ${Math.round(errors[REPLICATIONS / 2] * 100)}%, 90th percentile ${Math.round(errors[Math.floor(REPLICATIONS * 0.9)] * 100)}%.\n`);
console.log("| Arrivals in the model | Mean latency | p99 latency |");
console.log("|---|---|---|");
console.log(`| The clustered traffic (ground truth) | ${s(truthMean)} s | ${s(truthP99.m)} s ± ${s(truthP99.ci)} |`);
console.log(`| Poisson (\`dispersionIndex\` 1) | ${s(poisson.mean)} s (${pct(poisson.mean, truthMean)}) | ${s(poisson.p99)} s (${pct(poisson.p99, truthP99.m)}) |`);
console.log(`| \`dispersionIndex\` ${fit.dispersionIndex.toFixed(2)} | ${s(bursty.mean)} s (${pct(bursty.mean, truthMean)}) | ${s(bursty.p99)} s ± ${s(bursty.p99ci)} (${pct(bursty.p99, truthP99.m)}) |`);

const exactP99 = summary(Array.from({ length: REPLICATIONS }, (_, r) => groundTruth(SEED + r, 0).p99));
const exact = engine({ mode: "rateProfile", rateProfile: [[0, RATE]], dispersionIndex: THEORY });
const agree = Math.abs(exact.p99 - exactP99.m) <= Math.hypot(exact.p99ci, exactP99.ci);
console.log(`\nSame clusters with no gaps: ground truth p99 ${s(exactP99.m)} ± ${s(exactP99.ci)} s, engine with dispersionIndex ${THEORY} ${s(exact.p99)} ± ${s(exact.p99ci)} s (${agree ? "agree" : "DISAGREE"}).`);
if (!agree) process.exitCode = 1;
