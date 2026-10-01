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
| Fit inputs from your real metrics and check the model against them | `chronon fit`, `fit-arrivals`, `calibrate` ([docs](docs/calibration.md)) |
| Try it without installing | the [browser demo](docs/browser-demo.md): the engine in a Web Worker, one HTML file |

## Where this is useful

It answers "what happens if..." questions about **queues, limits and timing**, which are hard to reason about by hand
and easy to get wrong in production.

| Situation | The question | What to look at |
|---|---|---|
| Launch or sale traffic | Can we survive 5x traffic? | peak queue length, p99, throttled share |
| Choosing a Lambda concurrency limit | What avoids throttling without paying for idle capacity? | `ThrottleFraction`, `ColdStarts`, `Cost` |
| Sizing an SQS consumer | How many workers keep the backlog under 5 minutes at peak? | `AverageQueueTime`, `Backlog` over time |
| Visibility timeout bugs | Why are messages processed twice? | `NumberRedelivered`, `StaleAcks`, dead letters |
| Retry storms | Do our retries make a slow dependency worse? | `RetryAmplification` |
| Autoscaling tuning | Does scaling react fast enough to a sudden spike? | p99 and backlog during the spike |
| Cost versus latency | Is the cheaper, slower instance type good enough? | `chronon compare`: cost, p99, verdicts |
| Rate limit design | What burst size protects the backend without rejecting too much? | `RejectionFraction`, backend utilisation |
| Capacity gates | Fail a pull request if p99 under load passes 2 s | `--assert`, exit code 3 |
| Reviewing infrastructure changes | Does this CDK change alter capacity? | `chronon import` before and after, then `compare` |

**Not a good fit:** anything it does not model (databases, caches, network hops, load balancers, DynamoDB throttling,
batching, FIFO queues, multi-region), questions about why your code is slow (service time is an *input*), correlated
failures such as a bad deploy, very low-traffic systems where capacity is not the problem, and any case where you have
no data and would be inventing the traffic and timings.

## Acknowledgement

