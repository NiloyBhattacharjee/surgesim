import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** Remove comments and the contents of string/template literals so the scan sees only code. */
function codeOnly(src: string): string {
  return stripComments(src)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

/** Import specifiers are strings, so these run on comment-stripped source with the strings intact. */
const FORBIDDEN_IMPORTS: [string, RegExp][] = [
  ["a node: import", /(?:from|import)\s*\(?\s*["']node:/],
  ["an import of a Node built-in", /(?:from|import)\s*\(?\s*["'](?:fs|path|os|crypto|child_process|http|https|net|url|util|stream|worker_threads|perf_hooks)(?:\/[^"']*)?["']/],
  ["require()", /\brequire\s*\(/],
];

/** Node-only and DOM-only globals, checked on code with comments and string contents removed. */
const FORBIDDEN: [string, RegExp][] = [
  ["process", /\bprocess\./],
  ["Buffer", /\bBuffer\b/],
  ["__dirname/__filename", /\b__(?:dirname|filename)\b/],
  ["the DOM (window/document)", /\b(?:window|document)\b\s*[.[]/],
  ["localStorage/sessionStorage", /\b(?:localStorage|sessionStorage)\b/],
  ["fetch / XMLHttpRequest", /\b(?:fetch|XMLHttpRequest)\b\s*[(]/],
  ["timers (use the kernel)", /\b(?:setTimeout|setInterval|setImmediate)\s*\(/],
  ["wall clock (hosts supply a Clock)", /\b(?:performance\.now|Date\.now|new Date)\b/],
  ["Math.random (use the seeded Rng)", /\bMath\.random\b/],
];

/** Everything wrong with one source file. `engineRules` adds the clock and randomness bans. */
function violationsIn(src: string, engineRules: boolean): string[] {
  const out: string[] = [];
  const noComments = stripComments(src);
  for (const [what, re] of FORBIDDEN_IMPORTS) if (re.test(noComments)) out.push(what);
  const code = codeOnly(src);
  for (const [what, re] of FORBIDDEN) {
    if (!engineRules && (what.startsWith("wall clock") || what.startsWith("Math.random"))) continue;
    if (re.test(code)) out.push(what);
  }
  return out;
}

describe("the scanner itself", () => {
  it("catches real violations", () => {
    expect(violationsIn('import { readFile } from "node:fs";', true)).toEqual(["a node: import"]);
    expect(violationsIn('import { readFile } from "fs/promises";', true)).toEqual(["an import of a Node built-in"]);
    expect(violationsIn('const m = await import("node:path");', true)).toEqual(["a node: import"]);
    expect(violationsIn('const fs = require("fs");', true)).toEqual(["require()"]);
    expect(violationsIn("const e = process.env.HOME;", true)).toEqual(["process"]);
    expect(violationsIn("document.title = x;", true)).toEqual(["the DOM (window/document)"]);
    expect(violationsIn("const t = Date.now();", true)).toEqual(["wall clock (hosts supply a Clock)"]);
    expect(violationsIn("const r = Math.random();", true)).toEqual(["Math.random (use the seeded Rng)"]);
    expect(violationsIn("setTimeout(f, 1);", true)).toEqual(["timers (use the kernel)"]);
  });

  it("only applies the clock and randomness bans to the engine", () => {
    expect(violationsIn("const t = Date.now();", false)).toEqual([]);
  });

  it("ignores mentions in comments and strings", () => {
    expect(violationsIn("// uses process.env and Date.now()\nconst a = 1;", true)).toEqual([]);
    expect(violationsIn('/* document.title */ const s = "window.location and Math.random()";', true)).toEqual([]);
    expect(violationsIn("const html = `<script>document.title = 1</script>`;", true)).toEqual([]);
    expect(violationsIn('// import x from "node:fs"\nconst a = 1;', true)).toEqual([]);
  });
});

/**
 * The packages that must stay embeddable in a Web Worker (and a browser, for report/sdk/importer).
 * The engine additionally must not read the clock or use unseeded randomness: simulation time and
 * randomness come only from the kernel and the seeded generator.
 */
const PACKAGES = ["engine", "sdk", "report", "importer"];

describe("embeddable packages use no Node or DOM APIs", () => {
  for (const pkg of PACKAGES) {
    const files = sourceFiles(join(root, "packages", pkg, "src"));
    it(`@chronon-sim/${pkg} (${files.length} files)`, () => {
      expect(files.length).toBeGreaterThan(0);
      const violations: string[] = [];
      for (const file of files) {
        for (const what of violationsIn(readFileSync(file, "utf8"), pkg === "engine")) {
          violations.push(`${relative(root, file)} uses ${what}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }

  it("the engine has no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "packages/engine/package.json"), "utf8")) as { dependencies?: object };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it("the engine compiles against no Node or DOM type definitions", () => {
    const tsconfig = JSON.parse(readFileSync(join(root, "packages/engine/tsconfig.json"), "utf8")) as { compilerOptions: { lib: string[]; types: string[] } };
    expect(tsconfig.compilerOptions.types).toEqual([]);
    expect(tsconfig.compilerOptions.lib).toEqual(["ES2022"]);
  });

  it("the platform package is interfaces only (no runtime code)", () => {
    const code = codeOnly(readFileSync(join(root, "packages/platform/src/index.ts"), "utf8"));
    expect(code).not.toMatch(/\bclass\b|\bfunction\b|=>|\bconst\b|\blet\b/);
  });
});
