import { loadModel } from "@surgesim/engine";
import type { FileStore, Logger } from "@surgesim/platform";
import {
  importCloudFormation,
  importKubernetes,
  parseManifests,
  parseOverlay,
  parseTemplate,
  type ImportOptions,
  type ImportResult,
  type KubernetesImportOptions,
} from "@surgesim/importer";
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
  /** Kubernetes only: requests one pod serves at once. */
  concurrencyPerPod: number | undefined;
  /** Kubernetes only: seconds from pod creation to taking traffic. */
  startupDelay: number | undefined;
  /** Kubernetes only: path of the overlay file (traffic, service times, call graph). */
  overlay: string | undefined;
  seed: number | undefined;
  replications: number | undefined;
  entry: string[];
}

/** Used only to pick which parser's error to show when the file is neither format: manifests have `apiVersion`. */
const LOOKS_KUBERNETES = /["']?\bapiVersion["']?\s*:/;

/**
 * `surgesim import <file>`: convert a CloudFormation (JSON or YAML) / CDK-synthesized template, or Kubernetes
 * manifests plus an optional overlay, to a model.
 */
export async function runImport(path: string, args: ImportArgs, host: { fs: FileStore; logger: Logger }): Promise<number> {
  const { fs, logger } = host;
  const read = async (file: string): Promise<string | undefined> => {
    try {
      return await fs.readText(file);
    } catch (e) {
      logger.error(`error: cannot read ${file}: ${(e as Error).message}`);
      return undefined;
    }
  };
  const text = await read(path);
  if (text === undefined) return EXIT_USAGE;
  // Manifests parse as Kubernetes objects (each has a kind); a CloudFormation template does not.
  const manifests = parseManifests(text);
  const template = manifests.ok ? undefined : parseTemplate(text);
  const isTemplate = template?.ok === true && typeof template.template === "object" && template.template !== null && "Resources" in template.template;
  const kubernetes = args.overlay !== undefined || manifests.ok || (!isTemplate && LOOKS_KUBERNETES.test(text));
  const misplaced = (kubernetes
    ? [args.coldStart !== undefined && "--cold-start", args.concurrencyPerTask !== undefined && "--concurrency-per-task"]
    : [args.concurrencyPerPod !== undefined && "--concurrency-per-pod", args.startupDelay !== undefined && "--startup-delay"]
  ).filter((f) => f !== false);
  if (misplaced.length > 0) {
    const kind = kubernetes ? "Kubernetes manifests" : "a CloudFormation template";
    logger.error(`error: ${misplaced.join(" and ")} cannot be used here: ${path} is ${kind}`);
    return EXIT_USAGE;
  }
  const common = {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.rate !== undefined ? { ratePerSecond: args.rate } : {}),
    ...(args.serviceTime !== undefined ? { serviceTime: dist.exponential(args.serviceTime) } : {}),
    ...(args.duration !== undefined ? { duration: args.duration } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    ...(args.replications !== undefined ? { replications: args.replications } : {}),
    ...(args.entry.length > 0 ? { entry: args.entry } : {}),
  };

  let result: ImportResult;
  if (kubernetes) {
    if (!manifests.ok) {
      logger.error(`error: ${path}: ${manifests.message}`);
      return EXIT_INVALID_MODEL;
    }
    let fromOverlay: KubernetesImportOptions = {};
    if (args.overlay !== undefined) {
      const overlayText = await read(args.overlay);
      if (overlayText === undefined) return EXIT_USAGE;
      const overlay = parseOverlay(overlayText);
      if (!overlay.ok) {
        logger.error(`error: ${args.overlay}:\n${overlay.errors.map((e) => `  - ${e.message}`).join("\n")}`);
        return EXIT_INVALID_MODEL;
      }
      fromOverlay = overlay.options;
      // A --rate on the command line replaces the overlay's traffic, rate profile included.
      if (args.rate !== undefined) delete fromOverlay.rateProfile;
    }
    result = importKubernetes(manifests.objects, {
      ...fromOverlay,
      ...common,
      ...(args.concurrencyPerPod !== undefined ? { concurrencyPerPod: args.concurrencyPerPod } : {}),
      ...(args.startupDelay !== undefined ? { startupDelay: args.startupDelay } : {}),
    });
  } else {
    const parsed = template ?? parseTemplate(text);
    if (!parsed.ok) {
      logger.error(`error: ${path}: ${parsed.message}`);
      return EXIT_INVALID_MODEL;
    }
    const options: ImportOptions = {
      ...common,
      ...(args.coldStart !== undefined ? { coldStartTime: dist.constant(args.coldStart) } : {}),
      ...(args.concurrencyPerTask !== undefined ? { concurrencyPerTask: args.concurrencyPerTask } : {}),
    };
    result = importCloudFormation(parsed.template, options);
  }
  if (!result.ok) {
    logger.error(`error: ${path}${args.overlay !== undefined ? ` with ${args.overlay}` : ""}: ${result.errors.map((e) => e.message).join("; ")}`);
    return EXIT_INVALID_MODEL;
  }
  // Never emit a model the engine would reject. An overlay's distribution parameters are first checked here.
  const check = loadModel(result.model);
  if (!check.ok) {
    const cause = args.overlay !== undefined ? `check the values in ${args.overlay}` : "this is a bug in the importer";
    logger.error(`error: the imported model failed validation (${cause}):\n${formatErrors(check.errors)}`);
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
    say(`\nAssumptions (the ${kubernetes ? "manifests do" : "template does"} not say; review these):\n${result.assumptions.map((a) => `  - ${a}`).join("\n")}`);
  }
  if (result.warnings.length > 0) {
    say(`\nWarnings:\n${result.warnings.map((w) => `  - ${w}`).join("\n")}`);
  }
  return EXIT_OK;
}
