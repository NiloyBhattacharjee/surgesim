import { Priority } from "../kernel/index.js";
import { LinkedComponent, type ComponentInit, type MovingEntity, type SimContext } from "../model/index.js";
import type { SampleProvider } from "../rng/index.js";
import { asSampler, type ComponentSchema } from "../schema/index.js";
import { TimeWeightedStat } from "../stats/index.js";
import type { Scalable } from "./autoscaler.js";
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
 * - **Synchronous calls** (`holdUntilRelease`): after service the worker stays busy, waiting for the response,
 *   until the entity passes a Release. The Autoscaler does not count a held worker as busy: waiting uses no CPU.
 * - **CPU throttling** (`cpuOversubscription` above 1): the workers demand more CPU than their limit once enough are
 *   computing, so service stretches by `max(1, computing / concurrency * cpuOversubscription)`, and the Autoscaler
 *   sees CPU use capped at the limit.
 */
export class WorkerPool extends LinkedComponent implements QueueWaiter, Scalable {
  static readonly schema: ComponentSchema<WorkerPool> = {
    type: "WorkerPool",
    description:
      "Worker pool with a concurrency limit, throttling, cold starts and failures. Pulls from a queue or accepts pushed entities.",
    roles: ["receiver", "scalable", "costed"],
    inputs: [
      { key: "concurrency", type: "integer", unit: "dimensionless", min: 1, required: true, description: "Maximum workers busy at once (cold-starting workers count). An Autoscaler can change it during the run; this is the starting value." },
      { key: "serviceTime", type: "sampler", unit: "time", min: 0, required: true, description: "Service time per entity (seconds)." },
      { key: "coldStartTime", type: "sampler", unit: "time", min: 0, default: 0, required: false, description: "Extra seconds when a request has to start a new instance." },
      { key: "idleTimeout", type: "number", unit: "time", min: 0, required: false, description: "Seconds an idle instance stays warm. Instances never expire if omitted." },
      { key: "initialWarm", type: "integer", unit: "dimensionless", min: 0, default: 0, required: false, description: "Instances already warm at time 0 (capped at concurrency)." },
      { key: "failureProbability", type: "number", unit: "dimensionless", min: 0, max: 1, default: 0, required: false, description: "Probability that an entity fails after its service time." },
      { key: "costPerBusySecond", type: "number", unit: "cost", min: 0, default: 0, required: false, description: "Price per busy-worker-second (serverless-style billing)." },
      { key: "costPerProvisionedSecond", type: "number", unit: "cost", min: 0, default: 0, required: false, description: "Price per provisioned-worker-second, busy or not (container/VM-style billing; follows autoscaling)." },
      { key: "costPerRequest", type: "number", unit: "cost", min: 0, default: 0, required: false, description: "Price per request started." },
      { key: "holdUntilRelease", type: "boolean", unit: "dimensionless", default: false, required: false, description: "Keep the worker busy after service until the entity passes a Release (a synchronous call: the worker waits for the response). The Autoscaler does not count held workers as busy." },
      { key: "cpuOversubscription", type: "number", unit: "dimensionless", min: 0, default: 1, required: false, description: "CPU the pool would use with every worker computing, as a multiple of its CPU limit. Above 1, service times stretch once demand passes the limit (CFS throttling), and the Autoscaler sees CPU use capped at the limit." },
    ],
    links: [
      { key: "queue", description: "Queue or MessageQueue to pull from (pull mode). Omit to accept pushed entities.", required: false, accepts: "pullable" },
      { key: "next", description: "Where successfully served entities are sent.", required: false, accepts: "receiver" },
      { key: "onFailure", description: "Where failed entities are sent (e.g. a RetryPolicy).", required: false, accepts: "receiver" },
      { key: "onThrottle", description: "Where entities rejected because the pool was full are sent (e.g. a RetryPolicy).", required: false, accepts: "receiver" },
    ],
    outputs: [
      { key: "Utilisation", unit: "dimensionless", description: "Time-weighted busy workers / provisioned concurrency.", get: (p) => p.busyStat.mean(p.now) / p.limitStat.mean(p.now) },
      { key: "Concurrency", unit: "dimensionless", series: true, description: "Current concurrency limit (changes when autoscaled, and during a RollingUpdate).", get: (p) => p.available },
      { key: "AverageConcurrency", unit: "dimensionless", description: "Time-weighted average concurrency limit.", get: (p) => p.limitStat.mean(p.now) },
      { key: "AverageBusyWorkers", unit: "dimensionless", description: "Time-weighted average number of busy workers.", get: (p) => p.busyStat.mean(p.now) },
      { key: "BusyWorkers", unit: "dimensionless", series: true, description: "Workers currently busy, including held ones.", get: (p) => p.busy },
      { key: "HeldWorkers", unit: "dimensionless", series: true, description: "Workers currently held waiting for a Release (holdUntilRelease).", get: (p) => p.held },
      { key: "AverageCpuStretch", unit: "dimensionless", description: "Mean factor by which CPU throttling stretched service times (1 means never throttled).", get: (p) => (p.started === 0 ? NaN : p.stretchTotal / p.started) },
      { key: "ColdStarts", unit: "dimensionless", description: "Requests that had to start a new instance (no idle warm instance).", get: (p) => p.coldStarts },
      { key: "NumberSucceeded", unit: "dimensionless", description: "Entities served successfully.", get: (p) => p.succeeded },
      { key: "NumberFailed", unit: "dimensionless", description: "Entities that failed after service.", get: (p) => p.failed },
      { key: "NumberThrottled", unit: "dimensionless", description: "Pushed entities rejected because every worker was busy.", get: (p) => p.throttled },
      { key: "ThrottleFraction", unit: "dimensionless", description: "Throttled / pushed entities (the blocking probability).", get: (p) => (p.pushed === 0 ? NaN : p.throttled / p.pushed) },
      { key: "Cost", unit: "cost", description: "Busy-second, provisioned-second and per-request charges over the measured window.", get: (p) => p.cost() },
      { key: "StaleAcks", unit: "dimensionless", description: "Successes whose acknowledgement was too late (visibility timeout had expired): duplicate processing.", get: (p) => p.staleAcks },
    ],
  };

