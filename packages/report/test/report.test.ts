import { describe, expect, it } from "vitest";
import { loadModel, runModel, type RunResults } from "@surgesim/engine";
import { computeDeltas, renderComparison, renderReport } from "../src/index.js";

type Comp = { type: string; name: string; inputs?: object; links?: object };

function results(opts: { name?: string; workers?: number; replications?: number; seed?: number; assertions?: unknown[]; series?: boolean } = {}): RunResults {
  const components: Comp[] = [
    { type: "EntityGenerator", name: "gen", inputs: { interArrivalTime: { dist: "exponential", mean: 0.5 } }, links: { next: "q" } },
    { type: "Queue", name: "q" },
    { type: "WorkerPool", name: "pool", inputs: { concurrency: opts.workers ?? 3, serviceTime: { dist: "exponential", mean: 1 } }, links: { queue: "q", next: "sink" } },
    { type: "EntitySink", name: "sink" },
  ];
  const loaded = loadModel({
    version: 1,
    name: opts.name ?? "report test",
    settings: {
      duration: 400,
      replications: opts.replications ?? 4,
      seed: opts.seed ?? 3,
      ...(opts.series === false ? {} : { timeSeries: { interval: 20, outputs: ["q.QueueLength", "pool.BusyWorkers"] } }),
    },
    components,
    ...(opts.assertions ? { assertions: opts.assertions } : {}),
  });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return runModel(loaded.model);
}

const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");

describe("renderReport", () => {
  const r = results({ assertions: [{ output: "sink.mean", op: "<", value: 1000, name: "fine" }, { output: "sink.mean", op: "<", value: 0.001 }] });
  const html = renderReport(r);

  it("is a complete, self-contained HTML document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>report test</title>");
    expect(html).toContain('<meta name="viewport"');
    // no external assets: nothing is fetched from anywhere
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).not.toMatch(/<script[^>]*\bsrc=/i);
  });

  it("is deterministic: the same results give the same bytes (no timestamps)", () => {
    expect(renderReport(r)).toBe(html);
  });

  it("shows assertions with an icon and a label, not color alone", () => {
    expect(html).toContain("1 passed, 1 failed");
    expect(html).toMatch(/class="badge pass"[^>]*>\s*<svg[\s\S]*?<\/svg>PASS/);
    expect(html).toMatch(/class="badge fail"[^>]*>\s*<svg[\s\S]*?<\/svg>FAIL/);
    expect(text(html)).toContain("fine: sink.mean (mean)");
  });

  it("contains a latency chart, one time-series chart per sampled output, tables and a table view for each chart", () => {
    expect(html).toContain("sink · time in system");
    expect((html.match(/<figure class="chart card"/g) ?? []).length).toBe(2);
    expect((html.match(/<summary>Table view<\/summary>/g) ?? []).length).toBe(2);
    expect(text(html)).toContain("q · QueueLength");
    expect(html).toContain("<h2>All results</h2>");
    expect(html).toContain("Replications (4)");
    expect(html).toContain("Per-replication values (");
  });

  it("every value shown also exists without script: charts carry a data table", () => {
    expect(html).toMatch(/<table>[\s\S]*?<th class="n">seconds<\/th>/);
  });

  it("never prints undefined, NaN or null", () => {
    const t = text(html);
    expect(t).not.toMatch(/\bundefined\b|\bNaN\b|\bnull\b/);
  });

  it("uses tokens for color and supports both OS dark mode and an explicit theme", () => {
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain("--series-1: #2a78d6");
    expect(html).toContain("--series-1: #3987e5");
  });

  it("omits sections it has no data for", () => {
    const bare = renderReport(results({ series: false, replications: 1 }));
    expect(bare).not.toContain("<h2>Over time</h2>");
    expect(bare).not.toContain("<h2>Assertions</h2>");
    expect(bare).toContain("A single replication: no confidence intervals.");
  });

  it("escapes model-controlled text everywhere (no markup injection)", () => {
    const evil = results({ name: `<img src=x onerror=alert(1)> & "quotes"` });
    const out = renderReport(evil);
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;");
    // the chart data attribute stays inside its quotes
    expect(out).not.toMatch(/data-chart="[^"]*"[^>]*onerror/);
  });

  it("the script only writes text with textContent (no innerHTML)", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(script).toContain("textContent");
  });

  it("honours a title override", () => {
    expect(renderReport(r, { title: "Q3 capacity review" })).toContain("<h1>Q3 capacity review</h1>");
  });
});

