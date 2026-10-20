import { LinkedComponent, type ComponentInit, type MovingEntity, type SimContext } from "../model/index.js";
import type { Rng } from "../rng/index.js";
import type { ComponentSchema } from "../schema/index.js";

/**
 * Pub/sub topic (SNS-style fan-out). Each published entity is delivered, as a copy, to every
 * subscriber whose filter it passes; copies keep the original creation time, so a sink downstream
 * measures end-to-end latency. Delivery is instantaneous. Subscriber `i` passes with probability
 * `filterProbabilities[i]` (default 1: every copy is delivered).
 */
export class Topic extends LinkedComponent {
  static readonly schema: ComponentSchema<Topic> = {
    type: "Topic",
    description: "Pub/sub fan-out: delivers a copy of each entity to every subscriber.",
    roles: ["receiver"],
    inputs: [
      { key: "filterProbabilities", type: "numberList", unit: "dimensionless", min: 0, max: 1, lengthOf: "subscribers", required: false, description: "One probability per subscriber that a message passes its filter policy (default: all pass)." },
    ],
    links: [
      { key: "subscribers", description: "Where copies are delivered, in order.", required: true, accepts: "receiver", multiple: true },
    ],
    outputs: [
      { key: "NumberPublished", unit: "dimensionless", description: "Entities published to the topic.", get: (t) => t.numberAdded },
      { key: "NumberDelivered", unit: "dimensionless", description: "Copies delivered to subscribers.", get: (t) => t.delivered },
      { key: "NumberFiltered", unit: "dimensionless", description: "Copies a subscription's filter dropped.", get: (t) => t.filtered },
    ],
  };

  private readonly subscribers: LinkedComponent[] = [];
  private readonly filter: readonly number[] | undefined;
  private readonly rng: Rng;
  private delivered = 0;
  private filtered = 0;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
    this.filter = init.inputs["filterProbabilities"] as number[] | undefined;
    this.rng = ctx.rng(`${this.stream}/filter`);
  }

  override setLink(key: string, target: LinkedComponent): void {
    if (key === "subscribers") this.subscribers.push(target);
    else super.setLink(key, target);
  }

  override addEntity(entity: MovingEntity): void {
    this.noteAdded();
    this.noteCompleted();
    this.subscribers.forEach((s, i) => {
      const p = this.filter?.[i] ?? 1;
      if (p < 1 && this.rng.nextFloat() >= p) {
        this.filtered++;
        return;
      }
      this.delivered++;
      s.addEntity(this.ctx.copyEntity(entity));
    });
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.delivered = 0;
    this.filtered = 0;
  }
}
