# Browser demo

The demo is hosted at **https://niloybhattacharjee.github.io/surgesim/** (rebuilt by `.github/workflows/pages.yml` on
every push to `main`). To build it yourself:

```bash
pnpm demo:build      # writes apps/demo/dist/index.html
pnpm demo            # builds, then serves http://localhost:5173/
```

`apps/demo/dist/index.html` is **one self-contained file** (about 230 KB). The engine and the report renderer are
bundled and run in a **Web Worker** whose source is embedded in the page, so the file works when double-clicked
(`file://`), from any static host, or attached to an email. Nothing is fetched and nothing leaves the machine. It lets
you pick an example, edit the model, run it, and read the HTML report in place (with a download button). Add
`?run=1&example=Retry%20storm` to a link to open an example and run it immediately.

## Diagram editor

The **Diagram** tab is a drag-and-drop editor for the same model (pick **Blank** to start from scratch):

- Drag a component type from the palette onto the canvas, or click it to add one below the others. New components
  get starter values for their required inputs, so they validate as soon as they are linked.
- Drag a node to move it (it snaps to the grid); **Tidy up** lays everything out along the flow again. Drag from a
  port (●) to set that link: the components it may connect to light up and the rest fade, and dropping on empty
  space clears it. Dashed lines are pull links (`queue`), which point against the flow.
- Click a node to edit its name, inputs and links (link menus offer only valid targets). **Delete** removes the
  selected component and **Esc** deselects it. Renaming or deleting a component also updates the links, time series
  and assertions that refer to it.
- The model is validated as you edit, with the same checks **Run** applies: the bar above the canvas says
  "Ready to run" or how many problems there are (hover for the list), and components and ports with a problem are
  marked in red.

The JSON stays the source of truth: every diagram edit rewrites it, and the **JSON** tab shows the result. Node
positions are not saved (the model format has no layout fields); the diagram lays a model out by flow depth when it
opens. The page bundles the engine's component schemas for the palette and inspector, which is why it is larger than
the worker alone.

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
