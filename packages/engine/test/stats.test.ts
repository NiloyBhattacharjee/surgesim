import { describe, expect, it } from "vitest";
import {
  ExactPercentileTracker,
  Tally,
  TimeWeightedStat,
  adjustPValues,
  pairedTTest,
  summarize,
  tCdf,
  tQuantile,
  tQuantile975,
  tTwoSidedP,
  welchTTest,
} from "../src/stats/index.js";

describe("TimeWeightedStat", () => {
  it("integrates over time on a hand-calculable scenario", () => {
    // value: 0 on [0,10), 2 on [10,14), 5 on [14,15), 1 on [15,20]
    // area = 0*10 + 2*4 + 5*1 + 1*5 = 18  -> mean over 20 = 0.9
    const s = new TimeWeightedStat(0, 0);
    s.set(10, 2);
    s.set(14, 5);
    s.set(15, 1);
    expect(s.mean(20)).toBeCloseTo(0.9, 12);
    expect(s.max(20)).toBe(5);
    // a plain average of the sampled values (0,2,5,1) would be 2 — the wrong answer
  });

  it("ignores zero-duration spikes for max and the mean", () => {
    const s = new TimeWeightedStat(0, 0);
    s.set(5, 1);
    s.set(5, 0);
    expect(s.max(10)).toBe(0);
    expect(s.mean(10)).toBe(0);
  });

  it("reset restarts accumulation but keeps the current value", () => {
    const s = new TimeWeightedStat(0, 0);
    s.set(10, 4);
    s.reset(10);
    expect(s.current).toBe(4);
    s.set(20, 0);
    expect(s.mean(30)).toBeCloseTo(2, 12); // 4 for 10, 0 for 10 -> 40/20
    expect(s.max(30)).toBe(4);
  });

  it("returns the current value when no time elapsed", () => {
    expect(new TimeWeightedStat(5, 3).mean(5)).toBe(3);
  });
});

describe("ExactPercentileTracker", () => {
  it("matches known percentiles with linear interpolation", () => {
    const t = new ExactPercentileTracker();
    for (let i = 1; i <= 101; i++) t.add(i); // 1..101
    expect(t.count).toBe(101);
    expect(t.mean()).toBe(51);
    expect(t.percentile(0)).toBe(1);
    expect(t.percentile(50)).toBe(51);
    expect(t.percentile(99)).toBeCloseTo(100, 12);
    expect(t.percentile(100)).toBe(101);
  });

  it("interpolates and sorts lazily; reset clears", () => {
    const t = new ExactPercentileTracker();
    [4, 1, 3, 2].forEach((x) => t.add(x));
    expect(t.percentile(50)).toBe(2.5);
    t.add(0);
    expect(t.percentile(0)).toBe(0);
    t.reset();
    expect(t.count).toBe(0);
    expect(t.percentile(50)).toBeNaN();
    expect(t.mean()).toBeNaN();
  });
});

describe("Tally", () => {
  it("tracks count/mean/min/max", () => {
    const t = new Tally();
    expect(t.mean()).toBeNaN();
    [3, 1, 5].forEach((x) => t.add(x));
    expect(t.count).toBe(3);
    expect(t.mean()).toBe(3);
    expect(t.min).toBe(1);
    expect(t.max).toBe(5);
  });
});

describe("summarize", () => {
  it("computes mean and a t-based 95% CI", () => {
    const s = summarize([10, 12, 14, 16, 18]);
    expect(s.mean).toBe(14);
    expect(s.stdDev).toBeCloseTo(Math.sqrt(10), 12);
    // t(0.975, df=4) = 2.776445; half width = 2.776445 * sqrt(10)/sqrt(5)
    expect(s.ci95?.halfWidth).toBeCloseTo(2.776445 * Math.sqrt(2), 5);
  });
  it("handles n = 0, 1 and non-finite values", () => {
    expect(summarize([]).mean).toBeNull();
    expect(summarize([NaN]).n).toBe(0);
    const one = summarize([3, NaN]);
    expect(one.mean).toBe(3);
    expect(one.ci95).toBeNull();
  });
  it("t quantiles match reference values", () => {
    expect(tQuantile975(1)).toBeCloseTo(12.7062, 3);
    expect(tQuantile975(9)).toBeCloseTo(2.2622, 3);
    expect(tQuantile975(31)).toBeCloseTo(2.0395, 3);
    expect(tQuantile975(60)).toBeCloseTo(2.0003, 3);
    expect(tQuantile975(120)).toBeCloseTo(1.9799, 3);
    expect(tQuantile975(100000)).toBeCloseTo(1.96, 3);
  });
});

