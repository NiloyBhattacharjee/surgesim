import { parseArgs } from "node:util";
import {
  ASSERTION_OPS,
  ASSERTION_STATISTICS,
  createDefaultRegistry,
  defaultTimeSeries,
  describeSchema,
  isKnownOutputId,
  loadModel,
  runModel,
  type AssertionDefinition,
  type RunOptions,
} from "@chronon-sim/engine";
import type { Clock, FileStore, Logger } from "@chronon-sim/platform";
import { formatAssertions, formatReport, timeSeriesCsv } from "./report.js";

/** Host services the CLI needs; the real binary supplies Node implementations. */
export interface CliHost {
  fs: FileStore;
  logger: Logger;
  clock: Clock;
}

/** Exit codes. */
export const EXIT_OK = 0;
export const EXIT_INVALID_MODEL = 1;
export const EXIT_USAGE = 2;
/** The run completed but at least one assertion failed (use this to fail a CI job). */
export const EXIT_ASSERTION_FAILED = 3;

const USAGE = `Usage:
  chronon run <model.json> [--seed N] [--replications N] [--assert EXPR]... [--timeseries out.csv] [--json out.json]
  chronon schema            Print the component schemas as JSON

Options:
  --seed N            Override the model's base seed
  --replications N    Override the number of replications
  --assert EXPR       Check a threshold after the run, e.g. "sink.p99<=2" or "queue.MaxQueueLength@max<500".
                      Repeatable. A suffix @mean|ci95Low|ci95High|min|max picks the statistic (default mean).
                      Exit code 3 if any assertion fails, including those in the model's "assertions".
  --timeseries FILE   Write sampled outputs over time to a CSV file
  --json FILE         Write the full results object to a JSON file
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

  if (command !== "run" || modelPath === undefined || positionals.length > 2) {
    logger.error(`error: expected "chronon run <model.json>"\n\n${USAGE}`);
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

  let text: string;
  try {
    text = await fs.readText(modelPath);
  } catch (e) {
    logger.error(`error: cannot read ${modelPath}: ${(e as Error).message}`);
    return EXIT_USAGE;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    logger.error(`error: ${modelPath} is not valid JSON: ${(e as Error).message}`);
    return EXIT_INVALID_MODEL;
  }

  const loaded = loadModel(json);
  if (!loaded.ok) {
    const lines = loaded.errors.map((e) => {
      const where = [e.component, e.key].filter((x) => x !== null).join(".");
      return `  - ${where ? `[${where}] ` : ""}${e.message}`;
    });
    logger.error(`error: ${modelPath} failed validation with ${loaded.errors.length} error${loaded.errors.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
    return EXIT_INVALID_MODEL;
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
