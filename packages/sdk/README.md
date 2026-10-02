# @surgesim/sdk

Describe a system in TypeScript and compile it to the Surgesim JSON model format.

```ts
import { Model, dist } from "@surgesim/sdk";

const model = new Model("api", { duration: 600, replications: 5 });
const sink = model.entitySink("ok");
const pool = model.workerPool("pool", { concurrency: 50, serviceTime: dist.lognormal(0.5, 0.25), next: sink });
model.entityGenerator("traffic", { interArrivalTime: dist.exponential(0.02), next: pool });
model.assert(sink.output("p99"), "<=", 2);
export default model;                          // surgesim run model.ts
```

Full guide: [docs/sdk.md](https://github.com/NiloyBhattacharjee/surgesim/blob/main/docs/sdk.md).

Part of [Surgesim](https://github.com/NiloyBhattacharjee/surgesim). Apache-2.0.
