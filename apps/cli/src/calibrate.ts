import { isKnownOutputId, runModel, type DistributionSpec, type ModelDefinition } from "@surgesim/engine";
import type { FileStore, Logger } from "@surgesim/platform";
import {
  DataParseError,
  FAMILIES,
  compareToObserved,
  scaleArrivals,
  scaleServiceTimes,
  fitArrivalProfile,
  fitSamples,
  parseColumn,
  type Family,
  type ObservedMetrics,
} from "@surgesim/calibrate";
import { EXIT_ASSERTION_FAILED, EXIT_INVALID_MODEL, EXIT_OK, EXIT_USAGE } from "./exit.js";
import { loadModelSource, type SourceHost } from "./source.js";

type Host = SourceHost & { logger: Logger; fs: FileStore };

/** A number shown to 4 significant digits, without trailing noise. */
function num(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  if (v === 0) return "0";
  return String(Number(v.toPrecision(4)));
}

/** Parameters of a fitted distribution as compact JSON with rounded numbers. */
function specJson(spec: DistributionSpec): string {
  return JSON.stringify(Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, typeof v === "number" ? Number(v.toPrecision(4)) : v])));
}

function pad(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ").trimEnd();
}

/** A column given as digits means "the Nth column" (0-based); anything else is a header name. */
function columnOption(raw: string | undefined): string | number | undefined {
  if (raw === undefined) return undefined;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

async function readText(path: string, host: Host): Promise<string | number> {
  try {
    return await host.fs.readText(path);
  } catch (e) {
    host.logger.error(`error: cannot read ${path}: ${(e as Error).message}`);
    return EXIT_USAGE;
  }
}

export interface FitArgs {
  column: string | undefined;
  scale: number;
  family: string | undefined;
}

/** `surgesim fit <file>`: fit a distribution to measured durations. */
export async function runFit(path: string, args: FitArgs, host: Host): Promise<number> {
  const { logger } = host;
  const families: Family[] | undefined = args.family === undefined || args.family === "auto" ? undefined : [args.family as Family];
  if (families && !FAMILIES.includes(families[0] as Family)) {
    logger.error(`error: --family must be auto or one of ${FAMILIES.join(", ")} (got "${args.family}")`);
    return EXIT_USAGE;
  }
  const text = await readText(path, host);
  if (typeof text === "number") return text;
  let column;
  try {
    column = parseColumn(text, { kind: "number", ...(args.column !== undefined ? { column: columnOption(args.column) as string | number } : {}) });
  } catch (e) {
    if (!(e instanceof DataParseError)) throw e;
    logger.error(`error: ${path}: ${e.message}`);
    return EXIT_USAGE;
  }
  const values = column.values.map((v) => v * args.scale);
  const fit = fitSamples(values, families ? { families } : {});

  logger.info(
    `Read ${fit.n} values from ${column.column}${column.skipped > 0 ? ` (${column.skipped} unreadable row(s) skipped)` : ""}` +
      `${args.scale !== 1 ? `, multiplied by ${args.scale}` : ""}.`,
  );
  logger.info(`Summary (the unit after scaling, normally seconds): mean ${num(fit.mean)}, std dev ${num(fit.stdDev)}, CV ${num(fit.cv)}, min ${num(fit.min)}, max ${num(fit.max)}`);
  logger.info(`Percentiles: p50 ${num(fit.p50)}, p95 ${num(fit.p95)}, p99 ${num(fit.p99)}`);
  if (fit.fits.length > 0) {
    logger.info(`\nCandidate fits, best first. KS distance: smaller is better; about ${num(fit.ksCritical)} is the 5% critical value for this much data.`);
    const widths = [12, 9, 9, 60];
    logger.info(pad(["family", "KS", "p-value*", "parameters"], widths));
    for (const f of fit.fits) logger.info(pad([f.family, num(f.ks), num(f.pValue), specJson(f.spec)], widths));
    logger.info("* approximate and optimistic, because the parameters were fitted to the same data.");
  }
  for (const w of fit.warnings) logger.warn(`warning: ${w}`);
  if (fit.best === null) return EXIT_USAGE;
  logger.info(`\nUse in a model (as a time input such as serviceTime):\n  ${specJson(fit.best.spec)}`);
  return EXIT_OK;
}

export interface FitArrivalsArgs {
  column: string | undefined;
  scale: number;
  window: number;
  mergeTolerance: number | undefined;
}

/** `surgesim fit-arrivals <file>`: turn arrival timestamps into an EntityGenerator rate profile. */
export async function runFitArrivals(path: string, args: FitArrivalsArgs, host: Host): Promise<number> {
  const { logger } = host;
  const text = await readText(path, host);
  if (typeof text === "number") return text;
  let column;
  try {
    column = parseColumn(text, { kind: "time", ...(args.column !== undefined ? { column: columnOption(args.column) as string | number } : {}) });
  } catch (e) {
    if (!(e instanceof DataParseError)) throw e;
    logger.error(`error: ${path}: ${e.message}`);
    return EXIT_USAGE;
  }
  const timestamps = column.values.map((v) => v * args.scale);
  let fit;
  try {
    fit = fitArrivalProfile(timestamps, { windowSeconds: args.window, ...(args.mergeTolerance !== undefined ? { mergeTolerance: args.mergeTolerance } : {}) });
  } catch (e) {
    logger.error(`error: ${path}: ${(e as Error).message}`);
    return EXIT_USAGE;
  }
  logger.info(`Read ${fit.arrivals} arrival timestamps from ${column.column}${column.skipped > 0 ? ` (${column.skipped} unreadable row(s) skipped)` : ""}.`);
  logger.info(`Observation period ${num(fit.duration)} s, mean rate ${num(fit.meanRate)} per second, counted in ${fit.windows.length} windows of ${num(fit.duration / fit.windows.length)} s.`);
  logger.info(`\nFitted rate profile (${fit.rateProfile.length} segment${fit.rateProfile.length === 1 ? "" : "s"}):`);
  logger.info(pad(["from (s)", "per second"], [10, 12]));
  for (const [start, rate] of fit.rateProfile) logger.info(pad([num(start), num(rate)], [10, 12]));
  logger.info(`\nDispersion index ${num(fit.dispersionIndex)} (about 1 means Poisson-like arrivals; the generator's dispersionIndex input models more).`);
  for (const w of fit.warnings) logger.warn(`warning: ${w}`);
  const profile = JSON.stringify(fit.rateProfile.map(([s, r]) => [Number(s.toPrecision(6)), Number(r.toPrecision(4))]));
  const bursts = fit.bursty ? `, "dispersionIndex": ${Number(fit.dispersionIndex.toPrecision(3))}` : "";
  logger.info(`\nUse in an EntityGenerator:\n  "inputs": { "mode": "rateProfile", "rateProfile": ${profile}${bursts} }`);
  return EXIT_OK;
}

export interface CalibrateArgs {
  observed: string | undefined;
  tolerance: number | undefined;
  seed: number | undefined;
  replications: number | undefined;
  /** Show how the results move when arrival rates and service times are off by this many percent. */
  sensitivity: number | undefined;
}

function isObserved(v: unknown): v is ObservedMetrics {
  if (typeof v !== "object" || v === null) return false;
  const metrics = (v as { metrics?: unknown }).metrics;
  return typeof metrics === "object" && metrics !== null && !Array.isArray(metrics) && Object.keys(metrics).length > 0;
}

/** `surgesim calibrate <model> --observed observed.json`: compare a model with measurements from the real system. */
export async function runCalibrate(modelPath: string, args: CalibrateArgs, host: Host): Promise<number> {
  const { logger } = host;
  if (args.observed === undefined) {
    logger.error('error: "surgesim calibrate" needs --observed <file> (a JSON file such as {"metrics": {"sink.p99": 1.2}})');
    return EXIT_USAGE;
  }
  const text = await readText(args.observed, host);
  if (typeof text === "number") return text;
  let observed: unknown;
  try {
    observed = JSON.parse(text);
  } catch (e) {
    logger.error(`error: ${args.observed} is not valid JSON: ${(e as Error).message}`);
    return EXIT_INVALID_MODEL;
  }
  if (!isObserved(observed)) {
    logger.error(`error: ${args.observed} must look like {"tolerance": 0.1, "metrics": {"sink.p99": 1.2, "pool.Utilisation": {"value": 0.6, "low": 0.55, "high": 0.65}}}`);
    return EXIT_INVALID_MODEL;
  }
  const loaded = await loadModelSource(modelPath, host);
  if (!loaded.ok) {
    logger.error(`error: ${loaded.message}`);
    return loaded.code;
  }
  const unknown = Object.keys(observed.metrics).filter((id) => !isKnownOutputId(id, loaded.model.components));
  if (unknown.length > 0) {
    logger.error(`error: ${args.observed} refers to outputs the model does not have: ${unknown.join(", ")} (outputs are named "<component>.<OutputKey>")`);
    return EXIT_USAGE;
  }
  for (const [id, m] of Object.entries(observed.metrics)) {
    const value = typeof m === "number" ? m : (m as { value?: unknown })?.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      logger.error(`error: ${args.observed}: the value for "${id}" must be a number (or an object with a numeric "value")`);
      return EXIT_INVALID_MODEL;
    }
  }

  let results;
  try {
    results = runModel(loaded.model, {
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(args.replications !== undefined ? { replications: args.replications } : {}),
    });
  } catch (e) {
    logger.error(`error: the simulation could not finish: ${(e as Error).message}`);
    return EXIT_INVALID_MODEL;
  }
  const cmp = compareToObserved(results, observed, args.tolerance !== undefined ? { tolerance: args.tolerance } : {});
  const periods = Math.max(1, observed.periods ?? 1);

  logger.info(`Calibration of ${results.modelName ?? modelPath} against ${args.observed}`);
  logger.info(
    `The model ran ${results.settings.replications} replication(s). The observations are treated as ${periods} period(s) of data; default tolerance ${num((observed.tolerance ?? args.tolerance ?? 0.1) * 100)}%.
`,
  );
  const widths = [26, 11, 11, 24, 9, 8];
  logger.info(pad(["output", "observed", "model", "expected range (95%)", "error", "verdict"], widths));
  for (const r of cmp.rows) {
    const range = r.expectedLow !== null && r.expectedHigh !== null ? `[${num(r.expectedLow)}, ${num(r.expectedHigh)}]` : "";
    const err = r.relativeError === null ? "" : `${r.relativeError >= 0 ? "+" : ""}${(r.relativeError * 100).toFixed(1)}%`;
    logger.info(pad([r.id, num(r.observed), num(r.model), range, err, r.verdict], widths));
  }
  const c = cmp.counts;
  logger.info(`
${c.match} match, ${c.close} close, ${c.off} off, ${c.missing} missing.`);
  logger.info(
    cmp.passed
      ? "The model is consistent with the observations. That supports it but does not prove it: check it also on a period it was not built from."
      : "The model is not consistent with the observations. Compare the inputs you fitted (arrivals, service times, concurrency) with how the real system is configured.",
  );
  logger.info(
    `"expected range" is where 95% of single measurements of that output should fall according to the model, because a measurement varies from period to period even when nothing changes.`,
  );
  if (cmp.widestRelativeRange !== null) {
    logger.info(
      `With ${periods} period(s) of data, errors smaller than about ${Math.round(cmp.widestRelativeRange * 100)}% of the model's value in the noisiest output cannot be detected. Real differences below that stay hidden; more periods of data narrow it.`,
    );
  }

  if (args.sensitivity !== undefined) {
    const delta = args.sensitivity / 100;
    const ids = cmp.rows.filter((r) => r.model !== null).map((r) => r.id);
    const mean = (r: typeof results, id: string): number | null => r.outputs.find((o) => o.id === id)?.mean ?? null;
    const options = { ...(args.seed !== undefined ? { seed: args.seed } : {}), ...(args.replications !== undefined ? { replications: args.replications } : {}) };
    const sensitivityTable = (title: string, scale: (m: ModelDefinition, f: number) => ModelDefinition) => {
      let low;
      let high;
      try {
        low = runModel(scale(loaded.model, 1 - delta), options);
        high = runModel(scale(loaded.model, 1 + delta), options);
      } catch (e) {
        logger.warn(`warning: sensitivity run failed: ${(e as Error).message}`);
        return;
      }
      logger.info(`
Sensitivity: ${title} off by ${num(args.sensitivity)}% in each direction`);
      const w = [26, 12, 12, 12, 16];
      logger.info(pad(["output", `-${num(args.sensitivity)}%`, "as modelled", `+${num(args.sensitivity)}%`, "span (low to high)"], w));
      for (const id of ids) {
        const lo = mean(low, id);
        const mid = mean(results, id);
        const hi = mean(high, id);
        const span = lo !== null && hi !== null && mid ? `${(((hi - lo) / Math.abs(mid)) * 100).toFixed(0)}% of model` : "";
        logger.info(pad([id, num(lo), num(mid), num(hi), span], w));
      }
    };
    sensitivityTable("the arrival rate", scaleArrivals);
    sensitivityTable("every service time", scaleServiceTimes);
    logger.info("\nIf a small input error moves an output a lot, that output is only as trustworthy as the measurement of the input (the system is close to its capacity).");
  }
  return cmp.passed ? EXIT_OK : EXIT_ASSERTION_FAILED;
}
