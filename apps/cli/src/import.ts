import { loadModel } from "@surgesim/engine";
import type { FileStore, Logger } from "@surgesim/platform";
import { importCloudFormation, parseTemplate, type ImportOptions } from "@surgesim/importer";
import { dist } from "@surgesim/sdk";
import { EXIT_INVALID_MODEL, EXIT_OK, EXIT_USAGE } from "./exit.js";
import { formatErrors } from "./source.js";

/** Command-line options of `surgesim import`, already parsed to numbers. */
export interface ImportArgs {
  out: string | undefined;
  name: string | undefined;
  rate: number | undefined;
  serviceTime: number | undefined;
  coldStart: number | undefined;
  duration: number | undefined;
  concurrencyPerTask: number | undefined;
  seed: number | undefined;
  replications: number | undefined;
  entry: string[];
}

/** `surgesim import <template>`: convert a CloudFormation (JSON or YAML) / CDK-synthesized template to a model. */
export async function runImport(path: string, args: ImportArgs, host: { fs: FileStore; logger: Logger }): Promise<number> {
  const { fs, logger } = host;
  let text: string;
  try {
    text = await fs.readText(path);
  } catch (e) {
    logger.error(`error: cannot read ${path}: ${(e as Error).message}`);
    return EXIT_USAGE;
  }
  const parsed = parseTemplate(text);
  if (!parsed.ok) {
    logger.error(`error: ${path}: ${parsed.message}`);
    return EXIT_INVALID_MODEL;
  }
  const template = parsed.template;

  const options: ImportOptions = {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.rate !== undefined ? { ratePerSecond: args.rate } : {}),
    ...(args.serviceTime !== undefined ? { serviceTime: dist.exponential(args.serviceTime) } : {}),
    ...(args.coldStart !== undefined ? { coldStartTime: dist.constant(args.coldStart) } : {}),
    ...(args.duration !== undefined ? { duration: args.duration } : {}),
    ...(args.concurrencyPerTask !== undefined ? { concurrencyPerTask: args.concurrencyPerTask } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    ...(args.replications !== undefined ? { replications: args.replications } : {}),
    ...(args.entry.length > 0 ? { entry: args.entry } : {}),
  };
  const result = importCloudFormation(template, options);
  if (!result.ok) {
    logger.error(`error: ${path}: ${result.errors.map((e) => e.message).join("; ")}`);
    return EXIT_INVALID_MODEL;
  }
  // Never emit a model the engine would reject.
  const check = loadModel(result.model);
  if (!check.ok) {
    logger.error(`error: the imported model failed validation (this is a bug in the importer):\n${formatErrors(check.errors)}`);
    return EXIT_INVALID_MODEL;
  }

  const json = JSON.stringify(result.model, null, 2) + "\n";
  // When the model goes to stdout, keep stdout pure JSON and send the summary to stderr.
  const say = args.out === undefined ? (m: string) => logger.warn(m) : (m: string) => logger.info(m);
  if (args.out === undefined) {
    logger.info(json.trimEnd());
  } else {
    try {
      await fs.writeText(args.out, json);
    } catch (e) {
      logger.error(`error: cannot write ${args.out}: ${(e as Error).message}`);
      return EXIT_USAGE;
    }
    say(`Wrote ${args.out}`);
  }

  say(`\nImported ${result.mapped.length} resource(s) from ${path}:`);
  for (const m of result.mapped) {
    say(`  ${m.logicalId} (${m.type}) -> ${m.componentType} "${m.component}"${m.notes.length > 0 ? `  [${m.notes.join("; ")}]` : ""}`);
  }
  if (result.ignored.length > 0) {
    say(`\nNot modelled (ignored): ${result.ignored.map((i) => `${i.logicalId} (${i.type})`).join(", ")}`);
  }
  if (result.assumptions.length > 0) {
    say(`\nAssumptions (the template does not say; review these):\n${result.assumptions.map((a) => `  - ${a}`).join("\n")}`);
  }
  if (result.warnings.length > 0) {
    say(`\nWarnings:\n${result.warnings.map((w) => `  - ${w}`).join("\n")}`);
  }
  return EXIT_OK;
}
