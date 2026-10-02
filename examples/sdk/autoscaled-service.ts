/**
 * The same system as ../autoscaled-service.json, written with the TypeScript SDK.
 *
 *   surgesim run examples/sdk/autoscaled-service.ts
 *   surgesim compile examples/sdk/autoscaled-service.ts --out model.json
 *
 * (TypeScript models need Node 22.18+, or compile with tsc / run through tsx.)
 */
import { Model, dist } from "@surgesim/sdk";

const model = new Model("Autoscaled service under a 4x traffic spike, with cost and SLO gates", {
  description:
    "A worker service behind a queue. Traffic jumps from 20/s to 80/s at t=300 for 5 minutes. A target-tracking autoscaler (50% utilisation, 15 s evaluation, 10 s provisioning delay) resizes the fleet; workers cost 0.0001 per provisioned second. The assertions are the SLO and budget gates CI would enforce. Slow it down (evaluationInterval 60, scaleUpDelay 30) and p99 rises to ~43 s, so `surgesim run` fails with exit code 3.",
  duration: 1200,
  warmUp: 0,
  seed: 5,
  replications: 5,
});

const traffic = model.entityGenerator("traffic", {
  mode: "rateProfile",
  rateProfile: [[0, 20], [300, 80], [600, 20]],
});
const queue = model.queue("queue");
const done = model.entitySink("done");
const service = model.workerPool("service", {
  concurrency: 20,
  serviceTime: dist.lognormal(0.5, 0.25),
  costPerProvisionedSecond: 0.0001,
  queue,
  next: done,
});
traffic.link("next", queue);
model.autoscaler("scaler", {
  targetUtilisation: 0.5,
  evaluationInterval: 15,
  scaleUpDelay: 10,
  scaleDownCooldown: 120,
  minConcurrency: 10,
  maxConcurrency: 120,
  target: service,
});

model.sampleEvery(10, [queue.output("QueueLength"), service.output("Concurrency"), service.output("BusyWorkers")]);
model.assert(done.output("p99"), "<=", 30, { name: "p99 latency under 30 s" });
model.assert(queue.output("MaxQueueLength"), "<", 5000, { statistic: "max", name: "backlog stays under 5000" });
model.assert(service.output("Cost"), "<", 8, { name: "fleet cost under 8" });

export default model;
