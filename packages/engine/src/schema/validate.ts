import { validateSamplerSpec, type SamplerSpec } from "../rng/index.js";
import type { ComponentSchema, InputSpec, ValidationError } from "./types.js";

/** One piecewise-constant segment of a rate profile: from `start` seconds, `rate` arrivals/second. */
export type RateSegment = readonly [startSeconds: number, ratePerSecond: number];

/** Result of {@link validateInputs}: normalised values (defaults applied) plus all errors found. */
export interface InputValidation {
  values: Record<string, unknown>;
  errors: ValidationError[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkBounds(spec: InputSpec, v: number): string | null {
  if (spec.min !== undefined && v < spec.min) return `must be >= ${spec.min}`;
  if (spec.max !== undefined && v > spec.max) return `must be <= ${spec.max}`;
  return null;
}

/** Check one raw value against its input spec. Returns an error message or null. */
function checkValue(spec: InputSpec, v: unknown): string | null {
  switch (spec.type) {
    case "number": {
      if (!finite(v)) return "must be a finite number";
      return checkBounds(spec, v);
    }
    case "integer": {
      if (!finite(v) || !Number.isInteger(v)) return "must be an integer";
      return checkBounds(spec, v);
    }
    case "boolean":
      return typeof v === "boolean" ? null : "must be true or false";
    case "string":
      return typeof v === "string" ? null : "must be a string";
    case "enum":
      return typeof v === "string" && (spec.options ?? []).includes(v)
        ? null
        : `must be one of ${(spec.options ?? []).map((o) => JSON.stringify(o)).join(", ")}`;
    case "sampler": {
      const problems = validateSamplerSpec(v);
      if (problems.length > 0) return problems.join("; ");
      if (finite(v)) return checkBounds(spec, v);
      const c = v as { dist?: string; value?: number };
      if (c.dist === "constant" && typeof c.value === "number") return checkBounds(spec, c.value);
      return null;
    }
    case "rateProfile": {
      if (!Array.isArray(v) || v.length === 0) {
        return "must be a non-empty array of [startSeconds, ratePerSecond] pairs";
      }
      let prev = -Infinity;
      for (let i = 0; i < v.length; i++) {
        const seg: unknown = v[i];
        if (!Array.isArray(seg) || seg.length !== 2 || !finite(seg[0]) || !finite(seg[1])) {
          return `segment ${i} must be a [startSeconds, ratePerSecond] pair of numbers`;
        }
        if (seg[0] < 0) return `segment ${i}: startSeconds must be >= 0`;
        if (seg[1] < 0) return `segment ${i}: ratePerSecond must be >= 0`;
        if (seg[0] <= prev) return `segment ${i}: startSeconds must be strictly increasing`;
        prev = seg[0];
      }
      return null;
    }
  }
}

/**
 * Validate a component's raw `inputs` object against its schema, applying defaults.
 * Collects every problem rather than stopping at the first.
 */
export function validateInputs(
  schema: ComponentSchema,
  raw: unknown,
  componentName: string,
): InputValidation {
  const errors: ValidationError[] = [];
  const values: Record<string, unknown> = {};
  const err = (key: string | null, message: string) =>
    errors.push({ component: componentName, key, message });

  if (raw !== undefined && !isRecord(raw)) {
    err("inputs", "must be an object");
    return { values, errors };
  }
  const given = (raw ?? {}) as Record<string, unknown>;
  const known = new Set(schema.inputs.map((i) => i.key));
  for (const key of Object.keys(given)) {
    if (!known.has(key)) {
      err(key, `unknown input for ${schema.type} (known inputs: ${[...known].join(", ")})`);
    }
  }

  for (const spec of schema.inputs) {
    const v = given[spec.key];
    if (v === undefined || v === null) {
      const conditional =
        spec.requiredWhen !== undefined &&
        (given[spec.requiredWhen.input] ?? schema.inputs.find((i) => i.key === spec.requiredWhen!.input)?.default) ===
          spec.requiredWhen.equals;
      if (spec.required || conditional) {
        err(
          spec.key,
          conditional && !spec.required
            ? `required when ${spec.requiredWhen!.input} is ${JSON.stringify(spec.requiredWhen!.equals)}`
            : "required input is missing",
        );
      } else if (spec.default !== undefined) {
        values[spec.key] = spec.default;
      }
      continue;
    }
    const problem = checkValue(spec, v);
    if (problem) err(spec.key, problem);
    else values[spec.key] = v;
  }
  return { values, errors };
}

/** Narrow a validated sampler input. */
export function asSampler(v: unknown): SamplerSpec {
  return v as SamplerSpec;
}

/** Narrow a validated rate profile input. */
export function asRateProfile(v: unknown): RateSegment[] {
  return v as RateSegment[];
}
