import { Priority } from "../kernel/index.js";
import { LinkedComponent, type ComponentInit, type SimContext } from "../model/index.js";
import type { ComponentSchema } from "../schema/index.js";
import type { Scalable } from "./autoscaler.js";

/**
 * Replaces a WorkerPool's pods once, at time `at`, under the Kubernetes Deployment controller's rules: at most
 * `maxSurge` pods above the desired count and at most `maxUnavailable` below it. A new pod serves after
 * `readinessDelay`; an old pod takes no new work once it is removed, and finishes what it is running.
 *
 * Fractions resolve against the pods at `at`, so an autoscaled pool uses its size then: surge rounds up, unavailable
 * rounds down, and if both come to 0, unavailable is 1 so that the update makes progress. `Recreate` is
 * `maxUnavailableFraction: 1`. An Autoscaler keeps working from the pool's nominal size during the update.
 */
export class RollingUpdate extends LinkedComponent {
  static readonly schema: ComponentSchema<RollingUpdate> = {
    type: "RollingUpdate",
    description: "Replaces a WorkerPool's pods once at a given time, within maxSurge and maxUnavailable, like a Kubernetes Deployment rollout.",
    roles: [],
    inputs: [
      { key: "at", type: "number", unit: "time", min: 0, required: true, description: "Seconds into the run at which the update starts." },
      { key: "readinessDelay", type: "number", unit: "time", min: 0, default: 0, required: false, description: "Seconds from a new pod being created to it taking work." },
      { key: "podSize", type: "integer", unit: "dimensionless", min: 1, default: 1, required: false, description: "Workers per pod." },
      { key: "maxSurge", type: "integer", unit: "dimensionless", min: 0, default: 0, required: false, description: "Pods allowed above the desired count." },
      { key: "maxSurgeFraction", type: "number", unit: "dimensionless", min: 0, default: 0, required: false, description: "Added to maxSurge: this share of the pods at the start, rounded up." },
      { key: "maxUnavailable", type: "integer", unit: "dimensionless", min: 0, default: 0, required: false, description: "Pods allowed below the desired count." },
      { key: "maxUnavailableFraction", type: "number", unit: "dimensionless", min: 0, max: 1, default: 0, required: false, description: "Added to maxUnavailable: this share of the pods at the start, rounded down." },
    ],
    links: [{ key: "target", description: "The WorkerPool to update.", required: true, accepts: "scalable" }],
    outputs: [
      { key: "PodsReplaced", unit: "dimensionless", description: "Old pods removed so far.", get: (r) => r.replaced },
      { key: "RolloutSeconds", unit: "time", description: "How long the update took; not a number until it finishes.", get: (r) => r.rolloutSeconds },
    ],
  };

  private readonly atTicks: number;
  private readonly delayTicks: number;
  private readonly podSize: number;
  private readonly surgePods: number;
  private readonly surgeFraction: number;
  private readonly unavailablePods: number;
  private readonly unavailableFraction: number;
  private pool: Scalable | null = null;
  private maxSurge = 0;
  private maxUnavailable = 0;
  /** Old pods still serving. */
  private old = 0;
  /** New pods still to create. */
  private toCreate = 0;
  /** New pods created but not ready. */
  private pending = 0;
  /** New pods ready minus old pods removed: serving pods relative to the desired count. */
  private surplus = 0;
  /** The surplus the pool has been told about. */
  private applied = 0;
  private replaced = 0;
  private rolloutSeconds = NaN;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
    const i = init.inputs;
    this.atTicks = ctx.kernel.secondsToTicks(i["at"] as number);
    this.delayTicks = ctx.kernel.secondsToTicks(i["readinessDelay"] as number);
    this.podSize = i["podSize"] as number;
    this.surgePods = i["maxSurge"] as number;
    this.surgeFraction = i["maxSurgeFraction"] as number;
    this.unavailablePods = i["maxUnavailable"] as number;
    this.unavailableFraction = i["maxUnavailableFraction"] as number;
  }

  override setLink(key: string, target: LinkedComponent): void {
    if (key === "target") this.pool = target as unknown as Scalable;
    else super.setLink(key, target);
  }

  override start(): void {
    if (this.pool !== null) this.ctx.kernel.schedule(this.atTicks, Priority.HIGH, () => this.begin());
  }

  private begin(): void {
    const pods = Math.ceil((this.pool as Scalable).concurrency / this.podSize);
    this.maxSurge = this.surgePods + Math.ceil(this.surgeFraction * pods);
    this.maxUnavailable = this.unavailablePods + Math.floor(this.unavailableFraction * pods);
    if (this.maxSurge === 0 && this.maxUnavailable === 0) this.maxUnavailable = 1;
    this.old = pods;
    this.toCreate = pods;
    this.setState("Rolling");
    this.advance();
  }

  /** Create and remove every pod the limits allow, then apply the net change at once, so capacity never overshoots. */
  private advance(): void {
    for (;;) {
      if (this.toCreate > 0 && this.surplus + this.pending < this.maxSurge) {
        this.toCreate--;
        this.pending++;
        this.ctx.kernel.schedule(this.delayTicks, Priority.HIGH, () => {
          this.pending--;
          this.surplus++;
          this.advance();
        });
      } else if (this.old > 0 && this.surplus > -this.maxUnavailable) {
        this.old--;
        this.surplus--;
        this.replaced++;
      } else {
        break;
      }
    }
    if (this.surplus !== this.applied) {
      (this.pool as Scalable).adjustCapacity((this.surplus - this.applied) * this.podSize);
      this.applied = this.surplus;
    }
    if (this.old === 0 && this.pending === 0 && this.toCreate === 0) {
      this.rolloutSeconds = this.ctx.kernel.ticksToSeconds(this.ctx.kernel.currentTick - this.atTicks);
      this.setState("Idle");
    }
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.replaced = 0;
  }
}
