# @surgesim/engine

The simulation engine behind Surgesim. It runs in Node and in a Web Worker: no DOM or Node APIs and no runtime
dependencies.

```ts
import { loadModel, runModel } from "@surgesim/engine";

const loaded = loadModel(modelJson);          // validates; returns every error at once
if (loaded.ok) {
  const results = runModel(loaded.model);     // replications, confidence intervals, time series, assertions
  // `outputs` is an array with one summary per component output, not an object keyed by name:
  // { id: "sink.p99", component, key, unit, n, mean, stdDev, ci95 }. Find one by its id, "<component>.<key>".
  console.log(results.outputs.find((o) => o.id === "sink.p99")?.mean);
}
```

To follow individual requests (to animate them, or to debug a path), pass `trace`. It is called each time an entity
enters a component, in simulation order, with `{ replication, time, component, entity, createdAt }` (times in
seconds). It is called for every entity in every replication, so filter in the callback for long runs:

```ts
const path: string[] = [];
runModel(loaded.model, { replications: 1, trace: (e) => { if (e.entity === 0) path.push(`${e.time}s ${e.component}`); } });
// e.g. ["0s traffic", "0s queue", "0.4s workers", "1.1s done"]
```

Tracing never changes results. A `Topic`'s copies get new ids and keep the original's `createdAt`; a `RetryPolicy` shows
up once per attempt.

The component type names are exact and case-sensitive (`EntityGenerator`, `Queue`, `Server`, `EntitySink`, ...); if you
get one wrong, `loadModel` lists the valid types.

Models are plain, versioned JSON; see the [model format](https://github.com/NiloyBhattacharjee/surgesim/blob/main/docs/model-format.md). To run models from the
command line use [`@surgesim/cli`](https://www.npmjs.com/package/@surgesim/cli).

Part of [Surgesim](https://github.com/NiloyBhattacharjee/surgesim). Apache-2.0.
