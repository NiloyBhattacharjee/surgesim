import { loadModel, type ModelDefinition, type ValidationError } from "@chronon-sim/engine";
import type { FileStore } from "@chronon-sim/platform";

import { EXIT_INVALID_MODEL, EXIT_USAGE } from "./exit.js";

/** Extensions loaded as code (a module exporting a model) rather than parsed as JSON. */
const MODULE_EXT = /\.(?:[cm]?[jt]s)$/i;

/** True if `path` names a code module that exports a model (e.g. built with `@chronon-sim/sdk`). */
export function isModuleSource(path: string): boolean {
  return MODULE_EXT.test(path);
}

/** Services needed to load a model from a file. */
export interface SourceHost {
  fs: FileStore;
  /** Import a code module and return its namespace. Provided by hosts that can run code (Node). */
  importModule?: (path: string) => Promise<unknown>;
}

export type SourceResult = { ok: true; json: unknown } | { ok: false; code: number; message: string };

/** Format structured validation errors as an indented list. */
export function formatErrors(errors: readonly ValidationError[]): string {
  return errors
    .map((e) => {
      const where = [e.component, e.key].filter((x) => x !== null).join(".");
      return `  - ${where ? `[${where}] ` : ""}${e.message}`;
    })
    .join("\n");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Read a model source: a `.json` file, or a code module whose `default` export (or `model` export)
 * is an SDK `Model` or a plain model object. Returns the model as JSON, not yet validated.
 */
export async function readModelSource(path: string, host: SourceHost): Promise<SourceResult> {
  if (!isModuleSource(path)) {
    let text: string;
    try {
      text = await host.fs.readText(path);
    } catch (e) {
      return { ok: false, code: EXIT_USAGE, message: `cannot read ${path}: ${(e as Error).message}` };
    }
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch (e) {
      return { ok: false, code: EXIT_INVALID_MODEL, message: `${path} is not valid JSON: ${(e as Error).message}` };
    }
  }

  if (host.importModule === undefined) {
    return { ok: false, code: EXIT_USAGE, message: `cannot load ${path}: this host cannot run model modules (use a .json model)` };
  }
  let mod: unknown;
  try {
    mod = await host.importModule(path);
  } catch (e) {
    const err = e as Error & { code?: string };
    const isTs = /\.[cm]?ts$/i.test(path);
    let hint = "";
    if (isTs && (err.code === "ERR_UNKNOWN_FILE_EXTENSION" || /Unknown file extension/.test(err.message))) {
      hint = "\n  TypeScript models need Node 22.18+ (or run through tsx / ts-node), or compile to .js first.";
    } else if (/Cannot use import statement outside a module|Unexpected token 'export'|Cannot use 'import.meta' outside a module/.test(err.message)) {
      // Node treats .js/.ts as CommonJS unless the nearest package.json says "type": "module".
      hint = isTs
        ? '\n  Models are ES modules. Rename the file to .mts, or add "type": "module" to your package.json.'
        : '\n  Models are ES modules. Rename the file to .mjs, or add "type": "module" to your package.json.';
    }
    return { ok: false, code: EXIT_USAGE, message: `cannot load ${path}: ${err.message}${hint}` };
  }
  const exported = isRecord(mod) ? (mod["default"] ?? mod["model"]) : undefined;
  if (exported === undefined) {
    return { ok: false, code: EXIT_INVALID_MODEL, message: `${path} must export a model as its default export (or a named export "model")` };
  }
  if (isRecord(exported) && typeof exported["toJSON"] === "function") {
    try {
      return { ok: true, json: (exported["toJSON"] as () => unknown)() };
    } catch (e) {
      const problems = (e as { problems?: { component: string | null; key: string | null; message: string }[] }).problems;
      if (Array.isArray(problems)) {
        return { ok: false, code: EXIT_INVALID_MODEL, message: `${path} could not be built, ${problems.length} problem(s):\n${formatErrors(problems)}` };
      }
      return { ok: false, code: EXIT_INVALID_MODEL, message: `${path} failed to build: ${(e as Error).message}` };
    }
  }
  return { ok: true, json: exported };
}

export type LoadResult = { ok: true; json: unknown; model: ModelDefinition } | { ok: false; code: number; message: string };

/** Read a model source and validate it against the format and component schemas. */
export async function loadModelSource(path: string, host: SourceHost): Promise<LoadResult> {
  const source = await readModelSource(path, host);
  if (!source.ok) return source;
  const loaded = loadModel(source.json);
  if (!loaded.ok) {
    return {
      ok: false,
      code: EXIT_INVALID_MODEL,
      message: `${path} failed validation with ${loaded.errors.length} error${loaded.errors.length === 1 ? "" : "s"}:\n${formatErrors(loaded.errors)}`,
    };
  }
  return { ok: true, json: source.json, model: loaded.model };
}
