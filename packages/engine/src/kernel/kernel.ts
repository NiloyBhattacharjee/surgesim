import { BinaryHeap } from "./heap.js";

/** Conventional event priorities. Lower numbers run first among events at the same tick. */
export const Priority = {
  HIGHEST: 0,
  HIGH: 2,
  DEFAULT: 5,
  LOW: 8,
  LOWEST: 10,
} as const;

/** Default simulation resolution: microseconds. */
export const DEFAULT_TICKS_PER_SECOND = 1_000_000;

/**
 * How many events may run in a row without the clock advancing before the run is declared stuck.
 * A legitimate burst (thousands of simultaneous arrivals) is far below this; a zero-delay loop hits it in seconds.
 */
export const DEFAULT_MAX_EVENTS_PER_TICK = 10_000_000;

/** Safety limits for a kernel. Both are optional. */
export interface KernelLimits {
  /** Largest number of events allowed at one instant (default {@link DEFAULT_MAX_EVENTS_PER_TICK}). */
  maxEventsPerTick?: number;
  /** Largest total number of events in a run (default unlimited). */
  maxEvents?: number;
}

/** Thrown when a simulation hits a safety limit, such as a zero-delay loop that would never end. */
export class SimulationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationLimitError";
  }
}

/** A handle to a scheduled event or registered condition. */
export interface EventHandle {
  /** Cancel the event. No effect if it already fired or was cancelled. */
  cancel(): void;
  /** True while the event is waiting to fire (not fired, not cancelled). */
  isScheduled(): boolean;
}

/** Options for {@link Kernel.schedule}. */
export interface ScheduleOptions {
  /** Insert ahead of other events with the same tick and priority (default: FIFO, i.e. behind them). */
  lifo?: boolean;
}

const PENDING = 0;
const FIRED = 1;
const CANCELLED = 2;

class ScheduledEvent implements EventHandle {
  state = PENDING;
  constructor(
    readonly tick: number,
    readonly priority: number,
    readonly seq: number,
    readonly callback: () => void,
    private readonly onCancel: () => void,
  ) {}

  cancel(): void {
    if (this.state !== PENDING) return;
    this.state = CANCELLED;
    this.onCancel();
  }

  isScheduled(): boolean {
    return this.state === PENDING;
  }
}

class Condition implements EventHandle {
  state = PENDING;
  constructor(
    readonly predicate: () => boolean,
    readonly callback: () => void,
    readonly priority: number,
  ) {}

  cancel(): void {
    if (this.state === PENDING) this.state = CANCELLED;
  }

  isScheduled(): boolean {
    return this.state === PENDING;
  }
}

function compareEvents(a: ScheduledEvent, b: ScheduledEvent): number {
  return a.tick - b.tick || a.priority - b.priority || a.seq - b.seq;
}

/**
 * The discrete event kernel. Time is an integer number of ticks (a JS number, safe to 2^53).
 *
 * Events are ordered by (tick, priority, insertion sequence), which makes execution fully
 * deterministic. Conditional events ({@link Kernel.waitUntil}) are evaluated only when the next
 * event would advance the clock, never mid-tick.
 */
export class Kernel {
  /** Ticks per simulated second. */
  readonly ticksPerSecond: number;

  private tick = 0;
  private readonly heap = new BinaryHeap<ScheduledEvent>(compareEvents);
  private nextSeq = 0;
  private nextLifoSeq = -1;
  private pendingEvents = 0;
  private conditions: Condition[] = [];
  private processed = 0;
  /** How many events in a row have run without the clock moving. */
  private sameTickStreak = 0;
  private readonly maxEventsPerTick: number;
  private readonly maxEvents: number;

  constructor(ticksPerSecond: number = DEFAULT_TICKS_PER_SECOND, limits: KernelLimits = {}) {
    if (!Number.isInteger(ticksPerSecond) || ticksPerSecond < 1) {
      throw new RangeError(`ticksPerSecond must be a positive integer, got ${ticksPerSecond}`);
    }
    this.ticksPerSecond = ticksPerSecond;
    this.maxEventsPerTick = limits.maxEventsPerTick ?? DEFAULT_MAX_EVENTS_PER_TICK;
    this.maxEvents = limits.maxEvents ?? Infinity;
  }

  /** The current simulation time in ticks. */
  get currentTick(): number {
    return this.tick;
  }

  /** The current simulation time in seconds. */
  get currentSeconds(): number {
    return this.tick / this.ticksPerSecond;
  }

  /** Number of events waiting to fire (excludes cancelled events and unsatisfied conditions). */
  get pendingCount(): number {
    return this.pendingEvents;
  }

  /** Total number of events executed so far. */
  get eventsProcessed(): number {
    return this.processed;
  }

