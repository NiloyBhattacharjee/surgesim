import { LinkedComponent, type ComponentInit, type MovingEntity, type SimContext } from "../model/index.js";
import type { ComponentSchema } from "../schema/index.js";

/**
 * Frees every worker slot an entity holds (WorkerPools with `holdUntilRelease`), then passes it to `next`, instantly.
 * Put one where a synchronous call's response goes back: where the request completes, or before an asynchronous
 * hop the callers do not wait for. Calls are exclusive and nothing happens after a response returns, so at that
 * point every waiting caller has its response, and all of them are freed at once.
 */
export class Release extends LinkedComponent {
  static readonly schema: ComponentSchema<Release> = {
    type: "Release",
    description: "Frees the worker slots an entity holds (WorkerPool holdUntilRelease), then passes it on.",
    roles: ["receiver"],
    inputs: [],
    links: [{ key: "next", description: "Where entities go once their slots are freed.", required: false, accepts: "receiver" }],
    outputs: [
      { key: "NumberReleased", unit: "dimensionless", description: "Worker slots freed.", get: (r) => r.released },
    ],
  };

  private released = 0;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
  }

  override addEntity(entity: MovingEntity): void {
    this.noteAdded();
    const holds = entity.holds;
    if (holds !== undefined) {
      entity.holds = undefined;
      this.released += holds.length;
      for (const free of holds) free();
    }
    this.sendToNext(entity);
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.released = 0;
  }
}
