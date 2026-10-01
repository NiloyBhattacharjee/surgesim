import { Priority } from "../kernel/index.js";
import { LinkedComponent, type ComponentInit, type MovingEntity, type SimContext } from "../model/index.js";
import type { SampleProvider } from "../rng/index.js";
import { asSampler, type ComponentSchema } from "../schema/index.js";
import { TimeWeightedStat } from "../stats/index.js";
import type { Lease, PullSource, QueueWaiter } from "./pullable.js";

/**
 * A pool of up to `concurrency` workers, modelled on a serverless function or container fleet.
 *
 * - **Pull mode** (`queue` link): workers pull from a Queue or MessageQueue whenever one is free.
 * - **Push mode** (entities sent straight to the pool): when all `concurrency` workers are busy the
 *   request is *throttled* (rejected) and goes to the `onThrottle` link, or is dropped and counted.
 * - **Cold starts**: a worker needs a warm instance. If none is idle, a new one starts and the
 *   request pays `coldStartTime` on top of its service time. Instances idle for `idleTimeout`
 *   seconds are reclaimed; the most recently used instance is reused first.
 * - **Failures**: after service, an entity fails with probability `failureProbability`. A failure
 *   goes to `onFailure` if linked (and is acked). Otherwise, with a MessageQueue source it is left
 *   unacked so the visibility timeout redelivers it; with a plain Queue or push mode it is lost.
 */
export class WorkerPool extends LinkedComponent implements QueueWaiter {
  static readonly schema: ComponentSchema<WorkerPool> = {
    type: "WorkerPool",
    description:
      "Worker pool with a concurrency limit, throttling, cold starts and failures. Pulls from a queue or accepts pushed entities.",
    roles: ["receiver"],
    inputs: [
      { key: "concurrency", type: "integer", unit: "dimensionless", min: 1, required: true, description: "Maximum workers busy at once (cold-starting workers count)." },
      { key: "serviceTime", type: "sampler", unit: "time", min: 0, required: true, description: "Service time per entity (seconds)." },
      { key: "coldStartTime", type: "sampler", unit: "time", min: 0, default: 0, required: false, description: "Extra seconds when a request has to start a new instance." },
      { key: "idleTimeout", type: "number", unit: "time", min: 0, required: false, description: "Seconds an idle instance stays warm. Instances never expire if omitted." },
      { key: "initialWarm", type: "integer", unit: "dimensionless", min: 0, default: 0, required: false, description: "Instances already warm at time 0 (capped at concurrency)." },
      { key: "failureProbability", type: "number", unit: "dimensionless", min: 0, max: 1, default: 0, required: false, description: "Probability that an entity fails after its service time." },
    ],
    links: [
      { key: "queue", description: "Queue or MessageQueue to pull from (pull mode). Omit to accept pushed entities.", required: false, accepts: "pullable" },
      { key: "next", description: "Where successfully served entities are sent.", required: false, accepts: "receiver" },
      { key: "onFailure", description: "Where failed entities are sent (e.g. a RetryPolicy).", required: false, accepts: "receiver" },
      { key: "onThrottle", description: "Where entities rejected because the pool was full are sent (e.g. a RetryPolicy).", required: false, accepts: "receiver" },
    ],
    outputs: [
      { key: "Utilisation", unit: "dimensionless", description: "Time-weighted busy workers / concurrency.", get: (p) => p.busyStat.mean(p.now) / p.concurrency },
      { key: "AverageBusyWorkers", unit: "dimensionless", description: "Time-weighted average number of busy workers.", get: (p) => p.busyStat.mean(p.now) },
      { key: "BusyWorkers", unit: "dimensionless", series: true, description: "Workers currently busy.", get: (p) => p.busy },
      { key: "ColdStarts", unit: "dimensionless", description: "Requests that had to start a new instance (no idle warm instance).", get: (p) => p.coldStarts },
      { key: "NumberSucceeded", unit: "dimensionless", description: "Entities served successfully.", get: (p) => p.succeeded },
      { key: "NumberFailed", unit: "dimensionless", description: "Entities that failed after service.", get: (p) => p.failed },
      { key: "NumberThrottled", unit: "dimensionless", description: "Pushed entities rejected because every worker was busy.", get: (p) => p.throttled },
      { key: "ThrottleFraction", unit: "dimensionless", description: "Throttled / pushed entities (the blocking probability).", get: (p) => (p.pushed === 0 ? NaN : p.throttled / p.pushed) },
      { key: "StaleAcks", unit: "dimensionless", description: "Successes whose acknowledgement was too late (visibility timeout had expired): duplicate processing.", get: (p) => p.staleAcks },
    ],
  };

