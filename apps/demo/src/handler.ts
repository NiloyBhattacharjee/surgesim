import { loadModel, runModel, type RunResults } from "@surgesim/engine";
import { renderReport } from "@surgesim/report";

/** A request from the page to the worker. */
export interface RunRequest {
  /** The model, as parsed JSON. */
  json: unknown;
  /** Override the model's replications (optional). */
  replications?: number;
  /** Override the model's base seed (optional). */
  seed?: number;
}

export type RunResponse =
  | {
      ok: true;
      /** A complete self-contained HTML report, ready for an iframe. */
      html: string;
      modelName: string | null;
      replications: number;
      eventsProcessed: number;
      assertionsFailed: number;
      assertionsTotal: number;
    }
  | { ok: false; errors: { component: string | null; key: string | null; message: string }[] };

/**
 * Validate and run a model, then render the report. Pure: no DOM, no Node, no worker globals, so it is
 * the same code in the browser worker, in Node and in the tests.
 */
export function handleRun(req: RunRequest): RunResponse {
  const loaded = loadModel(req.json);
  if (!loaded.ok) return { ok: false, errors: loaded.errors };
  let results: RunResults;
  try {
    results = runModel(loaded.model, {
      ...(req.replications !== undefined ? { replications: req.replications } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
    });
  } catch (e) {
    return { ok: false, errors: [{ component: null, key: null, message: e instanceof Error ? e.message : String(e) }] };
  }
  const assertions = results.assertions ?? [];
  return {
    ok: true,
    html: renderReport(results),
    modelName: results.modelName,
    replications: results.settings.replications,
    eventsProcessed: results.replications.reduce((n, r) => n + r.eventsProcessed, 0),
    assertionsFailed: assertions.filter((a) => !a.passed).length,
    assertionsTotal: assertions.length,
  };
}
