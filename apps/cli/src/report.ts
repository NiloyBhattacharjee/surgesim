import type { AssertionResult, OutputSummary, RunResults } from "@surgesim/engine";

function fmt(v: number | null): string {
  if (v === null) return "n/a";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e6 || abs < 1e-3) return v.toExponential(3);
  if (Number.isInteger(v)) return String(v);
  return v.toPrecision(5).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

const UNIT_LABEL = { time: "s", rate: "/s", cost: "cost", dimensionless: "" } as const;

function row(o: OutputSummary): string[] {
  const ci = o.ci95 ? `[${fmt(o.ci95.low)}, ${fmt(o.ci95.high)}]` : "";
  return [o.component, o.key, UNIT_LABEL[o.unit], fmt(o.mean), ci];
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i >= 3 ? c.padStart(widths[i] as number) : c.padEnd(widths[i] as number))).join("  ").trimEnd();
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

/** Render run results as a readable text report. */
export function formatReport(results: RunResults): string {
  const s = results.settings;
  const head = [
    results.modelName ? `Model: ${results.modelName}` : "Model: (unnamed)",
    `Duration: ${s.duration}s   Warm-up: ${s.warmUp}s   Seed: ${s.seed}   Replications: ${s.replications}`,
    s.replications > 1 ? "Values are means across replications with 95% confidence intervals (Student t)." : "Single replication: no confidence intervals.",
    "",
  ];
  const rows: string[][] = [];
  let last = "";
  for (const o of results.outputs) {
    const r = row(o);
    if (o.component === last) r[0] = "";
    last = o.component;
    rows.push(r);
  }
  return [...head, table(["Component", "Output", "Unit", "Mean", "95% CI"], rows)].join("\n");
}

/** Render assertion outcomes, one PASS/FAIL line each. */
export function formatAssertions(results: readonly AssertionResult[]): string {
  const failed = results.filter((r) => !r.passed).length;
  return [
    `Assertions: ${results.length - failed} passed, ${failed} failed`,
    ...results.map((r) => `  ${r.passed ? "PASS" : "FAIL"}  ${r.message}`),
  ].join("\n");
}

/** Render time series as CSV: replication,time_s,<output ids...>. */
export function timeSeriesCsv(results: RunResults): string {
  const ts = results.timeSeries;
  if (!ts) return "";
  const lines = [["replication", "time_s", ...ts.outputs].join(",")];
  for (const rep of ts.replications) {
    rep.times.forEach((t, i) => {
      const cells = ts.outputs.map((id) => {
        const v = rep.values[id]?.[i];
        return v === null || v === undefined ? "" : String(v);
      });
      lines.push([rep.replication, t, ...cells].join(","));
    });
  }
  return lines.join("\n") + "\n";
}
