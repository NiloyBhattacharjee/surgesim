import { LinkedComponent, type ComponentInit, type MovingEntity, type SimContext } from "../model/index.js";
import type { Rng } from "../rng/index.js";
import type { ComponentSchema } from "../schema/index.js";

/**
 * Probabilistic router. Each entity goes to exactly one target, chosen with `probabilities[i]`
 * (which add up to 1), instantly. Unlike a Topic it moves the entity rather than copying it, so a
 * call graph like "60% of frontend requests call orders-api, the rest finish" is a Branch to
 * `[orders-api, done]` with `[0.6, 0.4]`. Draws use the branch's own RNG stream.
 */
export class Branch extends LinkedComponent {
  static readonly schema: ComponentSchema<Branch> = {
    type: "Branch",
    description: "Probabilistic router: sends each entity to one target, chosen with the given probabilities.",
    roles: ["receiver"],
    inputs: [
      { key: "probabilities", type: "numberList", unit: "dimensionless", min: 0, max: 1, lengthOf: "targets", sum: 1, required: true, description: "One probability per target; they must add up to 1." },
    ],
    links: [
      { key: "targets", description: "Where entities are routed, in the same order as probabilities.", required: true, accepts: "receiver", multiple: true },
    ],
    outputs: [
      { key: "NumberRouted", unit: "dimensionless", description: "Entities routed.", get: (b) => b.numberAdded },
    ],
  };

  private readonly targets: LinkedComponent[] = [];
  private readonly cumulative: number[];
  private readonly rng: Rng;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
    let total = 0;
    this.cumulative = (init.inputs["probabilities"] as number[]).map((p) => (total += p));
    this.rng = ctx.rng(`${this.stream}/route`);
  }

  override setLink(key: string, target: LinkedComponent): void {
    if (key === "targets") this.targets.push(target);
    else super.setLink(key, target);
  }

  override addEntity(entity: MovingEntity): void {
    this.noteAdded();
    this.noteCompleted();
    const u = this.rng.nextFloat();
    const i = this.cumulative.findIndex((c) => u < c);
    // Rounding can leave the last cumulative value a hair below 1: fall back to the last target.
    (this.targets[i === -1 ? this.targets.length - 1 : i] as LinkedComponent).addEntity(entity);
  }
}
