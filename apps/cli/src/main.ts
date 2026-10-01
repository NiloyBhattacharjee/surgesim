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
} from "@chronon-sim/engine";
import type { Clock, FileStore, Logger } from "@chronon-sim/platform";
import { formatAssertions, formatReport, timeSeriesCsv } from "./report.js";
import { renderReport } from "@chronon-sim/report";
import { runCompare, runReport } from "./compare.js";
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
  chronon run <model> [--seed N] [--replications N] [--assert EXPR]... [--html report.html] [--timeseries out.csv] [--json out.json]
  chronon report <results.json|model> --html report.html     Render an HTML report from saved results
  chronon compare <a> <b> --html compare.html                Compare two runs (results files or models)
  chronon compile <model.ts|.js|.json> [--out model.json]   Build a model module to the JSON format
  chronon schema            Print the component schemas as JSON

A <model> is a .json file, or a .js/.ts module whose default export is a model built with @chronon-sim/sdk.

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
  --out FILE          (compile) Write the JSON model to a file instead of stdout
  -h, --help          Show this help`;

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
        title: { type: "string" },
        "label-a": { type: "string" },
        "label-b": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    logger.error(`error: ${(e as Error).message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  const [command, modelPath] = positionals;

  if (values.help || command === undefined) {
    (values.help ? logger.info : logger.error)(USAGE);
    return values.help ? EXIT_OK : EXIT_USAGE;
  }

  if (command === "schema") {
    logger.info(JSON.stringify(createDefaultRegistry().schemas().map(describeSchema), null, 2));
    return EXIT_OK;
  }

  if (command === "report") {
    if (modelPath === undefined || positionals.length > 2) {
      logger.error(`error: expected "chronon report <results.json|model> --html report.html"

${USAGE}`);
      return EXIT_USAGE;
    }
    return runReport(modelPath, { html: values.html, title: values.title }, host);
  }

  if (command === "compare") {
    if (positionals.length !== 3) {
      logger.error(`error: expected "chronon compare <a> <b> --html compare.html"

${USAGE}`);
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
      logger.error(`error: expected "chronon compile <model.ts|model.js|model.json> [--out model.json]"\n\n${USAGE}`);
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

  if (command !== "run" || modelPath === undefined || positionals.length > 2) {
    logger.error(`error: expected "chronon run <model>"\n\n${USAGE}`);
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
  const results = runModel(model, options);
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
