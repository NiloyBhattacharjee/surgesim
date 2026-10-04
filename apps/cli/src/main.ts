import { parseArgs } from "node:util";
import {
  ASSERTION_OPS,
  ASSERTION_STATISTICS,
  createDefaultRegistry,
  defaultTimeSeries,
  describeSchema,
  isKnownOutputId,
  runModel,
  type AssertionDefinition,
  type RunOptions,
} from "@surgesim/engine";
import type { Clock, FileStore, Logger } from "@surgesim/platform";
import { formatAssertions, formatReport, timeSeriesCsv } from "./report.js";
import { renderReport } from "@surgesim/report";
import { runCalibrate, runFit, runFitArrivals } from "./calibrate.js";
import { runCompare, runReport } from "./compare.js";
import { runImport } from "./import.js";
import { EXIT_ASSERTION_FAILED, EXIT_INVALID_MODEL, EXIT_OK, EXIT_USAGE } from "./exit.js";
import { loadModelSource } from "./source.js";

export { EXIT_ASSERTION_FAILED, EXIT_INVALID_MODEL, EXIT_OK, EXIT_USAGE };

/** Host services the CLI needs; the real binary supplies Node implementations. */
export interface CliHost {
  fs: FileStore;
  logger: Logger;
  clock: Clock;
  /** Import a model module (.js/.mjs/.ts...). Without it only .json models can be run. */
  importModule?: (path: string) => Promise<unknown>;
}


const USAGE = `Usage:
  surgesim run <model> [--seed N] [--replications N] [--assert EXPR]... [--html report.html] [--timeseries out.csv] [--json out.json]
  surgesim report <results.json|model> --html report.html     Render an HTML report from saved results
  surgesim compare <a> <b> --html compare.html                Compare two runs (results files or models)
  surgesim import <template.json> [--out model.json] [--rate N] [--service-time MEAN] [--entry ID]...
                            Convert a CloudFormation / CDK template (cdk.out/*.template.json) to a model
  surgesim fit <data.csv> [--column NAME] [--scale K]       Fit a distribution to measured durations
  surgesim fit-arrivals <timestamps.csv> --window S         Fit an arrival rate profile from request timestamps
  surgesim calibrate <model> --observed observed.json       Compare a model with what the real system measured
  surgesim compile <model.ts|.js|.json> [--out model.json]   Build a model module to the JSON format
  surgesim schema            Print the component schemas as JSON

A <model> is a .json file, or a .js/.ts module whose default export is a model built with @surgesim/sdk.

Options:
  --seed N            Override the model's base seed
  --replications N    Override the number of replications
  --assert EXPR       Check a threshold after the run, e.g. "sink.p99<=2" or "queue.MaxQueueLength@max<500".
                      Repeatable. A suffix @mean|ci95Low|ci95High|min|max picks the statistic (default mean).
                      Exit code 3 if any assertion fails, including those in the model's "assertions".
  --timeseries FILE   Write sampled outputs over time to a CSV file
  --json FILE         Write the full results object to a JSON file
  --html FILE         Write a self-contained HTML report (charts, assertions, tables); for report/compare too
  --title TEXT        (report/compare) Override the page title
  --label-a/--label-b (compare) Names for the two sides (default: the file names)
  --column NAME|N     (fit, fit-arrivals) The column to read, by header name or 0-based index (default: first numeric)
  --scale K           (fit, fit-arrivals) Multiply every value by K, for example 0.001 to turn milliseconds into seconds
  --family F          (fit) Only try one family: exponential, lognormal, normal, uniform, triangular, constant
  --window S          (fit-arrivals) Counting window in seconds; --merge-tolerance F sets how alike windows must be to merge (0.15)
  --observed FILE     (calibrate) JSON of measured values; --tolerance F accepts that relative error (0.1 = 10%)
  --sensitivity P     (calibrate) Also show how results move when arrival rates and service times are off by P percent
  --out FILE          (compile, import) Write the JSON model to a file instead of stdout
  --rate N            (import) Requests per second at each entry point (default 10; templates do not say)
  --service-time MEAN (import) Mean service time in seconds, exponential (default 0.2; templates do not say)
  --concurrency-per-task N  (import) Requests one ECS task handles at once (default 10)
  --cold-start S      (import) Cold start seconds for Lambda functions (default none)
  --duration S        (import) Simulated seconds (default 600)
  --entry ID          (import) Entry point logical id or name (repeatable)
  --name TEXT         (import) Model name
  -h, --help          Show this help`;

