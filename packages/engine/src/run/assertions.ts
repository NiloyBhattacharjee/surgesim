import type { AssertionDefinition } from "../format/index.js";
import type { AssertionResult, RunResults } from "./results.js";

function compare(actual: number, op: AssertionDefinition["op"], value: number): boolean {
  switch (op) {
    case "<":
      return actual < value;
    case "<=":
      return actual <= value;
    case ">":
      return actual > value;
    case ">=":
      return actual >= value;
    case "==":
      return actual === value;
  }
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(5)));
}

/** The number an assertion compares, or null when it is undefined for these results. */
function pick(results: RunResults, a: AssertionDefinition): number | null {
  const summary = results.outputs.find((o) => o.id === a.output);
  if (summary === undefined) return null;
  switch (a.statistic ?? "mean") {
    case "mean":
      return summary.mean;
    case "ci95Low":
      return summary.ci95?.low ?? null;
    case "ci95High":
      return summary.ci95?.high ?? null;
    case "min":
    case "max": {
      const values = results.replications.map((r) => r.outputs[a.output]).filter((v): v is number => typeof v === "number");
      if (values.length === 0) return null;
      return a.statistic === "min" ? Math.min(...values) : Math.max(...values);
    }
  }
}

/**
 * Check assertions against run results. An assertion on an undefined value (an unknown output, no
 * observations, or a confidence interval with a single replication) fails, because a gate that
 * silently passes when its data is missing is worse than no gate.
 */
export function evaluateAssertions(results: RunResults, assertions: readonly AssertionDefinition[]): AssertionResult[] {
  return assertions.map((assertion) => {
    const stat = assertion.statistic ?? "mean";
    const label = assertion.name ? `${assertion.name}: ` : "";
    const actual = pick(results, assertion);
    const subject = `${assertion.output} (${stat})`;
    if (actual === null) {
      return { assertion, actual: null, passed: false, message: `${label}${subject} is undefined, cannot check ${assertion.op} ${fmt(assertion.value)}` };
    }
    const passed = compare(actual, assertion.op, assertion.value);
    return { assertion, actual, passed, message: `${label}${subject} = ${fmt(actual)} ${passed ? assertion.op : `violates ${assertion.op}`} ${fmt(assertion.value)}` };
  });
}
