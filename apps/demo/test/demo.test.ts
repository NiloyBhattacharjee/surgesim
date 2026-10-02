import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error build.mjs is plain JavaScript (no declarations); it is the same script `pnpm build` runs
import { buildDemo } from "../build.mjs";
import { handleRun, type RunResponse } from "../src/handler.js";

const exampleJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../../../examples/${file}`, import.meta.url)), "utf8"));

describe("handleRun (the worker's logic)", () => {
  it("validates, runs and renders a report", async () => {
    const r = handleRun({ json: await exampleJson("autoscaled-service.json"), replications: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replications).toBe(2);
    expect(r.assertionsTotal).toBe(3);
    expect(r.assertionsFailed).toBe(0);
    expect(r.eventsProcessed).toBeGreaterThan(10_000);
    expect(r.html.startsWith("<!doctype html>")).toBe(true);
  });

  it("reports every validation error, structured, instead of throwing", () => {
    const r = handleRun({ json: { version: 1, settings: {}, components: [{ type: "WorkerPool", name: "p" }] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
    expect(r.errors.every((e) => typeof e.message === "string" && "component" in e && "key" in e)).toBe(true);
  });

  it("returns an error (not an exception) for non-model input", () => {
    for (const json of [null, 5, "x", []]) expect(handleRun({ json }).ok).toBe(false);
  });

  it("seed and replications overrides take effect", async () => {
    const json = await exampleJson("mm1.json");
    const a = handleRun({ json, replications: 1, seed: 1 });
    const b = handleRun({ json, replications: 1, seed: 2 });
    expect(a.ok && b.ok && a.html !== b.html).toBe(true);
  });
});

describe("the built demo", () => {
  let dir: string;
  let built: { htmlPath: string; workerSource: string; html: string };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "surgesim-demo-"));
    built = await buildDemo({ outDir: dir });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is one self-contained HTML file: nothing is fetched from anywhere", () => {
    const html = built.html;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]*\bsrc=/i);
    expect(html).not.toMatch(/\bimport\s*\(|\bfetch\s*\(/); // no dynamic loading, no network
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    // One real script element. The worker source is embedded as a string inside it, so nothing in there may
    // contain a closing script tag (that would end the element early); the build escapes them.
    const start = html.indexOf("<script>");
    const end = html.lastIndexOf("</script>");
    expect(start).toBeGreaterThan(-1);
    expect(html.slice(start + "<script>".length, end)).not.toMatch(/<\/script/i);
    expect(html.slice(0, start) + html.slice(end + "</script>".length)).not.toMatch(/<script/i);
  });

  it("embeds every example model", () => {
    for (const name of ["Autoscaled service", "Traffic spike", "SQS visibility timeout", "Serverless cold starts", "Retry storm", "M/M/1"]) {
      expect(built.html).toContain(name);
    }
  });

  it("the worker bundle runs with NO Node or DOM globals: only ECMAScript built-ins", async () => {
    // A fresh context has Math, JSON, Date, Map... but no process, require, Buffer, window, document, timers.
    const out: unknown[] = [];
    const context = vm.createContext({ __out: out });
    vm.runInContext("var self = { onmessage: null, postMessage: function (m) { __out.push(m); } };", context);
    const present = vm.runInContext(
      "['process','require','module','Buffer','window','document','navigator','setTimeout','fetch','XMLHttpRequest','localStorage'].filter(function (n) { return typeof globalThis[n] !== 'undefined'; })",
      context,
    ) as string[];
    expect(present).toEqual([]); // the sandbox really is bare

    vm.runInContext(built.workerSource, context);
    const model = await exampleJson("traffic-spike.json");
    vm.runInContext(`self.onmessage({ data: ${JSON.stringify({ json: model, replications: 2 })} })`, context);

    expect(out).toHaveLength(1);
    const reply = out[0] as RunResponse & { elapsedMs: number };
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(typeof reply.elapsedMs).toBe("number");

    // The same model run in Node gives the *same bytes*: results do not depend on the host.
    const inNode = handleRun({ json: model, replications: 2 });
    expect(inNode.ok).toBe(true);
    if (!inNode.ok) return;
    expect(reply.html).toBe(inNode.html);
    expect(reply.eventsProcessed).toBe(inNode.eventsProcessed);
  }, 60_000);

  it("the worker answers a bad model with errors, in the sandbox too", () => {
    const out: unknown[] = [];
    const context = vm.createContext({ __out: out });
    vm.runInContext("var self = { onmessage: null, postMessage: function (m) { __out.push(m); } };", context);
    vm.runInContext(built.workerSource, context);
    vm.runInContext(`self.onmessage({ data: { json: { version: 7 } } })`, context);
    const reply = out[0] as RunResponse;
    expect(reply.ok).toBe(false);
  });
});
