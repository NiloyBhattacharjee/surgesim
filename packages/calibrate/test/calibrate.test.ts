import { describe, expect, it } from "vitest";
import {
  ExponentialSampler,
  LognormalSampler,
  NormalSampler,
  Rng,
  TriangularSampler,
  UniformSampler,
  loadModel,
  runModel,
  type ModelDefinition,
  type RunResults,
} from "@chronon-sim/engine";
import { DataParseError, compareToObserved, erf, fitArrivalProfile, fitSamples, ksPValue, normalCdf, parseColumn, scaleArrivals, scaleSampler, scaleServiceTimes } from "../src/index.js";

const draw = (n: number, next: () => number): number[] => Array.from({ length: n }, next);

describe("special functions", () => {
  it("erf and the normal CDF match known values", () => {
    expect(erf(0)).toBeCloseTo(0, 7);
    expect(erf(1)).toBeCloseTo(0.8427007929, 6);
    expect(erf(2)).toBeCloseTo(0.995322265, 6);
    expect(erf(-1)).toBeCloseTo(-erf(1), 12);
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.158655254, 6);
  });

  it("the Kolmogorov-Smirnov p-value falls as the distance grows, and is about 0.05 at the 5% critical value", () => {
    const n = 1000;
    expect(ksPValue(0.001, n)).toBe(1);
    expect(ksPValue(0.02, n)).toBeGreaterThan(ksPValue(0.04, n));
    expect(ksPValue(0.2, n)).toBeLessThan(1e-6);
    expect(ksPValue(1.358 / Math.sqrt(n), n)).toBeGreaterThan(0.03);
    expect(ksPValue(1.358 / Math.sqrt(n), n)).toBeLessThan(0.08);
  });
});

