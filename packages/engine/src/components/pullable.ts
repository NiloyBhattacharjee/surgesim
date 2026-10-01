import type { MovingEntity } from "../model/index.js";

/** Something that wants to be told when a queue has entities available. */
export interface QueueWaiter {
  queueHasEntity(): void;
}

/** One received entity. `ack` confirms it was processed. */
export interface Lease {
  readonly entity: MovingEntity;
  /**
   * Confirm successful processing. Returns false if the lease is stale, i.e. the source already
   * took the entity back (an SQS visibility timeout expired) and the confirmation has no effect.
   */
  ack(): boolean;
}

/** A source that workers pull entities from: a plain Queue or a MessageQueue. */
export interface PullSource {
  /** True if an entity that is received but never acked comes back (visibility-timeout semantics). */
  readonly redeliversUnacked: boolean;
  /** Take the next available entity, or null if there is none. */
  receive(): Lease | null;
  /** Register a waiter to be notified whenever an entity becomes available. */
  addWaiter(waiter: QueueWaiter): void;
}
