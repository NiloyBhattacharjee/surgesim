import { describe, expect, it } from "vitest";
import { describeSchema, validateInputs, type ComponentSchema } from "../src/index.js";

const schema: ComponentSchema = {
  type: "Demo",
  description: "demo",
  roles: [],
  links: [],
  inputs: [
    { key: "rate", type: "sampler", unit: "rate", description: "r", required: true, min: 0 },
    { key: "cap", type: "integer", unit: "dimensionless", description: "c", required: false, default: 1, min: 1 },
    { key: "mode", type: "enum", unit: "dimensionless", description: "m", required: false, default: "a", options: ["a", "b"] },
    { key: "extra", type: "number", unit: "time", description: "e", required: false, requiredWhen: { input: "mode", equals: "b" } },
    { key: "profile", type: "rateProfile", unit: "rate", description: "p", required: false },
  ],
  outputs: [{ key: "X", unit: "dimensionless", description: "x", get: () => 1 }],
};

describe("validateInputs", () => {
  it("applies defaults and accepts valid inputs", () => {
    const r = validateInputs(schema, { rate: { dist: "exponential", mean: 2 } }, "d");
    expect(r.errors).toEqual([]);
    expect(r.values).toMatchObject({ cap: 1, mode: "a", rate: { dist: "exponential", mean: 2 } });
  });

  it("returns every error as structured data", () => {
    const r = validateInputs(schema, { cap: 0.5, mode: "z", bogus: 1, profile: [[5, 1], [3, 1]] }, "d");
    const keys = r.errors.map((e) => e.key).sort();
    expect(keys).toEqual(["bogus", "cap", "mode", "profile", "rate"]);
    for (const e of r.errors) {
      expect(e.component).toBe("d");
      expect(typeof e.message).toBe("string");
    }
  });

  it("enforces bounds, including on constant distributions", () => {
    expect(validateInputs(schema, { rate: -1 }, "d").errors).toHaveLength(1);
    expect(validateInputs(schema, { rate: { dist: "constant", value: -1 } }, "d").errors).toHaveLength(1);
    expect(validateInputs(schema, { rate: 1, cap: 0 }, "d").errors).toHaveLength(1);
  });

  it("supports conditionally required inputs", () => {
    expect(validateInputs(schema, { rate: 1, mode: "b" }, "d").errors.map((e) => e.key)).toEqual(["extra"]);
    expect(validateInputs(schema, { rate: 1, mode: "b", extra: 3 }, "d").errors).toEqual([]);
  });

  it("rejects non-object inputs", () => {
    expect(validateInputs(schema, [1], "d").errors[0]?.key).toBe("inputs");
  });
});

describe("describeSchema", () => {
  it("strips getters and is JSON-serialisable", () => {
    const d = describeSchema(schema);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(d.outputs[0]).toEqual({ key: "X", unit: "dimensionless", description: "x" });
  });
});
