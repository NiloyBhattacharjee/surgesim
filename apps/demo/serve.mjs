// Serves apps/demo/dist on http://localhost:5173 (optional: dist/index.html also works from file://).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "dist");
const port = Number(process.env.PORT ?? 5173);
createServer(async (req, res) => {
  try {
    const body = await readFile(join(root, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(500).end("run `pnpm --filter @chronon-sim/demo build` first");
  }
}).listen(port, () => console.log(`Chronon Sim demo: http://localhost:${port}/`));
