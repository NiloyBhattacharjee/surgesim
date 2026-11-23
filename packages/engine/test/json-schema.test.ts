import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { loadModel, modelJsonSchema } from "../src/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const schema = modelJsonSchema();
const validate = new Ajv({ allErrors: true }).compile(schema);

const exampleModels = ["examples", "examples/calibration", "examples/stress"].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".json") && f !== "observed.json")
    .map((f) => [`${dir}/${f}`, JSON.parse(readFileSync(join(root, dir, f), "utf8"))] as const),
);

const valid = (components: unknown[], extra: object = {}) =>
  validate({ version: 1, settings: { duration: 10 }, components, ...extra });

describe("model JSON Schema", () => {
  it("matches the committed docs/model.schema.json", () => {
    // Regenerate with: pnpm build && node apps/cli/dist/bin.js schema --json-schema > docs/model.schema.json
    expect(JSON.parse(readFileSync(join(root, "docs/model.schema.json"), "utf8"))).toEqual(schema);
  });

  it.each(exampleModels)("accepts %s, which the loader also accepts", (_, model) => {
    expect(loadModel(model).ok).toBe(true);
    expect(validate(model), JSON.stringify(validate.errors)).toBe(true);
  });

  it("covers the examples", () => expect(exampleModels.length).toBeGreaterThanOrEqual(15));

  it("rejects what the loader rejects on shape alone", () => {
    const sink = { type: "EntitySink", name: "sink" };
    expect(valid([sink])).toBe(true);
    expect(valid([{ type: "Sinkk", name: "s" }])).toBe(false); // unknown type
    expect(valid([{ ...sink, inputz: {} }])).toBe(false); // unknown component field
    expect(valid([{ type: "Queue", name: "q", inputs: { maxLenght: 5 } }])).toBe(false); // misspelled input
    expect(valid([{ type: "Server", name: "s", inputs: { capacity: 1 } }])).toBe(false); // missing serviceTime and links
    expect(valid([{ type: "Server", name: "s", inputs: { capacity: 0, serviceTime: 1 }, links: { queue: "q", next: "sink" } }])).toBe(false); // below min
    expect(valid([sink], { settings: {} })).toBe(false); // missing duration
    expect(valid([sink], { assertions: [{ output: "sink.p99", op: "=<", value: 2 }] })).toBe(false);
  });

  it("checks distributions by their dist", () => {
    const server = (serviceTime: unknown) => valid([{ type: "Server", name: "s", inputs: { serviceTime }, links: { queue: "q", next: "k" } }]);
    expect(server({ dist: "exponential", mean: 1 })).toBe(true);
    expect(server({ dist: "exponential", mu: 1 })).toBe(false);
    expect(server({ dist: "uniform", min: 1 })).toBe(false);
    expect(server({ dist: "empirical", points: [[0, 1], [1, 2]] })).toBe(true);
    expect(server({ dist: "gamma", mean: 1 })).toBe(false);
  });

  it("requires an input only when the input it depends on has the triggering value", () => {
    const gen = (inputs: object) => valid([{ type: "EntityGenerator", name: "g", inputs, links: { next: "k" } }]);
    // mode defaults to "interval", so omitting it (or all inputs) still requires interArrivalTime.
    expect(valid([{ type: "EntityGenerator", name: "g", links: { next: "k" } }])).toBe(false);
    expect(gen({})).toBe(false);
    expect(gen({ interArrivalTime: 1 })).toBe(true);
    expect(gen({ mode: "rateProfile" })).toBe(false);
    expect(gen({ mode: "rateProfile", rateProfile: [[0, 5]] })).toBe(true);
  });
});
