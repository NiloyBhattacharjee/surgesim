import { Priority } from "../kernel/index.js";
import { LinkedComponent, type ComponentInit, type MovingEntity, type SimContext } from "../model/index.js";
import { TimeWeightedStat } from "../stats/index.js";
import { asSampler, type ComponentSchema } from "../schema/index.js";
import type { SampleProvider } from "../rng/index.js";
import type { Queue, QueueWaiter } from "./queue.js";

/**
 * A pool of `capacity` parallel workers pulling from a Queue. A worker that starts an entity
 * schedules `endStep` after the sampled service time; on endStep it sends the entity to `next`
 * and pulls the next entity, or goes idle.
 */
export class Server extends LinkedComponent implements QueueWaiter {
  static readonly schema: ComponentSchema<Server> = {
    type: "Server",
    description: "Pool of parallel workers that pull entities from a queue, serve them, and pass them on.",
    roles: [],
    inputs: [
      { key: "capacity", type: "integer", unit: "dimensionless", min: 1, default: 1, required: false, description: "Number of parallel workers." },
      { key: "serviceTime", type: "sampler", unit: "time", min: 0, required: true, description: "Service time per entity (seconds)." },
    ],
    links: [
      { key: "queue", description: "Queue this server pulls from.", required: true, accepts: "queue" },
      { key: "next", description: "Where served entities are sent.", required: false, accepts: "receiver" },
    ],
    outputs: [
      { key: "Utilisation", unit: "dimensionless", description: "Time-weighted busy workers / capacity.", get: (s) => s.busyStat.mean(s.now) / s.capacity },
      { key: "AverageBusyWorkers", unit: "dimensionless", description: "Time-weighted average number of busy workers.", get: (s) => s.busyStat.mean(s.now) },
      { key: "BusyWorkers", unit: "dimensionless", series: true, description: "Workers currently busy.", get: (s) => s.busy },
    ],
  };

  private readonly capacity: number;
  private readonly serviceTime: SampleProvider;
  private readonly busyStat: TimeWeightedStat;
  private queue: Queue | null = null;
  private busy = 0;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
    this.capacity = init.inputs["capacity"] as number;
    this.serviceTime = this.makeSampler(asSampler(init.inputs["serviceTime"]), "serviceTime");
    this.busyStat = new TimeWeightedStat(ctx.kernel.currentTick, 0);
  }

  private get now(): number {
    return this.ctx.kernel.currentTick;
  }

  override setLink(key: string, target: LinkedComponent): void {
    if (key === "queue") {
      this.queue = target as Queue;
      this.queue.addWaiter(this);
    } else {
      super.setLink(key, target);
    }
  }

  queueHasEntity(): void {
    while (this.busy < this.capacity && this.startNext()) {
      /* fill idle workers */
    }
  }

  /** Pull one entity from the queue onto a worker. Returns false if the queue was empty. */
  private startNext(): boolean {
    const entity = this.queue?.poll() ?? null;
    if (entity === null) return false;
    this.noteAdded();
    this.setBusy(this.busy + 1);
    this.ctx.kernel.schedule(this.secondsToTicks(this.serviceTime.nextSample()), Priority.DEFAULT, () =>
      this.endStep(entity),
    );
    return true;
  }

  private endStep(entity: MovingEntity): void {
    this.setBusy(this.busy - 1);
    this.sendToNext(entity);
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
  }
}
