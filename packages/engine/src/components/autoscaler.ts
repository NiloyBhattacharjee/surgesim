import { Priority } from "../kernel/index.js";
import { LinkedComponent, type ComponentInit, type SimContext } from "../model/index.js";
import type { ComponentSchema } from "../schema/index.js";

/** Something whose concurrency an {@link Autoscaler} can change (a WorkerPool). */
export interface Scalable {
  readonly concurrency: number;
  setConcurrency(n: number): void;
  /** Cumulative busy-worker-ticks since time 0, unaffected by the warm-up statistics reset. */
  busyWorkerTicks(): number;
}

/**
 * Target-tracking autoscaler for a WorkerPool (like AWS target tracking or a Kubernetes HPA).
 *
 * Every `evaluationInterval` seconds it measures the average number of busy workers over that
 * interval and computes `desired = ceil(averageBusy / targetUtilisation)`, rounded up to a multiple of
 * `step` and clamped to `[minConcurrency, maxConcurrency]`. With `step` set to the workers per pod, this is
 * the Kubernetes HPA formula `ceil(currentReplicas * currentUtilisation / target)` in whole pods.
 *
 * - **Scale out** takes effect after `scaleUpDelay` seconds (provisioning time). While a scale-out is
 *   pending, only a larger desired value schedules another.
 * - **Scale in** is immediate but only allowed `scaleDownCooldown` seconds after the last scaling
 *   change, so a brief lull does not shed capacity that a spike needs a minute later.
 * - With `scaleDownStabilisation` set, scale in follows the Kubernetes HPA rule instead of the cooldown:
 *   scale in to the highest desired value of the last `scaleDownStabilisation` seconds.
 *
 * Because saturation caps measured busy workers at the current limit, a saturated pool grows by
 * a factor of `1 / targetUtilisation` per evaluation until demand is met.
 */
export class Autoscaler extends LinkedComponent {
  static readonly schema: ComponentSchema<Autoscaler> = {
    type: "Autoscaler",
    description: "Target-tracking autoscaler: resizes a WorkerPool's concurrency from its measured utilisation.",
    roles: [],
    inputs: [
      { key: "targetUtilisation", type: "number", unit: "dimensionless", min: 0.05, max: 1, default: 0.6, required: false, description: "Busy workers / concurrency to aim for." },
      { key: "evaluationInterval", type: "number", unit: "time", min: 0.000001, default: 60, required: false, description: "Seconds between scaling decisions (and the metric averaging window)." },
      { key: "minConcurrency", type: "integer", unit: "dimensionless", min: 1, default: 1, required: false, description: "Never scale below this." },
      { key: "maxConcurrency", type: "integer", unit: "dimensionless", min: 1, required: true, description: "Never scale above this." },
      { key: "scaleUpDelay", type: "number", unit: "time", min: 0, default: 0, required: false, description: "Seconds before added capacity becomes available." },
      { key: "scaleDownCooldown", type: "number", unit: "time", min: 0, default: 300, required: false, description: "Minimum seconds since the last scaling change before scaling in." },
      { key: "scaleDownStabilisation", type: "number", unit: "time", min: 0, required: false, description: "Kubernetes HPA scale-down stabilisation window (seconds): scale in to the highest desired value within this window. Replaces scaleDownCooldown when set." },
      { key: "step", type: "integer", unit: "dimensionless", min: 1, default: 1, required: false, description: "Scale in whole multiples of this many workers (e.g. requests per pod)." },
    ],
    links: [{ key: "target", description: "The WorkerPool to scale.", required: true, accepts: "scalable" }],
    outputs: [
      { key: "ScaleOuts", unit: "dimensionless", description: "Scale-out decisions applied.", get: (a) => a.scaleOuts },
      { key: "ScaleIns", unit: "dimensionless", description: "Scale-in decisions applied.", get: (a) => a.scaleIns },
      { key: "DesiredConcurrency", unit: "dimensionless", series: true, description: "The most recent desired concurrency.", get: (a) => a.desired },
    ],
  };