describe("Student t distribution", () => {
  it("matches the exact closed forms for 1 and 2 degrees of freedom", () => {
    for (const t of [0.1, 0.5, 1, 2.5, 10, 100]) {
      // df = 1 is the Cauchy distribution, df = 2 has P(|T| >= t) = 1 - t / sqrt(t^2 + 2)
      expect(tTwoSidedP(t, 1)).toBeCloseTo(1 - (2 / Math.PI) * Math.atan(t), 12);
      expect(tTwoSidedP(t, 2)).toBeCloseTo(1 - t / Math.sqrt(t * t + 2), 12);
    }
  });

  it("reproduces published two-sided 5% critical values", () => {
    for (const [df, crit] of [[5, 2.5706], [10, 2.2281], [20, 2.086], [30, 2.0423], [120, 1.9799]] as const) {
      expect(tTwoSidedP(crit, df)).toBeCloseTo(0.05, 4);
    }
  });

  it("is symmetric, and the quantile inverts the CDF (also for fractional df)", () => {
    expect(tCdf(0, 7)).toBe(0.5);
    expect(tCdf(-1.3, 7) + tCdf(1.3, 7)).toBeCloseTo(1, 12);
    for (const df of [1, 2.5, 7.3, 19.998, 250]) {
      for (const p of [0.6, 0.9, 0.975, 0.999]) expect(tCdf(tQuantile(p, df), df)).toBeCloseTo(p, 10);
    }
    expect(tQuantile(0.975, 10)).toBeCloseTo(2.2281, 4);
    expect(tQuantile(0.025, 10)).toBeCloseTo(-2.2281, 4);
    // Published two-sided 95% critical values
    for (const [df, t] of [[1, 12.7062], [2, 4.3027], [30, 2.0423], [120, 1.9799]] as const) {
      expect(tQuantile975(df)).toBeCloseTo(t, 4);
    }
  });

  it("handles degenerate inputs without throwing", () => {
    expect(tTwoSidedP(Infinity, 5)).toBe(0);
    expect(tTwoSidedP(0, 5)).toBe(1);
    expect(tTwoSidedP(1, 0)).toBeNaN();
    expect(tQuantile(1, 5)).toBeNaN();
  });
});

