/**
 * Report stylesheet. Colors are tokens on :root; dark mode redefines them (selected steps, validated
 * against the dark surface), under both the OS setting and an explicit data-theme attribute.
 */
export const STYLES = `
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface-1: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #6f6d68;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11, 11, 11, 0.10);
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --good: #0ca30c;
  --critical: #d03b3b;
  --wash: rgba(11, 11, 11, 0.04);
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface-1: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #a3a198;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255, 255, 255, 0.10);
    --series-1: #3987e5;
    --series-2: #d95926;
    --wash: rgba(255, 255, 255, 0.05);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d;
  --surface-1: #1a1a19;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --muted: #a3a198;
  --grid: #2c2c2a;
  --axis: #383835;
  --border: rgba(255, 255, 255, 0.10);
  --series-1: #3987e5;
  --series-2: #d95926;
  --wash: rgba(255, 255, 255, 0.05);
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 64px; }
header.top { margin-bottom: 24px; }
h1 { font-size: 26px; line-height: 1.2; margin: 0 0 6px; font-weight: 650; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 36px 0 12px; font-weight: 650; }
h3 { font-size: 14px; margin: 0 0 2px; font-weight: 600; }
.sub { color: var(--ink-2); margin: 0; }
.desc { color: var(--ink-2); max-width: 72ch; margin: 10px 0 0; }
.meta { color: var(--muted); font-size: 13px; margin-top: 8px; }
.card {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
}
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.tile .label { color: var(--ink-2); font-size: 13px; }
.tile .value { font-size: 28px; font-weight: 600; line-height: 1.15; margin: 4px 0 2px; }
.tile .ci { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 12px; }
@media (max-width: 520px) { .charts { grid-template-columns: 1fr; } main { padding-top: 20px; } }
figure.chart { margin: 0; position: relative; }
figure.chart figcaption { margin-bottom: 8px; }
figure.chart .unit { color: var(--muted); font-size: 12px; }
figure.chart:focus-visible { outline: 2px solid var(--series-1); outline-offset: 4px; border-radius: 8px; }
svg.plot { display: block; width: 100%; height: auto; overflow: visible; }
svg.bars { max-width: 560px; }
svg text { fill: var(--muted); font: 12px system-ui, -apple-system, "Segoe UI", sans-serif; }
svg text.ink { fill: var(--ink-2); }
svg text.val { fill: var(--ink); font-weight: 600; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { stroke: var(--axis); stroke-width: 1; }
.line-1, .line-2 { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.line-1 { stroke: var(--series-1); }
.line-2 { stroke: var(--series-2); }
.band-1 { fill: var(--series-1); opacity: 0.10; }
.band-2 { fill: var(--series-2); opacity: 0.10; }
.dot-1 { fill: var(--series-1); }
.spread { margin: 22px 0 2px; font-size: 15px; }
.mean-tick { stroke: var(--ink); stroke-width: 2; stroke-linecap: round; }
.dot-2 { fill: var(--series-2); }
.ring { stroke: var(--surface-1); stroke-width: 2; }
.bar-1 { fill: var(--series-1); }
.whisker { stroke: var(--ink-2); stroke-width: 1; }
.cross { stroke: var(--axis); stroke-width: 1; }
.hit { fill: transparent; }
.tip {
  position: absolute; pointer-events: none; display: none; z-index: 2;
  background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
  min-width: 140px;
}
.tip .t { color: var(--muted); margin-bottom: 4px; }
.tip .row { display: flex; align-items: center; gap: 6px; }
.tip .row b { font-weight: 650; font-variant-numeric: tabular-nums; }
.tip .row span.name { color: var(--ink-2); margin-left: auto; padding-left: 10px; }
.key { display: inline-block; width: 14px; height: 0; border-top: 2px solid; vertical-align: middle; position: relative; }
.key.k1 { border-color: var(--series-1); }
.key.k2 { border-color: var(--series-2); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0 0 12px; color: var(--ink-2); font-size: 13px; align-items: center; }
.legend .item { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 10px; height: 10px; display: inline-block; }
.swatch.s1 { background: var(--series-1); border-radius: 50%; }
.swatch.s2 { background: var(--series-2); border-radius: 2px; }
.assertions { list-style: none; margin: 0; padding: 0; }
.assertions li { display: flex; gap: 10px; align-items: baseline; padding: 6px 0; border-top: 1px solid var(--border); }
.assertions li:first-child { border-top: 0; }
.badge { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; padding: 2px 8px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
.badge.pass { color: var(--ink); border-color: var(--good); }
.badge.fail { color: var(--ink); border-color: var(--critical); background: color-mix(in srgb, var(--critical) 14%, transparent); }
.badge svg { width: 10px; height: 10px; vertical-align: -1px; margin-right: 4px; }
.summary-pass { color: var(--ink-2); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-top: 1px solid var(--border); }
th { color: var(--ink-2); font-weight: 600; border-top: 0; white-space: nowrap; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
td.comp { font-weight: 600; }
tr.group td { border-top: 1px solid var(--axis); }
.scroll { overflow-x: auto; }
details { margin-top: 8px; }
summary { cursor: pointer; color: var(--ink-2); font-size: 13px; }
details table { margin-top: 6px; }
.delta-up, .delta-down { white-space: nowrap; }
.note { color: var(--muted); font-size: 12px; margin-top: 8px; }
footer { color: var(--muted); font-size: 12px; margin-top: 40px; }
@media print {
  body { background: #fff; }
  .card { break-inside: avoid; box-shadow: none; }
  .tip { display: none !important; }
}
@media (forced-colors: active) {
  .band-1, .band-2 { opacity: 0.3; }
  .line-1, .line-2 { stroke: CanvasText; }
  .line-2 { stroke-dasharray: 6 3; }
}
`;
