import { parseArgs } from "node:util";
import {
  createDefaultRegistry,
  defaultTimeSeries,
  describeSchema,
  loadModel,
  runModel,
  type RunOptions,
} from "@chronon-sim/engine";
import type { Clock, FileStore, Logger } from "@chronon-sim/platform";
import { formatReport, timeSeriesCsv } from "./report.js";

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

const USAGE = `Usage:
  chronon run <model.json> [--seed N] [--replications N] [--timeseries out.csv] [--json out.json]
  chronon schema            Print the component schemas as JSON

Options:
  --seed N            Override the model's base seed
  --replications N    Override the number of replications
  --timeseries FILE   Write sampled outputs over time to a CSV file
  --json FILE         Write the full results object to a JSON file
  -h, --help          Show this help`;

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

  const options: RunOptions = {};
  if (typeof seed === "number") options.seed = seed;
  if (typeof replications === "number") options.replications = replications;
  if (values.timeseries !== undefined && !model.settings.timeSeries) options.timeSeries = defaultTimeSeries(model);

  const started = clock.nowMs();
  const results = runModel(model, options);
  const elapsed = clock.nowMs() - started;

  logger.info(formatReport(results));
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
  return EXIT_OK;
}
