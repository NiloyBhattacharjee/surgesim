# Browser demo

The demo is hosted at **https://niloybhattacharjee.github.io/surgesim/** (rebuilt by `.github/workflows/pages.yml` on
every push to `main`). To build it yourself:

```bash
pnpm demo:build      # writes apps/demo/dist/index.html
pnpm demo            # builds, then serves http://localhost:5173/
```

`apps/demo/dist/index.html` is **one self-contained file** (about 130 KB). The engine and the report renderer are
bundled and run in a **Web Worker** whose source is embedded in the page, so the file works when double-clicked
(`file://`), from any static host, or attached to an email. Nothing is fetched and nothing leaves the machine. It lets
you pick an example, edit the model JSON, run it, and read the HTML report in place (with a download button). Add
`?run=1&example=Retry%20storm` to a link to open an example and run it immediately.

## Why this is a real test of embeddability

The engine is specified to use no Node and no DOM APIs. That is enforced three ways:

1. **At compile time**: `packages/engine/tsconfig.json` has `lib: ["ES2022"]` and `types: []`, so `process`, `fs`,
   `window` and `document` do not exist as far as the compiler is concerned.
2. **By a static scan** (`apps/demo/test/purity.test.ts`) of the engine, SDK, report and importer sources for Node imports,
   `process`, `Buffer`, the DOM, timers, `fetch`, and (for the engine) the wall clock and `Math.random`. The scanner has
   its own tests proving it catches each kind of violation.
3. **By running the worker bundle in a bare JavaScript context** (`apps/demo/test/demo.test.ts`): a `node:vm` context
   with only ECMAScript built-ins (no `process`, `require`, `Buffer`, `window`, `document`, timers or `fetch`). The same
   model run there and in Node yields **byte-identical** report HTML, so results do not depend on the host.

The page was also exercised in real Chrome from a `file://` URL (worker run, report rendered in the iframe).
