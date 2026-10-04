import { Priority } from "../kernel/index.js";
import { ExponentialSampler, type Rng, type SampleProvider } from "../rng/index.js";
import { LinkedComponent, type ComponentInit, type SimContext } from "../model/index.js";
import { asRateProfile, asSampler, type ComponentSchema, type RateSegment } from "../schema/index.js";

/**
 * Produces arrivals and sends them to `next`.
 *
 * - `interval` mode: the first arrival happens at `firstArrivalTime` (default 0), then one every
 *   `interArrivalTime` samples.
 * - `rateProfile` mode: a non-homogeneous Poisson process whose rate is piecewise constant.
 *   Generated exactly per segment (memorylessness of the exponential). The process starts at
 *   `firstArrivalTime`; before the first segment's start the rate is 0; the last segment
 *   continues forever.
 * - `dispersionIndex` D > 1 makes either mode bursty: arrival events become (D + 1) / 2 times rarer and each one
 *   releases a batch of simultaneous entities with a geometric size of mean (D + 1) / 2, so the average rate is
 *   unchanged. For Poisson arrivals this is a compound Poisson process whose counts have variance / mean = D in any
 *   window. D = 1 draws no batch sizes, so results are identical to a model without the input.
 */
export class EntityGenerator extends LinkedComponent {
  static readonly schema: ComponentSchema<EntityGenerator> = {
    type: "EntityGenerator",
    description: "Generates arriving entities, either at sampled intervals or from a time-varying Poisson rate profile.",
    roles: ["source"],
    inputs: [
      { key: "mode", type: "enum", unit: "dimensionless", options: ["interval", "rateProfile"], default: "interval", required: false, description: "Arrival mode." },
      { key: "interArrivalTime", type: "sampler", unit: "time", min: 0, required: false, requiredWhen: { input: "mode", equals: "interval" }, description: "Time between arrivals (seconds). Interval mode." },
      { key: "rateProfile", type: "rateProfile", unit: "rate", required: false, requiredWhen: { input: "mode", equals: "rateProfile" }, description: "Piecewise-constant Poisson rate: [[startSeconds, ratePerSecond], ...]. RateProfile mode." },
      { key: "firstArrivalTime", type: "sampler", unit: "time", min: 0, default: 0, required: false, description: "Time of the first arrival (interval mode) or start of the process (rateProfile mode), in seconds." },
      { key: "maxNumber", type: "integer", unit: "dimensionless", min: 0, required: false, description: "Stop after generating this many entities. Unlimited if omitted." },
      { key: "dispersionIndex", type: "number", unit: "dimensionless", min: 1, max: 1000, default: 1, required: false, description: "How bursty arrivals are: variance / mean of arrival counts, as surgesim fit-arrivals measures it (1 = Poisson). Above 1, arrivals come in simultaneous batches of geometric size with mean (D + 1) / 2, at a lower batch rate, so the average rate is unchanged." },
    ],
    links: [{ key: "next", description: "Where generated entities are sent.", required: false, accepts: "receiver" }],
    outputs: [
      { key: "NumberGenerated", unit: "dimensionless", description: "Entities generated.", get: (c) => c.numberAdded },
    ],
  };

  private readonly mode: string;
  private readonly interArrival: SampleProvider | null;
  private readonly firstArrival: SampleProvider;
  private readonly profile: RateSegment[];
  private readonly unitExp: SampleProvider;
  private readonly maxNumber: number | undefined;
  /** Mean batch size, (D + 1) / 2; 1 without bursts. */
  private readonly batchMean: number;
  private readonly batchRng: Rng | null;
  private profileSeconds = 0;
  private generated = 0;

  constructor(ctx: SimContext, init: ComponentInit) {
    super(ctx, init, "Waiting");
    const i = init.inputs;
    this.mode = i["mode"] as string;
    this.interArrival = i["interArrivalTime"] !== undefined ? this.makeSampler(asSampler(i["interArrivalTime"]), "interArrivalTime") : null;
    this.firstArrival = this.makeSampler(asSampler(i["firstArrivalTime"]), "firstArrivalTime");
    this.profile = i["rateProfile"] !== undefined ? asRateProfile(i["rateProfile"]) : [];
    this.unitExp = new ExponentialSampler(ctx.rng(`${this.stream}/arrivals`), 1);
    this.maxNumber = i["maxNumber"] as number | undefined;
    this.batchMean = ((i["dispersionIndex"] as number) + 1) / 2;
    this.batchRng = this.batchMean > 1 ? ctx.rng(`${this.stream}/batches`) : null;
  }

  /** Geometric on 1, 2, ... with mean `batchMean` (always 1 without bursts). */
  private batchSize(): number {
    if (this.batchRng === null) return 1;
    return 1 + Math.floor(Math.log(this.batchRng.nextFloatOpen()) / Math.log1p(-1 / this.batchMean));
  }

  override start(): void {
    if (this.maxNumber === 0) return this.finish();
    const first = Math.max(0, this.firstArrival.nextSample());
    if (this.mode === "interval") {
      this.scheduleAtSeconds(first);
    } else {
      this.profileSeconds = first;
      this.scheduleNextProfileArrival();
    }
  }

  private scheduleAtSeconds(seconds: number): void {
    const k = this.ctx.kernel;
    const delay = Math.max(0, k.secondsToTicks(seconds) - k.currentTick);
    k.schedule(delay, Priority.DEFAULT, () => this.arrive());
  }

  private finish(): void {
    this.setState("Done");
  }

  private arrive(): void {
    this.setState("Generating");
    for (let b = this.batchSize(); b > 0; b--) {
      this.generated++;
      this.noteAdded();
      this.sendToNext(this.ctx.createEntity());
      if (this.maxNumber !== undefined && this.generated >= this.maxNumber) return this.finish();
    }
    if (this.mode === "interval") {
      const gap = Math.max(0, (this.interArrival as SampleProvider).nextSample()) * this.batchMean;
      this.profileSeconds = this.ctx.kernel.currentSeconds + gap;
      this.scheduleAtSeconds(this.profileSeconds);
    } else {
      this.scheduleNextProfileArrival();
    }
  }

  private scheduleNextProfileArrival(): void {
    const t = this.nextProfileArrival(this.profileSeconds);
    if (t === null) return this.finish();
    this.profileSeconds = t;
    this.scheduleAtSeconds(t);
  }

  /** Time (seconds) of the next arrival strictly generated after `from`, or null if the rate is 0 forever. */
  private nextProfileArrival(from: number): number | null {
    const segs = this.profile;
    let t = from;
    for (;;) {
      let idx = -1;
      for (let s = 0; s < segs.length; s++) {
        if ((segs[s] as RateSegment)[0] <= t) idx = s;
        else break;
      }
      if (idx === -1) {
        t = (segs[0] as RateSegment)[0];
        continue;
      }
      const rate = (segs[idx] as RateSegment)[1];
      const end = idx + 1 < segs.length ? (segs[idx + 1] as RateSegment)[0] : Infinity;
      if (rate <= 0) {
        if (end === Infinity) return null;
        t = end;
        continue;
      }
      const candidate = t + (this.unitExp.nextSample() * this.batchMean) / rate;
      if (candidate < end) return candidate;
      t = end;
    }
  }
}
