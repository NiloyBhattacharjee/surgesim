import { Priority } from "../kernel/index.js";
import { LinkedComponent, type ComponentInit, type MovingEntity, type SimContext } from "../model/index.js";
import type { SampleProvider } from "../rng/index.js";
import type { ComponentSchema } from "../schema/index.js";

/**
 * Retries failed attempts with exponential backoff and jitter.
 *
 * Wiring: send entities *into* the RetryPolicy, point `next` at the thing that can fail (a
 * WorkerPool), and point that thing's `onFailure` / `onThrottle` links back at the RetryPolicy. The
 * first time an entity arrives it is a fresh request and is forwarded immediately. If it comes back
 * it is a failed attempt: after a backoff delay it is forwarded again, until `maxAttempts` attempts
 * have been made, at which point it goes to `giveUp` (or is dropped and counted).
 *
 * The attempt count lives on the entity, so an entity should pass through a given RetryPolicy once.
 *
 * Delay before retry n (n = attempts made so far, starting at 1):
 * `d = min(maxDelay, baseDelay * multiplier^(n-1))`, then jitter: `none` uses d, `full` draws
 * uniformly from [0, d], `equal` draws from [d/2, d] (the AWS Architecture Blog definitions).
 */
export class RetryPolicy extends LinkedComponent {
  static readonly schema: ComponentSchema<RetryPolicy> = {
    type: "RetryPolicy",
    description: "Retries failed attempts with exponential backoff and jitter, then gives up.",
    roles: ["receiver"],
    inputs: [
      { key: "maxAttempts", type: "integer", unit: "dimensionless", min: 1, default: 3, required: false, description: "Total attempts including the first." },
      { key: "baseDelay", type: "number", unit: "time", min: 0, default: 0.1, required: false, description: "Delay before the first retry (seconds)." },
      { key: "multiplier", type: "number", unit: "dimensionless", min: 1, default: 2, required: false, description: "Backoff growth factor per retry." },
      { key: "maxDelay", type: "number", unit: "time", min: 0, required: false, description: "Cap on the delay before jitter (seconds). Uncapped if omitted." },
      { key: "jitter", type: "enum", unit: "dimensionless", options: ["none", "full", "equal"], default: "full", required: false, description: "Randomisation of each delay." },
    ],
    links: [
      { key: "next", description: "Where each attempt is sent (the thing that can fail).", required: true, accepts: "receiver" },
      { key: "giveUp", description: "Where entities go after exhausting maxAttempts. Dropped and counted if omitted.", required: false, accepts: "receiver" },
    ],
    outputs: [
      { key: "NumberRequests", unit: "dimensionless", description: "Fresh requests received.", get: (r) => r.requests },
      { key: "NumberAttempts", unit: "dimensionless", description: "Attempts sent to next (first attempts plus retries).", get: (r) => r.attempts },
      { key: "NumberRetries", unit: "dimensionless", description: "Retries scheduled.", get: (r) => r.retries },
      { key: "NumberGivenUp", unit: "dimensionless", description: "Requests that exhausted maxAttempts.", get: (r) => r.givenUp },
      { key: "RetryAmplification", unit: "dimensionless", description: "Attempts per fresh request: the load multiplier retries put on the downstream.", get: (r) => (r.requests === 0 ? NaN : r.attempts / r.requests) },
      { key: "Retrying", unit: "dimensionless", series: true, description: "Requests currently waiting out a backoff delay.", get: (r) => r.waiting },
    ],
  };

  private readonly attemptKey: string;
  private readonly maxAttempts: number;
  private readonly baseDelay: number;
  private readonly multiplier: number;
  private readonly maxDelay: number;
  private readonly jitter: string;
  private readonly unit: SampleProvider;
  private giveUpTarget: LinkedComponent | null = null;
  private requests = 0;
  private attempts = 0;
  private retries = 0;
  private givenUp = 0;
  private waiting = 0;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
    const i = init.inputs;
    this.attemptKey = `retry:${init.name}`;
    this.maxAttempts = i["maxAttempts"] as number;
    this.baseDelay = i["baseDelay"] as number;
    this.multiplier = i["multiplier"] as number;
    this.maxDelay = (i["maxDelay"] as number | undefined) ?? Infinity;
    this.jitter = i["jitter"] as string;
    this.unit = this.makeSampler({ dist: "uniform", min: 0, max: 1 }, "jitter");
  }

  override setLink(key: string, target: LinkedComponent): void {
    if (key === "giveUp") this.giveUpTarget = target;
    else super.setLink(key, target);
  }

  override addEntity(entity: MovingEntity): void {
    const made = entity.attributes[this.attemptKey] as number | undefined;
    if (made === undefined) {
      this.requests++;
      entity.attributes[this.attemptKey] = 1;
      this.send(entity);
      return;
    }
    // A failed attempt came back.
    if (made >= this.maxAttempts) {
      this.givenUp++;
      this.giveUpTarget?.addEntity(entity);
      return;
    }
    this.retries++;
    this.waiting++;
    this.setState("Backoff");
    this.ctx.kernel.schedule(this.secondsToTicks(this.backoff(made)), Priority.DEFAULT, () => {
      this.waiting--;
      if (this.waiting === 0) this.setState("Idle");
      entity.attributes[this.attemptKey] = made + 1;
      this.send(entity);
    });
  }

  private send(entity: MovingEntity): void {
    this.attempts++;
    this.next?.addEntity(entity);
  }

  /** Delay in seconds before the retry that follows `made` attempts. */
  private backoff(made: number): number {
    const d = Math.min(this.maxDelay, this.baseDelay * this.multiplier ** (made - 1));
    switch (this.jitter) {
      case "full":
        return d * this.unit.nextSample();
      case "equal":
        return d / 2 + (d / 2) * this.unit.nextSample();
      default:
        return d;
    }
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.requests = 0;
    this.attempts = 0;
    this.retries = 0;
    this.givenUp = 0;
  }
}