The architecture is inspired by [JaamSim](https://github.com/jaamsim/jaamsim) (Apache 2.0): its integer-tick event
kernel with (time, priority, FIFO/LIFO) ordering and conditional events, its Entity → StateEntity → LinkedComponent
object model, schema-declared inputs and outputs, and per-component random streams. Chronon Sim is an independent
TypeScript implementation; no JaamSim code is ported.

## Quick start

Needs Node 20+ (TypeScript model files need Node 22.18+, or compile them to `.js` first).

**Use it** (nothing to clone or build): the packages are on npm under the `@chronon-sim` scope.

```bash
npx @chronon-sim/cli run model.json --html report.html      # run without installing
npm install -g @chronon-sim/cli                             # or install once to get a plain `chronon` command
chronon run model.json --html report.html
```

The bare name `chronon` on npm belongs to an unrelated package, which is why the published name is
`@chronon-sim/cli`. The installed command is still called `chronon`. For models written in TypeScript, install the SDK
next to them: `npm install @chronon-sim/sdk`.

**Work on it** (clone the repository; this also needs pnpm):

```bash
pnpm install
pnpm build
pnpm exec chronon run examples/autoscaled-service.json --html out/report.html
```

`pnpm exec chronon` runs the workspace build. The commands below are shown as `chronon ...`; use whichever form fits.

```
chronon run <model> [--seed N] [--replications N] [--assert EXPR]... [--html report.html] [--timeseries out.csv] [--json out.json]
chronon report <results.json|model> --html report.html       render an HTML report from saved results
chronon compare <a> <b> --html compare.html                  compare two runs (results files or models)
chronon compile <model.ts|.js|.json> [--out model.json]      build a model module to the JSON format
chronon import <template.json> [--out model.json] [--rate N] [--service-time MEAN] [--entry ID]...
chronon fit <data.csv> [--column NAME] [--scale K]           fit a distribution to measured durations
chronon fit-arrivals <timestamps.csv> --window S             fit an arrival rate profile from request timestamps
chronon calibrate <model> --observed observed.json           compare a model with what the real system measured
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
| [`examples/rate-limited-api.json`](examples/rate-limited-api.json) | a token-bucket limiter sheds an 80/s burst (about 25% rejected) so the worker pool behind it barely throttles |
| [`examples/bounded-queue-overload.json`](examples/bounded-queue-overload.json) | M/M/2/50 under permanent overload: the bounded queue drops excess arrivals and latency stays capped near 12 s |
| [`examples/two-stage-pipeline.json`](examples/two-stage-pipeline.json) | parse then enrich: the slower stage (about 88% utilised) holds the backlog and sets end-to-end p95; gated by an assertion |
| [`examples/diurnal-autoscaling-cost.json`](examples/diurnal-autoscaling-cost.json) | a compressed daily traffic cycle with an autoscaler held near 50% utilisation, showing provisioned cost versus backlog |
| [`examples/stress/month-instance-m.json`](examples/stress/month-instance-m.json), [`-t.json`](examples/stress/month-instance-t.json) | a 30-day stress test (20 million requests, about 35 s per run): a general-purpose fleet versus a cheaper, slower burstable one under a daily/weekly cycle. Kept out of the top level because the test suite runs every example there |
| [`examples/sdk/autoscaled-service.ts`](examples/sdk/autoscaled-service.ts) | the same system written with the TypeScript SDK |
| [`examples/cloudformation/orders-stack.template.json`](examples/cloudformation/orders-stack.template.json) | a CDK-style template (SQS + DLQ + Lambda + ECS + autoscaling + API Gateway throttle) for `chronon import` |
| [`examples/calibration/`](examples/calibration/README.md) | **synthetic** monitoring data with a known ground truth, to try `fit`, `fit-arrivals` and `calibrate` |

## Architecture

```
apps/cli ──► engine ◄── report ◄── apps/demo (engine + report in a Web Worker)
   │            ▲
   │            └─────── (types only)
   ├──► platform           interfaces only: FileStore, Logger, Clock
   ├──► sdk ◄── importer   no runtime dependencies
   ├──► calibrate          fit distributions and rates from data, compare with observations
   └──► report, importer

sdks/python                standalone; emits the same JSON
validation/                an independent simulator (SimPy) and the synthetic data generator
```

- **`@chronon-sim/engine`**: no DOM, no Node APIs, no runtime dependencies. Everything platform-specific sits behind
  the interfaces in **`@chronon-sim/platform`**, so the engine runs in Node and in a Web Worker.
- **`@chronon-sim/sdk`**, **`report`**, **`importer`**, **`calibrate`**: also free of Node and DOM APIs. Only
  `apps/cli` touches the file system, the process and dynamic `import()`.

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

- **An independent simulator**: six scenarios (M/M/1, M/M/5, lognormal and heavy-tailed service, a bounded queue under
  overload, a traffic spike) run through both Chronon Sim and SimPy, which uses a different clock and a different method
  for time-varying arrivals. All 53 compared metrics agree, and the check is shown to have teeth: a model with a service
  time only 4% off is detected. See [docs/calibration.md](docs/calibration.md).

It also tests the things around the engine: SDK output against the hand-written examples (exact JSON match), Python
against TypeScript, report and CLI behaviour, **property-based tests** (the heap sorts, events run in the documented
order, no request is ever lost, and 100,000 randomly mutated models never crash or hang; this found and fixed four real
bugs, see [docs/testing.md](docs/testing.md)), and **embeddability**: a static scan of the engine, SDK, report,
importer and calibration packages for Node/DOM APIs, plus running the worker bundle in a bare `vm` context with no Node
globals and requiring byte-identical output to Node. See [docs/browser-demo.md](docs/browser-demo.md).

A 95% CI misses the truth 5% of the time by construction. The tests use fixed seeds, so they are deterministic rather
than flaky, but they are a statistical check, not a proof.

**Calibration against real systems.** The calibration tools were validated on synthetic data with a known ground truth,
which showed that the engine is right but that fitted inputs carry error that queueing near capacity amplifies. The
tools therefore report how detectable an error is and how sensitive each result is to its inputs. They have not yet
been run on production data.

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
| [docs/calibration.md](docs/calibration.md) | fitting inputs from measurements, comparing with observations, and what the validation showed |
| [docs/testing.md](docs/testing.md) | the test layers, property-based tests, CI, and how to reproduce a failure |
| [docs/releasing.md](docs/releasing.md) | how a version tag publishes every package to npm |

## Limits and next steps

Be aware of what this is not. A model answers "what if" for the traffic and service times you give it; they are
inputs, not measurements. The importer cannot read them from a template (it prints every number it invented), so
calibrate them against real metrics before trusting a conclusion.

Not built yet:

- PyPI: the Python SDK is not published yet (the npm packages are, and releases are automated; see
  [docs/releasing.md](docs/releasing.md)).
- Real-data calibration: the fitting and comparison tools exist but have only been exercised on synthetic data.
- CI: the workflows exist (Node 20 and 22 on Linux, macOS and Windows; Python 3.9 to 3.13) but their macOS and Linux
  cells only run on GitHub, so they had not been observed when this was written.
- Importer: JSON templates only (no YAML), and only SQS, Lambda, ECS services, Application Auto Scaling target tracking
  and API Gateway throttling.
- Components: no DynamoDB, SNS fan-out, load balancers, FIFO queues, batching, step scaling or multi-region.
- Distributions are fitted one at a time from independent samples; there is no mixture model, expression language or
  richer unit system.
- Reports do not yet embed a model diff or per-replication drill-downs, and "differs" in a comparison is a conservative
  confidence-interval overlap check, not a formal hypothesis test.

## License

Apache-2.0.
