# Surgesim model format — version 1

The JSON model format is the stable contract between model authoring (hand-written JSON, the future
TypeScript/Python SDKs, CDK importers) and simulation engines (the TypeScript engine today, possibly
Rust/WASM later). It contains only plain JSON values and no language-specific concepts.

- **Units.** All times are in **seconds**; all rates are **per second**. This is independent of the
  engine's internal tick resolution. Prices (`cost` inputs and outputs) are in whatever currency the
  model's prices use; the engine never converts them.
- **Versioning.** The top-level `"version"` field is required. This document describes version `1`.
  Engines must reject versions they do not support. Backwards-incompatible changes increment the version.
- **Strictness.** Unknown fields are errors everywhere, so typos are caught rather than ignored.
- **Validation.** Loaders report *all* problems at once as `{component, key, message}` records.

## Top level

```json
{
  "version": 1,
  "name": "optional human-readable name",
  "description": "optional text",
  "settings": { "duration": 600 },
  "components": [ ... ]
}
```

## `settings`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `duration` | number > 0 | **required** | Total simulated seconds, including warm-up. |
| `warmUp` | number ≥ 0, < duration | `0` | At this time every component resets its statistics. Reported statistics cover `[warmUp, duration]`. |
| `seed` | integer ≥ 0 | `1` | Base seed. Replication *i* uses a seed derived from `(seed, i)`. |
| `replications` | integer ≥ 1 | `1` | Number of independent replications. |
| `ticksPerSecond` | integer ≥ 1 | `1000000` | Engine time resolution. Times are rounded to the nearest tick. |
| `timeSeries` | object | none | Sample outputs over time (below). |

### `timeSeries`

```json
{ "interval": 5, "outputs": ["queue.QueueLength", "server.BusyWorkers"] }
```

Every `interval` seconds, from time 0 to `duration`, the listed outputs are sampled (output ids are
`"<componentName>.<OutputKey>"`). Samples cover the warm-up period too, so backlog growth is visible.

## Components

```json
{ "type": "Server", "name": "server", "inputs": { ... }, "links": { "queue": "queue", "next": "sink" } }
```

| Field | Meaning |
|---|---|
| `type` | Component type (see below). |
| `name` | Unique, non-empty. Used in links and output ids. |
| `inputs` | Object of inputs, validated against the component's schema. Optional if none are required. |
| `links` | Object mapping link keys to **component names**. |
| `stream` | Optional RNG stream id (default: the component name). Two components never share a stream unless you give them the same id. |

Links must point to a component with the role the link requires (e.g. `Server.queue` needs a
`Queue`). Cycles are permitted.

### Numeric inputs: constants and distributions

A `sampler` input accepts either a number (a constant) or a distribution object:

| Object | Parameters |
|---|---|
| `{"dist":"constant","value":v}` | `value` |
| `{"dist":"uniform","min":a,"max":b}` | `min ≤ max` |
| `{"dist":"exponential","mean":m}` | `mean > 0` |
| `{"dist":"normal","mean":m,"stdDev":s}` | `stdDev ≥ 0` (negative samples of times are clamped to 0) |
| `{"dist":"triangular","min":a,"mode":c,"max":b}` | `min ≤ mode ≤ max` |
| `{"dist":"lognormal","mean":m,"stdDev":s}` | `mean > 0`, `stdDev ≥ 0`; mean/stdDev are of the lognormal variable itself, not of its logarithm |
| `{"dist":"empirical","points":[[p,x],...]}` | at least 2 `[cumulativeProbability, value]` pairs; probabilities strictly increasing from exactly `0` to exactly `1`; values never decreasing |

