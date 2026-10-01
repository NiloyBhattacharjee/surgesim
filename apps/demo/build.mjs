// Builds the demo into one self-contained HTML file: the engine and report renderer run in a Web
// Worker whose source is embedded in the page, so the file works when double-clicked (file://),
// from any static host, or attached to an email. Sources are bundled directly (no tsc step needed).
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = (name) => resolve(here, "../../packages", name, "src/index.ts");
const alias = {
  "@chronon-sim/engine": pkg("engine"),
  "@chronon-sim/report": pkg("report"),
};
const common = { bundle: true, format: "iife", platform: "neutral", mainFields: ["module", "main"], target: "es2022", write: false, legalComments: "none", alias, logLevel: "silent" };

/** Build the demo. Returns the worker source (for tests) and the path of the page. */
export async function buildDemo({ outDir = join(here, "dist") } = {}) {
  const worker = await build({ ...common, entryPoints: [join(here, "src/worker.ts")] });
  const workerSource = worker.outputFiles[0].text;
  const page = await build({
    ...common,
    platform: "browser",
    entryPoints: [join(here, "src/page.ts")],
    define: { __WORKER_SOURCE__: JSON.stringify(workerSource) },
  });
  const pageJs = page.outputFiles[0].text.replace(/<\/script/gi, "<\/script");
  const template = await readFile(join(here, "src/index.template.html"), "utf8");
  const html = template.replace("/*PAGE_JS*/", () => pageJs);
  await mkdir(outDir, { recursive: true });
  const htmlPath = join(outDir, "index.html");
  await writeFile(htmlPath, html, "utf8");
  return { htmlPath, workerSource, html };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { htmlPath, html } = await buildDemo();
  console.log(`Built ${htmlPath} (${(html.length / 1024).toFixed(0)} KB, self-contained)`);
}
