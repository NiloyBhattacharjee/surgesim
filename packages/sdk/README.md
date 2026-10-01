# @chronon-sim/sdk

Describe a system in TypeScript and compile it to the Chronon Sim JSON model format.

```ts
import { Model, dist } from "@chronon-sim/sdk";

const model = new Model("api", { duration: 600, replications: 5 });
const sink = model.entitySink("ok");
const pool = model.workerPool("pool", { concurrency: 50, serviceTime: dist.lognormal(0.5, 0.25), next: sink });
model.entityGenerator("traffic", { interArrivalTime: dist.exponential(0.02), next: pool });
model.assert(sink.output("p99"), "<=", 2);
export default model;                          // chronon run model.ts
```

Full guide: [docs/sdk.md](https://github.com/NiloyBhattacharjee/chronon-sim/blob/main/docs/sdk.md).

Part of [Chronon Sim](https://github.com/NiloyBhattacharjee/chronon-sim). Apache-2.0.
