import { compact, esc, fmt, niceTicks, timeUnit } from "./util.js";

// The viewBox is close to the rendered width (a chart card is ~450-550px) so text keeps its size.
const W = 540;
const H = 230;
const M = { left: 46, right: 16, top: 12, bottom: 38 };

/** One line on a time-series chart, aggregated across replications. */
export interface LineSeries {
  label: string;
  /** Mean across replications at each sample (null where no replication had a value). */
  mean: (number | null)[];
  /** Smallest / largest replication value at each sample, for the min-max band. */
  min: (number | null)[];
  max: (number | null)[];
  /** Which series slot (and marker shape) this line uses. */
  slot: 1 | 2;
}

const num = (v: number | null): v is number => v !== null && Number.isFinite(v);

/**
 * A time-series chart as inline SVG, with a hover layer wired up by the report's inline script
 * (crosshair + one tooltip listing every series). The figure carries its data as JSON in a
 * `data-chart` attribute; the page script reads it. Without script the chart still renders.
 */
export function lineChart(opts: { times: number[]; series: LineSeries[]; yLabel: string; title: string }): string {
  const { times, series } = opts;
  const xmaxSeconds = times.length > 0 ? (times[times.length - 1] as number) : 1;
  const unit = timeUnit(xmaxSeconds);
  const xs = times.map((t) => t / unit.divisor);
  const x0 = xs[0] ?? 0;
  const x1 = Math.max(xs[xs.length - 1] ?? 1, x0 + 1e-9);

  let ymin = Infinity;
  let ymax = -Infinity;
  for (const s of series) {
    for (const arr of [s.mean, s.min, s.max]) {
      for (const v of arr) if (num(v)) {
        if (v < ymin) ymin = v;
        if (v > ymax) ymax = v;
      }
    }
  }
  if (!Number.isFinite(ymin)) {
    ymin = 0;
    ymax = 1;
  }
  const baseline = ymin >= 0 ? 0 : ymin;
  const { ticks: yTicks, lo: ylo, hi: yhi } = niceTicks(baseline, ymax, 4);
  const { ticks: xTicks } = niceTicks(x0, x1, 6);

  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;
  const sx = (x: number) => M.left + ((x - x0) / (x1 - x0)) * pw;
  const sy = (y: number) => M.top + ph - ((y - ylo) / (yhi - ylo || 1)) * ph;
  const f = (n: number) => String(Number(n.toFixed(2)));

  const grid = yTicks
    .map((t) => `<line class="grid" x1="${M.left}" x2="${W - M.right}" y1="${f(sy(t))}" y2="${f(sy(t))}"/><text x="${M.left - 8}" y="${f(sy(t) + 4)}" text-anchor="end">${esc(compact(t))}</text>`)
    .join("");
  const xAxis = xTicks
    .filter((t) => t >= x0 - 1e-9 && t <= x1 + 1e-9)
    .map((t) => `<text x="${f(sx(t))}" y="${H - M.bottom + 16}" text-anchor="middle">${esc(compact(t))}</text>`)
    .join("");

  const paths = series
    .map((s) => {
      const pts: [number, number][] = [];
      s.mean.forEach((v, i) => {
        if (num(v)) pts.push([sx(xs[i] as number), sy(v)]);
      });
      const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${f(x)} ${f(y)}`).join("");
      let band = "";
      const upper: [number, number][] = [];
      const lower: [number, number][] = [];
      s.max.forEach((v, i) => {
        const lo = s.min[i];
        if (num(v) && num(lo ?? null)) {
          upper.push([sx(xs[i] as number), sy(v)]);
          lower.push([sx(xs[i] as number), sy(lo as number)]);
        }
      });
      if (upper.length > 1 && upper.some(([, y], i) => y !== (lower[i] as [number, number])[1])) {
        const poly = [...upper, ...lower.reverse()].map(([x, y], i) => `${i === 0 ? "M" : "L"}${f(x)} ${f(y)}`).join("") + "Z";
        band = `<path class="band-${s.slot}" d="${poly}"/>`;
      }
      const last = pts[pts.length - 1];
      const marker = last
        ? s.slot === 1
          ? `<circle class="dot-1 ring" cx="${f(last[0])}" cy="${f(last[1])}" r="4"/>`
          : `<rect class="dot-2 ring" x="${f(last[0] - 4)}" y="${f(last[1] - 4)}" width="8" height="8" rx="2"/>`
        : "";
      return `${band}<path class="line-${s.slot}" d="${line}"/>${marker}`;
    })
    .join("");

  const data = {
    x: xs,
    xUnit: unit.label,
    plot: { left: M.left, right: W - M.right, top: M.top, bottom: H - M.bottom, w: W, x0, x1 },
    series: series.map((s) => ({ label: s.label, slot: s.slot, mean: s.mean })),
  };
  const caption = `<figcaption><h3>${esc(opts.title)}</h3><span class="unit">${esc(opts.yLabel)}</span></figcaption>`;

  const table = `<details><summary>Table view</summary><div class="scroll"><table><thead><tr><th class="n">${esc(unit.label)}</th>${series
    .map((s) => `<th class="n">${esc(s.label)}</th>`)
    .join("")}</tr></thead><tbody>${xs
    .map((x, i) => `<tr><td class="n">${esc(fmt(x))}</td>${series.map((s) => `<td class="n">${esc(fmt(s.mean[i] ?? null))}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div></details>`;

  return (
    `<figure class="chart card" tabindex="0" data-chart="${esc(JSON.stringify(data))}" aria-label="${esc(opts.title)}">` +
    caption +
    `<svg class="plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title + " over time")}">` +
    grid +
    `<line class="axis" x1="${M.left}" x2="${W - M.right}" y1="${f(sy(ylo))}" y2="${f(sy(ylo))}"/>` +
    xAxis +
    `<text x="${f(M.left + pw / 2)}" y="${H - 3}" text-anchor="middle">time (${esc(unit.label)})</text>` +
    paths +
    `<line class="cross" x1="0" x2="0" y1="${M.top}" y2="${H - M.bottom}" style="display:none"/>` +
    `<rect class="hit" x="${M.left}" y="${M.top}" width="${pw}" height="${ph}"/>` +
    `</svg><div class="tip" role="status"></div>` +
    table +
    `</figure>`
  );
}

/** One horizontal bar with an optional confidence-interval whisker. */
export interface BarRow {
  label: string;
  value: number;
  ci: { low: number; high: number } | null;
}

/**
 * Horizontal bars (one series, so one color) with the value at the bar tip and a thin whisker for the
 * 95% interval. Bars are at most 24px thick with a 4px rounded data end and a square baseline.
 */
export function barChart(opts: { rows: BarRow[]; unit: string; title: string }): string {
  const { rows } = opts;
  const left = 70;
  const right = 90;
  const rowH = 34;
  const barH = 18;
  const width = 560;
  const height = rows.length * rowH + 8;
  const maxV = Math.max(1e-12, ...rows.map((r) => Math.max(r.value, r.ci?.high ?? 0)));
  const sx = (v: number) => left + (Math.max(0, v) / maxV) * (width - left - right);
  const f = (n: number) => String(Number(n.toFixed(2)));

  const body = rows
    .map((r, i) => {
      const cy = i * rowH + rowH / 2 + 2;
      const x1 = Math.max(left + 1, sx(r.value));
      const y0 = cy - barH / 2;
      const rad = Math.min(4, (x1 - left) / 2, barH / 2);
      const path = `M${left} ${f(y0)}H${f(x1 - rad)}Q${f(x1)} ${f(y0)} ${f(x1)} ${f(y0 + rad)}V${f(y0 + barH - rad)}Q${f(x1)} ${f(y0 + barH)} ${f(x1 - rad)} ${f(y0 + barH)}H${left}Z`;
      let whisker = "";
      let labelX = x1 + 8;
      if (r.ci) {
        const a = sx(r.ci.low);
        const b = sx(r.ci.high);
        whisker = `<line class="whisker" x1="${f(a)}" x2="${f(b)}" y1="${f(cy)}" y2="${f(cy)}"/><line class="whisker" x1="${f(a)}" x2="${f(a)}" y1="${f(cy - 4)}" y2="${f(cy + 4)}"/><line class="whisker" x1="${f(b)}" x2="${f(b)}" y1="${f(cy - 4)}" y2="${f(cy + 4)}"/>`;
        labelX = Math.max(labelX, b + 8);
      }
      const tip = `${r.label}: ${fmt(r.value)}${r.ci ? ` (95% CI ${fmt(r.ci.low)} to ${fmt(r.ci.high)})` : ""}${opts.unit}`;
      return (
        `<g><title>${esc(tip)}</title><text class="ink" x="${left - 10}" y="${f(cy + 4)}" text-anchor="end">${esc(r.label)}</text>` +
        `<path class="bar-1" d="${path}"/>${whisker}` +
        `<text class="val" x="${f(labelX)}" y="${f(cy + 4)}">${esc(fmt(r.value))}${esc(opts.unit)}</text></g>`
      );
    })
    .join("");
  return `<svg class="plot bars" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.title)}"><line class="axis" x1="${left}" x2="${left}" y1="0" y2="${height}"/>${body}</svg>`;
}

/** One run's per-replication values of a single output, for a strip plot. */
export interface StripRow {
  label: string;
  /** Which series slot (and marker shape) this row uses. */
  slot: 1 | 2;
  /** One finite value per replication. */
  values: number[];
}

/**
 * A strip plot: one dot per replication on a shared axis, one row per run, with a bar at each mean. It
 * shows the spread that a mean and an interval summarise, so a reader can judge whether two runs really
 * separate. Every dot has a tooltip, and the same numbers are in the report's per-replication tables.
 */
export function stripChart(opts: { rows: StripRow[]; unit: string; title: string }): string {
  const { rows } = opts;
  const left = 78;
  const right = 20;
  const rowH = 40;
  const top = 6;
  const axisH = 24;
  const width = 560;
  const height = top + rows.length * rowH + axisH;
  const all = rows.flatMap((r) => r.values);
  const lo0 = all.length > 0 ? Math.min(...all) : 0;
  const hi0 = all.length > 0 ? Math.max(...all) : 1;
  // Dots encode position, not length, so the axis need not start at zero.
  const { ticks, lo, hi } = niceTicks(lo0, hi0, 4);
  const sx = (v: number) => left + ((v - lo) / (hi - lo || 1)) * (width - left - right);
  const f = (n: number) => String(Number(n.toFixed(2)));

  const grid = ticks
    .map((t) => `<line class="grid" x1="${f(sx(t))}" x2="${f(sx(t))}" y1="${top}" y2="${top + rows.length * rowH}"/><text x="${f(sx(t))}" y="${height - 6}" text-anchor="middle">${esc(compact(t))}</text>`)
    .join("");
  const body = rows
    .map((r, ri) => {
      const cy = top + ri * rowH + rowH / 2;
      const mean = r.values.length > 0 ? r.values.reduce((a, b) => a + b, 0) / r.values.length : null;
      const dots = r.values
        .map((v, i) => {
          const y = cy + ((i % 3) - 1) * 7;
          const tip = `<title>${esc(`${r.label}, replication ${i}: ${fmt(v)}${opts.unit}`)}</title>`;
          return r.slot === 1
            ? `<circle class="dot-1" cx="${f(sx(v))}" cy="${f(y)}" r="4" fill-opacity="0.8">${tip}</circle>`
            : `<rect class="dot-2" x="${f(sx(v) - 4)}" y="${f(y - 4)}" width="8" height="8" rx="2" fill-opacity="0.8">${tip}</rect>`;
        })
        .join("");
      const meanTick =
        mean === null ? "" : `<line class="mean-tick" x1="${f(sx(mean))}" x2="${f(sx(mean))}" y1="${f(cy - rowH / 2 + 4)}" y2="${f(cy + rowH / 2 - 4)}"><title>${esc(`${r.label} mean: ${fmt(mean)}${opts.unit}`)}</title></line>`;
      return `<g><text class="ink" x="${left - 10}" y="${f(cy + 4)}" text-anchor="end">${esc(r.label)}</text>${meanTick}${dots}</g>`;
    })
    .join("");
  return (
    `<svg class="plot strip" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.title)}">${grid}` +
    `<line class="axis" x1="${left}" x2="${width - right}" y1="${top + rows.length * rowH}" y2="${top + rows.length * rowH}"/>${body}</svg>`
  );
}