**Empirical distributions** describe a measured shape directly, for data that no single family fits (for example fast
cache hits plus slow misses). Each point says "a fraction `p` of values are at most `x`", so the first point is the
minimum and the last is the maximum. Values between points are interpolated linearly (a piecewise-linear cumulative
distribution, like JaamSim's `ContinuousDistribution`), and nothing below the first value or above the last is ever
drawn. Repeating a value makes an atom: `[[0,3],[0.3,3],[1,4]]` returns exactly 3 with probability 0.3.
Percentiles from a dashboard work as points, as long as you add the minimum and maximum:

```json
{ "dist": "empirical", "points": [[0, 0.008], [0.5, 0.049], [0.9, 0.32], [0.99, 1.21], [1, 2.49]] }
```

`surgesim fit` prints one with a point at every percentile and finer points in the tail. Because it cannot exceed the
largest measured value, it understates the far tail when you have few samples.

## Component types (phase 1: generic components)

`surgesim schema` prints these schemas as machine-readable JSON; it is the source of truth.

### `EntityGenerator` — role `source`
| Input | Type | Default | |
|---|---|---|---|
| `mode` | `"interval"` \| `"rateProfile"` | `"interval"` | |
| `interArrivalTime` | sampler (s) | required if `mode` is `interval` | Time between arrivals. |
| `rateProfile` | `[[startSeconds, ratePerSecond], ...]` | required if `mode` is `rateProfile` | Piecewise-constant Poisson rate. Starts strictly increasing; before the first start the rate is 0; the last segment continues forever. |
| `firstArrivalTime` | sampler (s) | `0` | Interval mode: time of the first arrival. RateProfile mode: when the process starts. |
| `maxNumber` | integer ≥ 0 | unlimited | Stop after this many entities. |
| `dispersionIndex` | number, 1 to 1000 | `1` | How bursty arrivals are: variance ÷ mean of arrival counts, as `surgesim fit-arrivals` prints it. `1` is Poisson. |

Link: `next` (role `receiver`, optional). Outputs: `NumberGenerated`.

**Bursty arrivals.** With `dispersionIndex` D above 1, arrival events become (D + 1) / 2 times rarer and each releases
a batch of simultaneous entities whose size is geometric with mean (D + 1) / 2. The average rate stays what
`rateProfile` or `interArrivalTime` says. For Poisson arrivals (any `rateProfile`, or an exponential
`interArrivalTime`) this is a compound Poisson process: in any window, arrival counts have variance D times their mean.
Real bursts are usually spread over a short time rather than simultaneous, so this is slightly pessimistic. A
`maxNumber` limit can cut the last batch short.

### `Queue` — roles `receiver`, `queue`, `pullable`
Input `maxLength` (integer ≥ 1, default unlimited): arrivals beyond it are dropped and counted.
Outputs: `QueueLength`, `AverageQueueLength` (time-weighted), `MaxQueueLength`, `AverageQueueTime` (s), `NumberDropped`.

### `Server`
Inputs: `capacity` (integer ≥ 1, default 1), `serviceTime` (sampler, s, required).
Links: `queue` (role `queue`, **required**), `next` (role `receiver`, optional).
Outputs: `Utilisation` (time-weighted busy workers / capacity), `AverageBusyWorkers`, `BusyWorkers` (current).

### `EntitySink` — role `receiver`
No inputs. Records each entity's time in system. Outputs: `count`, `mean`, `p50`, `p95`, `p99` (seconds).


## Component types (phase 2: cloud components)

These compose with the phase 1 components through the same `links`. Entities flow downstream through
`next`; the extra links below route *rejected*, *failed* and *dead* entities, which is how
retries and dead-letter queues are wired. Cycles are allowed (a `WorkerPool` may point `onThrottle` at the
`RetryPolicy` that feeds it).

### `MessageQueue` — roles `receiver`, `pullable`
SQS-style queue. A consumer *receives* a message, hiding it for `visibilityTimeout`; if it is not
acknowledged in time the message becomes visible again (a redelivery). Once a message has been received
`maxReceiveCount` times and its visibility timeout expires again, it is dead-lettered.

| Input | Type | Default | |
|---|---|---|---|
| `visibilityTimeout` | number > 0 (s) | `30` | Seconds a received message stays hidden. |
| `maxReceiveCount` | integer ≥ 1 | unlimited | Receives before dead-lettering. |
| `costPerMillionRequests` | number ≥ 0 (cost) | `0` | Price per million API requests; each send, receive and delete is one request. |

Link: `deadLetter` (role `receiver`, optional; without it exhausted messages are discarded and counted).
Outputs: `QueueLength` (visible), `InFlight`, `Backlog` (visible + in flight), `AverageQueueLength`,
`MaxQueueLength`, `AverageInFlight`, `AverageQueueTime`, `NumberReceived`, `NumberRedelivered`, `NumberDeadLettered`.

A consumer that is still working when the timeout expires is **not** interrupted: it finishes, its
acknowledgement is stale, and the redelivered copy may be processed again (duplicate processing).

### `WorkerPool`
Up to `concurrency` workers. **Pull mode**: set `queue` to a `Queue` or `MessageQueue`. **Push mode**:
omit `queue` and send entities to the pool; when every worker is busy the entity is *throttled*.

| Input | Type | Default | |
|---|---|---|---|
| `concurrency` | integer ≥ 1 | **required** | Maximum workers busy at once (cold-starting ones count). |
| `serviceTime` | sampler (s) | **required** | Service time per entity. |
| `coldStartTime` | sampler (s) | `0` | Extra time when a request must start a new instance. |
| `idleTimeout` | number ≥ 0 (s) | never | An idle instance goes cold after this long. The most recently used instance is reused first. |
| `initialWarm` | integer ≥ 0 | `0` | Instances warm at time 0 (capped at `concurrency`). |
| `failureProbability` | number in [0, 1] | `0` | Chance an entity fails after its service time. |
| `costPerBusySecond` | number ≥ 0 (cost) | `0` | Price per busy-worker-second (serverless-style billing). |
| `costPerProvisionedSecond` | number ≥ 0 (cost) | `0` | Price per provisioned-worker-second, busy or idle; follows autoscaling. |
| `costPerRequest` | number ≥ 0 (cost) | `0` | Price per request started. |

Links: `queue` (role `pullable`), `next`, `onFailure`, `onThrottle` (role `receiver`, all optional).
Failures: with `onFailure` the entity goes there and is acknowledged; otherwise a `MessageQueue` source
redelivers it after the visibility timeout and anything else loses it (counted in `NumberFailed`).
Throttled entities go to `onThrottle` or are dropped (counted).
Outputs: `Utilisation` (busy / provisioned concurrency), `AverageBusyWorkers`, `BusyWorkers`, `Concurrency`
(current limit), `AverageConcurrency`, `ColdStarts`, `NumberSucceeded`, `NumberFailed`, `NumberThrottled`,
`ThrottleFraction` (throttled / pushed), `Cost`, `StaleAcks`.

`Cost = busySeconds × costPerBusySecond + provisionedSeconds × costPerProvisionedSecond + requestsStarted × costPerRequest`,
over the measured window (after `warmUp`). `provisionedSeconds` is the time-integral of the concurrency limit.

A pool without a queue and without cold starts is an M/M/c/c loss system, whose blocking probability is
the Erlang-B formula; the test suite checks this.

### `RetryPolicy` — role `receiver`
Retries failed attempts with exponential backoff and jitter. Send entities in; point `next` at the thing
that can fail; point that thing's `onFailure` / `onThrottle` back at the `RetryPolicy`. A first-time
entity is forwarded immediately; one that returns is a failed attempt and is retried after a delay until
`maxAttempts` attempts have been made, then sent to `giveUp`.

| Input | Type | Default | |
|---|---|---|---|
| `maxAttempts` | integer ≥ 1 | `3` | Total attempts, including the first. |
| `baseDelay` | number ≥ 0 (s) | `0.1` | Delay before the first retry. |
| `multiplier` | number ≥ 1 | `2` | Growth factor per retry. |
| `maxDelay` | number ≥ 0 (s) | uncapped | Cap applied before jitter. |
| `jitter` | `"none"` \| `"full"` \| `"equal"` | `"full"` | `none`: d. `full`: uniform on [0, d]. `equal`: uniform on [d/2, d]. |

The delay before retry *n* is `d = min(maxDelay, baseDelay × multiplier^(n−1))`. The attempt count is stored
on the entity, so an entity should pass through a given `RetryPolicy` only once.
Links: `next` (**required**), `giveUp` (optional). Outputs: `NumberRequests`, `NumberAttempts`,
`NumberRetries`, `NumberGivenUp`, `RetryAmplification` (attempts per request), `Retrying` (current).

### `RateLimiter` — role `receiver`
Token bucket. Starts full with `burst` tokens, refills at `rate` per second up to `burst`; each entity
takes one token, otherwise it is rejected.

| Input | Type | |
|---|---|---|
| `rate` | number ≥ 0 (per s), **required** | Sustained allowed rate. |
| `burst` | number ≥ 1, **required** | Bucket size. |

Links: `next`, `onReject` (role `receiver`, optional; rejected entities are dropped and counted without it).
Outputs: `NumberAllowed`, `NumberRejected`, `RejectionFraction`, `Tokens` (current).

### `Autoscaler`
Target-tracking autoscaler (like AWS target tracking or a Kubernetes HPA) for a `WorkerPool`. Every
`evaluationInterval` it measures the average number of busy workers over that interval and computes
`desired = ceil(averageBusy / targetUtilisation)`, clamped to `[minConcurrency, maxConcurrency]`.
Scale-out takes effect after `scaleUpDelay`; scale-in is immediate but only `scaleDownCooldown` seconds after the
last scaling change. A saturated pool therefore grows by a factor of `1 / targetUtilisation` per evaluation.

| Input | Type | Default | |
|---|---|---|---|
| `targetUtilisation` | number in [0.05, 1] | `0.6` | Busy workers / concurrency to aim for. |
| `evaluationInterval` | number > 0 (s) | `60` | Seconds between decisions, and the averaging window. |
| `minConcurrency` | integer ≥ 1 | `1` | |
| `maxConcurrency` | integer ≥ 1 | **required** | |
| `scaleUpDelay` | number ≥ 0 (s) | `0` | Provisioning time before added capacity is usable. |
| `scaleDownCooldown` | number ≥ 0 (s) | `300` | Minimum seconds since the last change before scaling in. |

Link: `target` (role `scalable`, **required**). Outputs: `ScaleOuts`, `ScaleIns`, `DesiredConcurrency` (current).
Lowering a pool's concurrency never interrupts running work: the pool just stops starting new work until busy
workers fall below the new limit.

### Roles
`Queue` has roles `receiver`, `queue`, `pullable`; `MessageQueue` has `receiver`, `pullable`; `WorkerPool` has
`receiver`, `scalable`. `Server.queue` needs role `queue` (so a plain `Queue`); `WorkerPool.queue` needs `pullable`
(either); `Autoscaler.target` needs `scalable`.

## Assertions

An optional top-level `assertions` array states capacity thresholds that must hold after a run, so a model
can gate CI:

```json
"assertions": [
  { "name": "p99 under 2 s", "output": "sink.p99", "op": "<=", "value": 2 },
  { "output": "queue.MaxQueueLength", "op": "<", "value": 5000, "statistic": "max" }
]
```

| Field | Meaning |
|---|---|
| `output` | An output id `"<componentName>.<OutputKey>"`. Must exist. |
| `op` | One of `<`, `<=`, `>`, `>=`, `==`. |
| `value` | The threshold, in the output's own unit. |
| `statistic` | Which number is compared: `mean` (default, across replications), `ci95High` / `ci95Low` (ends of the 95% confidence interval, so `ci95High` with `<=` demands the limit hold even at the pessimistic end of the estimate), `min` / `max` (smallest / largest over replications: a worst-case gate). |
| `name` | Optional label shown in reports. |

An assertion whose value is undefined (no observations, or a confidence interval from a single replication)
**fails**: a gate that passes when its data is missing is worse than no gate. Results carry an `assertions`
array of `{assertion, actual, passed, message}`. The CLI prints PASS/FAIL lines and exits with code `3` if any
fail; extra checks can be added at the command line with `--assert "sink.p99<=2"`.

## Models that cannot finish

A model can pass validation and still be impossible to complete, typically a loop with no delay in it, such as an
`EntityGenerator` with `interArrivalTime: 0` and no `maxNumber`: events keep scheduling more events at the same instant,
so simulated time never advances. The engine stops such a run once more than 10 million events have happened at one
instant and reports a `SimulationLimitError` explaining what happened. The CLI prints it as
`error: the simulation could not finish: ...` and exits with code `1`. Many simultaneous events are fine below that
limit (for example `interArrivalTime: 0` with `maxNumber: 5000` produces 5,000 arrivals at the same instant).

Time values far beyond the run (more than about 285 years at the default resolution) are capped rather than rejected,
because an event that far away simply never happens during the run.

## Results

`surgesim run --json` writes a `RunResults` object (`resultsVersion: 1`): the settings used, one summary
per output (`mean`, `stdDev`, `ci95: {low, high, halfWidth}`, `n`), the raw per-replication values, and
the optional time series. The 95% CI uses Student's t over replications and is `null` for a single
replication. Undefined values (e.g. percentiles of an empty sink) are `null`.

## Full example

See [`examples/traffic-spike.json`](../examples/traffic-spike.json).