describe("fitSamples recovers known distributions", () => {
  const rng = (name: string) => new Rng(2024, name);

  it("lognormal service times: picks lognormal and recovers the mean and spread", () => {
    const s = new LognormalSampler(rng("ln"), 0.5, 0.25);
    const fit = fitSamples(draw(5000, () => s.nextSample()));
    expect(fit.best!.family).toBe("lognormal");
    const spec = fit.best!.spec as { dist: "lognormal"; mean: number; stdDev: number };
    expect(Math.abs(spec.mean / 0.5 - 1)).toBeLessThan(0.03);
    expect(Math.abs(spec.stdDev / 0.25 - 1)).toBeLessThan(0.08);
    expect(fit.best!.ks).toBeLessThan(fit.ksCritical);
    expect(fit.warnings).toEqual([]);
  });

  it("exponential gaps: picks exponential and recovers the mean", () => {
    const s = new ExponentialSampler(rng("ex"), 2);
    const fit = fitSamples(draw(5000, () => s.nextSample()));
    expect(fit.best!.family).toBe("exponential");
    expect(Math.abs((fit.best!.spec as { mean: number }).mean / 2 - 1)).toBeLessThan(0.03);
    expect(fit.best!.ks).toBeLessThan(fit.ksCritical);
  });

  it("normal values: picks normal", () => {
    const s = new NormalSampler(rng("no"), 10, 2);
    const fit = fitSamples(draw(5000, () => s.nextSample()));
    expect(fit.best!.family).toBe("normal");
    const spec = fit.best!.spec as { mean: number; stdDev: number };
    expect(Math.abs(spec.mean - 10)).toBeLessThan(0.15);
    expect(Math.abs(spec.stdDev - 2)).toBeLessThan(0.15);
  });

  it("uniform values: picks uniform and recovers the range", () => {
    const s = new UniformSampler(rng("un"), 1, 3);
    const fit = fitSamples(draw(5000, () => s.nextSample()));
    expect(fit.best!.family).toBe("uniform");
    const spec = fit.best!.spec as { min: number; max: number };
    expect(spec.min).toBeCloseTo(1, 1);
    expect(spec.max).toBeCloseTo(3, 1);
  });

  it("triangular values: picks triangular and recovers the mode", () => {
    const s = new TriangularSampler(rng("tr"), 1, 2, 6);
    const fit = fitSamples(draw(8000, () => s.nextSample()));
    expect(fit.best!.family).toBe("triangular");
    expect(Math.abs((fit.best!.spec as { mode: number }).mode - 2)).toBeLessThan(0.35);
  });

  it("identical values are a constant", () => {
    const fit = fitSamples(Array(50).fill(0.25));
    expect(fit.best).toMatchObject({ family: "constant", spec: { dist: "constant", value: 0.25 } });
  });

  it("a fast-or-slow mixture fits nothing well, and says so", () => {
    const fast = new NormalSampler(rng("m1"), 0.1, 0.01);
    const slow = new LognormalSampler(rng("m2"), 3, 1);
    const pick = rng("m3");
    const values = draw(5000, () => (pick.nextFloat() < 0.8 ? Math.abs(fast.nextSample()) : slow.nextSample()));
    const fit = fitSamples(values);
    expect(fit.best!.ks).toBeGreaterThan(fit.ksCritical * 1.5);
    expect(fit.warnings.join(" ")).toContain("No family fits well");
  });

  it("negative values skip exponential and lognormal, with a warning", () => {
    const s = new NormalSampler(rng("neg"), 0, 1);
    const fit = fitSamples(draw(500, () => s.nextSample()));
    expect(fit.fits.map((f) => f.family)).not.toContain("exponential");
    expect(fit.fits.map((f) => f.family)).not.toContain("lognormal");
    expect(fit.warnings.join(" ")).toMatch(/Exponential was skipped/);
    expect(fit.best!.family).toBe("normal");
  });

  it("zeros skip lognormal", () => {
    const fit = fitSamples([0, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2, 3, 5]);
    expect(fit.fits.map((f) => f.family)).not.toContain("lognormal");
    expect(fit.warnings.join(" ")).toMatch(/Lognormal was skipped/);
  });

  it("reports summary statistics and percentiles", () => {
    const fit = fitSamples(Array.from({ length: 101 }, (_, i) => i));
    expect(fit).toMatchObject({ n: 101, mean: 50, min: 0, max: 100, p50: 50, p95: 95, p99: 99 });
    expect(fit.cv).toBeCloseTo(fit.stdDev / 50, 12);
  });

  it("too little data gives no verdict, and ignores non-finite values", () => {
    const few = fitSamples([1, 2, 3]);
    expect(few.best).toBeNull();
    expect(few.warnings.join(" ")).toContain("at least 8");
    const dirty = fitSamples([...Array.from({ length: 20 }, (_, i) => 1 + i / 10), NaN, Infinity]);
    expect(dirty.n).toBe(20);
    expect(dirty.warnings.join(" ")).toContain("2 non-finite");
    expect(fitSamples([]).best).toBeNull();
  });

  it("can be restricted to some families", () => {
    const s = new LognormalSampler(rng("only"), 1, 0.5);
    const fit = fitSamples(draw(1000, () => s.nextSample()), { families: ["normal", "exponential"] });
    expect(fit.fits.map((f) => f.family).sort()).toEqual(["exponential", "normal"]);
  });

  it("the fitted lognormal spec is usable in a model and reproduces the data's mean", () => {
    const s = new LognormalSampler(rng("loop"), 0.4, 0.3);
    const fit = fitSamples(draw(6000, () => s.nextSample()));
    const spec = fit.best!.spec;
    const loaded = loadModel({
      version: 1,
      settings: { duration: 4000, replications: 3, seed: 5 },
      components: [
        { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: 5 }, links: { next: "q" } },
        { type: "Queue", name: "q" },
        { type: "Server", name: "srv", inputs: { capacity: 1, serviceTime: spec }, links: { queue: "q", next: "sink" } },
        { type: "EntitySink", name: "sink" },
      ],
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const results = runModel(loaded.model);
    const mean = results.outputs.find((o) => o.id === "sink.mean")!.mean!;
    expect(Math.abs(mean / 0.4 - 1)).toBeLessThan(0.05);
  });
});

/** Arrivals from a piecewise-constant Poisson process, generated by thinning (independent of the engine's method). */
function poissonArrivals(profile: [number, number][], end: number, rng: Rng): number[] {
  const peak = Math.max(...profile.map(([, r]) => r));
  const rateAt = (t: number) => profile.reduce((r, [s, v]) => (s <= t ? v : r), 0);
  const out: number[] = [];
  let t = 0;
  for (;;) {
    t += -Math.log(rng.nextFloatOpen()) / peak;
    if (t >= end) return out;
    if (rng.nextFloat() < rateAt(t) / peak) out.push(t);
  }
}

describe("fitArrivalProfile", () => {
  it("recovers a spike: the segment boundaries and the rates", () => {
    const truth: [number, number][] = [[0, 5], [300, 25], [600, 5]];
    const arrivals = poissonArrivals(truth, 900, new Rng(7, "spike"));
    const fit = fitArrivalProfile(arrivals, { windowSeconds: 30, start: 0, end: 900 });
    expect(fit.rateProfile).toHaveLength(3);
    truth.forEach(([start, rate], i) => {
      expect(Math.abs((fit.rateProfile[i] as [number, number])[0] - start)).toBeLessThanOrEqual(30);
      expect(Math.abs((fit.rateProfile[i] as [number, number])[1] / rate - 1)).toBeLessThan(0.08);
    });
    expect(fit.meanRate).toBeCloseTo(arrivals.length / 900, 9);
    expect(fit.dispersionIndex).toBeGreaterThan(0.6);
    expect(fit.dispersionIndex).toBeLessThan(1.5);
    expect(fit.warnings).toEqual([]);
  });

  it("a window that straddles a step does not become a segment of its own; the breakpoint lands where the step really is", () => {
    const truth: [number, number][] = [[0, 8], [300, 20], [600, 8]];
    const arrivals = poissonArrivals(truth, 900, new Rng(21, "straddle"));
    // A 31 s window puts the step at 300 s and 600 s inside a window (windows end at multiples of about 31).
    const fit = fitArrivalProfile(arrivals, { windowSeconds: 31, start: 0, end: 900 });
    expect(fit.rateProfile).toHaveLength(3);
    expect(Math.abs((fit.rateProfile[1] as [number, number])[0] - 300)).toBeLessThan(8);
    expect(Math.abs((fit.rateProfile[2] as [number, number])[0] - 600)).toBeLessThan(8);
    expect(Math.abs((fit.rateProfile[1] as [number, number])[1] / 20 - 1)).toBeLessThan(0.08);
    expect(Math.abs((fit.rateProfile[0] as [number, number])[1] / 8 - 1)).toBeLessThan(0.08);
  });

  it("the refined breakpoints keep the total: a model run from the profile generates the observed number of arrivals", () => {
    const truth: [number, number][] = [[0, 8], [300, 20], [600, 8]];
    const arrivals = poissonArrivals(truth, 900, new Rng(22, "conserve"));
    const fit = fitArrivalProfile(arrivals, { windowSeconds: 37, start: 0, end: 900 });
    let expected = 0;
    fit.rateProfile.forEach(([start, rate], i) => {
      const end = i + 1 < fit.rateProfile.length ? (fit.rateProfile[i + 1] as [number, number])[0] : 900;
      expected += rate * (end - start);
    });
    expect(Math.abs(expected / arrivals.length - 1)).toBeLessThan(0.02);
  });

  it("steady Poisson traffic is one segment, not noise-chasing", () => {
    const arrivals = poissonArrivals([[0, 10]], 1200, new Rng(8, "flat"));
    const fit = fitArrivalProfile(arrivals, { windowSeconds: 20, start: 0, end: 1200 });
    expect(fit.rateProfile).toHaveLength(1);
    expect(Math.abs(fit.rateProfile[0]![1] / 10 - 1)).toBeLessThan(0.03);
  });

  it("follows a slow daily-style cycle with several segments", () => {
    const profile: [number, number][] = [[0, 4], [200, 12], [400, 24], [600, 12], [800, 4]];
    const arrivals = poissonArrivals(profile, 1000, new Rng(9, "cycle"));
    const fit = fitArrivalProfile(arrivals, { windowSeconds: 25, start: 0, end: 1000 });
    expect(fit.rateProfile.length).toBeGreaterThanOrEqual(5);
    expect(fit.rateProfile.length).toBeLessThanOrEqual(8);
    // The busiest fitted segment must be near the true peak.
    const peak = Math.max(...fit.rateProfile.map(([, r]) => r));
    expect(Math.abs(peak / 24 - 1)).toBeLessThan(0.12);
  });

  it("flags arrivals that are burstier than Poisson", () => {
    const rng = new Rng(10, "bursty");
    const centres = poissonArrivals([[0, 1]], 1200, rng);
    const arrivals = centres.flatMap((c) => Array.from({ length: 8 }, () => c + rng.nextFloat() * 0.2)).sort((a, b) => a - b);
    const fit = fitArrivalProfile(arrivals, { windowSeconds: 20, start: 0, end: 1200 });
    // Clusters of 8 make counts about 8 times more variable than Poisson. The estimate is rough, but it must be clearly high.
    expect(fit.dispersionIndex).toBeGreaterThan(4);
    expect(fit.dispersionIndex).toBeLessThan(14);
    // Bursts are noise on a steady rate, not rate changes: the profile must not be chopped into many segments.
    expect(fit.rateProfile.length).toBeLessThanOrEqual(3);
    expect(fit.warnings.join(" ")).toContain("burstier than Poisson");
  });

  it("flags arrivals that are more regular than Poisson", () => {
    const arrivals = Array.from({ length: 6001 }, (_, i) => i * 0.1);
    const fit = fitArrivalProfile(arrivals, { windowSeconds: 30, start: 0, end: 600 });
    expect(fit.dispersionIndex).toBeLessThan(0.5);
    expect(fit.warnings.join(" ")).toContain("more regular than Poisson");
  });

  it("rejects unusable input", () => {
    expect(() => fitArrivalProfile([1, 2, 3], { windowSeconds: 0 })).toThrow(RangeError);
    expect(() => fitArrivalProfile([1], { windowSeconds: 10 })).toThrow(RangeError);
    expect(() => fitArrivalProfile([5, 5, 5], { windowSeconds: 10 })).toThrow(RangeError);
  });

  it("round trip: a model driven by the fitted profile generates about as many arrivals as were observed", () => {
    const truth: [number, number][] = [[0, 6], [200, 30], [400, 6]];
    const arrivals = poissonArrivals(truth, 600, new Rng(11, "rt"));
    const fit = fitArrivalProfile(arrivals, { windowSeconds: 20, start: 0, end: 600 });
    const loaded = loadModel({
      version: 1,
      settings: { duration: 600, replications: 5, seed: 3 },
      components: [
        { type: "EntityGenerator", name: "gen", inputs: { mode: "rateProfile", rateProfile: fit.rateProfile }, links: { next: "sink" } },
        { type: "EntitySink", name: "sink" },
      ],
    });
    expect(loaded.ok ? [] : loaded.errors).toEqual([]);
    if (!loaded.ok) return;
    const generated = runModel(loaded.model).outputs.find((o) => o.id === "gen.NumberGenerated")!.mean!;
    expect(Math.abs(generated / arrivals.length - 1)).toBeLessThan(0.03);
  });
});

/**
 * Regression for a bug found on a real measured run (validation/real-system): traffic that was Poisson at 8, then
 * 11 (a 37% rise for 120 s), then 8 per second was reported as ONE segment with a "bursty" warning. The dispersion
 * estimate included the unmodelled step, which widened the noise allowance, which merged the step away, which
 * raised the dispersion again.
 *
 * These are statistical properties, so each is checked over many independent seeded samples. A single sample is a
 * poor test of a change-point estimate: where a step is placed is uncertain by the noise in the counts, and one
 * unlucky draw can move it by tens of seconds. Measured when this was written, over 60 samples, the previous algorithm
 * found the 8, 11, 8 pattern in 18 (window 5 s) to 54 (window 30 s) and split steady traffic in up to 27% of runs.
 */
describe("fitArrivalProfile does not lose a step to its own dispersion estimate", () => {
  const trials = 30;
  const cases: { label: string; profile: [number, number][]; end: number }[] = [
    { label: "8, 11, 8 per second (a 37% rise for 120 s)", profile: [[0, 8], [300, 11], [420, 8]], end: 600 },
    { label: "8, 20, 8 per second (a 150% rise)", profile: [[0, 8], [300, 20], [600, 8]], end: 900 },
  ];
  for (const { label, profile, end } of cases) {
    for (const windowSeconds of [5, 10, 20, 30]) {
      it(`${label}: finds three segments with the right rates and breakpoints, window ${windowSeconds} s`, () => {
        let three = 0;
        let ratesRight = 0;
        let looksPoisson = 0;
        const breakpointErrors: number[] = [];
        for (let seed = 0; seed < trials; seed++) {
          const arrivals = poissonArrivals(profile, end, new Rng(1000 + seed, `step-${label}-${windowSeconds}`));
          const fit = fitArrivalProfile(arrivals, { windowSeconds, start: 0, end });
          if (fit.rateProfile.length !== 3) continue;
          three++;
          if (profile.every(([, rate], i) => Math.abs((fit.rateProfile[i] as [number, number])[1] / rate - 1) < 0.08)) ratesRight++;
          // The traffic is Poisson inside each segment, and the step must not be mistaken for burstiness.
          if (fit.dispersionIndex > 0.6 && fit.dispersionIndex < 1.5 && fit.warnings.length === 0) looksPoisson++;
          profile.slice(1).forEach(([start], i) => breakpointErrors.push(Math.abs((fit.rateProfile[i + 1] as [number, number])[0] - start)));
        }
        expect(three).toBeGreaterThanOrEqual(Math.ceil(trials * 0.85));
        expect(ratesRight).toBeGreaterThanOrEqual(three - 2);
        expect(looksPoisson).toBeGreaterThanOrEqual(three - 2);
        breakpointErrors.sort((a, b) => a - b);
        expect(breakpointErrors[Math.floor(breakpointErrors.length / 2)] as number).toBeLessThan(5); // median error, seconds
        expect(breakpointErrors[Math.floor(breakpointErrors.length * 0.9)] as number).toBeLessThan(20); // 90th percentile
      });
    }
  }

  it("steady Poisson traffic is almost never split (false-positive rate)", () => {
    let split = 0;
    let runs = 0;
    for (const windowSeconds of [5, 10, 30]) {
      for (let seed = 0; seed < 100; seed++, runs++) {
        const arrivals = poissonArrivals([[0, 9]], 600, new Rng(2000 + seed, `flat-${windowSeconds}`));
        if (fitArrivalProfile(arrivals, { windowSeconds, start: 0, end: 600 }).rateProfile.length > 1) split++;
      }
    }
    expect(split / runs).toBeLessThan(0.06); // measured: 1% to 3%
  });

  it("a rise smaller than the merge tolerance is treated as noise", () => {
    const arrivals = poissonArrivals([[0, 10], [300, 11]], 600, new Rng(41, "small"));
    expect(fitArrivalProfile(arrivals, { windowSeconds: 20, start: 0, end: 600 }).rateProfile).toHaveLength(1);
  });

  it("bursty traffic with a rate step: finds the step AND reports the burstiness", () => {
    let found = 0;
    let flagged = 0;
    const attempts = 40;
    for (let seed = 0; seed < attempts; seed++) {
      const rng = new Rng(3000 + seed, "burst-step");
      const centres = poissonArrivals([[0, 1], [300, 1.6]], 600, rng);
      const arrivals = centres.flatMap((c) => Array.from({ length: 4 }, () => c + rng.nextFloat() * 0.2)).sort((a, b) => a - b);
      const fit = fitArrivalProfile(arrivals, { windowSeconds: 20, start: 0, end: 600 });
      if (fit.rateProfile.length !== 2) continue;
      found++;
      // Clusters of 4 make counts about 4 times as variable as Poisson.
      if (fit.dispersionIndex > 2.5 && fit.dispersionIndex < 6 && fit.warnings.join(" ").includes("burstier than Poisson")) flagged++;
    }
    expect(found).toBeGreaterThanOrEqual(Math.ceil(attempts * 0.8)); // measured: 93%
    expect(flagged).toBeGreaterThanOrEqual(found - 2);
  });
});

describe("parseColumn", () => {
  it("reads a CSV by header name (case-insensitive) and ignores the other columns", () => {
    const r = parseColumn("time,Latency_ms,status\n1,120,200\n2,95,200\n3,300,500\n", { column: "latency_ms" });
    expect(r).toMatchObject({ values: [120, 95, 300], column: "Latency_ms", hasHeader: true, rows: 3, skipped: 0 });
  });

  it("finds the first numeric column on its own, with or without a header", () => {
    expect(parseColumn("name,value\nfoo,1.5\nbar,2.5\n").values).toEqual([1.5, 2.5]);
    expect(parseColumn("1.5\n2.5\n3.5\n")).toMatchObject({ values: [1.5, 2.5, 3.5], hasHeader: false });
  });

  it("handles tabs, semicolons, whitespace, quotes, comments and blank lines", () => {
    expect(parseColumn("a\tb\n1\t2\n3\t4\n", { column: "b" }).values).toEqual([2, 4]);
    expect(parseColumn("a;b\n1;2\n3;4\n", { column: 1 }).values).toEqual([2, 4]);
    expect(parseColumn("1 10\n2 20\n", { column: 1 }).values).toEqual([10, 20]);
    expect(parseColumn('"x"\n"1.5"\n"2.5"\n').values).toEqual([1.5, 2.5]);
    expect(parseColumn("# exported 2024\n\n1\n\n2\n# end\n").values).toEqual([1, 2]);
  });

  it("counts cells it cannot read instead of failing", () => {
    const r = parseColumn("v\n1\nn/a\n3\n\"\"\n5\n");
    expect(r.values).toEqual([1, 3, 5]);
    expect(r.skipped).toBe(2);
  });

  it("reads ISO timestamps as seconds in time mode", () => {
    const r = parseColumn("timestamp\n2024-05-06T09:00:00Z\n2024-05-06T09:00:01.500Z\n2024-05-06T09:01:00Z\n", { kind: "time" });
    expect(r.values[1]! - r.values[0]!).toBeCloseTo(1.5, 6);
    expect(r.values[2]! - r.values[0]!).toBeCloseTo(60, 6);
    expect(() => parseColumn("timestamp\n2024-05-06T09:00:00Z\n")).toThrow(DataParseError); // number mode: dates are not numbers
  });

  it("explains what is wrong", () => {
    expect(() => parseColumn("")).toThrow("no data");
    expect(() => parseColumn("a,b\n1,2\n", { column: "zzz" })).toThrow(/no column named "zzz".*a, b/);
    expect(() => parseColumn("name\nfoo\nbar\n")).toThrow(/no column of numbers/);
    expect(() => parseColumn("a,b\n1,x\n2,y\n", { column: "b" })).toThrow(/no readable numbers/);
  });
});

describe("compareToObserved", () => {
  // Five replications each. The expected range for ONE measurement is mean +/- t(4) * sd * sqrt(1 + 1/5):
  // p99: 2.0 +/- 2.776 * 0.1 * 1.0954 = [1.696, 2.304]; utilisation: 0.6 +/- 0.0304; count: 1000 +/- 15.2.
  const results = {
    resultsVersion: 1,
    modelName: null,
    settings: { duration: 1, warmUp: 0, seed: 1, replications: 5, ticksPerSecond: 1_000_000 },
    outputs: [
      { id: "sink.p99", component: "sink", componentType: "EntitySink", key: "p99", unit: "time", description: "", n: 5, mean: 2.0, stdDev: 0.1, ci95: { low: 1.9, high: 2.1, halfWidth: 0.1 } },
      { id: "pool.Utilisation", component: "pool", componentType: "WorkerPool", key: "Utilisation", unit: "dimensionless", description: "", n: 5, mean: 0.6, stdDev: 0.01, ci95: { low: 0.59, high: 0.61, halfWidth: 0.01 } },
      { id: "sink.count", component: "sink", componentType: "EntitySink", key: "count", unit: "dimensionless", description: "", n: 5, mean: 1000, stdDev: 5, ci95: null },
      { id: "queue.NumberDropped", component: "queue", componentType: "Queue", key: "NumberDropped", unit: "dimensionless", description: "", n: 5, mean: 0, stdDev: 0, ci95: { low: 0, high: 0, halfWidth: 0 } },
      { id: "x.nodata", component: "x", componentType: "X", key: "nodata", unit: "time", description: "", n: 0, mean: null, stdDev: null, ci95: null },
    ],
    replications: [],
  } as unknown as RunResults;

  const verdict = (id: string, metric: Parameters<typeof compareToObserved>[1]["metrics"][string], extra: { tolerance?: number; periods?: number } = {}) => {
    const c = compareToObserved(results, { metrics: { [id]: metric }, ...extra });
    return c.rows[0]!;
  };

  it("match: the observation is inside the range the model expects for a single measurement", () => {
    const r = verdict("sink.p99", 2.25); // outside the model's confidence interval for the MEAN (1.9 to 2.1), but one run can easily be this high
    expect(r.verdict).toBe("match");
    expect(r.expectedLow!).toBeCloseTo(1.696, 2);
    expect(r.expectedHigh!).toBeCloseTo(2.304, 2);
    expect(verdict("sink.p99", 1.7).verdict).toBe("match");
  });

  it("running more replications does not make a good model fail (the range is about single measurements, not about the mean)", () => {
    const many = { ...results, outputs: results.outputs.map((o) => (o.id === "sink.p99" ? { ...o, n: 500, ci95: { low: 1.991, high: 2.009, halfWidth: 0.009 } } : o)) } as RunResults;
    const c = compareToObserved(many, { metrics: { "sink.p99": 2.15 } });
    expect(c.rows[0]!.verdict).toBe("match"); // the old interval-of-the-mean check would now say "off"
  });

  it("close: outside the expected range but within the tolerance (default 10%)", () => {
    const r = verdict("pool.Utilisation", 0.64); // expected 0.57 to 0.63
    expect(r.verdict).toBe("close");
    expect(r.relativeError).toBeCloseTo(-0.0625, 4);
  });

  it("off: further than the tolerance", () => {
    expect(verdict("sink.p99", 3).verdict).toBe("off");
    expect(verdict("pool.Utilisation", 0.64, { tolerance: 0.05 }).verdict).toBe("off"); // a tighter tolerance turns "close" into "off"
  });

  it("an observed range that overlaps the expected range is a match", () => {
    expect(verdict("sink.p99", { value: 2.8, low: 2.2, high: 3.0 }).verdict).toBe("match");
    expect(verdict("sink.p99", { value: 2.6, low: 2.4, high: 2.9 }).verdict).toBe("off");
  });

  it("a per-metric tolerance overrides the default", () => {
    expect(verdict("sink.p99", { value: 2.6, tolerance: 0.3 }).verdict).toBe("close");
  });

  it("periods: data averaged over more periods is steadier, so the expected range narrows", () => {
    const one = verdict("sink.p99", 2.2, { periods: 1 });
    const many = verdict("sink.p99", 2.2, { periods: 100 });
    expect(one.verdict).toBe("match");
    expect(many.expectedHigh! - many.expectedLow!).toBeLessThan((one.expectedHigh! - one.expectedLow!) / 2);
    expect(many.verdict).toBe("close"); // 2.2 is no longer inside [1.87, 2.13], but is within 10% of the mean
  });

  it("handles observed zeros, outputs without a spread, and missing data", () => {
    expect(verdict("queue.NumberDropped", 0).verdict).toBe("match");
    expect(verdict("queue.NumberDropped", 5).verdict).toBe("off");
    expect(verdict("sink.count", 1010).verdict).toBe("match");
    expect(verdict("sink.count", 1080).verdict).toBe("close");
    expect(verdict("nope.x", 1).verdict).toBe("missing");
    expect(verdict("x.nodata", 1).verdict).toBe("missing");
  });

  it("with a single replication there is no spread, so only an exact value or the tolerance can match", () => {
    const single = { ...results, outputs: results.outputs.map((o) => ({ ...o, n: 1, stdDev: null, ci95: null })) } as RunResults;
    expect(compareToObserved(single, { metrics: { "sink.p99": 2.0 } }).rows[0]!.verdict).toBe("match");
    expect(compareToObserved(single, { metrics: { "sink.p99": 2.05 } }).rows[0]!.verdict).toBe("close");
    expect(compareToObserved(single, { metrics: { "sink.p99": 2.05 } }).widestRelativeRange).toBeNull();
  });

  it("passes only when nothing is off or missing, counts the verdicts, and reports the detection limit", () => {
    const good = compareToObserved(results, { metrics: { "sink.p99": 2.0, "pool.Utilisation": 0.64 } });
    expect(good.passed).toBe(true);
    expect(good.counts).toEqual({ match: 1, close: 1, off: 0, missing: 0 });
    const bad = compareToObserved(results, { metrics: { "sink.p99": 2.0, "pool.Utilisation": 0.9, "nope.x": 1 } });
    expect(bad.passed).toBe(false);
    expect(bad.counts).toEqual({ match: 1, close: 0, off: 1, missing: 1 });
    expect(good.widestRelativeRange).toBeCloseTo(0.152, 2); // p99: 0.304 / 2.0
  });
});

describe("sensitivity helpers", () => {
  const model = (loadModel({
    version: 1,
    settings: { duration: 100 },
    components: [
      { type: "EntityGenerator", name: "profile", inputs: { mode: "rateProfile", rateProfile: [[0, 10], [50, 20]] }, links: { next: "q" } },
      { type: "EntityGenerator", name: "gaps", inputs: { interArrivalTime: { dist: "exponential", mean: 0.5 } }, links: { next: "q" } },
      { type: "Queue", name: "q" },
      { type: "Server", name: "s", inputs: { capacity: 2, serviceTime: { dist: "lognormal", mean: 0.4, stdDev: 0.2 } }, links: { queue: "q", next: "sink" } },
      { type: "WorkerPool", name: "w", inputs: { concurrency: 3, serviceTime: 0.3 }, links: { next: "sink" } },
      { type: "EntitySink", name: "sink" },
    ],
  }) as { ok: true; model: ModelDefinition }).model;
  const input = (m: ModelDefinition, name: string, key: string) => m.components.find((c) => c.name === name)!.inputs[key];

  it("scaleSampler multiplies every time parameter of every distribution", () => {
    expect(scaleSampler(2, 1.5)).toBe(3);
    expect(scaleSampler({ dist: "exponential", mean: 2 }, 0.5)).toEqual({ dist: "exponential", mean: 1 });
    expect(scaleSampler({ dist: "lognormal", mean: 1, stdDev: 0.5 }, 2)).toEqual({ dist: "lognormal", mean: 2, stdDev: 1 });
    expect(scaleSampler({ dist: "triangular", min: 1, mode: 2, max: 4 }, 3)).toEqual({ dist: "triangular", min: 3, mode: 6, max: 12 });
    expect(scaleSampler({ dist: "uniform", min: 1, max: 2 }, 2)).toEqual({ dist: "uniform", min: 2, max: 4 });
    expect(scaleSampler({ dist: "constant", value: 5 }, 2)).toEqual({ dist: "constant", value: 10 });
    expect(scaleSampler({ dist: "normal", mean: 5, stdDev: 1 }, 2)).toEqual({ dist: "normal", mean: 10, stdDev: 2 });
  });

  it("scaleArrivals multiplies rate profiles and divides inter-arrival times, leaving the original untouched", () => {
    const more = scaleArrivals(model, 1.1);
    expect(input(more, "profile", "rateProfile")).toEqual([[0, 11], [50, 22]].map(([s, r]) => [s, expect.closeTo(r as number, 9)]));
    expect((input(more, "gaps", "interArrivalTime") as { mean: number }).mean).toBeCloseTo(0.5 / 1.1, 12);
    expect(input(model, "profile", "rateProfile")).toEqual([[0, 10], [50, 20]]);
    expect(input(more, "s", "capacity")).toBe(2); // only traffic changes
  });

  it("scaleServiceTimes changes every Server and WorkerPool service time and nothing else", () => {
    const slower = scaleServiceTimes(model, 1.2);
    expect((input(slower, "s", "serviceTime") as { mean: number; stdDev: number }).mean).toBeCloseTo(0.48, 12);
    expect(input(slower, "w", "serviceTime")).toBeCloseTo(0.36, 12);
    expect(input(slower, "profile", "rateProfile")).toEqual([[0, 10], [50, 20]]);
  });

  it("more traffic or slower service makes a real queue longer", () => {
    const base = {
      version: 1,
      settings: { duration: 600, replications: 6, seed: 4 },
      components: [
        { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: { dist: "exponential", mean: 0.13 } }, links: { next: "q" } },
        { type: "Queue", name: "q" },
        { type: "Server", name: "srv", inputs: { capacity: 1, serviceTime: { dist: "exponential", mean: 0.1 } }, links: { queue: "q", next: "sink" } },
        { type: "EntitySink", name: "sink" },
      ],
    };
    const m = (loadModel(base) as { ok: true; model: ModelDefinition }).model;
    const queue = (mm: ModelDefinition) => runModel(mm).outputs.find((o) => o.id === "q.AverageQueueLength")!.mean!;
    expect(queue(scaleArrivals(m, 1.05))).toBeGreaterThan(queue(m));
    expect(queue(scaleServiceTimes(m, 1.05))).toBeGreaterThan(queue(m));
    expect(queue(scaleArrivals(m, 0.95))).toBeLessThan(queue(m));
  });
});
