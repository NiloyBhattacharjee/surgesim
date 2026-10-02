# @chronon-sim/engine

The simulation engine behind Chronon Sim. It runs in Node and in a Web Worker: no DOM or Node APIs and no runtime
dependencies.

```ts
import { loadModel, runModel } from "@chronon-sim/engine";

const loaded = loadModel(modelJson);          // validates; returns every error at once
if (loaded.ok) {
  const results = runModel(loaded.model);     // replications, confidence intervals, time series, assertions
  // `outputs` is an array with one summary per component output, not an object keyed by name:
  // { id: "sink.p99", component, key, unit, n, mean, stdDev, ci95 }. Find one by its id, "<component>.<key>".
  console.log(results.outputs.find((o) => o.id === "sink.p99")?.mean);
}
```

The component type names are exact and case-sensitive (`EntityGenerator`, `Queue`, `Server`, `EntitySink`, ...); if you
get one wrong, `loadModel` lists the valid types.

Models are plain, versioned JSON; see the [model format](https://github.com/NiloyBhattacharjee/chronon-sim/blob/main/docs/model-format.md). To run models from the
command line use [`@chronon-sim/cli`](https://www.npmjs.com/package/@chronon-sim/cli).

Part of [Chronon Sim](https://github.com/NiloyBhattacharjee/chronon-sim). Apache-2.0.
