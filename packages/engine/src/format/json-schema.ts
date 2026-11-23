import { createDefaultRegistry, type ComponentRegistry } from "../components/index.js";
import { DISTRIBUTION_NAMES, DISTRIBUTION_PARAMS } from "../rng/index.js";
import type { InputSpec } from "../schema/index.js";
import { ASSERTION_OPS, ASSERTION_STATISTICS, MODEL_FORMAT_VERSION } from "./definition.js";

/** Where the JSON Schema of the current format is published; models can point `"$schema"` at it. */
export const MODEL_JSON_SCHEMA_URL = "https://raw.githubusercontent.com/NiloyBhattacharjee/surgesim/main/docs/model.schema.json";

type Json = Record<string, unknown>;

const OUTPUT_ID = { type: "string", pattern: "^.+\\.[^.]+$", description: 'Output id "<componentName>.<OutputKey>".' };
const pair = (a: Json, b: Json) => ({ type: "array", items: [a, b], minItems: 2, maxItems: 2 });

function bounds(spec: InputSpec): Json {
  return { ...(spec.min !== undefined ? { minimum: spec.min } : {}), ...(spec.max !== undefined ? { maximum: spec.max } : {}) };
}

function inputSchema(spec: InputSpec): Json {
  const value: Json = (() => {
    switch (spec.type) {
      case "number": return { type: "number", ...bounds(spec) };
      case "integer": return { type: "integer", ...bounds(spec) };
      case "boolean": return { type: "boolean" };
      case "string": return { type: "string" };
      case "enum": return { enum: spec.options ?? [] };
      case "sampler": return { anyOf: [{ type: "number", ...bounds(spec) }, { $ref: "#/definitions/distribution" }] };
      case "rateProfile": return { $ref: "#/definitions/rateProfile" };
      case "numberList": return { type: "array", minItems: 1, items: { type: "number", ...bounds(spec) } };
    }
  })();
  return { ...value, description: spec.description, ...(spec.default !== undefined ? { default: spec.default } : {}) };
}

/**
 * The model format as a JSON Schema (draft-07), for editor autocomplete, hover docs and inline errors.
 * It checks the shape of a model: fields, types, bounds, required inputs and links. Checks that span
 * fields (link targets exist and have the right role, uniform min <= max, output ids name real outputs)
 * stay in {@link loadModel}, which remains the authority.
 */
