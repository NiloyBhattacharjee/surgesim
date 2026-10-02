import type { AssertionResult, OutputSummary, RunResults, TimeSeriesResult } from "@surgesim/engine";
import { barChart, lineChart, type BarRow, type LineSeries } from "./charts.js";
import { SCRIPT } from "./script.js";
import { STYLES } from "./styles.js";
import { compact, esc, fmt, unitSuffix } from "./util.js";

/** Options shared by the report renderers. */
export interface ReportOptions {
  /** Override the page title (default: the model name). */
  title?: string;
}

/** A labelled set of results, for comparisons. */
export interface LabelledResults {
  label: string;
  results: RunResults;
}

const PASS_ICON = `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5.5 4 8l4.5-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FAIL_ICON = `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

function page(title: string, body: string): string {
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="generator" content="Surgesim">\n<title>${esc(title)}</title>\n<style>${STYLES}</style>\n</head>\n` +
    `<body>\n<main>\n${body}\n</main>\n<script>${SCRIPT}</script>\n</body>\n</html>\n`
  );
}

function settingsLine(r: RunResults): string {
  const s = r.settings;
  return `${fmt(s.duration)} s simulated${s.warmUp > 0 ? `, ${fmt(s.warmUp)} s warm-up` : ""} · seed ${s.seed} · ${s.replications} replication${s.replications === 1 ? "" : "s"}`;
}

function ciNote(r: RunResults): string {
  return r.settings.replications > 1
    ? "Values are means across replications; intervals are 95% confidence intervals (Student t)."
    : "A single replication: no confidence intervals.";
}

// ---- assertions

function assertionList(list: readonly AssertionResult[]): string {
  return `<ul class="assertions">${list
    .map(
      (a) =>
        `<li><span class="badge ${a.passed ? "pass" : "fail"}">${a.passed ? PASS_ICON + "PASS" : FAIL_ICON + "FAIL"}</span><span>${esc(a.message)}</span></li>`,
    )
    .join("")}</ul>`;
}

function assertionsCard(list: readonly AssertionResult[] | undefined, heading = "Assertions"): string {
  if (!list || list.length === 0) return "";
  const failed = list.filter((a) => !a.passed).length;
  return (
    `<h2>${esc(heading)}</h2><section class="card"><p class="sub ${failed === 0 ? "summary-pass" : ""}"><strong>${list.length - failed} passed, ${failed} failed</strong></p>` +
    `${assertionList(list)}</section>`
  );
}

// ---- headline tiles

interface Tile {
  label: string;
  value: string;
  ci: string;
}

const HEADLINE: Record<string, { label: string; percent?: boolean; always?: boolean }> = {
  Utilisation: { label: "utilisation", percent: true, always: true },
  MaxQueueLength: { label: "peak length" },
  ThrottleFraction: { label: "throttled share", percent: true },
  RejectionFraction: { label: "rejected share", percent: true },
  NumberDropped: { label: "dropped" },
  NumberDeadLettered: { label: "dead-lettered" },
  NumberGivenUp: { label: "given up" },
  RetryAmplification: { label: "amplification" },
  NumberThrottled: { label: "throttled calls" },
  Cost: { label: "cost" },
};

function tileFor(o: OutputSummary, label: string, percent = false): Tile {
  const show = (v: number) => (percent ? `${fmt(v * 100)}%` : o.key === "Cost" ? fmt(v) : compact(v) + unitSuffix(o.unit));
  return {
    label,
    value: o.mean === null ? "n/a" : show(o.mean),
    ci: o.ci95 ? `95% CI ${show(o.ci95.low)} to ${show(o.ci95.high)}` : "",
  };
}

function headlineTiles(results: RunResults): Tile[] {
  const tiles: Tile[] = [];
  for (const o of results.outputs) {
    if (o.mean === null) continue;
    if (o.componentType === "EntitySink") {
      if (o.key === "p99") tiles.push(tileFor(o, `${o.component} p99 latency`));
      else if (o.key === "count") tiles.push(tileFor(o, `${o.component} completed`));
      continue;
    }
    const spec = HEADLINE[o.key];
    if (spec && (o.mean !== 0 || spec.always)) tiles.push(tileFor(o, `${o.component} ${spec.label}`, spec.percent));
  }
  return tiles.slice(0, 12);
}

function tilesSection(tiles: readonly Tile[]): string {
  if (tiles.length === 0) return "";
  return `<h2>Headlines</h2><section class="tiles">${tiles
    .map((t) => `<div class="card tile"><div class="label">${esc(t.label)}</div><div class="value">${esc(t.value)}</div><div class="ci">${esc(t.ci) || "&nbsp;"}</div></div>`)
    .join("")}</section>`;
}

// ---- latency bars

function latencySection(results: RunResults): string {
  const sinks = [...new Set(results.outputs.filter((o) => o.componentType === "EntitySink").map((o) => o.component))];
  const cards: string[] = [];
  for (const name of sinks) {
    const rows: BarRow[] = [];
    for (const [key, label] of [["p50", "p50"], ["p95", "p95"], ["p99", "p99"]] as const) {
      const o = results.outputs.find((x) => x.id === `${name}.${key}`);
      if (o && o.mean !== null) rows.push({ label, value: o.mean, ci: o.ci95 ? { low: o.ci95.low, high: o.ci95.high } : null });
    }
    if (rows.length === 0) continue;
    cards.push(
      `<section class="card"><h3>${esc(name)} · time in system</h3><span class="unit" style="color:var(--muted);font-size:12px">seconds; whiskers are 95% intervals across replications</span>` +
        `${barChart({ rows, unit: " s", title: `${name} latency percentiles` })}</section>`,
    );
  }
  return cards.length === 0 ? "" : `<h2>Latency</h2><div class="charts">${cards.join("")}</div>`;
}

// ---- time series

interface Aggregated {
  times: number[];
  mean: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
}

function aggregate(ts: TimeSeriesResult, id: string): Aggregated | null {
  const first = ts.replications[0];
  if (!first) return null;
  const n = first.times.length;
  const mean: (number | null)[] = [];
  const min: (number | null)[] = [];
  const max: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const vals = ts.replications.map((r) => r.values[id]?.[i]).filter((v): v is number => typeof v === "number");
    if (vals.length === 0) {
      mean.push(null);
      min.push(null);
      max.push(null);
    } else {
      mean.push(vals.reduce((a, b) => a + b, 0) / vals.length);
      min.push(Math.min(...vals));
      max.push(Math.max(...vals));
    }
  }
  return { times: first.times, mean, min, max };
}

function seriesTitle(results: RunResults, id: string): { title: string; yLabel: string } {
  const o = results.outputs.find((x) => x.id === id);
  return o ? { title: `${o.component} · ${o.key}`, yLabel: o.description } : { title: id, yLabel: "" };
}

function timeSeriesSection(results: RunResults): string {
  const ts = results.timeSeries;
  if (!ts) return "";
  const charts = ts.outputs
    .map((id) => {
      const agg = aggregate(ts, id);
      if (!agg || agg.times.length === 0) return "";
      const { title, yLabel } = seriesTitle(results, id);
      const line: LineSeries = { label: title, slot: 1, mean: agg.mean, min: agg.min, max: agg.max };
      return lineChart({ times: agg.times, series: [line], title, yLabel });
    })
    .filter((c) => c !== "");
  if (charts.length === 0) return "";
  const note =
    results.settings.replications > 1
      ? "Line: mean across replications. Shaded band: smallest to largest replication."
      : "Single replication.";
  return `<h2>Over time</h2><p class="sub">${esc(note)} Hover or use the arrow keys for values.</p><div class="charts">${charts.join("")}</div>`;
}

// ---- results table

function resultsTable(results: RunResults): string {
  let last = "";
  const rows = results.outputs
    .map((o) => {
      const first = o.component !== last;
      last = o.component;
      const ci = o.ci95 ? `${fmt(o.ci95.low)} to ${fmt(o.ci95.high)}` : "";
      return (
        `<tr${first ? ' class="group"' : ""}><td class="comp">${first ? esc(o.component) : ""}</td><td>${esc(o.key)}</td>` +
        `<td>${esc(o.unit === "dimensionless" ? "" : o.unit === "time" ? "s" : o.unit === "rate" ? "/s" : o.unit)}</td>` +
        `<td class="n">${esc(fmt(o.mean))}</td><td class="n">${esc(ci)}</td><td class="n">${esc(fmt(o.stdDev))}</td><td class="n">${o.n}</td></tr>`
      );
    })
    .join("");
  return (
    `<h2>All results</h2><section class="card"><div class="scroll"><table><thead><tr><th>Component</th><th>Output</th><th>Unit</th>` +
    `<th class="n">Mean</th><th class="n">95% CI</th><th class="n">Std dev</th><th class="n">n</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<p class="note">${esc(ciNote(results))}</p></section>`
  );
}

function replicationsSection(results: RunResults): string {
  const reps = results.replications;
  if (reps.length === 0) return "";
  const rows = reps
    .map((r) => `<tr><td class="n">${r.index}</td><td class="n">${r.seed}</td><td class="n">${esc(fmt(r.eventsProcessed))}</td></tr>`)
    .join("");
  return `<details><summary>Replications (${reps.length})</summary><table><thead><tr><th class="n">#</th><th class="n">Seed</th><th class="n">Events processed</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

/**
 * Render run results as one self-contained HTML page: assertions, headline numbers, latency
 * percentiles, every sampled series over time, and the full results table. No external assets,
 * no timestamps (the same results always produce the same bytes), light and dark themes.
 */
export function renderReport(results: RunResults, options: ReportOptions = {}): string {
  const name = results.modelName ?? "Surgesim run";
  const title = options.title ?? name;
  const body =
    `<header class="top"><h1>${esc(title)}</h1><p class="sub">${esc(settingsLine(results))}</p></header>` +
    assertionsCard(results.assertions) +
    tilesSection(headlineTiles(results)) +
    latencySection(results) +
    timeSeriesSection(results) +
    resultsTable(results) +
    replicationsSection(results) +
    `<footer>Generated by Surgesim · results format v${results.resultsVersion}</footer>`;
  return page(title, body);
}

// ---- comparison

/** One output compared across two runs. */
export interface Delta {
  id: string;
  component: string;
  key: string;
  a: OutputSummary;
  b: OutputSummary;
  diff: number | null;
  pct: number | null;
  /** True/false when both have confidence intervals; null when it cannot be judged. */
  significant: boolean | null;
}

function overlaps(a: OutputSummary, b: OutputSummary): boolean | null {
  if (!a.ci95 || !b.ci95) return null;
  return a.ci95.low <= b.ci95.high && b.ci95.low <= a.ci95.high;
}

/** Pair up the outputs of two runs by id and compute the change and a confidence-interval overlap verdict. */
export function computeDeltas(a: RunResults, b: RunResults): { deltas: Delta[]; onlyA: string[]; onlyB: string[] } {
  const bById = new Map(b.outputs.map((o) => [o.id, o]));
  const aIds = new Set(a.outputs.map((o) => o.id));
  const deltas: Delta[] = [];
  const onlyA: string[] = [];
  for (const oa of a.outputs) {
    const ob = bById.get(oa.id);
    if (!ob) {
      onlyA.push(oa.id);
      continue;
    }
    const diff = oa.mean !== null && ob.mean !== null ? ob.mean - oa.mean : null;
    const pct = diff !== null && oa.mean !== null && oa.mean !== 0 ? (diff / Math.abs(oa.mean)) * 100 : null;
    const ov = overlaps(oa, ob);
    deltas.push({ id: oa.id, component: oa.component, key: oa.key, a: oa, b: ob, diff, pct, significant: ov === null ? null : !ov });
  }
  const onlyB = b.outputs.filter((o) => !aIds.has(o.id)).map((o) => o.id);
  return { deltas, onlyA, onlyB };
}

function arrow(d: number | null): string {
  return d === null || d === 0 ? "" : d > 0 ? "▲" : "▼";
}

function verdict(d: Delta): string {
  if (d.significant === null) return d.diff === null ? "n/a" : "needs 2+ replications";
  return d.significant ? "differs (intervals do not overlap)" : "within noise";
}

/**
 * Render two runs side by side: assertions, the biggest statistically meaningful differences, a delta
 * table for every shared output, and overlaid time series. "Differs" means the two 95% confidence
 * intervals do not overlap (a conservative check); it needs 2+ replications on both sides.
 */
export function renderComparison(a: LabelledResults, b: LabelledResults, options: ReportOptions = {}): string {
  const title = options.title ?? `${a.label} vs ${b.label}`;
  const { deltas, onlyA, onlyB } = computeDeltas(a.results, b.results);

  const legend =
    `<div class="legend"><span class="item"><span class="swatch s1"></span>${esc(a.label)} (circle)</span>` +
    `<span class="item"><span class="swatch s2"></span>${esc(b.label)} (square)</span></div>`;

  const meta = [a, b].map((x) => `<p class="meta"><strong>${esc(x.label)}</strong>: ${esc(x.results.modelName ?? "(unnamed)")} · ${esc(settingsLine(x.results))}</p>`).join("");

  // assertions, side by side
  let assertions = "";
  if ((a.results.assertions?.length ?? 0) + (b.results.assertions?.length ?? 0) > 0) {
    const col = (x: LabelledResults) =>
      `<section class="card"><h3>${esc(x.label)}</h3>${x.results.assertions?.length ? assertionList(x.results.assertions) : '<p class="sub">No assertions.</p>'}</section>`;
    assertions = `<h2>Assertions</h2><div class="charts">${col(a)}${col(b)}</div>`;
  }

  // biggest meaningful differences
  const notable = deltas
    .filter((d) => d.significant === true && d.pct !== null)
    .sort((x, y) => Math.abs(y.pct as number) - Math.abs(x.pct as number))
    .slice(0, 6);
  const notableHtml =
    notable.length === 0
      ? ""
      : `<h2>Biggest differences</h2><section class="tiles">${notable
          .map(
            (d) =>
              `<div class="card tile"><div class="label">${esc(d.component)} ${esc(d.key)}</div>` +
              `<div class="value">${arrow(d.diff)} ${esc(fmt(Math.abs(d.pct as number)))}%</div>` +
              `<div class="ci">${esc(fmt(d.a.mean))} to ${esc(fmt(d.b.mean))}${esc(unitSuffix(d.a.unit))}</div></div>`,
          )
          .join("")}</section>`;

  // delta table
  let last = "";
  const rows = deltas
    .map((d) => {
      const first = d.component !== last;
      last = d.component;
      const suffix = unitSuffix(d.a.unit);
      return (
        `<tr${first ? ' class="group"' : ""}><td class="comp">${first ? esc(d.component) : ""}</td><td>${esc(d.key)}</td>` +
        `<td class="n">${esc(fmt(d.a.mean))}</td><td class="n">${esc(fmt(d.b.mean))}</td>` +
        `<td class="n delta-up">${esc(arrow(d.diff))} ${esc(d.diff === null ? "n/a" : fmt(d.diff) + suffix)}</td>` +
        `<td class="n">${esc(d.pct === null ? "" : fmt(d.pct) + "%")}</td><td>${esc(verdict(d))}</td></tr>`
      );
    })
    .join("");
  const table =
    `<h2>All outputs</h2><section class="card"><div class="scroll"><table><thead><tr><th>Component</th><th>Output</th>` +
    `<th class="n">${esc(a.label)}</th><th class="n">${esc(b.label)}</th><th class="n">Change</th><th class="n">%</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<p class="note">Change is ${esc(b.label)} minus ${esc(a.label)}, in each output's own unit. "Differs" means the 95% confidence intervals do not overlap; arrows show direction only, not whether it is better.</p></section>`;

  // overlaid series
  let overlays = "";
  const tsA = a.results.timeSeries;
  const tsB = b.results.timeSeries;
  const skipped: string[] = [];
  if (tsA && tsB) {
    const shared = tsA.outputs.filter((id) => tsB.outputs.includes(id));
    const charts = shared
      .map((id) => {
        const ga = aggregate(tsA, id);
        const gb = aggregate(tsB, id);
        if (!ga || !gb || ga.times.length === 0) return "";
        if (ga.times.length !== gb.times.length || ga.times.some((t, i) => t !== gb.times[i])) {
          skipped.push(id);
          return "";
        }
        const { title, yLabel } = seriesTitle(a.results, id);
        return lineChart({
          times: ga.times,
          title,
          yLabel,
          series: [
            { label: a.label, slot: 1, mean: ga.mean, min: ga.min, max: ga.max },
            { label: b.label, slot: 2, mean: gb.mean, min: gb.min, max: gb.max },
          ],
        });
      })
      .filter((c) => c !== "");
    if (charts.length > 0 || skipped.length > 0) {
      overlays =
        `<h2>Over time</h2>` +
        (charts.length > 0
          ? `<p class="sub">Lines are means across replications; bands span the smallest to largest replication. Hover or use the arrow keys for values.</p><div class="charts">${charts.join("")}</div>`
          : "") +
        (skipped.length > 0 ? `<p class="note">Not overlaid (different sampling times): ${esc(skipped.join(", "))}.</p>` : "");
    }
  }

  const notes: string[] = [];
  if (onlyA.length > 0) notes.push(`Only in ${a.label}: ${onlyA.join(", ")}.`);
  if (onlyB.length > 0) notes.push(`Only in ${b.label}: ${onlyB.join(", ")}.`);

  const body =
    `<header class="top"><h1>${esc(title)}</h1>${meta}</header>` +
    legend +
    assertions +
    notableHtml +
    table +
    overlays +
    (notes.length > 0 ? `<p class="note">${esc(notes.join(" "))}</p>` : "") +
    `<footer>Generated by Surgesim · comparison of two runs</footer>`;
  return page(title, body);
}