const HINT = `Run "surgesim --help" for usage.`;
const COMMANDS = ["run", "report", "compare", "import", "fit", "fit-arrivals", "calibrate", "compile", "schema"];

const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const OPS = [...ASSERTION_OPS].sort((a, b) => b.length - a.length).join("|");
const ASSERT_EXPR = new RegExp(
  String.raw`^\s*([^\s@<>=]+)(?:@(` + ASSERTION_STATISTICS.join("|") + String.raw`))?\s*(` + OPS + String.raw`)\s*(` + NUMBER + String.raw`)\s*$`,
);

/** Parse "output[@statistic] op value", e.g. "sink.p99<=2". Returns an error message on failure. */
export function parseAssertion(expr: string): AssertionDefinition | string {
  const m = ASSERT_EXPR.exec(expr);
  if (!m) return `cannot parse assertion "${expr}" (expected e.g. "sink.p99<=2" or "queue.MaxQueueLength@max<500")`;
  return {
    output: m[1] as string,
    op: m[3] as AssertionDefinition["op"],
    value: Number(m[4]),
    ...(m[2] ? { statistic: m[2] as NonNullable<AssertionDefinition["statistic"]> } : {}),
  };
}

function parseIntOption(name: string, value: string | undefined, min: number): number | string | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) return `--${name} must be an integer >= ${min} (got "${value}")`;
  return n;
}