export function modelJsonSchema(registry: ComponentRegistry = createDefaultRegistry()): Json {
  const schemas = registry.schemas();
  const typesWithRole = (role: string) => schemas.filter((s) => s.roles.includes(role)).map((s) => s.type).join(", ");

  const components = schemas.map((s) => {
    // The loader falls back to the other input's default, so an omitted input triggers requiredWhen only when its default matches.
    const triggeredByDefault = (i: InputSpec) => i.requiredWhen !== undefined && s.inputs.find((o) => o.key === i.requiredWhen?.input)?.default === i.requiredWhen.equals;
    const conditional = s.inputs.flatMap((i) => i.requiredWhen ? [{
      if: { properties: { [i.requiredWhen.input]: { const: i.requiredWhen.equals } }, ...(triggeredByDefault(i) ? {} : { required: [i.requiredWhen.input] }) },
      then: { required: [i.key] },
    }] : []);
    const inputs: Json = {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(s.inputs.map((i) => [i.key, inputSchema(i)])),
      required: s.inputs.filter((i) => i.required).map((i) => i.key),
      ...(conditional.length > 0 ? { allOf: conditional } : {}),
    };
    const links: Json = {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(s.links.map((l) => {
        const desc = `${l.description} Target: ${typesWithRole(l.accepts) || `a component with role "${l.accepts}"`}.`;
        return [l.key, l.multiple
          ? { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" }, description: desc }
          : { type: "string", description: desc }];
      })),
      required: s.links.filter((l) => l.required).map((l) => l.key),
    };
    const required = [...(s.inputs.some((i) => i.required || triggeredByDefault(i)) ? ["inputs"] : []), ...(s.links.some((l) => l.required) ? ["links"] : [])];
    return {
      if: { properties: { type: { const: s.type } } },
      then: { properties: { inputs, links }, ...(required.length > 0 ? { required } : {}) },
    };
  });

  const distributions = DISTRIBUTION_NAMES.map((name) => {
    const params = DISTRIBUTION_PARAMS[name];
    const points = { type: "array", minItems: 2, items: pair({ type: "number", minimum: 0, maximum: 1 }, { type: "number" }), description: "[cumulative probability, value] pairs from probability 0 to 1." };
    return {
      if: { properties: { dist: { const: name } } },
      then: {
        additionalProperties: false,
        required: ["dist", ...params],
        properties: { dist: {}, ...Object.fromEntries(params.map((p) => [p, p === "points" ? points : { type: "number" }])) },
      },
    };
  });

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: MODEL_JSON_SCHEMA_URL,
    title: "Surgesim model",
    description: `A Surgesim model, format version ${MODEL_FORMAT_VERSION}. Times are in seconds and rates per second. See docs/model-format.md.`,
    type: "object",
    additionalProperties: false,
    required: ["version", "settings", "components"],
    properties: {
      $schema: { type: "string", description: "Schema location for editors; ignored by the engine." },
      version: { const: MODEL_FORMAT_VERSION, description: "Model format version." },
      name: { type: "string" },
      description: { type: "string" },
      settings: {
        type: "object",
        additionalProperties: false,
        required: ["duration"],
        properties: {
          duration: { type: "number", exclusiveMinimum: 0, description: "Total simulated seconds, including warm-up." },
          warmUp: { type: "number", minimum: 0, default: 0, description: "Statistics are reset at this time (seconds); must be less than duration." },
          seed: { type: "integer", minimum: 0, default: 1, description: "Base seed." },
          replications: { type: "integer", minimum: 1, default: 1, description: "Number of independent replications." },
          ticksPerSecond: { type: "integer", minimum: 1, default: 1_000_000, description: "Simulation resolution." },
          timeSeries: {
            type: "object",
            additionalProperties: false,
            required: ["interval", "outputs"],
            description: "Sample outputs over time.",
            properties: {
              interval: { type: "number", exclusiveMinimum: 0, description: "Sampling interval (seconds)." },
              outputs: { type: "array", minItems: 1, items: OUTPUT_ID },
            },
          },
        },
      },
      components: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "name"],
          properties: {
            type: { enum: registry.types(), description: "Component type." },
            name: { type: "string", minLength: 1, description: "Unique name; links and output ids refer to it." },
            inputs: { type: "object" },
            links: { type: "object", description: "Link key to target component name (or list of names)." },
            stream: { type: "string", description: "RNG stream id; defaults to the component name." },
          },
          allOf: components,
        },
      },
      assertions: {
        type: "array",
        description: "Thresholds checked after the run; the CLI exits non-zero if any fail.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["output", "op", "value"],
          properties: {
            output: OUTPUT_ID,
            op: { enum: [...ASSERTION_OPS] },
            value: { type: "number", description: "Threshold, in the output's own unit." },
            statistic: { enum: [...ASSERTION_STATISTICS], default: "mean", description: "Which number of the output to compare." },
            name: { type: "string", description: "Label shown in reports." },
          },
        },
      },
    },
    definitions: {
      distribution: {
        type: "object",
        required: ["dist"],
        properties: { dist: { enum: [...DISTRIBUTION_NAMES] } },
        allOf: distributions,
      },
      rateProfile: {
        type: "array",
        minItems: 1,
        items: pair({ type: "number", minimum: 0 }, { type: "number", minimum: 0 }),
        description: "[startSeconds, ratePerSecond] pairs with strictly increasing start times.",
      },
    },
  };
}
