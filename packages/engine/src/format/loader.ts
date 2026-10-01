import { createDefaultRegistry, type ComponentRegistry } from "../components/index.js";
import { validateInputs, type ValidationError } from "../schema/index.js";
import {
  MODEL_FORMAT_VERSION,
  type ComponentDefinition,
  type ModelDefinition,
  type ModelSettings,
  type TimeSeriesConfig,
} from "./definition.js";

/** Result of {@link loadModel}: either a validated model, or every validation error found. */
export type LoadResult =
  | { ok: true; model: ModelDefinition }
  | { ok: false; errors: ValidationError[] };

const SETTINGS_KEYS = ["duration", "warmUp", "seed", "replications", "ticksPerSecond", "timeSeries"];
const TOP_KEYS = ["version", "name", "description", "settings", "components"];
const COMPONENT_KEYS = ["type", "name", "inputs", "links", "stream"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Validate a parsed JSON model against the format and the component schemas.
 * Never throws for bad input; returns all errors at once.
 */
export function loadModel(json: unknown, registry: ComponentRegistry = createDefaultRegistry()): LoadResult {
  const errors: ValidationError[] = [];
  const modelErr = (key: string | null, message: string) => errors.push({ component: null, key, message });

  if (!isRecord(json)) {
    modelErr(null, "model must be a JSON object");
    return { ok: false, errors };
  }
  for (const k of Object.keys(json)) if (!TOP_KEYS.includes(k)) modelErr(k, "unknown top-level field");

  if (json["version"] !== MODEL_FORMAT_VERSION) {
    modelErr("version", `unsupported or missing version (expected ${MODEL_FORMAT_VERSION}, got ${JSON.stringify(json["version"])})`);
  }
  for (const k of ["name", "description"] as const) {
    if (json[k] !== undefined && typeof json[k] !== "string") modelErr(k, "must be a string");
  }

  const settings = loadSettings(json["settings"], modelErr);

  const components: ComponentDefinition[] = [];
  const rawComponents = json["components"];
  if (!Array.isArray(rawComponents)) {
    modelErr("components", "must be an array of components");
  } else {
    const byName = new Map<string, ComponentDefinition>();
    const rawLinks: { def: ComponentDefinition; raw: Record<string, unknown> }[] = [];
    rawComponents.forEach((raw: unknown, idx) => {
      const label = isRecord(raw) && typeof raw["name"] === "string" ? raw["name"] : `components[${idx}]`;
      const cerr = (key: string | null, message: string) => errors.push({ component: label, key, message });
      if (!isRecord(raw)) return cerr(null, "component must be an object");
      for (const k of Object.keys(raw)) if (!COMPONENT_KEYS.includes(k)) cerr(k, "unknown component field");
      const name = raw["name"];
      const type = raw["type"];
      let ok = true;
      if (typeof name !== "string" || name.trim() === "") {
        cerr("name", "must be a non-empty string");
        ok = false;
      } else if (byName.has(name)) {
        cerr("name", "duplicate component name");
        ok = false;
      }
      if (typeof type !== "string") {
        cerr("type", "must be a string");
        ok = false;
      }
      if (raw["stream"] !== undefined && typeof raw["stream"] !== "string") cerr("stream", "must be a string");
      if (!ok) return;
      const cls = registry.get(type as string);
      if (!cls) {
        return cerr("type", `unknown component type "${type as string}" (known: ${registry.types().join(", ")})`);
      }
      const v = validateInputs(cls.schema, raw["inputs"], name as string);
      errors.push(...v.errors);
      const def: ComponentDefinition = {
        type: type as string,
        name: name as string,
        inputs: v.values,
        links: {},
        ...(typeof raw["stream"] === "string" ? { stream: raw["stream"] } : {}),
      };
      byName.set(def.name, def);
      components.push(def);
      rawLinks.push({ def, raw });
    });

    // Links are resolved after all names are known.
    for (const { def, raw } of rawLinks) {
      const schema = (registry.get(def.type) as NonNullable<ReturnType<ComponentRegistry["get"]>>).schema;
      const lerr = (key: string, message: string) => errors.push({ component: def.name, key, message });
      const links = raw["links"];
      if (links !== undefined && !isRecord(links)) {
        lerr("links", "must be an object mapping link keys to component names");
        continue;
      }
      const given = (links ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(given)) {
        if (!schema.links.some((l) => l.key === k)) lerr(k, `unknown link for ${schema.type}`);
      }
      for (const spec of schema.links) {
        const target = given[spec.key];
        if (target === undefined || target === null) {
          if (spec.required) lerr(spec.key, "required link is missing");
          continue;
        }
        if (typeof target !== "string") {
          lerr(spec.key, "must be a component name");
          continue;
        }
        const targetDef = byName.get(target);
        if (!targetDef) {
          lerr(spec.key, `no component named "${target}"`);
          continue;
        }
        const targetSchema = (registry.get(targetDef.type) as NonNullable<ReturnType<ComponentRegistry["get"]>>).schema;
        if (!targetSchema.roles.includes(spec.accepts)) {
          lerr(spec.key, `"${target}" is a ${targetDef.type}, which cannot be used here (needs a component with role "${spec.accepts}")`);
          continue;
        }
        def.links[spec.key] = target;
      }
    }

    if (settings?.timeSeries) {
      validateTimeSeriesOutputs(settings.timeSeries, byName, registry, modelErr);
    }
  }

  if (errors.length > 0 || settings === null) return { ok: false, errors };
  const model: ModelDefinition = {
    version: MODEL_FORMAT_VERSION,
    ...(typeof json["name"] === "string" ? { name: json["name"] } : {}),
    ...(typeof json["description"] === "string" ? { description: json["description"] } : {}),
    settings,
    components,
  };
  return { ok: true, model };
}

function validateTimeSeriesOutputs(
  ts: TimeSeriesConfig,
  byName: Map<string, ComponentDefinition>,
  registry: ComponentRegistry,
  modelErr: (key: string | null, message: string) => void,
): void {
  for (const id of ts.outputs) {
    const dot = id.lastIndexOf(".");
    const comp = dot > 0 ? byName.get(id.slice(0, dot)) : undefined;
    const schema = comp ? registry.get(comp.type)?.schema : undefined;
    if (!schema || !schema.outputs.some((o) => o.key === id.slice(dot + 1))) {
      modelErr("settings.timeSeries.outputs", `unknown output "${id}" (expected "<componentName>.<OutputKey>")`);
    }
  }
}

function loadSettings(
  raw: unknown,
  err: (key: string | null, message: string) => void,
): ModelSettings | null {
  if (!isRecord(raw)) {
    err("settings", "must be an object with at least a duration");
    return null;
  }
  const before = { n: 0 };
  const e = (key: string, message: string) => {
    before.n++;
    err(`settings.${key}`, message);
  };
  for (const k of Object.keys(raw)) if (!SETTINGS_KEYS.includes(k)) e(k, "unknown setting");

  const num = (key: string, dflt: number | undefined, check: (v: number) => string | null): number => {
    const v = raw[key];
    if (v === undefined) {
      if (dflt === undefined) e(key, "required setting is missing");
      return dflt ?? 0;
    }
    if (!finite(v)) {
      e(key, "must be a finite number");
      return dflt ?? 0;
    }
    const problem = check(v);
    if (problem) e(key, problem);
    return v;
  };

  const ticksPerSecond = num("ticksPerSecond", 1_000_000, (v) =>
    Number.isInteger(v) && v >= 1 ? null : "must be a positive integer",
  );
  const duration = num("duration", undefined, (v) => (v > 0 ? null : "must be > 0"));
  const warmUp = num("warmUp", 0, (v) => (v >= 0 ? null : "must be >= 0"));
  const seed = num("seed", 1, (v) => (Number.isInteger(v) && v >= 0 ? null : "must be a non-negative integer"));
  const replications = num("replications", 1, (v) =>
    Number.isInteger(v) && v >= 1 ? null : "must be a positive integer",
  );
  if (finite(duration) && finite(warmUp) && warmUp >= duration && duration > 0) e("warmUp", "must be less than duration");
  if (duration * ticksPerSecond > Number.MAX_SAFE_INTEGER) e("duration", "duration x ticksPerSecond exceeds 2^53 ticks");

  let timeSeries: TimeSeriesConfig | undefined;
  const ts = raw["timeSeries"];
  if (ts !== undefined) {
    if (!isRecord(ts)) {
      e("timeSeries", "must be an object {interval, outputs}");
    } else {
      const interval = ts["interval"];
      const outputs = ts["outputs"];
      for (const k of Object.keys(ts)) if (k !== "interval" && k !== "outputs") e(`timeSeries.${k}`, "unknown field");
      if (!finite(interval) || interval <= 0) e("timeSeries.interval", "must be a number > 0");
      else if (duration / interval > 1_000_000) e("timeSeries.interval", "too small: more than 1,000,000 samples");
      if (!Array.isArray(outputs) || outputs.length === 0 || !outputs.every((o) => typeof o === "string")) {
        e("timeSeries.outputs", 'must be a non-empty array of output ids like "queue.QueueLength"');
      } else if (finite(interval) && interval > 0) {
        timeSeries = { interval, outputs: outputs as string[] };
      }
    }
  }
  if (before.n > 0) return null;
  return { duration, warmUp, seed, replications, ticksPerSecond, ...(timeSeries ? { timeSeries } : {}) };
}
