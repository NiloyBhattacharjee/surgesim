import { defaultTimeSeries, loadModel, runModel, type RunResults } from "@surgesim/engine";
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

/** One replication's sampled outputs: `values[outputId][i]` is the value at `times[i]` seconds (null = undefined). */
export interface Playback {
  duration: number;
  warmUp: number;
  times: number[];
  values: Record<string, (number | null)[]>;
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
      /** Replication 1 sampled over time (every current-value output), for replaying the run on the diagram. */
      playback: Playback;
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
  // A second run of replication 1 alone: same derived seed, so the same trajectory, but sampling every
  // current-value output without changing which series the report shows.
  const replay = runModel(loaded.model, {
    replications: 1,
    timeSeries: defaultTimeSeries(loaded.model),
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
  }).timeSeries!.replications[0]!;
  return {
    ok: true,
    html: renderReport(results),
    modelName: results.modelName,
    replications: results.settings.replications,
    eventsProcessed: results.replications.reduce((n, r) => n + r.eventsProcessed, 0),
    assertionsFailed: assertions.filter((a) => !a.passed).length,
    assertionsTotal: assertions.length,
    playback: { duration: results.settings.duration, warmUp: results.settings.warmUp, times: replay.times, values: replay.values },
  };
}
