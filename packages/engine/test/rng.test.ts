import { describe, expect, it } from "vitest";
import {
  Rng,
  createSampler,
  deriveSeed,
  samplerMean,
  validateSamplerSpec,
  type SamplerSpec,
} from "../src/index.js";

function draw(spec: SamplerSpec, n: number, seed = 7): number[] {
  const s = createSampler(spec, new Rng(seed, "t"));
  return Array.from({ length: n }, () => s.nextSample());
}
const lo = (a: number[]) => a.reduce((x, y) => Math.min(x, y), Infinity);
const hi = (a: number[]) => a.reduce((x, y) => Math.max(x, y), -Infinity);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const variance = (a: number[]) => {
  const m = mean(a);
  return a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1);
};

describe("Rng", () => {
  it("is reproducible for the same (seed, stream)", () => {
    const a = new Rng(42, "gen");
    const b = new Rng(42, "gen");
    for (let i = 0; i < 100; i++) expect(a.nextFloat()).toBe(b.nextFloat());
  });

  it("differs across seeds and across streams", () => {
    const first = (r: Rng) => Array.from({ length: 5 }, () => r.nextUint32());
    expect(first(new Rng(1, "a"))).not.toEqual(first(new Rng(2, "a")));
    expect(first(new Rng(1, "a"))).not.toEqual(first(new Rng(1, "b")));
    expect(first(new Rng(1, 0))).not.toEqual(first(new Rng(1, 1)));
  });

  it("produces floats in [0,1) with mean 1/2 and variance 1/12", () => {
    const r = new Rng(3, "u");
    const xs = Array.from({ length: 200_000 }, () => r.nextFloat());
    expect(lo(xs)).toBeGreaterThanOrEqual(0);
    expect(hi(xs)).toBeLessThan(1);
    expect(mean(xs)).toBeCloseTo(0.5, 2);
    expect(variance(xs)).toBeCloseTo(1 / 12, 2);
  });

  it("has uncorrelated neighbouring streams", () => {
    const a = new Rng(5, "s1");
    const b = new Rng(5, "s2");
    const n = 100_000;
    let sxy = 0;
    for (let i = 0; i < n; i++) sxy += (a.nextFloat() - 0.5) * (b.nextFloat() - 0.5);
    const corr = sxy / n / (1 / 12);
    expect(Math.abs(corr)).toBeLessThan(0.02);
  });

  it("deriveSeed is deterministic and spreads indices", () => {
    expect(deriveSeed(42, 0)).toBe(deriveSeed(42, 0));
    const seeds = new Set(Array.from({ length: 1000 }, (_, i) => deriveSeed(42, i)));
    expect(seeds.size).toBe(1000);
    for (const s of seeds) {
      expect(Number.isSafeInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
    expect(deriveSeed(1, 3)).not.toBe(deriveSeed(2, 3));
  });
});

describe("distributions", () => {
  const N = 200_000;
  it("constant", () => {
    expect(draw(5, 3)).toEqual([5, 5, 5]);
    expect(draw({ dist: "constant", value: 2 }, 2)).toEqual([2, 2]);
  });
  it("uniform", () => {
    const xs = draw({ dist: "uniform", min: 2, max: 6 }, N);
    expect(lo(xs)).toBeGreaterThanOrEqual(2);
    expect(hi(xs)).toBeLessThan(6);
    expect(mean(xs)).toBeCloseTo(4, 1);
    expect(variance(xs)).toBeCloseTo(16 / 12, 1);
  });
  it("exponential", () => {
    const xs = draw({ dist: "exponential", mean: 2.5 }, N);
    expect(lo(xs)).toBeGreaterThanOrEqual(0);
    expect(mean(xs)).toBeCloseTo(2.5, 1);
    expect(variance(xs)).toBeCloseTo(6.25, 0);
  });
  it("normal", () => {
    const xs = draw({ dist: "normal", mean: 10, stdDev: 3 }, N);
    expect(mean(xs)).toBeCloseTo(10, 1);
    expect(Math.sqrt(variance(xs))).toBeCloseTo(3, 1);
  });
  it("triangular", () => {
    const spec = { dist: "triangular", min: 1, mode: 2, max: 6 } as const;
    const xs = draw(spec, N);
    expect(lo(xs)).toBeGreaterThanOrEqual(1);
    expect(hi(xs)).toBeLessThanOrEqual(6);
    expect(mean(xs)).toBeCloseTo(samplerMean(spec), 1);
  });
  it("lognormal has the requested mean and stdDev", () => {
    const xs = draw({ dist: "lognormal", mean: 0.5, stdDev: 0.25 }, N);
    expect(lo(xs)).toBeGreaterThan(0);
    expect(mean(xs)).toBeCloseTo(0.5, 2);
    expect(Math.sqrt(variance(xs))).toBeCloseTo(0.25, 2);
  });
  it("empirical reproduces its points and stays inside them", () => {
    // Half the mass uniform on [0, 1], 40% on [1, 2], 10% on [2, 10]: mean 0.25 + 0.6 + 0.6 = 1.45
    const spec = { dist: "empirical", points: [[0, 0], [0.5, 1], [0.9, 2], [1, 10]] } as const;
    expect(samplerMean(spec)).toBeCloseTo(1.45, 12);
    const xs = draw(spec, N);
    expect(lo(xs)).toBeGreaterThanOrEqual(0);
    expect(hi(xs)).toBeLessThanOrEqual(10);
    expect(xs.filter((x) => x <= 1).length / N).toBeCloseTo(0.5, 2);
    expect(xs.filter((x) => x <= 2).length / N).toBeCloseTo(0.9, 2);
    expect(mean(xs)).toBeCloseTo(1.45, 1);
  });
  it("empirical with a repeated value has an atom there, and two points make a uniform", () => {
    const atom = draw({ dist: "empirical", points: [[0, 3], [0.3, 3], [1, 4]] }, 10_000);
    expect(atom.filter((x) => x === 3).length).toBeGreaterThan(2_800);
    const u = draw({ dist: "empirical", points: [[0, 2], [1, 6]] }, N);
    expect(mean(u)).toBeCloseTo(4, 1);
    expect(variance(u)).toBeCloseTo(16 / 12, 1);
  });
});

describe("validateSamplerSpec", () => {
  it("accepts good specs", () => {
    expect(validateSamplerSpec(3)).toEqual([]);
    expect(validateSamplerSpec({ dist: "lognormal", mean: 0.5, stdDev: 0.2 })).toEqual([]);
  });
  it("reports problems", () => {
    expect(validateSamplerSpec("x")).not.toEqual([]);
    expect(validateSamplerSpec({ dist: "nope" })).not.toEqual([]);
    expect(validateSamplerSpec({ dist: "exponential" })).toEqual(['exponential: "mean" must be a finite number']);
    expect(validateSamplerSpec({ dist: "exponential", mean: -1 })).toEqual(["exponential: mean must be > 0"]);
    expect(validateSamplerSpec({ dist: "uniform", min: 3, max: 1 })).not.toEqual([]);
    expect(validateSamplerSpec({ dist: "triangular", min: 1, mode: 9, max: 3 })).not.toEqual([]);
    expect(validateSamplerSpec({ dist: "constant", value: 1, extra: 2 })).not.toEqual([]);
    expect(validateSamplerSpec(NaN)).not.toEqual([]);
  });
  it("reports problems with empirical points", () => {
    const e = (points: unknown) => validateSamplerSpec({ dist: "empirical", points });
    expect(e([[0, 1], [1, 2]])).toEqual([]);
    expect(validateSamplerSpec({ dist: "empirical" })).not.toEqual([]);
    expect(e("x")).toEqual(['empirical: "points" must be an array of at least 2 [probability, value] pairs']);
    expect(e([[0, 1]])).not.toEqual([]);
    expect(e([[0, 1], [1]])).toEqual(["empirical: point 1 must be a [probability, value] pair of finite numbers"]);
    expect(e([[0, 1], [0.5, NaN], [1, 2]])).not.toEqual([]);
    expect(e([[0, 1], [0.5, 2], [0.5, 3], [1, 4]])).toEqual(["empirical: point 2: probabilities must be strictly increasing"]);
    expect(e([[0, 1], [0.5, 3], [1, 2]])).toEqual(["empirical: point 2: values must not decrease"]);
    expect(e([[0.1, 1], [0.9, 2]])).toEqual([
      "empirical: the first probability must be 0 (the minimum value)",
      "empirical: the last probability must be 1 (the maximum value)",
    ]);
    expect(validateSamplerSpec({ dist: "empirical", points: [[0, 1], [1, 2]], mean: 1 })).toEqual(['empirical: unknown parameter "mean"']);
  });
});