  /**
   * Convert seconds to the nearest whole tick. Results are capped at the largest exactly representable
   * tick count: a delay that long (about 285 years at the default resolution) means "never within this
   * run", and an uncapped absurd value would overflow to Infinity and be rejected by {@link Kernel.schedule}.
   */
  secondsToTicks(seconds: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, Math.round(seconds * this.ticksPerSecond));
  }

  /** Convert ticks to seconds. */
  ticksToSeconds(ticks: number): number {
    return ticks / this.ticksPerSecond;
  }

  /**
   * Schedule `callback` to run `delayTicks` ticks from now.
   * @param delayTicks non-negative integer
   * @param priority lower runs first among events at the same tick (see {@link Priority})
   */
  schedule(
    delayTicks: number,
    priority: number,
    callback: () => void,
    options: ScheduleOptions = {},
  ): EventHandle {
    if (!Number.isInteger(delayTicks) || delayTicks < 0) {
      throw new RangeError(`delayTicks must be a non-negative integer, got ${delayTicks}`);
    }
    const seq = options.lifo ? this.nextLifoSeq-- : this.nextSeq++;
    const event = new ScheduledEvent(this.tick + delayTicks, priority, seq, callback, () => {
      this.pendingEvents--;
    });
    this.pendingEvents++;
    this.heap.push(event);
    return event;
  }

  /**
   * Register a condition. When `predicate()` first returns true — checked only when the clock is
   * about to advance — `callback` is scheduled at the current tick with the given priority.
   */
  waitUntil(
    predicate: () => boolean,
    callback: () => void,
    priority: number = Priority.DEFAULT,
  ): EventHandle {
    const condition = new Condition(predicate, callback, priority);
    this.conditions.push(condition);
    return condition;
  }

  /** Execute the next event (advancing the clock if needed). Returns false if nothing is left to run. */
  step(): boolean {
    return this.stepUpTo(Infinity);
  }

  /** Execute all events with tick <= `tick`, then set the clock to `tick`. */
  runUntil(tick: number): void {
    if (!Number.isFinite(tick) || tick < this.tick) {
      throw new RangeError(`runUntil(${tick}) is before the current tick ${this.tick}`);
    }
    while (this.stepUpTo(tick)) {
      /* keep going */
    }
    this.tick = tick;
  }

  /** Run for `durationSeconds` of simulated time from now. */
  run(durationSeconds: number): void {
    this.runUntil(this.tick + this.secondsToTicks(durationSeconds));
  }

  private peekLive(): ScheduledEvent | undefined {
    for (;;) {
      const top = this.heap.peek();
      if (top === undefined || top.state === PENDING) return top;
      this.heap.pop(); // discard cancelled
    }
  }

  private stepUpTo(limit: number): boolean {
    let next = this.peekLive();
    if (next === undefined || next.tick > this.tick) {
      // The clock is about to advance (or the queue is empty): evaluate conditions now.
      if (this.conditions.length > 0 && this.fireReadyConditions()) next = this.peekLive();
    }
    if (next === undefined || next.tick > limit) return false;
    this.guardAgainstRunaway(next.tick);
    this.heap.pop();
    this.tick = next.tick;
    next.state = FIRED;
    this.pendingEvents--;
    this.processed++;
    next.callback();
    return true;
  }

  /**
   * Stop a model that can never finish. Events that keep scheduling more events at the same instant
   * (a zero-delay loop) would otherwise run forever without the clock moving, so the run neither ends
   * nor reports anything. The limits turn that into a clear error.
   */
  private guardAgainstRunaway(nextTick: number): void {
    this.sameTickStreak = nextTick === this.tick ? this.sameTickStreak + 1 : 1;
    if (this.sameTickStreak > this.maxEventsPerTick) {
      throw new SimulationLimitError(
        `the simulation appears stuck: more than ${this.maxEventsPerTick.toLocaleString("en-US")} events ran at t=${this.ticksToSeconds(this.tick)} s without the clock advancing. ` +
          "This usually means a loop with no delay in it, for example an interArrivalTime or retry baseDelay of 0 with nothing to stop it (add maxNumber or a delay).",
      );
    }
    if (this.processed >= this.maxEvents) {
      throw new SimulationLimitError(`the simulation reached its limit of ${this.maxEvents.toLocaleString("en-US")} events at t=${this.ticksToSeconds(this.tick)} s`);
    }
  }

  private fireReadyConditions(): boolean {
    const current = this.conditions;
    this.conditions = [];
    const waiting: Condition[] = [];
    let fired = false;
    for (const c of current) {
      if (c.state !== PENDING) continue;
      if (c.predicate()) {
        c.state = FIRED;
        this.schedule(0, c.priority, c.callback);
        fired = true;
      } else {
        waiting.push(c);
      }
    }
    // Conditions registered by predicates during evaluation were pushed to the fresh array.
    this.conditions = waiting.concat(this.conditions);
    return fired;
  }
}
