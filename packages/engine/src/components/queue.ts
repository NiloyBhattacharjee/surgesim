import { FifoBuffer, LinkedComponent, type ComponentInit, type MovingEntity, type SimContext } from "../model/index.js";
import { Tally, TimeWeightedStat } from "../stats/index.js";
import type { ComponentSchema } from "../schema/index.js";

/** Something that wants to be told when a queue has entities available. */
export interface QueueWaiter {
  queueHasEntity(): void;
}

/**
 * FIFO queue with an optional maximum length. Arrivals beyond `maxLength` are dropped and counted.
 * Servers pull entities with {@link Queue.poll}; waiting servers are notified on arrival.
 */
export class Queue extends LinkedComponent {
  static readonly schema: ComponentSchema<Queue> = {
    type: "Queue",
    description: "FIFO queue with an optional capacity. Arrivals beyond maxLength are dropped and counted.",
    roles: ["receiver", "queue"],
    inputs: [
      { key: "maxLength", type: "integer", unit: "dimensionless", min: 1, required: false, description: "Maximum number of waiting entities. Unlimited if omitted." },
    ],
    links: [],
    outputs: [
      { key: "QueueLength", unit: "dimensionless", series: true, description: "Entities currently waiting.", get: (q) => q.length },
      { key: "AverageQueueLength", unit: "dimensionless", description: "Time-weighted average number waiting.", get: (q) => q.lengthStat.mean(q.now) },
      { key: "MaxQueueLength", unit: "dimensionless", description: "Largest number waiting.", get: (q) => q.lengthStat.max(q.now) },
      { key: "AverageQueueTime", unit: "time", description: "Mean time an entity waited before leaving the queue.", get: (q) => q.waitTally.mean() },
      { key: "NumberDropped", unit: "dimensionless", description: "Arrivals rejected because the queue was full.", get: (q) => q.dropped },
    ],
  };

  private readonly items = new FifoBuffer<{ entity: MovingEntity; enteredAt: number }>();
  private readonly waiters: QueueWaiter[] = [];
  private readonly maxLength: number | undefined;
  private readonly lengthStat: TimeWeightedStat;
  private readonly waitTally = new Tally();
  private dropped = 0;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Empty");
    this.maxLength = init.inputs["maxLength"] as number | undefined;
    this.lengthStat = new TimeWeightedStat(ctx.kernel.currentTick, 0);
  }

  private get now(): number {
    return this.ctx.kernel.currentTick;
  }

  /** Entities currently waiting. */
  get length(): number {
    return this.items.length;
  }

  /** Register a server to be notified whenever an entity is enqueued. */
  addWaiter(waiter: QueueWaiter): void {
    this.waiters.push(waiter);
  }

  override addEntity(entity: MovingEntity): void {
    if (this.maxLength !== undefined && this.items.length >= this.maxLength) {
      this.dropped++;
      return;
    }
    this.noteAdded();
    this.items.push({ entity, enteredAt: this.now });
    this.lengthChanged();
    for (const w of this.waiters) {
      if (this.items.length === 0) break;
      w.queueHasEntity();
    }
  }

  /** Remove and return the oldest waiting entity, or null if empty. */
  poll(): MovingEntity | null {
    const item = this.items.shift();
    if (item === undefined) return null;
    this.waitTally.add(this.ctx.kernel.ticksToSeconds(this.now - item.enteredAt));
    this.lengthChanged();
    this.noteCompleted();
    return item.entity;
  }

  private lengthChanged(): void {
    this.lengthStat.set(this.now, this.items.length);
    this.setState(this.items.length === 0 ? "Empty" : "NonEmpty");
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.lengthStat.reset(this.now);
    this.waitTally.reset();
    this.dropped = 0;
  }
}