  private readonly concurrency: number;
  private readonly serviceTime: SampleProvider;
  private readonly coldStart: SampleProvider;
  private readonly failureDraw: SampleProvider;
  private readonly failureProbability: number;
  private readonly idleTimeoutTicks: number | undefined;
  private readonly busyStat: TimeWeightedStat;
  /** Tick at which each idle warm instance became idle, oldest first. */
  private readonly idle: number[] = [];
  private source: PullSource | null = null;
  private onFailure: LinkedComponent | null = null;
  private onThrottle: LinkedComponent | null = null;
  private busy = 0;
  private coldStarts = 0;
  private succeeded = 0;
  private failed = 0;
  private throttled = 0;
  private pushed = 0;
  private staleAcks = 0;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
    const i = init.inputs;
    this.concurrency = i["concurrency"] as number;
    this.serviceTime = this.makeSampler(asSampler(i["serviceTime"]), "serviceTime");
    this.coldStart = this.makeSampler(asSampler(i["coldStartTime"]), "coldStartTime");
    this.failureDraw = this.makeSampler({ dist: "uniform", min: 0, max: 1 }, "failure");
    this.failureProbability = i["failureProbability"] as number;
    const timeout = i["idleTimeout"] as number | undefined;
    this.idleTimeoutTicks = timeout === undefined ? undefined : ctx.kernel.secondsToTicks(timeout);
    this.busyStat = new TimeWeightedStat(ctx.kernel.currentTick, 0);
    const warm = Math.min(i["initialWarm"] as number, this.concurrency);
    for (let w = 0; w < warm; w++) this.idle.push(ctx.kernel.currentTick);
  }

  private get now(): number {
    return this.ctx.kernel.currentTick;
  }

  override setLink(key: string, target: LinkedComponent): void {
    switch (key) {
      case "queue":
        this.source = target as unknown as PullSource;
        this.source.addWaiter(this);
        break;
      case "onFailure":
        this.onFailure = target;
        break;
      case "onThrottle":
        this.onThrottle = target;
        break;
      default:
        super.setLink(key, target);
    }
  }

  /** Push mode: start the entity if a worker is free, otherwise throttle it. */
  override addEntity(entity: MovingEntity): void {
    this.pushed++;
    if (this.busy >= this.concurrency) {
      this.throttled++;
      this.onThrottle?.addEntity(entity);
      return;
    }
    this.begin(entity, null);
  }

  /** Pull mode: fill free workers from the queue. */
  queueHasEntity(): void {
    while (this.source !== null && this.busy < this.concurrency) {
      const lease = this.source.receive();
      if (lease === null) break;
      this.begin(lease.entity, lease);
    }
  }

  private begin(entity: MovingEntity, lease: Lease | null): void {
    this.noteAdded();
    this.setBusy(this.busy + 1);
    let seconds = Math.max(0, this.serviceTime.nextSample());
    if (!this.takeWarmInstance()) {
      this.coldStarts++;
      seconds += Math.max(0, this.coldStart.nextSample());
    }
    this.ctx.kernel.schedule(this.secondsToTicks(seconds), Priority.DEFAULT, () => this.end(entity, lease));
  }

  /** Reclaim expired idle instances, then take the most recently used one. False if none is warm. */
  private takeWarmInstance(): boolean {
    if (this.idleTimeoutTicks !== undefined) {
      let expired = 0;
      while (expired < this.idle.length && this.now - (this.idle[expired] as number) >= this.idleTimeoutTicks) expired++;
      if (expired > 0) this.idle.splice(0, expired);
    }
    return this.idle.pop() !== undefined;
  }

  private end(entity: MovingEntity, lease: Lease | null): void {
    this.idle.push(this.now);
    this.setBusy(this.busy - 1);
    const failed = this.failureProbability > 0 && this.failureDraw.nextSample() < this.failureProbability;
    if (!failed) {
      this.succeeded++;
      if (lease !== null && !lease.ack()) this.staleAcks++;
      this.sendToNext(entity);
    } else {
      this.failed++;
      this.noteCompleted();
      if (this.onFailure !== null) {
        lease?.ack();
        this.onFailure.addEntity(entity);
      }
      // Otherwise: a MessageQueue redelivers after its visibility timeout; anything else is lost.
    }
    this.queueHasEntity();
  }

  private setBusy(n: number): void {
    this.busy = n;
    this.busyStat.set(this.now, n);
    this.setState(n === 0 ? "Idle" : "Busy");
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.busyStat.reset(this.now);
    this.coldStarts = 0;
    this.succeeded = 0;
    this.failed = 0;
    this.throttled = 0;
    this.pushed = 0;
    this.staleAcks = 0;
  }
}