describe("welchTTest", () => {
  it("matches a hand calculation: n 10 mean 20 sd 5 against n 12 mean 24 sd 6", () => {
    const r = welchTTest({ n: 10, mean: 20, stdDev: 5 }, { n: 12, mean: 24, stdDev: 6 });
    expect(r).not.toBeNull();
    // se^2 = 25/10 + 36/12 = 5.5; t = 4 / sqrt(5.5); df = 5.5^2 / (2.5^2/9 + 3^2/11)
    expect(r!.diff).toBe(4);
    expect(r!.t).toBeCloseTo(4 / Math.sqrt(5.5), 12);
    expect(r!.df).toBeCloseTo(30.25 / (6.25 / 9 + 9 / 11), 10);
    expect(r!.pValue).toBeGreaterThan(0.1); // t = 1.706 is just under the two-sided 10% critical value of 1.725 (df 20)
    expect(r!.pValue).toBeLessThan(0.11);
    // the 95% interval for the difference excludes zero exactly when p < 0.05
    expect(r!.ci95.low).toBeLessThan(0);
    expect(r!.ci95.high).toBeGreaterThan(4);
  });

  it("gives the same df at any scale, even when squared variances underflow", () => {
    const df = welchTTest({ n: 10, mean: 20, stdDev: 5 }, { n: 12, mean: 24, stdDev: 6 })!.df;
    const tiny = welchTTest({ n: 10, mean: 20e-100, stdDev: 5e-100 }, { n: 12, mean: 24e-100, stdDev: 6e-100 })!;
    expect(tiny.df).toBeCloseTo(df, 10);
    expect(tiny.pValue).toBeGreaterThan(0.1);
  });

  it("the interval excludes zero exactly when p < 0.05", () => {
    for (const shift of [0, 1, 2, 3, 5]) {
      const r = welchTTest({ n: 8, mean: 10, stdDev: 2 }, { n: 9, mean: 10 + shift, stdDev: 3 })!;
      expect(r.pValue < 0.05).toBe(r.ci95.low > 0 || r.ci95.high < 0);
    }
  });

  it("is antisymmetric in the difference and symmetric in p", () => {
    const a = { n: 6, mean: 3, stdDev: 1 };
    const b = { n: 9, mean: 5, stdDev: 2 };
    const ab = welchTTest(a, b)!;
    const ba = welchTTest(b, a)!;
    expect(ba.diff).toBe(-ab.diff);
    expect(ba.pValue).toBeCloseTo(ab.pValue, 12);
    expect(ba.ci95.low).toBeCloseTo(-ab.ci95.high, 10);
  });

  it("cannot be computed from fewer than 2 values on either side", () => {
    expect(welchTTest({ n: 1, mean: 1, stdDev: null }, { n: 5, mean: 2, stdDev: 1 })).toBeNull();
    expect(welchTTest({ n: 5, mean: 1, stdDev: 1 }, { n: 0, mean: null, stdDev: null })).toBeNull();
  });

  it("treats two constant samples as an exact comparison", () => {
    expect(welchTTest({ n: 4, mean: 7, stdDev: 0 }, { n: 4, mean: 7, stdDev: 0 })!.pValue).toBe(1);
    const r = welchTTest({ n: 4, mean: 7, stdDev: 0 }, { n: 4, mean: 8, stdDev: 0 })!;
    expect(r.pValue).toBe(0);
    expect(r.ci95).toEqual({ low: 1, high: 1 });
  });

  it("false-positive rate is close to alpha when both samples come from the same distribution", () => {
    // deterministic LCG so the test never flakes
    let seed = 12345;
    const u = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed + 0.5) / 4294967296;
    };
    const sample = (n: number) => {
      const xs = Array.from({ length: n }, () => -Math.log(u())); // exponential: skewed, like latencies
      return summarize(xs);
    };
    let rejected = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      const r = welchTTest(sample(10), sample(10))!;
      if (r.pValue < 0.05) rejected++;
    }
    expect(rejected / trials).toBeGreaterThan(0.03);
    expect(rejected / trials).toBeLessThan(0.07);
  });
});

