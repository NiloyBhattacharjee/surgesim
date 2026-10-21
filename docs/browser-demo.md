# Browser demo

The demo is hosted at **https://niloybhattacharjee.github.io/surgesim/** (rebuilt by `.github/workflows/pages.yml` on
every push to `main`). To build it yourself:

```bash
pnpm demo:build      # writes apps/demo/dist/index.html
pnpm demo            # builds, then serves http://localhost:5173/
```

`apps/demo/dist/index.html` is **one self-contained file** (about 330 KB). The engine and the report renderer are
bundled and run in a **Web Worker** whose source is embedded in the page, so the file works when double-clicked
(`file://`), from any static host, or attached to an email. Nothing is fetched and nothing leaves the machine. It lets
you pick an example, edit the model, run it, and read the HTML report in place (with a download button). Add
`?run=1&example=Retry%20storm` to a link to open an example and run it immediately.

## Kubernetes tab

The **Kubernetes** tab takes pasted manifests (`kubectl get deploy,svc,hpa -o yaml` output, or multi-document YAML)
and an [overlay](importing.md#the-overlay-file) with the traffic, service times and calls the manifests cannot describe.
It opens with the [shop example](importing.md#example-will-the-hpa-keep-up). **Import and run** converts them with
`@surgesim/importer` on the page, loads the model into the editor (the picker then shows "Imported from Kubernetes"),
runs it and replays it on the diagram: each HPA shows its desired concurrency and each Deployment its busy request
slots against its current pods. The tab lists what was imported, what was ignored, and the importer's assumptions
and warnings. Manifest and overlay errors appear in the error list, overlay errors with their paths.

[`?tab=kubernetes&run=1`](https://niloybhattacharjee.github.io/surgesim/?tab=kubernetes&run=1) opens the tab and runs
the example straight away. Import happens on the page, so the worker still only ever sees model JSON and its bundle
is unchanged. The YAML parser makes the page about 70 KB larger, and the page bundle is minified to keep it there.

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

After a run, the diagram **replays** it: each node shows its current-value outputs (queue length, busy workers
against capacity, tokens, retries in flight) moving through simulated time, and the links flow while it plays. Use
the play button, the time slider and the speed menu to control it. The replay is replication 1 of the run you see in
the report (same seed, so the same trajectory), sampled 200 times and interpolated between samples. Queue-like gauges
are scaled to their own peak in the run; busy workers turn red at 90% of capacity. Editing the model clears the
replay, since it would no longer match. With "reduce motion" set in the OS, it does not start playing by itself.

The JSON stays the source of truth: every diagram edit rewrites it, and the **JSON** tab shows the result. Node
positions are not saved (the model format has no layout fields); the diagram lays a model out by flow depth when it
opens. The page bundles the engine's component schemas for the palette and inspector, and the importer with its YAML
parser for the Kubernetes tab, which is why it is larger than the worker alone.

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