/** Run the CLI with the given arguments (excluding `node` and the script). Returns the exit code. */
export async function runCli(argv: string[], host: CliHost): Promise<number> {
  const { logger, fs, clock } = host;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        seed: { type: "string" },
        replications: { type: "string" },
        timeseries: { type: "string" },
        json: { type: "string" },
        assert: { type: "string", multiple: true },
        out: { type: "string" },
        html: { type: "string" },
        rate: { type: "string" },
        "service-time": { type: "string" },
        "cold-start": { type: "string" },
        "concurrency-per-task": { type: "string" },
        duration: { type: "string" },
        entry: { type: "string", multiple: true },
        name: { type: "string" },
        column: { type: "string" },
        scale: { type: "string" },
        family: { type: "string" },
        window: { type: "string" },
        "merge-tolerance": { type: "string" },
        observed: { type: "string" },
        tolerance: { type: "string" },
        sensitivity: { type: "string" },
        title: { type: "string" },
        "label-a": { type: "string" },
        "label-b": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    // Node appends advice about positionals that start with "-"; keep the first sentence.
    logger.error(`error: ${(e as Error).message.split(". To specify")[0]}\n${HINT}`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  const [command, modelPath] = positionals;

  if (values.help || command === undefined) {
    (values.help ? logger.info : logger.error)(USAGE);
    return values.help ? EXIT_OK : EXIT_USAGE;
  }

  if (!COMMANDS.includes(command)) {
    logger.error(`error: unknown command "${command}" (expected one of: ${COMMANDS.join(", ")})
${HINT}`);
    return EXIT_USAGE;
  }

  if (command === "schema") {
    logger.info(JSON.stringify(createDefaultRegistry().schemas().map(describeSchema), null, 2));
    return EXIT_OK;
  }

  if (command === "import") {
    if (modelPath === undefined || positionals.length > 2) {
      logger.error(`error: expected "surgesim import <template.json> [--out model.json]"
${HINT}`);
      return EXIT_USAGE;
    }
    const num = (flag: string, raw: string | undefined, positive: boolean): number | undefined | "bad" => {
      if (raw === undefined) return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n) || (positive ? n <= 0 : n < 0)) {
        logger.error(`error: --${flag} must be a ${positive ? "positive" : "non-negative"} number (got "${raw}")`);
        return "bad";
      }
      return n;
    };
    const rate = num("rate", values.rate, true);
    const serviceTime = num("service-time", values["service-time"], true);
    const coldStart = num("cold-start", values["cold-start"], false);
    const duration = num("duration", values.duration, true);
    const perTask = num("concurrency-per-task", values["concurrency-per-task"], true);
    const iSeed = parseIntOption("seed", values.seed, 0);
    const iReps = parseIntOption("replications", values.replications, 1);
    for (const v of [rate, serviceTime, coldStart, duration, perTask]) if (v === "bad") return EXIT_USAGE;
    for (const v of [iSeed, iReps]) {
      if (typeof v === "string") {
        logger.error(`error: ${v}`);
        return EXIT_USAGE;
      }
    }
    return runImport(
      modelPath,
      {
        out: values.out,
        name: values.name,
        rate: rate as number | undefined,
        serviceTime: serviceTime as number | undefined,
        coldStart: coldStart as number | undefined,
        duration: duration as number | undefined,
        concurrencyPerTask: perTask as number | undefined,
        seed: iSeed as number | undefined,
        replications: iReps as number | undefined,
        entry: values.entry ?? [],
      },
      host,
    );
  }

  if (command === "fit" || command === "fit-arrivals" || command === "calibrate") {
    if (modelPath === undefined || positionals.length > 2) {
      logger.error(`error: expected "surgesim ${command} <file>"
${HINT}`);
      return EXIT_USAGE;
    }
    const positive = (flag: string, raw: string | undefined, dflt: number | undefined, allowZero = false): number | undefined | "bad" => {
      if (raw === undefined) return dflt;
      const n = Number(raw);
      if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) {
        logger.error(`error: --${flag} must be a ${allowZero ? "non-negative" : "positive"} number (got "${raw}")`);
        return "bad";
      }
      return n;
    };
    const scale = positive("scale", values.scale, 1);
    const windowSeconds = positive("window", values.window, undefined);
    const mergeTolerance = positive("merge-tolerance", values["merge-tolerance"], undefined, true);
    const tolerance = positive("tolerance", values.tolerance, undefined, true);
    const sensitivity = positive("sensitivity", values.sensitivity, undefined);
    for (const v of [scale, windowSeconds, mergeTolerance, tolerance, sensitivity]) if (v === "bad") return EXIT_USAGE;
    if (command === "fit") {
      return runFit(modelPath, { column: values.column, scale: scale as number, family: values.family }, host);
    }
    if (command === "fit-arrivals") {
      if (windowSeconds === undefined) {
        logger.error('error: "surgesim fit-arrivals" needs --window <seconds> (how wide the counting windows are, for example 30)');
        return EXIT_USAGE;
      }
      return runFitArrivals(modelPath, { column: values.column, scale: scale as number, window: windowSeconds as number, mergeTolerance: mergeTolerance as number | undefined }, host);
    }
    const cSeed = parseIntOption("seed", values.seed, 0);
    const cReps = parseIntOption("replications", values.replications, 1);
    for (const v of [cSeed, cReps]) {
      if (typeof v === "string") {
        logger.error(`error: ${v}`);
        return EXIT_USAGE;
      }
    }
    return runCalibrate(
      modelPath,
      { observed: values.observed, tolerance: tolerance as number | undefined, seed: typeof cSeed === "number" ? cSeed : undefined, replications: typeof cReps === "number" ? cReps : undefined, sensitivity: sensitivity as number | undefined },
      host,
    );
  }

  if (command === "report") {
    if (modelPath === undefined || positionals.length > 2) {
      logger.error(`error: expected "surgesim report <results.json|model> --html report.html"
${HINT}`);
      return EXIT_USAGE;
    }
    return runReport(modelPath, { html: values.html, title: values.title }, host);
  }

  if (command === "compare") {
    if (positionals.length !== 3) {
      logger.error(`error: expected "surgesim compare <a> <b> --html compare.html"
${HINT}`);
      return EXIT_USAGE;
    }
    const cSeed = parseIntOption("seed", values.seed, 0);
    const cReps = parseIntOption("replications", values.replications, 1);
    for (const v of [cSeed, cReps]) {
      if (typeof v === "string") {
        logger.error(`error: ${v}`);
        return EXIT_USAGE;
      }
    }
    return runCompare(
      [positionals[1] as string, positionals[2] as string],
      {
        html: values.html,
        labelA: values["label-a"],
        labelB: values["label-b"],
        title: values.title,
        ...(typeof cSeed === "number" ? { seed: cSeed } : {}),
        ...(typeof cReps === "number" ? { replications: cReps } : {}),
      },
      host,
    );
  }

  if (command === "compile") {
    if (modelPath === undefined || positionals.length > 2) {
      logger.error(`error: expected "surgesim compile <model.ts|model.js|model.json> [--out model.json]"\n${HINT}`);
      return EXIT_USAGE;
    }
    const compiled = await loadModelSource(modelPath, host);
    if (!compiled.ok) {
      logger.error(`error: ${compiled.message}`);
      return compiled.code;
    }
    const text = JSON.stringify(compiled.json, null, 2) + "\n";
    if (values.out === undefined) {
      logger.info(text.trimEnd());
      return EXIT_OK;
    }
    try {
      await fs.writeText(values.out, text);
    } catch (e) {
      logger.error(`error: cannot write ${values.out}: ${(e as Error).message}`);
      return EXIT_USAGE;
    }
    logger.info(`Wrote ${values.out}`);
    return EXIT_OK;
  }

  if (modelPath === undefined || positionals.length > 2) {
    logger.error(`error: expected "surgesim run <model>"\n${HINT}`);
    return EXIT_USAGE;
  }

  const seed = parseIntOption("seed", values.seed, 0);
  const replications = parseIntOption("replications", values.replications, 1);
  for (const v of [seed, replications]) {
    if (typeof v === "string") {
      logger.error(`error: ${v}`);
      return EXIT_USAGE;
    }
  }

  const loaded = await loadModelSource(modelPath, host);
  if (!loaded.ok) {
    logger.error(`error: ${loaded.message}`);
    return loaded.code;
  }
  const model = loaded.model;

  const extra: AssertionDefinition[] = [];
  for (const expr of values.assert ?? []) {
    const parsed = parseAssertion(expr);
    if (typeof parsed === "string") {
      logger.error(`error: ${parsed}`);
      return EXIT_USAGE;
    }
    if (!isKnownOutputId(parsed.output, model.components)) {
      logger.error(`error: --assert: unknown output "${parsed.output}" (expected "<componentName>.<OutputKey>")`);
      return EXIT_USAGE;
    }
    extra.push(parsed);
  }

  const options: RunOptions = {};
  if (extra.length > 0) options.assertions = extra;
  if (typeof seed === "number") options.seed = seed;
  if (typeof replications === "number") options.replications = replications;
  if (values.timeseries !== undefined && !model.settings.timeSeries) options.timeSeries = defaultTimeSeries(model);

  const started = clock.nowMs();
  let results;
  try {
    results = runModel(model, options);
  } catch (e) {
    // A model can be valid yet impossible to finish (for example a zero-delay loop). Say so plainly.
    logger.error(`error: the simulation could not finish: ${(e as Error).message}`);
    if (!(e instanceof Error && e.name === "SimulationLimitError")) logger.debug((e as Error).stack ?? "");
    return EXIT_INVALID_MODEL;
  }
  const elapsed = clock.nowMs() - started;

  logger.info(formatReport(results));
  if (results.assertions) logger.info(`\n${formatAssertions(results.assertions)}`);
  logger.info(`\nCompleted ${results.settings.replications} replication(s) in ${(elapsed / 1000).toFixed(2)}s.`);

  try {
    if (values.timeseries !== undefined) {
      await fs.writeText(values.timeseries, timeSeriesCsv(results));
      logger.info(`Wrote time series to ${values.timeseries}`);
    }
    if (values.html !== undefined) {
      await fs.writeText(values.html, renderReport(results));
      logger.info(`Wrote report to ${values.html}`);
    }
    if (values.json !== undefined) {
      await fs.writeText(values.json, JSON.stringify(results, null, 2) + "\n");
      logger.info(`Wrote results to ${values.json}`);
    }
  } catch (e) {
    logger.error(`error: cannot write output: ${(e as Error).message}`);
    return EXIT_USAGE;
  }
  const failed = results.assertions?.filter((a) => !a.passed).length ?? 0;
  if (failed > 0) {
    logger.error(`error: ${failed} assertion(s) failed`);
    return EXIT_ASSERTION_FAILED;
  }
  return EXIT_OK;
}
