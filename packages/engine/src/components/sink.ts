import { LinkedComponent, type ComponentInit, type MovingEntity, type SimContext } from "../model/index.js";
import { ExactPercentileTracker, type PercentileTracker } from "../stats/index.js";
import type { ComponentSchema } from "../schema/index.js";

/** Consumes entities and records each one's time in system (now - creation time). */
export class EntitySink extends LinkedComponent {
  static readonly schema: ComponentSchema<EntitySink> = {
    type: "EntitySink",
    description: "Consumes entities and records their time in system.",
    roles: ["receiver"],
    inputs: [],
    links: [],
    outputs: [
      { key: "count", unit: "dimensionless", description: "Entities received.", get: (s) => s.times.count },
      { key: "mean", unit: "time", description: "Mean time in system.", get: (s) => s.times.mean() },
      { key: "p50", unit: "time", description: "Median time in system.", get: (s) => s.times.percentile(50) },
      { key: "p95", unit: "time", description: "95th percentile time in system.", get: (s) => s.times.percentile(95) },
      { key: "p99", unit: "time", description: "99th percentile time in system.", get: (s) => s.times.percentile(99) },
    ],
  };

  /** Swappable for an approximate streaming sketch later. */
  private readonly times: PercentileTracker = new ExactPercentileTracker();

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
  }

  override addEntity(entity: MovingEntity): void {
    this.noteAdded();
    const k = this.ctx.kernel;
    this.times.add(k.ticksToSeconds(k.currentTick - entity.createdAt));
    this.noteCompleted();
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.times.reset();
  }
}
