# Chronon Sim

**Code-first discrete event simulation (DES) for cloud and distributed systems.** Describe request
traffic, queues and worker pools in JSON (a TypeScript SDK is coming), run the model with the
`chronon` CLI, and get a report with confidence intervals. It answers questions like:

> What happens to my queue backlog and p99 latency if traffic spikes 5x with a concurrency limit of 50?

Think CDK for capacity planning: models live in your repo, runs are deterministic and seeded, and
(in a later phase) capacity thresholds can be enforced in CI.

This is **phase 1**: the domain-neutral headless engine, generic components, the JSON model format
and the CLI. Cloud-specific components and the TypeScript SDK come next (see below).

## Acknowledgement

The architecture is inspired by [JaamSim](https://github.com/jaamsim/jaamsim) (Apache 2.0): its
integer-tick event kernel with (time, priority, FIFO/LIFO) ordering and conditional events, its
Entity → StateEntity → LinkedComponent object model, schema-declared inputs and outputs, and
per-component random streams. Chronon Sim is an independent TypeScript implementation; no JaamSim
code is ported.

## Quick start

```bash
pnpm install
pnpm build
pnpm exec chronon run examples/traffic-spike.json --timeseries out/spike.csv --json out/spike.json
```

Requires Node 20+ and pnpm. (`pnpm exec chronon` runs the workspace binary; once the CLI is
published, `npx @chronon-sim/cli run model.json` will work. A bare `npx chronon` needs a package
named `chronon` on the registry, which is a publishing decision for later.)

```
chronon run <model.json> [--seed N] [--replications N] [--timeseries out.csv] [--json out.json]
chronon schema        # component schemas as JSON
```

Validation failures print every error and exit with code 1:

```
error: model.json failed validation with 2 errors:
  - [settings.duration] required setting is missing
  - [q.maxLength] must be >= 1
```

Exit codes: `0` ok, `1` invalid model / malformed JSON, `2` usage or I/O error.

### Examples

| File | What it shows |
|---|---|
| [`examples/mm1.json`](examples/mm1.json) | M/M/1, λ=0.8, μ=1 — matches queueing theory |
| [`examples/mmc.json`](examples/mmc.json) | M/M/5, λ=4, μ=1 |
| [`examples/traffic-spike.json`](examples/traffic-spike.json) | 50/s → 250/s for 2 min into 100 workers with lognormal service (mean 0.5 s): the backlog climbs to ~6,000 during the spike and drains afterwards (see the CSV time series) |

## Architecture

```
apps/cli  ──►  @chronon-sim/engine      (no DOM, no Node APIs, no runtime deps)
   │
   └─────►  @chronon-sim/platform       (interfaces only: FileStore, Logger, Clock)
```

The engine depends on nothing. The CLI implements the platform interfaces with Node, so the engine
can also run in a Web Worker. Inside the engine, each layer depends only on those below it:

| # | Layer | Contents |
|---|---|---|
| 1 | `kernel` | Integer-tick clock, binary-heap event queue ordered by (tick, priority, sequence), FIFO/LIFO, cancellable `EventHandle`s, `waitUntil` conditions evaluated only when time advances |
| 2 | `rng` | Own xoshiro128** PRNG; independent streams from `(seed, streamId)`; constant/uniform/exponential/normal/triangular/lognormal behind `SampleProvider` |
| 3 | `schema` | Pure-data component schemas (inputs, links, outputs, unit categories) and structured `ValidationError`s |
| 4 | `model` | `Entity` → `StateEntity` → `LinkedComponent`; lightweight moving entities |
| 5 | `components` | `EntityGenerator`, `Queue`, `Server`, `EntitySink` as callback state machines on `kernel.schedule` |
| 6 | `stats`, `run` | Time-weighted averages, pluggable percentile tracker, warm-up, replications, t-based 95% CIs, time series, JSON-serialisable results |
| 7 | `format` | The JSON model loader (validates everything, returns all errors at once) |

### The JSON model format is the contract

Models are plain, versioned JSON — [docs/model-format.md](docs/model-format.md). Future SDKs compile
to it and a different engine (e.g. Rust/WASM) can consume it. Times are seconds and rates are per
second regardless of engine resolution. Component schemas are data (`chronon schema`), so SDK types
and docs can be generated from them. Results are one JSON-serialisable object that the CLI table,
future HTML reports and future CI checks all render from.

### Determinism

Every component (and every sampler within it) draws from its own stream, `(seed, componentName/input)`.
Same model + seed ⇒ bit-identical results; adding components or changing one component's `stream`
never shifts another's random numbers. Both are tested.

## Validation against theory

A simulator is only credible if it reproduces known answers. The test suite
([`packages/engine/test/theory.test.ts`](packages/engine/test/theory.test.ts)) runs long, warmed-up,
replicated simulations and asserts that the 95% confidence intervals contain the closed-form results:

- **M/M/1** (λ=0.8, μ=1): utilisation 0.8, Lq 3.2, Wq 4.0, W 5.0; time in system is Exp(0.2), so
  p50 ≈ 3.466, p95 ≈ 14.979, p99 ≈ 23.026 (checked within a relative tolerance).
- **M/M/c** (λ=4, μ=1, c=5): utilisation 0.8, Lq ≈ 2.2165, Wq ≈ 0.5541, W ≈ 1.5541.

Other tests cover kernel ordering/LIFO/cancellation/conditional events, hand-calculated
time-weighted averages, rate-profile counts per segment, queue drop accounting, determinism and
stream isolation, loader validation, and CLI smoke runs of every example.

Note that a 95% CI misses the truth 5% of the time by construction; the tests use fixed seeds, so they
are deterministic rather than flaky, but they are a statistical check, not a proof.

## Development

```bash
pnpm test        # vitest, all packages (runs against TypeScript sources)
pnpm build       # tsc -b, emits dist/ for every package
pnpm typecheck   # type-checks sources and tests
```

## Next steps

**Phase 2 — cloud components and authoring**
- `MessageQueue` (SQS-style visibility timeout, `maxReceiveCount`, dead-letter queue)
- `WorkerPool` (concurrency limit, cold starts, throttling)
- `RetryPolicy` (exponential backoff with jitter)
- `RateLimiter` (token bucket)
- `Autoscaler`
- Per-run cost estimates
- A TypeScript model SDK that compiles to the JSON format
- CLI threshold assertions (e.g. fail if p99 > 2s) for CI

**Phase 3**
- Self-contained HTML report generated by the CLI: backlog-over-time and latency charts, scenario comparison

**Later**
- Import models from CDK/CloudFormation templates
- Embeddable browser demo (the engine already avoids DOM/Node APIs)
- Optional Python SDK

## License

Apache-2.0.
