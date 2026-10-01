import type { Kernel } from "../kernel/index.js";
import { Rng, createSampler, type SampleProvider, type SamplerSpec } from "../rng/index.js";

/** A lightweight moving entity (a request or message) flowing through the model. */
export interface MovingEntity {
  /** Unique within a run. */
  readonly id: number;
  /** Tick at which the entity entered the model. */
  readonly createdAt: number;
  /** Free-form attributes for later phases. */
  attributes: Record<string, unknown>;
}

/** Services the model provides to every component. */
export interface SimContext {
  readonly kernel: Kernel;
  /** Create an RNG for the given stream id, derived from the run's seed. */
  rng(streamId: string): Rng;
  /** Create a new moving entity stamped with the current tick. */
  createEntity(): MovingEntity;
}

/** What the model hands a component constructor. */
export interface ComponentInit {
  name: string;
  /** Base RNG stream id (defaults to the component name). */
  stream: string;
  /** Validated inputs with defaults applied. */
  inputs: Record<string, unknown>;
}

/** Base class: a model object with a unique name, created by the model. */
export class Entity {
  constructor(
    protected readonly ctx: SimContext,
    readonly name: string,
  ) {}
}

/** An entity with a current state that tracks total time in each state since the last statistics reset. */
export class StateEntity extends Entity {
  private currentState: string;
  private stateSince: number;
  private readonly timeInState = new Map<string, number>();

  constructor(ctx: SimContext, name: string, initialState: string) {
    super(ctx, name);
    this.currentState = initialState;
    this.stateSince = ctx.kernel.currentTick;
  }

  get state(): string {
    return this.currentState;
  }

  protected setState(state: string): void {
    if (state === this.currentState) return;
    const now = this.ctx.kernel.currentTick;
    this.timeInState.set(
      this.currentState,
      (this.timeInState.get(this.currentState) ?? 0) + (now - this.stateSince),
    );
    this.currentState = state;
    this.stateSince = now;
  }

  /** Total seconds spent in `state` since the last statistics reset (including the ongoing stretch). */
  secondsInState(state: string): number {
    const now = this.ctx.kernel.currentTick;
    let ticks = this.timeInState.get(state) ?? 0;
    if (state === this.currentState) ticks += now - this.stateSince;
    return this.ctx.kernel.ticksToSeconds(ticks);
  }

  /** Clear accumulated statistics (called at the end of warm-up). */
  resetStatistics(): void {
    this.timeInState.clear();
    this.stateSince = this.ctx.kernel.currentTick;
  }
}

/** A component that receives entities and (usually) passes them on via `next`. */
export class LinkedComponent extends StateEntity {
  /** Downstream component, if linked. */
  next: LinkedComponent | null = null;
  protected readonly stream: string;
  private added = 0;
  private completed = 0;
  private inProgress = 0;

  constructor(ctx: SimContext, init: ComponentInit, initialState: string) {
    super(ctx, init.name, initialState);
    this.stream = init.stream;
  }

  /** Entities accepted since the last statistics reset. */
  get numberAdded(): number {
    return this.added;
  }

  /** Entities finished with (passed on, consumed or recorded) since the last statistics reset. */
  get numberCompleted(): number {
    return this.completed;
  }

  /** Entities currently held by this component. */
  get numberInProgress(): number {
    return this.inProgress;
  }

  /** Receive an entity. Components that do not accept pushed entities keep this default. */
  addEntity(_entity: MovingEntity): void {
    throw new Error(`${this.name} does not accept entities directly`);
  }

  /** Wire a named link (see the component schema's `links`). Default handles `next`. */
  setLink(key: string, target: LinkedComponent): void {
    if (key === "next") this.next = target;
  }

  /** Called once after all links are wired, before the run starts. Schedule initial events here. */
  start(): void {}

  protected noteAdded(): void {
    this.added++;
    this.inProgress++;
  }

  protected noteCompleted(): void {
    this.completed++;
    this.inProgress--;
  }

  /** Mark `entity` completed here and hand it to `next` (it leaves the model if there is none). */
  protected sendToNext(entity: MovingEntity): void {
    this.noteCompleted();
    this.next?.addEntity(entity);
  }

  /** A sampler on its own RNG stream, `<stream>/<purpose>`, so samplers never share numbers. */
  protected makeSampler(spec: SamplerSpec, purpose: string): SampleProvider {
    return createSampler(spec, this.ctx.rng(`${this.stream}/${purpose}`));
  }

  /** Convert a sampled time in seconds to whole ticks (negative samples clamp to 0). */
  protected secondsToTicks(seconds: number): number {
    return Math.max(0, this.ctx.kernel.secondsToTicks(seconds));
  }

  override resetStatistics(): void {
    super.resetStatistics();
    this.added = 0;
    this.completed = 0;
  }
}
