# Chronon Sim model format — version 1

The JSON model format is the stable contract between model authoring (hand-written JSON, the future
TypeScript/Python SDKs, CDK importers) and simulation engines (the TypeScript engine today, possibly
Rust/WASM later). It contains only plain JSON values and no language-specific concepts.

- **Units.** All times are in **seconds**; all rates are **per second**. This is independent of the
  engine's internal tick resolution.
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

## Component types (phase 1: generic components)

`chronon schema` prints these schemas as machine-readable JSON; it is the source of truth.

### `EntityGenerator` — role `source`
| Input | Type | Default | |
|---|---|---|---|
| `mode` | `"interval"` \| `"rateProfile"` | `"interval"` | |
| `interArrivalTime` | sampler (s) | required if `mode` is `interval` | Time between arrivals. |
| `rateProfile` | `[[startSeconds, ratePerSecond], ...]` | required if `mode` is `rateProfile` | Piecewise-constant Poisson rate. Starts strictly increasing; before the first start the rate is 0; the last segment continues forever. |
| `firstArrivalTime` | sampler (s) | `0` | Interval mode: time of the first arrival. RateProfile mode: when the process starts. |
| `maxNumber` | integer ≥ 0 | unlimited | Stop after this many entities. |

Link: `next` (role `receiver`, optional). Outputs: `NumberGenerated`.

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

Links: `queue` (role `pullable`), `next`, `onFailure`, `onThrottle` (role `receiver`, all optional).
Failures: with `onFailure` the entity goes there and is acknowledged; otherwise a `MessageQueue` source
redelivers it after the visibility timeout and anything else loses it (counted in `NumberFailed`).
Throttled entities go to `onThrottle` or are dropped (counted).
Outputs: `Utilisation`, `AverageBusyWorkers`, `BusyWorkers`, `ColdStarts`, `NumberSucceeded`, `NumberFailed`,
`NumberThrottled`, `ThrottleFraction` (throttled / pushed), `StaleAcks`.

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

### Roles
`Queue` has roles `receiver`, `queue`, `pullable`; `MessageQueue` has `receiver`, `pullable`. `Server.queue`
needs role `queue` (so a plain `Queue`); `WorkerPool.queue` needs `pullable` (either).

## Results

`chronon run --json` writes a `RunResults` object (`resultsVersion: 1`): the settings used, one summary
per output (`mean`, `stdDev`, `ci95: {low, high, halfWidth}`, `n`), the raw per-replication values, and
the optional time series. The 95% CI uses Student's t over replications and is `null` for a single
replication. Undefined values (e.g. percentiles of an empty sink) are `null`.

## Full example

See [`examples/traffic-spike.json`](../examples/traffic-spike.json).
