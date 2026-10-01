import type { ComponentInit, LinkedComponent, SimContext } from "../model/index.js";
import type { ComponentSchema } from "../schema/index.js";
import { EntityGenerator } from "./generator.js";
import { MessageQueue } from "./message-queue.js";
import { Queue } from "./queue.js";
import { RateLimiter } from "./rate-limiter.js";
import { RetryPolicy } from "./retry-policy.js";
import { Server } from "./server.js";
import { EntitySink } from "./sink.js";
import { WorkerPool } from "./worker-pool.js";

/** A component class: a static schema plus a constructor. */
export interface ComponentClass {
  readonly schema: ComponentSchema;
  new (ctx: SimContext, init: ComponentInit): LinkedComponent;
}

/** Maps component type names (as used in model files) to classes. */
export class ComponentRegistry {
  private readonly classes = new Map<string, ComponentClass>();

  register(cls: ComponentClass): this {
    if (this.classes.has(cls.schema.type)) throw new Error(`component type already registered: ${cls.schema.type}`);
    this.classes.set(cls.schema.type, cls);
    return this;
  }

  get(type: string): ComponentClass | undefined {
    return this.classes.get(type);
  }

  /** Registered type names, in registration order. */
  types(): string[] {
    return [...this.classes.keys()];
  }

  schemas(): ComponentSchema[] {
    return [...this.classes.values()].map((c) => c.schema);
  }
}

/** A registry containing every built-in component: the generic ones and the cloud ones. */
export function createDefaultRegistry(): ComponentRegistry {
  return new ComponentRegistry()
    .register(EntityGenerator)
    .register(Queue)
    .register(Server)
    .register(EntitySink)
    .register(MessageQueue)
    .register(WorkerPool)
    .register(RetryPolicy)
    .register(RateLimiter);
}
