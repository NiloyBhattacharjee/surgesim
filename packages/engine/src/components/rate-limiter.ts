import { LinkedComponent, type ComponentInit, type MovingEntity, type SimContext } from "../model/index.js";
import type { ComponentSchema } from "../schema/index.js";

/** Float slack so that e.g. five refills of 0.2 tokens count as one whole token. */
const EPSILON = 1e-9;

/**
 * Token-bucket rate limiter (an API-gateway-style throttle). The bucket starts full with `burst`
 * tokens and refills continuously at `rate` tokens per second, never exceeding `burst`. Each entity
 * takes one token and is passed to `next`; with no token it is rejected: sent to `onReject`, or
 * dropped and counted. Deterministic: it uses no randomness.
 */
export class RateLimiter extends LinkedComponent {
  static readonly schema: ComponentSchema<RateLimiter> = {
    type: "RateLimiter",
    description: "Token-bucket rate limiter: passes entities while tokens last, rejects the rest.",
    roles: ["receiver"],
    inputs: [
      { key: "rate", type: "number", unit: "rate", min: 0, required: true, description: "Tokens added per second (the sustained allowed rate)." },
      { key: "burst", type: "number", unit: "dimensionless", min: 1, required: true, description: "Bucket size: the largest burst that passes at once. The bucket starts full." },
    ],
    links: [
      { key: "next", description: "Where allowed entities are sent.", required: false, accepts: "receiver" },
      { key: "onReject", description: "Where rejected entities are sent. Dropped and counted if omitted.", required: false, accepts: "receiver" },
    ],
    outputs: [
      { key: "NumberAllowed", unit: "dimensionless", description: "Entities that got a token.", get: (l) => l.allowed },
      { key: "NumberRejected", unit: "dimensionless", description: "Entities rejected for lack of a token.", get: (l) => l.rejected },
      { key: "RejectionFraction", unit: "dimensionless", description: "Rejected / (allowed + rejected).", get: (l) => (l.allowed + l.rejected === 0 ? NaN : l.rejected / (l.allowed + l.rejected)) },
      { key: "Tokens", unit: "dimensionless", series: true, description: "Tokens currently in the bucket.", get: (l) => l.currentTokens() },
    ],
  };

  private readonly rate: number;
  private readonly burst: number;
  private tokens: number;
  private lastTick: number;
  private onReject: LinkedComponent | null = null;
  private allowed = 0;
  private rejected = 0;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Idle");
    this.rate = init.inputs["rate"] as number;
    this.burst = init.inputs["burst"] as number;
    this.tokens = this.burst;
    this.lastTick = ctx.kernel.currentTick;
  }

  override setLink(key: string, target: LinkedComponent): void {
    if (key === "onReject") this.onReject = target;
    else super.setLink(key, target);
  }

  private currentTokens(): number {
    const now = this.ctx.kernel.currentTick;
    if (now > this.lastTick) {
      const seconds = this.ctx.kernel.ticksToSeconds(now - this.lastTick);
      this.tokens = Math.min(this.burst, this.tokens + seconds * this.rate);
      this.lastTick = now;
    }
    return this.tokens;
  }

  override addEntity(entity: MovingEntity): void {
    if (this.currentTokens() >= 1 - EPSILON) {
      this.tokens = Math.max(0, this.tokens - 1);
      this.allowed++;
      this.noteAdded();
      this.sendToNext(entity);
    } else {
      this.rejected++;
      this.onReject?.addEntity(entity);
    }
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.allowed = 0;
    this.rejected = 0;
  }
}