describe("renderComparison", () => {
  const a = results({ workers: 3, assertions: [{ output: "sink.mean", op: "<", value: 100 }] });
  const b = results({ workers: 1, assertions: [{ output: "sink.mean", op: "<", value: 3 }] });
  const html = renderComparison({ label: "3 workers", results: a }, { label: "1 worker", results: b });

  it("has a legend whose two series differ by shape as well as color", () => {
    expect(html).toContain("3 workers (circle)");
    expect(html).toContain("1 worker (square)");
    expect(html).toMatch(/class="swatch s1"/);
    expect(html).toMatch(/class="swatch s2"/);
    expect(html).toMatch(/<circle class="dot-1 ring"/);
    expect(html).toMatch(/<rect class="dot-2 ring"/);
  });

  it("overlays both runs on each shared time series, with bands, and a table view", () => {
    expect((html.match(/<figure class="chart card"/g) ?? []).length).toBe(2);
    expect(html).toContain('class="line-1"');
    expect(html).toContain('class="line-2"');
    expect(html).toContain('class="band-1"');
    expect(html).toContain('class="band-2"');
    expect(html).toContain("<summary>Table view</summary>");
  });

  it("flags a difference only when the test, adjusted for the number of outputs, says so", () => {
    const { deltas } = computeDeltas(a, b);
    const mean = deltas.find((d) => d.id === "sink.mean")!;
    expect(mean.significant).toBe(true); // 3 workers vs 1 worker at rho ~ 0.67 vs 2: wildly different
    expect(mean.pValue).toBeLessThan(0.001);
    expect(mean.adjustedPValue as number).toBeGreaterThanOrEqual(mean.pValue as number);
    // the interval for the change excludes zero and contains the observed change
    expect(mean.diffCi95!.low).toBeGreaterThan(0);
    expect(mean.diff as number).toBeGreaterThan(mean.diffCi95!.low);
    expect(mean.diff as number).toBeLessThan(mean.diffCi95!.high);
    const generated = deltas.find((d) => d.id === "gen.NumberGenerated")!;
    expect(generated.diff).toBe(0); // same seed, same arrivals
    expect(generated.significant).toBe(false);
    for (const d of deltas) expect(d.significant).toBe(d.adjustedPValue === null ? null : d.adjustedPValue < 0.05);
    expect(html).toContain("differs");
    expect(html).toContain("within noise");
    expect(html).toContain("<h2>Biggest differences</h2>");
    expect(text(html)).toContain("Welch");
    expect(html).not.toContain("intervals do not overlap");
  });

  it("does not call two runs of the same model with different seeds different", () => {
    const x = results({ seed: 11, replications: 8, series: false });
    const y = results({ seed: 99, replications: 8, series: false });
    const { deltas } = computeDeltas(x, y);
    expect(deltas.length).toBeGreaterThan(10);
    expect(deltas.filter((d) => d.significant === true).map((d) => d.id)).toEqual([]);
  });

  it("is a stronger claim than overlapping intervals: a small but consistent shift is detected", () => {
    // 4 replications each: the means differ by ~1.5 sd, so 95% intervals overlap, but each run is a stable sample
    const mk = (mean: number, sd: number): RunResults => {
      const r = results({ replications: 2, series: false });
      const o = r.outputs.find((x) => x.id === "sink.mean")!;
      o.n = 6;
      o.mean = mean;
      o.stdDev = sd;
      o.ci95 = { low: mean - 2.5706 * (sd / Math.sqrt(6)), high: mean + 2.5706 * (sd / Math.sqrt(6)), halfWidth: 2.5706 * (sd / Math.sqrt(6)) };
      return r;
    };
    const lo = mk(10, 1);
    const hi = mk(11.4, 1);
    const ol = lo.outputs.find((x) => x.id === "sink.mean")!.ci95!;
    const oh = hi.outputs.find((x) => x.id === "sink.mean")!.ci95!;
    expect(ol.high).toBeGreaterThan(oh.low); // the old overlap rule would say "within noise"
    const d = computeDeltas(lo, hi).deltas.find((x) => x.id === "sink.mean")!;
    expect(d.pValue).toBeLessThan(0.05);
  });

  it("needs 2+ replications on both sides", () => {
    const one = results({ replications: 1, series: false });
    const many = results({ replications: 4, series: false });
    const d = computeDeltas(one, many).deltas.find((x) => x.id === "sink.mean")!;
    expect(d.pValue).toBeNull();
    expect(d.adjustedPValue).toBeNull();
    expect(d.diffCi95).toBeNull();
    expect(d.significant).toBeNull();
    expect(renderComparison({ label: "one", results: one }, { label: "many", results: many })).toContain("needs 2+ replications");
  });

  it("drills down to every replication: a strip plot per big difference and a table of all values", () => {
    expect((html.match(/<svg class="plot strip"/g) ?? []).length).toBeGreaterThan(0);
    expect(html).toContain("Replication spread");
    // one dot per replication per run, each with a tooltip
    const firstStrip = /<svg class="plot strip"[\s\S]*?<\/svg>/.exec(html)![0];
    expect((firstStrip.match(/<title>[^<]*replication \d/g) ?? []).length).toBe(8);
    expect(html).toContain("Per-replication values (");
    const meanRow = /<td rowspan="2">sink\.mean<\/td><td>3 workers<\/td>(?:<td class="n">[^<]*<\/td>){4}<\/tr><tr><td>1 worker<\/td>(?:<td class="n">[^<]*<\/td>){4}<\/tr>/;
    expect(html).toMatch(meanRow);
    const t = text(html);
    expect(t).not.toMatch(/undefined|NaN|null/);
  });

  it("computes change as B minus A", () => {
    const { deltas } = computeDeltas(a, b);
    const d = deltas.find((x) => x.id === "sink.mean")!;
    expect(d.diff).toBeCloseTo((b.outputs.find((o) => o.id === "sink.mean")!.mean as number) - (a.outputs.find((o) => o.id === "sink.mean")!.mean as number), 12);
    expect(d.pct).toBeCloseTo(((d.diff as number) / (d.a.mean as number)) * 100, 9);
  });

  it("with a single replication it cannot claim significance and says so", () => {
    const one = results({ replications: 1 });
    const two = results({ replications: 1, workers: 1 });
    const out = renderComparison({ label: "A", results: one }, { label: "B", results: two });
    expect(computeDeltas(one, two).deltas.every((d) => d.significant === null)).toBe(true);
    expect(out).toContain("needs 2+ replications");
    expect(out).not.toContain("<h2>Biggest differences</h2>");
  });

  it("shows each side's assertions", () => {
    expect(html).toContain('class="badge pass"');
    expect(html).toContain('class="badge fail"');
    expect(html).toContain("3 workers");
  });

  it("lists outputs that exist on only one side instead of dropping them silently", () => {
    const noSeries = results({ series: false });
    const withExtra = JSON.parse(JSON.stringify(noSeries)) as RunResults;
    withExtra.outputs.push({ ...noSeries.outputs[0]!, id: "extra.Thing", component: "extra", key: "Thing" });
    const out = renderComparison({ label: "A", results: noSeries }, { label: "B", results: withExtra });
    expect(out).toContain("Only in B: extra.Thing.");
  });

  it("skips overlays whose sampling times differ, and says which", () => {
    const x = results();
    const y = JSON.parse(JSON.stringify(x)) as RunResults;
    for (const rep of y.timeSeries!.replications) rep.times = rep.times.map((t) => t + 1);
    const out = renderComparison({ label: "A", results: x }, { label: "B", results: y });
    expect(out).not.toContain('class="line-2"');
    expect(out).toContain("Not overlaid (different sampling times)");
  });

  it("escapes labels", () => {
    const out = renderComparison({ label: "<b>A</b>", results: a }, { label: "B&C", results: b });
    expect(out).not.toContain("<b>A</b>");
    expect(out).toContain("&lt;b&gt;A&lt;/b&gt;");
    expect(out).toContain("B&amp;C");
  });
});
