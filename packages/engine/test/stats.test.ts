import { describe, expect, it } from "vitest";
import { ExactPercentileTracker, Tally, TimeWeightedStat, summarize, tQuantile975 } from "../src/stats/index.js";

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
    // t(0.975, df=4) = 2.7764; half width = 2.7764 * sqrt(10)/sqrt(5)
    expect(s.ci95?.halfWidth).toBeCloseTo(2.7764 * Math.sqrt(2), 4);
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
