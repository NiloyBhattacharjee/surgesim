import { createDefaultRegistry, describeSchema, loadModel, runModel, type RunResults } from "@surgesim/engine";
import { computeDeltas } from "@surgesim/report";
import { readModelSource, type SourceHost } from "./source.js";

// `surgesim mcp`: the Model Context Protocol over stdio (newline-delimited JSON-RPC 2.0), so an agent can read the
// schemas, validate, run and compare models without a shell.
// ponytail: hand-rolled tools-only server; move to @modelcontextprotocol/sdk if we need resources, prompts or HTTP.

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const MODEL = {
  type: ["object", "string"],
  description: 'A model in the JSON format (docs/model-format.md), or a path to a .json model or a .js/.ts module built with @surgesim/sdk.',
};
const OVERRIDES = {
  seed: { type: "integer", minimum: 0, description: "Override the model's base seed." },
  replications: { type: "integer", minimum: 1, description: "Override the number of replications (2+ for confidence intervals)." },
};

const TOOLS = [
  {
    name: "schema",
    description: "The component types a model can use: inputs (with units and bounds), links, roles and outputs. Read this before writing a model.",
    inputSchema: { type: "object", properties: { type: { type: "string", description: "Only this component type, e.g. WorkerPool." } } },
  },
  {
    name: "validate",
    description: "Check a model against the format and component schemas. Returns structured errors (component, key, message).",
    inputSchema: { type: "object", properties: { model: MODEL }, required: ["model"] },
  },
  {
    name: "run",
    description: "Run a model. Returns every output's mean and 95% confidence interval across replications, and assertion results. Outputs are in seconds and per-second.",
    inputSchema: { type: "object", properties: { model: MODEL, ...OVERRIDES }, required: ["model"] },
  },
  {
    name: "compare",
    description:
      'Run two models and report which outputs differ. "Differs" is a t-test on per-replication values (paired when both use the same seeds), Benjamini-Hochberg adjusted, p < 0.05; it needs 2+ replications. significant null means untestable, not "no difference".',
    inputSchema: { type: "object", properties: { a: MODEL, b: MODEL, ...OVERRIDES }, required: ["a", "b"] },
  },
];

type Args = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

class ToolError extends Error {}

const reply = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

async function modelJson(value: unknown, host: SourceHost): Promise<unknown> {
  if (typeof value !== "string") return value;
  const source = await readModelSource(value, host);
  if (!source.ok) throw new ToolError(source.message);
  return source.json;
}

async function results(value: unknown, args: Args, host: SourceHost): Promise<RunResults> {
  const loaded = loadModel(await modelJson(value, host));
  if (!loaded.ok) throw new ToolError(`invalid model:\n${JSON.stringify(loaded.errors, null, 2)}`);
  const overrides = {
    ...(Number.isInteger(args["seed"]) ? { seed: args["seed"] as number } : {}),
    ...(Number.isInteger(args["replications"]) ? { replications: args["replications"] as number } : {}),
  };
  try {
    return runModel(loaded.model, overrides);
  } catch (e) {
    throw new ToolError(`the simulation could not finish: ${(e as Error).message}`);
  }
}

async function callTool(name: string, args: Args, host: SourceHost): Promise<ToolResult> {
  try {
    switch (name) {
      case "schema": {
        const all = createDefaultRegistry().schemas().map(describeSchema);
        const picked = typeof args["type"] === "string" ? all.filter((s) => s.type === args["type"]) : all;
        if (picked.length === 0) throw new ToolError(`unknown component type "${String(args["type"])}" (known: ${all.map((s) => s.type).join(", ")})`);
        return reply(picked);
      }
      case "validate": {
        const loaded = loadModel(await modelJson(args["model"], host));
        return reply(loaded.ok ? { ok: true } : { ok: false, errors: loaded.errors });
      }
      case "run": {
        const r = await results(args["model"], args, host);
        const outputs = r.outputs.map((o) => ({ id: o.id, unit: o.unit, n: o.n, mean: o.mean, ci95: o.ci95 && { low: o.ci95.low, high: o.ci95.high } }));
        return reply({ settings: r.settings, outputs, ...(r.assertions ? { assertions: r.assertions } : {}) }, r.assertions?.some((a) => !a.passed) ?? false);
      }
      case "compare": {
        const a = await results(args["a"], args, host);
        const b = await results(args["b"], args, host);
        const { deltas, onlyA, onlyB } = computeDeltas(a, b);
        const rows = deltas.map((d) => ({
          id: d.id,
          a: d.a.mean,
          b: d.b.mean,
          pct: d.pct,
          diffCi95: d.diffCi95,
          method: d.method,
          adjustedPValue: d.adjustedPValue,
          significant: d.significant,
        }));
        return reply({ differ: rows.filter((d) => d.significant === true).map((d) => d.id), deltas: rows, onlyA, onlyB });
      }
    }
  } catch (e) {
    if (e instanceof ToolError) return reply({ error: e.message }, true);
    throw e;
  }
  throw new Error(`unknown tool "${name}"`);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Answer one JSON-RPC message. Returns the response, or undefined for a notification. */
export async function handleMcpMessage(message: unknown, host: SourceHost, version: string): Promise<object | undefined> {
  if (!isRecord(message) || message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string") {
    return { jsonrpc: "2.0", id: isRecord(message) ? (message["id"] ?? null) : null, error: { code: -32600, message: "invalid request" } };
  }
  const { id, method } = message;
  if (id === undefined) return undefined; // notifications (initialized, cancelled) need no answer
  const params = isRecord(message["params"]) ? message["params"] : {};
  const ok = (result: object) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize": {
      const asked = params["protocolVersion"];
      return ok({
        protocolVersion: typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "surgesim", version },
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(params["name"]);
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool "${name}"`);
      try {
        return ok(await callTool(name, isRecord(params["arguments"]) ? params["arguments"] : {}, host));
      } catch (e) {
        return fail(-32603, `internal error: ${(e as Error).message}`);
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

/** Serve MCP over newline-delimited JSON lines until the input ends. Nothing else may be written to `write`'s stream. */
export async function serveMcp(lines: AsyncIterable<string>, write: (line: string) => void, host: SourceHost, version: string): Promise<void> {
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      continue;
    }
    const response = await handleMcpMessage(message, host, version);
    if (response !== undefined) write(JSON.stringify(response));
  }
}
