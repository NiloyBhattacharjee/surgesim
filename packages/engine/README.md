# @chronon-sim/engine

The simulation engine behind Chronon Sim. It runs in Node and in a Web Worker: no DOM or Node APIs and no runtime
dependencies.

```ts
import { loadModel, runModel } from "@chronon-sim/engine";

const loaded = loadModel(modelJson);          // validates; returns every error at once
if (loaded.ok) {
  const results = runModel(loaded.model);     // replications, confidence intervals, time series, assertions
  console.log(results.outputs);
}
```

Models are plain, versioned JSON; see the [model format](https://github.com/NiloyBhattacharjee/chronon-sim/blob/main/docs/model-format.md). To run models from the
command line use [`@chronon-sim/cli`](https://www.npmjs.com/package/@chronon-sim/cli).

Part of [Chronon Sim](https://github.com/NiloyBhattacharjee/chronon-sim). Apache-2.0.
