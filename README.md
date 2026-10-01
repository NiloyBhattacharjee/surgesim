# Chronon Sim

**Code-first discrete event simulation (DES) for cloud and distributed systems.** Describe request traffic,
queues, worker pools, retries and autoscaling in JSON, TypeScript or Python (or import a CloudFormation/CDK
template), run it with the `chronon` CLI, and get a report with confidence intervals. It answers questions like:

> What happens to my queue backlog and p99 latency if traffic spikes 5x with a concurrency limit of 50?

Think CDK for capacity planning: models live in your repo, runs are deterministic and seeded, and capacity
thresholds fail the build in CI.

| You want to... | Use |
|---|---|
| Run a model and read the numbers | `chronon run model.json` |
| Fail CI when p99 or backlog or cost crosses a limit | `assertions` in the model, or `--assert "sink.p99<=2"` ([docs](docs/model-format.md#assertions)) |
| Share a result | `--html report.html`: one self-contained file with charts ([docs](docs/reports.md)) |
| Compare two designs | `chronon compare a.json b.json --html diff.html` |
| Write models as code | the [TypeScript SDK](docs/sdk.md) or the [Python SDK](sdks/python/README.md) |
| Start from real infrastructure | `chronon import cdk.out/Stack.template.json` ([docs](docs/importing.md)) |
| Try it without installing | the [browser demo](docs/browser-demo.md): the engine in a Web Worker, one HTML file |

## Acknowledgement

The architecture is inspired by [JaamSim](https://github.com/jaamsim/jaamsim) (Apache 2.0): its integer-tick event
kernel with (time, priority, FIFO/LIFO) ordering and conditional events, its Entity → StateEntity → LinkedComponent
object model, schema-declared inputs and outputs, and per-component random streams. Chronon Sim is an independent
TypeScript implementation; no JaamSim code is ported.

## Quick start

```bash
pnpm install
pnpm build
pnpm exec chronon run examples/autoscaled-service.json --html out/report.html
```

Requires Node 20+ and pnpm (TypeScript model files need Node 22.18+, or compile to `.js` first). `pnpm exec chronon`
runs the workspace binary; publishing to npm is not done yet, so `npx chronon` does not work today.

```
chronon run <model> [--seed N] [--replications N] [--assert EXPR]... [--html report.html] [--timeseries out.csv] [--json out.json]
chronon report <results.json|model> --html report.html       render an HTML report from saved results
chronon compare <a> <b> --html compare.html                  compare two runs (results files or models)
chronon compile <model.ts|.js|.json> [--out model.json]      build a model module to the JSON format
chronon import <template.json> [--out model.json] [--rate N] [--service-time MEAN] [--entry ID]...
chronon schema                                               component schemas as JSON
```

A `<model>` is a `.json` file, or a `.js`/`.ts` module whose default export is built with the SDK.
Validation failures print every error and exit with code 1:

```
error: model.json failed validation with 2 errors:
  - [settings.duration] required setting is missing
  - [q.maxLength] must be >= 1
```

Exit codes: `0` ok, `1` invalid model / malformed JSON, `2` usage or I/O error, `3` an assertion failed.

### Capacity gates in CI

```bash
chronon run model.json --assert "sink.p99<=2" --assert "queue.MaxQueueLength@max<5000" --assert "service.Cost<8"
echo $?   # 3 if any threshold is violated
```

Thresholds can also live in the model. `@ci95High` makes a gate conservative (the pessimistic end of the 95% interval
must satisfy the limit), and an assertion on an undefined value fails rather than passing silently.

### Writing models as code

```ts
import { Model, dist } from "@chronon-sim/sdk";

const model = new Model("api", { duration: 600, replications: 5 });
const sink = model.entitySink("ok");
const pool = model.workerPool("pool", { concurrency: 50, serviceTime: dist.lognormal(0.5, 0.25), next: sink });
model.entityGenerator("traffic", { interArrivalTime: dist.exponential(0.02), next: pool });
model.assert(sink.output("p99"), "<=", 2);
export default model;          // chronon run model.ts
```

```python
from chronon_sim import Model, dist

m = Model("api", duration=600, replications=5)
sink = m.entity_sink("ok")
pool = m.worker_pool("pool", concurrency=50, service_time=dist.lognormal(0.5, 0.25), next=sink)
m.entity_generator("traffic", inter_arrival_time=dist.exponential(0.02), next=pool)
m.assert_that(sink.output("p99"), "<=", 2)
print(m.to_json())             # chronon run model.json
```

Both SDKs compile to the same JSON, and a test proves a Python-built model is JSON-identical to the same model built
in TypeScript.

## Components

| Component | Models |
|---|---|
| `EntityGenerator` | arrivals: fixed or random inter-arrival times, or a time-varying Poisson rate profile |
| `Queue`, `Server`, `EntitySink` | FIFO queue with optional capacity, parallel workers, and the end of the line (latency percentiles) |
| `MessageQueue` | SQS-style visibility timeout, redelivery, `maxReceiveCount`, dead-letter queue |
| `WorkerPool` | concurrency limit, cold starts, idle reclaim, throttling, failures, per-second/per-request pricing |
| `RetryPolicy` | exponential backoff with `none` / `full` / `equal` jitter, `maxDelay`, give-up routing |
| `RateLimiter` | token bucket |
| `Autoscaler` | target-tracking scaling with provisioning delay and scale-in cooldown |

Every input, link and output is documented in [docs/model-format.md](docs/model-format.md), and `chronon schema`
prints the machine-readable form.

## Examples

| File | What it shows |
|---|---|
| [`examples/mm1.json`](examples/mm1.json) | M/M/1, λ=0.8, μ=1: matches queueing theory |
| [`examples/mmc.json`](examples/mmc.json) | M/M/5, λ=4, μ=1 |
| [`examples/traffic-spike.json`](examples/traffic-spike.json) | 50/s → 250/s for 2 min into 100 workers (lognormal service, mean 0.5 s): the backlog climbs to about 6,000 and drains |
| [`examples/sqs-dlq.json`](examples/sqs-dlq.json) | SQS visibility timeout (10 s) shorter than processing time (mean 12 s): redeliveries, duplicate processing, a dead-letter queue. With a 60 s timeout utilisation drops to the expected 2 × 12 / 40 = 0.6 |
| [`examples/serverless-cold-start.json`](examples/serverless-cold-start.json) | a function with a concurrency limit, cold starts and idle reclaim; a 5x spike throttles calls that retry with jittered backoff |
| [`examples/retry-storm.json`](examples/retry-storm.json) | a flaky, nearly-saturated dependency with immediate retries amplifies its own load (`RetryAmplification`) |
| [`examples/autoscaled-service.json`](examples/autoscaled-service.json) | a queue-fed service under a 4x spike: autoscaler, pricing, and SLO/budget assertions that fail the run (exit 3) if scaling is too slow |
| [`examples/sdk/autoscaled-service.ts`](examples/sdk/autoscaled-service.ts) | the same system written with the TypeScript SDK |
| [`examples/cloudformation/orders-stack.template.json`](examples/cloudformation/orders-stack.template.json) | a CDK-style template (SQS + DLQ + Lambda + ECS + autoscaling + API Gateway throttle) for `chronon import` |

## Architecture

```
apps/cli ──► engine ◄── report ◄── apps/demo (engine + report in a Web Worker)
   │            ▲
   │            └─────── (types only)
   ├──► platform           interfaces only: FileStore, Logger, Clock
   ├──► sdk ◄── importer   no runtime dependencies
   └──► report, importer

sdks/python                standalone; emits the same JSON
```

- **`@chronon-sim/engine`**: no DOM, no Node APIs, no runtime dependencies. Everything platform-specific sits behind
  the interfaces in **`@chronon-sim/platform`**, so the engine runs in Node and in a Web Worker.
- **`@chronon-sim/sdk`**, **`report`**, **`importer`**: also free of Node and DOM APIs. Only `apps/cli` touches the
  file system, the process and dynamic `import()`.

Inside the engine, each layer depends only on those below it:

| # | Layer | Contents |
|---|---|---|
| 1 | `kernel` | Integer-tick clock, binary-heap event queue ordered by (tick, priority, sequence), FIFO/LIFO, cancellable `EventHandle`s, `waitUntil` conditions evaluated only when time advances |
| 2 | `rng` | Own xoshiro128** PRNG; independent streams from `(seed, streamId)`; constant/uniform/exponential/normal/triangular/lognormal behind `SampleProvider` |
| 3 | `schema` | Pure-data component schemas (inputs, links, outputs, unit categories including cost) and structured `ValidationError`s |
| 4 | `model` | `Entity` → `StateEntity` → `LinkedComponent`; lightweight moving entities |
| 5 | `components` | the components above, all callback state machines on `kernel.schedule` (no generators, coroutines or blocking waits) |
| 6 | `stats`, `run` | Time-weighted averages, pluggable percentile tracker, warm-up, replications, t-based 95% CIs, time series, assertions, JSON-serialisable results |
| 7 | `format` | The JSON model loader (validates everything, returns all errors at once) |

### The JSON model format is the contract

Models are plain, versioned JSON ([docs/model-format.md](docs/model-format.md)). The SDKs and the importer compile to it,
and a different engine (for example Rust/WASM) can consume it. Times are seconds and rates are per second regardless of
engine resolution. Component schemas are data, and tests check that both SDKs declare exactly the keys the engine's
schemas do, so they cannot drift. Results are one JSON-serialisable object that the CLI table, the HTML report,
comparisons and the assertions all work from.

### Determinism

Every component (and every sampler within it) draws from its own stream, `(seed, componentName/input)`. The same model
and seed give bit-identical results; adding components or changing one component's `stream` never shifts another's
random numbers. Reports contain no timestamps, so the same results always produce the same bytes.

## How it is validated

A simulator is only credible if it reproduces known answers. The suite runs long, warmed-up, replicated simulations
and asserts that 95% confidence intervals contain the closed-form results:

- **M/M/1** (λ=0.8, μ=1): utilisation 0.8, Lq 3.2, Wq 4.0, W 5.0; time in system is Exp(0.2), so
  p50 ≈ 3.466, p95 ≈ 14.979, p99 ≈ 23.026.
- **M/M/c** (λ=4, μ=1, c=5): utilisation 0.8, Lq ≈ 2.2165, Wq ≈ 0.5541, W ≈ 1.5541.
- **M/M/c/c loss system**: a queue-less `WorkerPool` throttles exactly the **Erlang-B** fraction B ≈ 0.19907, and its
  utilisation is the carried load a(1−B)/c.
- **Imported infrastructure**: a CDK-style stack with a function of reserved concurrency 20 receiving 10 msg/s at 0.5 s
  each shows utilisation λ·E[S]/c = 0.25; an API Gateway throttle of 20/s against 50/s offered rejects about 60%.
- **Hand-calculable timelines**: visibility-timeout redelivery and dead-lettering, backoff delays and jitter means,
  cold-start counts, token-bucket throughput, autoscaler step times, cost arithmetic.

It also tests the things around the engine: SDK output against the hand-written examples (exact JSON match), Python
against TypeScript, report and CLI behaviour, and **embeddability**: a static scan of the engine, SDK, report and
importer for Node/DOM APIs, plus running the worker bundle in a bare `vm` context with no Node globals and requiring
byte-identical output to Node. See [docs/browser-demo.md](docs/browser-demo.md).

A 95% CI misses the truth 5% of the time by construction. The tests use fixed seeds, so they are deterministic rather
than flaky, but they are a statistical check, not a proof.

## Development

```bash
pnpm install
pnpm test          # vitest across all packages, including cross-language tests (skipped if Python is absent)
pnpm test:py       # the Python SDK's own unittest suite
pnpm typecheck     # sources and tests
pnpm build         # tsc -b, emits dist/ for every package
pnpm demo          # build and serve the browser demo (pnpm demo:build writes apps/demo/dist/index.html)
```

## Docs

| | |
|---|---|
| [docs/model-format.md](docs/model-format.md) | the JSON contract: settings, every component, assertions, results |
| [docs/sdk.md](docs/sdk.md) | the TypeScript SDK |
| [sdks/python/README.md](sdks/python/README.md) | the Python SDK |
| [docs/reports.md](docs/reports.md) | HTML reports and comparisons |
| [docs/importing.md](docs/importing.md) | importing CloudFormation and CDK |
| [docs/browser-demo.md](docs/browser-demo.md) | the browser demo and how embeddability is proven |

## Limits and next steps

Be aware of what this is not. A model answers "what if" for the traffic and service times you give it; they are
inputs, not measurements. The importer cannot read them from a template (it prints every number it invented), so
calibrate them against real metrics before trusting a conclusion.

Not built yet:

- Publishing: nothing is on npm or PyPI, so `npx chronon` does not work; there is no CI workflow file in the repo.
- Importer: JSON templates only (no YAML), and only SQS, Lambda, ECS services, Application Auto Scaling target tracking
  and API Gateway throttling.
- Components: no DynamoDB, SNS fan-out, load balancers, FIFO queues, batching, step scaling or multi-region.
- Distributions are specified, not fitted from data; there is no expression language and no richer unit system.
- Reports do not yet embed a model diff or per-replication drill-downs, and "differs" in a comparison is a conservative
  confidence-interval overlap check, not a formal hypothesis test.

## License

Apache-2.0.
