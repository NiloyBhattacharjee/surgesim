# TypeScript SDK (`@chronon-sim/sdk`)

Describe a system in code, the way CDK describes infrastructure, and compile it to the
[JSON model format](model-format.md). The SDK has no runtime dependencies and no Node or DOM APIs, so it also
works in a browser or a build script. It never simulates anything: the JSON it emits is the contract, and the
engine (or any future engine) runs it.

```ts
import { Model, dist, time } from "@chronon-sim/sdk";

const model = new Model("checkout", { duration: 600, warmUp: 60, replications: 10, seed: 7 });

const ok = model.entitySink("ok");
const dlq = model.entitySink("dlq");
const orders = model.messageQueue("orders", { visibilityTimeout: 30, maxReceiveCount: 3, deadLetter: dlq });
const workers = model.workerPool("workers", {
  concurrency: 50,
  serviceTime: dist.lognormal(0.5, 0.25),
  coldStartTime: dist.constant(1.5),
  idleTimeout: time.minutes(1),
  queue: orders,
  next: ok,
});
model.entityGenerator("traffic", {
  mode: "rateProfile",
  rateProfile: [[0, 50], [180, 250], [300, 50]],
  next: orders,
});
model.autoscaler("scaler", { maxConcurrency: 200, targetUtilisation: 0.6, target: workers });

model.sampleEvery(5, [orders.output("Backlog"), workers.output("Concurrency")]);
model.assert(ok.output("p99"), "<=", 2, { name: "p99 under 2 s" });

export default model;
```

```bash
chronon run checkout.ts                       # run it (TypeScript needs Node 22.18+, or tsx / compile to .js)
chronon compile checkout.ts --out model.json  # emit the JSON contract (validated first)
```

## Running model files

Model files are ES modules. In a project whose `package.json` says `"type": "commonjs"` (which `npm init` writes by
default), Node treats `.ts` and `.js` files as CommonJS and the import fails with "Cannot use import statement outside a
module". Either name the file
`.mts` (or `.mjs`), or add `"type": "module"` to your `package.json`. `chronon` suggests this when it sees the error.
Running `.ts` directly needs Node 22.18+; on older Node, compile to `.js` first or run through `tsx`.

## How it maps to the format

- `new Model(name, { duration, warmUp?, seed?, replications?, ticksPerSecond?, description? })` is the model
  header and `settings`.
- Each builder method (`entityGenerator`, `queue`, `server`, `entitySink`, `messageQueue`, `workerPool`,
  `retryPolicy`, `rateLimiter`, `autoscaler`) adds one component. Its props are the component's `inputs` **and**
  its `links` in one object: a prop whose value is another component becomes a link. Anything else is an input.
- `model.custom(type, name, inputs, links)` adds a component of any type, for custom engine registries.
- Times are seconds, rates are per second, as everywhere else. `time.ms/minutes/hours` and `dist.*` are
  helpers that return plain seconds and plain distribution objects.
- `component.output("p99")` returns the id `"sink.p99"`. The key is type-checked per component, so
  `sink.output("p98")` is a compile error.
- `model.assert(output, op, value, { statistic?, name? })` adds an assertion; `model.sampleEvery(seconds, outputs)`
  sets the time series.

Component order in the JSON is creation order, and it does not affect the simulation.

## Cycles and forward references

A link prop needs the target to exist already. For cycles (a pool's `onThrottle` back to the retry policy that
feeds it) create both, then connect them:

```ts
const retry = model.retryPolicy("retry", { maxAttempts: 4, giveUp: failed });
const pool = model.workerPool("pool", { concurrency: 5, serviceTime: 0.2, onThrottle: retry, next: ok });
retry.link("next", pool);
```

## Errors

Authoring mistakes throw a `ModelBuildError` (an `Error`) whose `problems` are `{ component, key, message }`
records, the same shape the engine uses:

- an unknown property (`concurency`), or a duplicate component name, throws **immediately** at the offending call;
- `toJSON()` throws if a link points at a component from a different model.

Semantic validation (ranges, required inputs, link roles) is deliberately **not** duplicated in the SDK. The
engine's loader is the single source of truth, so `chronon run` and `chronon compile` report those errors with
the same messages whether the model came from JSON or from the SDK.

## No drift

The SDK declares each component's input, link and output keys (`SPECS`). A test compares them with the engine's
registered schemas (`chronon schema`), so adding or changing a component in the engine fails the SDK build until
the SDK is updated. Two regression tests also rebuild `examples/mm1.json` and `examples/traffic-spike.json` from
SDK code and require an exact match.
