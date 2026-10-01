/**
 * Time-weighted statistic of a piecewise-constant signal (e.g. queue length, busy workers).
 *
 * The mean is the integral of the value over time divided by elapsed time — not an average of
 * samples. Call {@link set} whenever the value changes.
 */
export class TimeWeightedStat {
  private value: number;
  private lastTick: number;
  private startTick: number;
  private area = 0;
  private maxValue: number;

  constructor(startTick = 0, initialValue = 0) {
    this.value = initialValue;
    this.lastTick = startTick;
    this.startTick = startTick;
    this.maxValue = Number.NEGATIVE_INFINITY;
  }

  /** The current value of the signal. */
  get current(): number {
    return this.value;
  }

  /** Record that the signal changes to `value` at time `tick` (ticks must not decrease). */
  set(tick: number, value: number): void {
    if (tick > this.lastTick) {
      this.area += this.value * (tick - this.lastTick);
      // Only values that persisted for a positive duration count towards the maximum, so
      // transient same-tick values (e.g. enqueue-then-immediately-dequeue) are ignored.
      if (this.value > this.maxValue) this.maxValue = this.value;
      this.lastTick = tick;
    }
    this.value = value;
  }

  /** Change the value by `delta` at time `tick`. */
  add(tick: number, delta: number): void {
    this.set(tick, this.value + delta);
  }

  /** Time-weighted mean over [start, tick]. Returns the current value if no time has elapsed. */
  mean(tick: number): number {
    const elapsed = tick - this.startTick;
    if (elapsed <= 0) return this.value;
    return (this.area + this.value * (tick - this.lastTick)) / elapsed;
  }

  /** Largest value that persisted for a positive duration, up to `tick` (or the current value if none). */
  max(tick: number): number {
    let m = this.maxValue;
    if (tick > this.lastTick && this.value > m) m = this.value;
    return m === Number.NEGATIVE_INFINITY ? this.value : m;
  }

  /** Total time (ticks) covered since the last reset, up to `tick`. */
  elapsed(tick: number): number {
    return Math.max(0, tick - this.startTick);
  }

  /** Restart accumulation at `tick`, keeping the current value. */
  reset(tick: number): void {
    this.startTick = tick;
    this.lastTick = tick;
    this.area = 0;
    this.maxValue = Number.NEGATIVE_INFINITY;
  }
}
