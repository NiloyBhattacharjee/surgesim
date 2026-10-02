import { runModel, type RunResults } from "@surgesim/engine";
import type { Logger } from "@surgesim/platform";
import { computeDeltas, renderComparison, renderReport } from "@surgesim/report";
import { EXIT_INVALID_MODEL, EXIT_OK, EXIT_USAGE } from "./exit.js";
import { loadModelSource, readModelSource, type SourceHost } from "./source.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The file name without directories or extension, used as a default label. */
function baseLabel(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.[^.]+$/, "") || name;
}

export type ResultsLoad = { ok: true; results: RunResults } | { ok: false; code: number; message: string };

/**
 * Load run results from `path`: a results file written by `surgesim run --json`, or a model (JSON or
 * module), which is run first so that two models can be compared directly.
 */
export async function loadResults(path: string, host: SourceHost, overrides: { seed?: number; replications?: number } = {}): Promise<ResultsLoad> {
  const source = await readModelSource(path, host);
  if (!source.ok) return source;
  const json = source.json;
  if (isRecord(json) && json["resultsVersion"] !== undefined) {
    if (json["resultsVersion"] !== 1 || !Array.isArray(json["outputs"]) || !isRecord(json["settings"])) {
      return { ok: false, code: EXIT_INVALID_MODEL, message: `${path} is not a supported results file (expected resultsVersion 1 from "surgesim run --json")` };
    }
    return { ok: true, results: json as unknown as RunResults };
  }
  const loaded = await loadModelSource(path, host);
  if (!loaded.ok) return loaded;
  try {
    return { ok: true, results: runModel(loaded.model, overrides) };
  } catch (e) {
    return { ok: false, code: EXIT_INVALID_MODEL, message: `${path}: the simulation could not finish: ${(e as Error).message}` };
  }
}

/** `surgesim report <results.json|model> --html out.html` */
export async function runReport(
  path: string,
  options: { html: string | undefined; title: string | undefined },
  host: SourceHost & { logger: Logger },
): Promise<number> {
  if (options.html === undefined) {
    host.logger.error('error: "surgesim report" needs --html <file>');
    return EXIT_USAGE;
  }
  const loaded = await loadResults(path, host);
  if (!loaded.ok) {
    host.logger.error(`error: ${loaded.message}`);
    return loaded.code;
  }
  try {
    await host.fs.writeText(options.html, renderReport(loaded.results, options.title ? { title: options.title } : {}));
  } catch (e) {
    host.logger.error(`error: cannot write ${options.html}: ${(e as Error).message}`);
    return EXIT_USAGE;
  }
  host.logger.info(`Wrote report to ${options.html}`);
  return EXIT_OK;
}

/** `surgesim compare <a> <b> --html out.html` */
export async function runCompare(
  paths: [string, string],
  options: { html: string | undefined; labelA: string | undefined; labelB: string | undefined; title: string | undefined; seed?: number; replications?: number },
  host: SourceHost & { logger: Logger },
): Promise<number> {
  const { logger } = host;
  const overrides = {
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.replications !== undefined ? { replications: options.replications } : {}),
  };
  const [a, b] = [await loadResults(paths[0], host, overrides), await loadResults(paths[1], host, overrides)];
  for (const r of [a, b]) {
    if (!r.ok) {
      logger.error(`error: ${r.message}`);
      return r.code;
    }
  }
  if (!a.ok || !b.ok) return EXIT_USAGE;

  let labelA = options.labelA ?? baseLabel(paths[0]);
  let labelB = options.labelB ?? baseLabel(paths[1]);
  if (labelA === labelB) {
    labelA += " (A)";
    labelB += " (B)";
  }

  const { deltas } = computeDeltas(a.results, b.results);
  // Biggest relative change first, so the summary leads with what matters.
  const differing = deltas
    .filter((d) => d.significant === true)
    .sort((x, y) => Math.abs(y.pct ?? 0) - Math.abs(x.pct ?? 0));
  logger.info(`Compared ${labelA} with ${labelB}: ${deltas.length} shared outputs, ${differing.length} differ beyond their 95% confidence intervals.`);
  for (const d of differing.slice(0, 10)) {
    const pct = d.pct === null ? "" : ` (${d.pct > 0 ? "+" : ""}${Number(d.pct.toPrecision(3))}%)`;
    logger.info(`  ${d.id}: ${Number((d.a.mean as number).toPrecision(4))} -> ${Number((d.b.mean as number).toPrecision(4))}${pct}`);
  }

  if (options.html !== undefined) {
    try {
      await host.fs.writeText(
        options.html,
        renderComparison({ label: labelA, results: a.results }, { label: labelB, results: b.results }, options.title ? { title: options.title } : {}),
      );
    } catch (e) {
      logger.error(`error: cannot write ${options.html}: ${(e as Error).message}`);
      return EXIT_USAGE;
    }
    logger.info(`Wrote comparison to ${options.html}`);
  }
  return EXIT_OK;
}