  /** The nominal limit, which an Autoscaler sets and reads. */
  private limit: number;
  /** Workers a RollingUpdate has added or taken away for now. */
  private adjustment = 0;
  private readonly prices: { busy: number; provisioned: number; request: number };
  private readonly serviceTime: SampleProvider;
  private readonly coldStart: SampleProvider;
  private readonly failureDraw: SampleProvider;
  private readonly failureProbability: number;
  private readonly hold: boolean;
  private readonly cpuRatio: number;
  private stretchTotal = 0;
  private readonly idleTimeoutTicks: number | undefined;
  private readonly busyStat: TimeWeightedStat;
  private readonly limitStat: TimeWeightedStat;
  /** Busy, not held, workers since time 0; never reset, so an Autoscaler can read deltas across the warm-up reset. */
  private readonly busyLifetime: TimeWeightedStat;
  /** Tick at which each idle warm instance became idle, oldest first. */
  private readonly idle: number[] = [];
  private source: PullSource | null = null;
  private onFailure: LinkedComponent | null = null;
  private onThrottle: LinkedComponent | null = null;
  private busy = 0;
  private held = 0;
  private coldStarts = 0;
  private succeeded = 0;
  private failed = 0;
  private throttled = 0;
  private pushed = 0;
  private staleAcks = 0;
  private started = 0;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
    const i = init.inputs;
    this.limit = i["concurrency"] as number;
    this.prices = {
      busy: i["costPerBusySecond"] as number,
      provisioned: i["costPerProvisionedSecond"] as number,
      request: i["costPerRequest"] as number,
    };
    this.serviceTime = this.makeSampler(asSampler(i["serviceTime"]), "serviceTime");
    this.coldStart = this.makeSampler(asSampler(i["coldStartTime"]), "coldStartTime");
    this.failureDraw = this.makeSampler({ dist: "uniform", min: 0, max: 1 }, "failure");
    this.failureProbability = i["failureProbability"] as number;
    this.hold = i["holdUntilRelease"] as boolean;
    this.cpuRatio = i["cpuOversubscription"] as number;
    const timeout = i["idleTimeout"] as number | undefined;
    this.idleTimeoutTicks = timeout === undefined ? undefined : ctx.kernel.secondsToTicks(timeout);
    this.busyStat = new TimeWeightedStat(ctx.kernel.currentTick, 0);
    this.busyLifetime = new TimeWeightedStat(ctx.kernel.currentTick, 0);
    this.limitStat = new TimeWeightedStat(ctx.kernel.currentTick, this.limit);
    const warm = Math.min(i["initialWarm"] as number, this.limit);
    for (let w = 0; w < warm; w++) this.idle.push(ctx.kernel.currentTick);
  }

  private get now(): number {
    return this.ctx.kernel.currentTick;
  }

  /** Workers that may be busy now. */
  private get available(): number {
    return Math.max(0, this.limit + this.adjustment);
  }

  /** Current nominal concurrency limit (see {@link Scalable}). */
  get concurrency(): number {
    return this.limit;
  }

  /**
   * Change the concurrency limit. Raising it starts queued work immediately; lowering it never
   * interrupts running work, the pool just stops starting new work until busy workers drop below it.
   */
  setConcurrency(n: number): void {
    this.limit = Math.max(1, Math.floor(n));
    this.capacityChanged();
  }

  /** See {@link Scalable}. Taking workers away never interrupts running work, as with lowering the limit. */
  adjustCapacity(workers: number): void {
    this.adjustment += workers;
    this.capacityChanged();
  }

  private capacityChanged(): void {
    this.limitStat.set(this.now, this.available);
    this.recordCpu();
    this.queueHasEntity();
  }

  /** Cumulative busy-worker-ticks since time 0 (not affected by the warm-up reset). */
  busyWorkerTicks(): number {
    return this.busyLifetime.integral(this.now);
  }

  /** Charges over the measured window (see the `Cost` output). */
  cost(): number {
    const tps = this.ctx.kernel.ticksPerSecond;
    const busySeconds = this.busyStat.integral(this.now) / tps;
    const provisionedSeconds = this.limitStat.integral(this.now) / tps;
    return busySeconds * this.prices.busy + provisionedSeconds * this.prices.provisioned + this.started * this.prices.request;
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
    if (this.busy >= this.available) {
      this.throttled++;
      this.onThrottle?.addEntity(entity);
      return;
    }
    this.begin(entity, null);
  }

  /** Pull mode: fill free workers from the queue. */
  queueHasEntity(): void {
    while (this.source !== null && this.busy < this.available) {
      const lease = this.source.receive();
      if (lease === null) break;
      this.begin(lease.entity, lease);
    }
  }

  private begin(entity: MovingEntity, lease: Lease | null): void {
    this.noteAdded();
    this.started++;
    this.setBusy(this.busy + 1);
    const stretch = this.cpuStretch();
    this.stretchTotal += stretch;
    let seconds = Math.max(0, this.serviceTime.nextSample()) * stretch;
    if (!this.takeWarmInstance()) {
      this.coldStarts++;
      seconds += Math.max(0, this.coldStart.nextSample());
    }
    this.ctx.kernel.schedule(this.secondsToTicks(seconds), Priority.DEFAULT, () => this.end(entity, lease));
  }

  /**
   * How much the CPU limit slows a request starting now.
   * ponytail: fixed when service starts (the mean matches processor sharing, see the M/M/1-PS test) and fluid, so no
   * 100 ms CFS periods; re-time in-flight work if tail latency under throttling matters.
   */
  private cpuStretch(): number {
    if (this.cpuRatio <= 1) return 1;
    return Math.max(1, ((this.busy - this.held) / this.available) * this.cpuRatio);
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
    const failed = this.failureProbability > 0 && this.failureDraw.nextSample() < this.failureProbability;
    if (!failed && this.hold) {
      this.setBusy(this.busy, this.held + 1);
      (entity.holds ??= []).push(() => this.release());
    } else {
      this.freeWorker();
    }
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

  private freeWorker(): void {
    this.idle.push(this.now);
    this.setBusy(this.busy - 1);
  }

  /** A Release freed a held worker: the response came back. */
  private release(): void {
    this.held--;
    this.freeWorker();
    this.queueHasEntity();
  }

  private setBusy(n: number, held = this.held): void {
    this.busy = n;
    this.held = held;
    this.busyStat.set(this.now, n);
    this.recordCpu();
    this.setState(n === 0 ? "Idle" : "Busy");
  }

  /** The Autoscaler's CPU proxy: a held worker is waiting for a response, and CPU use stops at the limit. */
  private recordCpu(): void {
    const computing = this.busy - this.held;
    this.busyLifetime.set(this.now, this.cpuRatio > 1 ? Math.min(computing, this.available / this.cpuRatio) : computing);
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.busyStat.reset(this.now);
    this.limitStat.reset(this.now);
    this.started = 0;
    this.stretchTotal = 0;
    this.coldStarts = 0;
    this.succeeded = 0;
    this.failed = 0;
    this.throttled = 0;
    this.pushed = 0;
    this.staleAcks = 0;
  }
}