describe("pairedTTest", () => {
  it("matches a hand calculation", () => {
    // differences 1,2,2,3,3: mean 2.2, variance 0.7, se sqrt(0.7 / 5), t = 5.8797 on 4 df
    const a = [1, 2, 3, 4, 5];
    const b = [2, 4, 5, 7, 8];
    const r = pairedTTest(a, b)!;
    expect(r.diff).toBeCloseTo(2.2, 12);
    expect(r.df).toBe(4);
    expect(r.t).toBeCloseTo(2.2 / Math.sqrt(0.14), 10);
    // the two-sided critical values for 4 df are 4.604 (p = 0.01) and 5.598 (p = 0.005) and 8.610 (p = 0.001)
    expect(r.pValue).toBeGreaterThan(0.001);
    expect(r.pValue).toBeLessThan(0.005);
    expect(r.ci95.low).toBeCloseTo(2.2 - 2.7764 * Math.sqrt(0.14), 3);
    expect(r.ci95.high).toBeCloseTo(2.2 + 2.7764 * Math.sqrt(0.14), 3);
    // the same numbers treated as unrelated samples are far less convincing
    const w = welchTTest(summarize(a), summarize(b))!;
    expect(w.pValue).toBeGreaterThan(0.05);
  });

  it("is antisymmetric in the difference, symmetric in p, and its interval excludes zero exactly when p < 0.05", () => {
    const a = [3, 1, 4, 1, 5, 9];
    const b = [4, 3, 4, 2, 9, 12];
    const ab = pairedTTest(a, b)!;
    const ba = pairedTTest(b, a)!;
    expect(ba.diff).toBeCloseTo(-ab.diff, 12);
    expect(ba.pValue).toBeCloseTo(ab.pValue, 12);
    for (const shift of [0, 0.5, 1, 2, 4]) {
      const r = pairedTTest(a, b.map((v) => v + shift))!;
      expect(r.pValue < 0.05).toBe(r.ci95.low > 0 || r.ci95.high < 0);
    }
  });

  it("cannot be computed from fewer than 2 pairs, unequal lengths or non-finite values", () => {
    expect(pairedTTest([1], [2])).toBeNull();
    expect(pairedTTest([1, 2, 3], [1, 2])).toBeNull();
    expect(pairedTTest([1, 2, 3], [1, NaN, 3])).toBeNull();
    expect(pairedTTest([1, 2, 3], [1, Infinity, 3])).toBeNull();
  });

  it("treats a constant difference as exact, including one that only differs by rounding", () => {
    expect(pairedTTest([1, 2, 3], [1, 2, 3])!.pValue).toBe(1);
    const shifted = pairedTTest([1, 2, 3], [3, 4, 5])!;
    expect(shifted.pValue).toBe(0);
    expect(shifted.ci95).toEqual({ low: 2, high: 2 });
    expect(pairedTTest([0.1, 0.2, 0.3], [0.1 + 0.7, 0.2 + 0.7, 0.3 + 0.7])!.pValue).toBe(0);
  });

  it("false-positive rate is close to alpha even when the two runs are strongly correlated", () => {
    let seed = 987;
    const u = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed + 0.5) / 4294967296;
    };
    let rejected = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      const common = Array.from({ length: 8 }, () => -Math.log(u()) * 10); // large shared noise
      const a = common.map((c) => c + -Math.log(u()));
      const b = common.map((c) => c + -Math.log(u()));
      if (pairedTTest(a, b)!.pValue < 0.05) rejected++;
    }
    expect(rejected / trials).toBeGreaterThan(0.03);
    expect(rejected / trials).toBeLessThan(0.07);
  });
});

describe("adjustPValues (Benjamini-Hochberg)", () => {
  it("matches a hand calculation", () => {
    // sorted: 0.01, 0.02, 0.03, 0.04 with m = 4 -> 0.04, 0.04, 0.04, 0.04
    expect(adjustPValues([0.04, 0.01, 0.03, 0.02])).toEqual([0.04, 0.04, 0.04, 0.04].map((v) => expect.closeTo(v, 12)));
    // 0.001 * 3 / 1 = 0.003; 0.04 * 3 / 2 = 0.06; 0.5 * 3 / 3 = 0.5
    const adj = adjustPValues([0.5, 0.001, 0.04]);
    expect(adj[0]).toBeCloseTo(0.5, 12);
    expect(adj[1]).toBeCloseTo(0.003, 12);
    expect(adj[2]).toBeCloseTo(0.06, 12);
  });

  it("never lowers a p-value, never exceeds 1, and keeps the order of the raw values", () => {
    const raw = [0.2, 0.9, 0.0004, 0.03, 0.5, 0.049, 1];
    const adj = adjustPValues(raw) as number[];
    raw.forEach((p, i) => {
      expect(adj[i]).toBeGreaterThanOrEqual(p);
      expect(adj[i]).toBeLessThanOrEqual(1);
    });
    const order = [...raw.keys()].sort((x, y) => (raw[x] as number) - (raw[y] as number));
    for (let k = 1; k < order.length; k++) expect(adj[order[k] as number]).toBeGreaterThanOrEqual(adj[order[k - 1] as number] as number);
  });

  it("leaves untestable entries null and does not count them as tests", () => {
    expect(adjustPValues([null, 0.01, null])).toEqual([null, 0.01, null]);
    expect(adjustPValues([])).toEqual([]);
  });
});
