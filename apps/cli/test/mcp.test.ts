import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FileStore } from "@surgesim/platform";
import { handleMcpMessage, serveMcp } from "../src/mcp.js";

const mm1 = JSON.parse(readFileSync(new URL("../../../examples/mm1.json", import.meta.url), "utf8")) as {
  components: { name: string; inputs?: Record<string, unknown> }[];
};
const files: FileStore = {
  readText: async (path) => {
    if (path === "mm1.json") return JSON.stringify(mm1);
    throw new Error("file not found");
  },
  writeText: async () => {},
};
const host = { fs: files };

let id = 0;
const request = (method: string, params?: object) => handleMcpMessage({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }, host, "9.9.9");
const call = async (name: string, args: object) => {
  const r = (await request("tools/call", { name, arguments: args })) as { result: { content: { text: string }[]; isError?: boolean } };
  return { isError: r.result.isError === true, body: JSON.parse(r.result.content[0]!.text) };
};

describe("surgesim mcp", () => {
  it("speaks the protocol: initialize, notifications, ping, tools/list, errors", async () => {
    expect(await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).toMatchObject({
      id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "surgesim", version: "9.9.9" } },
    });
    expect(await request("initialize", { protocolVersion: "1999-01-01" })).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, host, "1")).toBeUndefined();
    expect(await request("ping")).toMatchObject({ result: {} });
    const list = (await request("tools/list")) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["schema", "validate", "run", "compare"]);
    expect(await request("nope")).toMatchObject({ error: { code: -32601 } });
    expect(await request("tools/call", { name: "nope" })).toMatchObject({ error: { code: -32602 } });

    const out: string[] = [];
    await serveMcp((async function* () { yield "not json"; yield ""; yield JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }); })(), (l) => out.push(l), host, "1");
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { jsonrpc: "2.0", id: 7, result: {} },
    ]);
  });

  it("schema, validate, run and compare give structured results", async () => {
    const schema = await call("schema", { type: "EntityGenerator" });
    expect(schema.body[0].inputs.map((i: { key: string }) => i.key)).toContain("dispersionIndex");
    expect((await call("schema", { type: "Nope" })).isError).toBe(true);

    expect((await call("validate", { model: "mm1.json" })).body).toEqual({ ok: true });
    const bad = await call("validate", { model: { version: 1, components: [{ type: "EntityGenerator", name: "g", inputs: { dispersionIndex: 0 } }] } });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ component: "g", key: "dispersionIndex" })]));
    expect((await call("run", { model: "missing.json" })).isError).toBe(true);

    const run = await call("run", { model: "mm1.json", replications: 3 });
    expect(run.isError).toBe(false);
    expect(run.body.settings.replications).toBe(3);
    const p99 = run.body.outputs.find((o: { id: string }) => o.id === "sink.p99");
    expect(p99.ci95.low).toBeLessThan(p99.mean);

    // The same model with servers twice as fast: latency must differ, by a paired test (same seeds)
    const faster = structuredClone(mm1);
    for (const c of faster.components) {
      const st = c.inputs?.["serviceTime"] as { mean?: number } | undefined;
      if (st?.mean !== undefined) st.mean /= 2;
    }
    const cmp = await call("compare", { a: "mm1.json", b: faster, replications: 5 });
    const mean = cmp.body.deltas.find((d: { id: string }) => d.id === "sink.mean");
    expect(mean).toMatchObject({ method: "paired", significant: true });
    expect(mean.b).toBeLessThan(mean.a);
    expect(cmp.body.differ).toContain(mean.id);
  });
});
