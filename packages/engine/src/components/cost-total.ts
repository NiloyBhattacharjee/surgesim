import { LinkedComponent, type ComponentInit, type SimContext } from "../model/index.js";
import type { ComponentSchema } from "../schema/index.js";

/** Something with a `Cost` output a {@link CostTotal} can add up (role `costed`: WorkerPool, MessageQueue). */
export interface Costed {
  /** Charges over the measured window (after warm-up), in the model's cost unit. */
  cost(): number;
}

/**
 * Adds up the `Cost` of its `sources`, so one output (and one assertion) covers a whole budget: money, or tokens
 * when the pools' prices are token counts. Entities never pass through it.
 */
export class CostTotal extends LinkedComponent {
  static readonly schema: ComponentSchema<CostTotal> = {
    type: "CostTotal",
    description: "Adds up the Cost of the components it links to, for one budget output.",
    roles: [],
    inputs: [],
    links: [{ key: "sources", description: "Components whose Cost is added up.", required: true, accepts: "costed", multiple: true }],
    outputs: [
      { key: "Cost", unit: "cost", description: "Sum of the sources' Cost over the measured window.", get: (t) => t.sources.reduce((s, c) => s + c.cost(), 0) },
    ],
  };

  private readonly sources: Costed[] = [];

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
  }

  override setLink(key: string, target: LinkedComponent): void {
    if (key === "sources") this.sources.push(target as unknown as Costed);
    else super.setLink(key, target);
  }
}