  private readonly targetUtilisation: number;
  private readonly intervalTicks: number;
  private readonly min: number;
  private readonly max: number;
  private readonly upDelayTicks: number;
  private readonly cooldownTicks: number;
  private readonly stabilisationTicks: number | undefined;
  private readonly step: number;
  /**
   * Monotonic deque of [tick, desired] recommendations inside the stabilisation window: oldest first,
   * desired strictly decreasing, so the window maximum is at `head`. Entries before `head` are expired.
   */
  private recommendations: [number, number][] = [];
  private head = 0;
  private pool: Scalable | null = null;
  private lastBusyTicks = 0;
  private lastEvalTick: number;
  private lastChangeTick = Number.NEGATIVE_INFINITY;
  private pendingTarget = 0;
  private desired = 0;
  private scaleOuts = 0;
  private scaleIns = 0;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
    const i = init.inputs;
    const k = ctx.kernel;
    this.targetUtilisation = i["targetUtilisation"] as number;
    this.intervalTicks = Math.max(1, k.secondsToTicks(i["evaluationInterval"] as number));
    this.min = i["minConcurrency"] as number;
    this.max = Math.max(this.min, i["maxConcurrency"] as number);
    this.upDelayTicks = k.secondsToTicks(i["scaleUpDelay"] as number);
    this.cooldownTicks = k.secondsToTicks(i["scaleDownCooldown"] as number);
    const window = i["scaleDownStabilisation"] as number | undefined;
    this.stabilisationTicks = window === undefined ? undefined : k.secondsToTicks(window);
    this.step = i["step"] as number;
    this.lastEvalTick = k.currentTick;
  }

  override setLink(key: string, target: LinkedComponent): void {
    if (key === "target") this.pool = target as unknown as Scalable;
    else super.setLink(key, target);
  }

  override start(): void {
    if (this.pool === null) return;
    this.desired = this.pool.concurrency;
    this.pendingTarget = this.pool.concurrency;
    this.lastBusyTicks = this.pool.busyWorkerTicks();
    this.ctx.kernel.schedule(this.intervalTicks, Priority.LOW, () => this.evaluate());
  }

  /**
   * Like the HPA: the highest recommendation newer than `now - window`, always including this one.
   * Amortised O(1) per evaluation, however long the window.
   */
  private windowMax(now: number, desired: number, window: number): number {
    const recs = this.recommendations;
    // A newer recommendation at least as high makes older, lower ones irrelevant for the rest of their life.
    while (recs.length > this.head && (recs[recs.length - 1] as [number, number])[1] <= desired) recs.pop();
    recs.push([now, desired]);
    while ((recs[this.head] as [number, number])[0] <= now - window && recs.length - this.head > 1) this.head++;
    if (this.head > 1024 && this.head * 2 > recs.length) {
      this.recommendations = recs.slice(this.head);
      this.head = 0;
    }
    return (this.recommendations[this.head] as [number, number])[1];
  }

  private evaluate(): void {
    const pool = this.pool as Scalable;
    const k = this.ctx.kernel;
    const now = k.currentTick;
    const busyTicks = pool.busyWorkerTicks();
    const averageBusy = (busyTicks - this.lastBusyTicks) / Math.max(1, now - this.lastEvalTick);
    this.lastBusyTicks = busyTicks;
    this.lastEvalTick = now;

    const steps = Math.ceil(averageBusy / this.targetUtilisation / this.step - 1e-9);
    const desired = Math.min(this.max, Math.max(this.min, steps * this.step));
    this.desired = desired;
    const current = pool.concurrency;
    let scaleInTo = desired;
    let scaleInAllowed = now - this.lastChangeTick >= this.cooldownTicks;
    if (this.stabilisationTicks !== undefined) {
      scaleInTo = this.windowMax(now, desired, this.stabilisationTicks);
      scaleInAllowed = true;
    }
    if (desired > Math.max(current, this.pendingTarget)) {
      this.pendingTarget = desired;
      this.setState("ScalingOut");
      k.schedule(this.upDelayTicks, Priority.HIGH, () => {
        if (desired > pool.concurrency) {
          pool.setConcurrency(desired);
          this.scaleOuts++;
          this.lastChangeTick = k.currentTick;
        }
        this.pendingTarget = pool.concurrency;
        this.setState("Idle");
      });
    } else if (scaleInTo < current && this.pendingTarget <= current && scaleInAllowed) {
      pool.setConcurrency(scaleInTo);
      this.pendingTarget = scaleInTo;
      this.scaleIns++;
      this.lastChangeTick = now;
    }
    k.schedule(this.intervalTicks, Priority.LOW, () => this.evaluate());
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.scaleOuts = 0;
    this.scaleIns = 0;
  }
}
