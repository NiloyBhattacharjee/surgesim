/**
 * Unit categories. All time quantities in the JSON format are seconds and all rates are per second,
 * regardless of the model's tick resolution. `cost` is an abstract currency amount (whatever unit
 * the model's prices use).
 */
export type UnitCategory = "time" | "rate" | "cost" | "dimensionless";

/** The kinds of values a component input can take. */
export type InputType =
  | "number" // a finite constant
  | "integer" // a constant integer
  | "boolean"
  | "string"
  | "enum" // one of `options`
  | "sampler" // a constant or a distribution spec, resolved to a SampleProvider
  | "rateProfile"; // [[startSeconds, ratePerSecond], ...]

/** Declares one input of a component. Pure data. */
export interface InputSpec {
  key: string;
  type: InputType;
  unit: UnitCategory;
  description: string;
  required: boolean;
  /** Value used when the input is omitted. Ignored when `required` or `requiredWhen` applies. */
  default?: unknown;
  /** Inclusive lower bound (number, integer, and constant samplers). */
  min?: number;
  /** Inclusive upper bound (number, integer, and constant samplers). */
  max?: number;
  /** Allowed values when `type` is "enum". */
  options?: readonly string[];
  /** Input is additionally required when another input has the given value. */
  requiredWhen?: { input: string; equals: unknown };
}

/** Declares one output (statistic) of a component. Pure data except for the getter. */
export interface OutputSpec<T = any> {
  key: string;
  unit: UnitCategory;
  description: string;
  /** Include in the default time series (current-value outputs such as QueueLength). */
  series?: boolean;
  /** Read the value from a live component. Return NaN when undefined (e.g. no observations). */
  get(component: T): number;
}

/** Declares a link from one component to another. Pure data. */
export interface LinkSpec {
  key: string;
  description: string;
  required: boolean;
  /** Role the target component must have (see {@link ComponentSchema.roles}). */
  accepts: string;
}

/** The schema of a component class: its inputs, links and outputs. */
export interface ComponentSchema<T = any> {
  /** Component type name used in model files, e.g. "Queue". */
  type: string;
  description: string;
  /** Roles this component plays, matched against `LinkSpec.accepts` (e.g. "receiver", "queue"). */
  roles: readonly string[];
  inputs: readonly InputSpec[];
  links: readonly LinkSpec[];
  outputs: readonly OutputSpec<T>[];
}

/** A structured validation problem. Never a thrown string. */
export interface ValidationError {
  /** Component name, or null for model-level problems. */
  component: string | null;
  /** Input/link/setting key the problem is about, or null if it concerns the component as a whole. */
  key: string | null;
  message: string;
}

/** A schema with the getters stripped: plain JSON, e.g. for SDK type or documentation generation. */
export interface SchemaDescription {
  type: string;
  description: string;
  roles: readonly string[];
  inputs: readonly InputSpec[];
  links: readonly LinkSpec[];
  outputs: readonly { key: string; unit: UnitCategory; description: string; series?: boolean }[];
}

/** Convert a schema to plain, JSON-serialisable data. */
export function describeSchema(schema: ComponentSchema): SchemaDescription {
  return {
    type: schema.type,
    description: schema.description,
    roles: schema.roles,
    inputs: schema.inputs,
    links: schema.links,
    outputs: schema.outputs.map((o) => {
      const d: SchemaDescription["outputs"][number] = {
        key: o.key,
        unit: o.unit,
        description: o.description,
      };
      return o.series ? { ...d, series: true } : d;
    }),
  };
}
