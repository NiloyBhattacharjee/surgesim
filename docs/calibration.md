# Calibration: checking the model against reality

A simulator is only as good as its inputs and its engine. Chronon Sim checks both:

1. **The engine** is cross-checked against an independent simulator (SimPy) and against exact queueing theory.
2. **Your model** can be fitted from measurements and then compared with what the real system did, with the
   `fit`, `fit-arrivals` and `calibrate` commands.

> **The data in `examples/calibration/` is synthetic.** It was produced by simulating a known system with SimPy, so
> that the right answers are known and the tests can check that the tools recover them. It is not production data.
> Everything below works the same way on a real export; real data will be noisier and messier.

## 1. The engine against an independent simulator

`validation/simpy_reference.py` is a separate implementation of the same basic system, built differently on purpose:
the clock comes from SimPy, time-varying arrivals use thinning (Chronon Sim draws piecewise-exponential gaps), the random
numbers are Python's, and every statistic is computed from scratch. The reference itself first reproduces textbook
M/M/1 values.

`packages/engine/test/crosscheck.test.ts` runs six scenarios through both and compares 53 metrics, requiring the means to
agree within 3.5 standard errors:

| Scenario | Metrics compared |
|---|---|
| M/M/1 (ρ 0.8) and M/M/5 (ρ 0.8) | utilisation, queue length, wait, time in system, p50/p95/p99, throughput |
| M/G/3 with lognormal service (cv 0.5) | the same |
| M/G/2 with heavy-tailed lognormal service (cv 2) | the same |
| M/M/2/20 under permanent overload (bounded queue) | the same, plus drops, arrivals and maximum queue length |
| A 5x traffic spike into 20 workers | the same, plus maximum queue length |

All 53 agree (median |z| 0.55; for pure sampling noise about 0.67). Two checks keep that from being hollow:

- **The comparison has teeth.** The test also feeds Chronon Sim a service time only 4% slower than the reference and
  requires the disagreement to be detected.
- **A suspicious pattern was chased down.** In the M/M/5 scenario every metric sat 2 to 3 standard errors on one
  side. Rerunning it with 8 times the statistical power, both simulators landed on the exact Erlang-C answer
  (mean queue length 2.2165): Chronon Sim at 2.2135, SimPy at 2.2165. It was sampling noise, not bias.

## 2. The workflow on measurements

You need three things from your monitoring tool: how long requests take to **process** (not end to end), when they
**arrive**, and some end-to-end numbers to compare against.

```bash
# 1. Service times. A Lambda "Duration" export is in milliseconds, so scale to seconds.
chronon fit examples/calibration/service_times.csv --scale 0.001

# 2. Arrival rate over time, from one timestamp per request (ISO dates or numbers).
chronon fit-arrivals examples/calibration/arrivals.csv --window 30

# 3. Build a model from those numbers plus what you know (workers, limits), then compare.
chronon calibrate examples/calibration/model.json --observed examples/calibration/observed.json
```

### `chronon fit`

Fits the distributions the model format supports (exponential, lognormal, normal, uniform, triangular, constant) and ranks
them by the Kolmogorov-Smirnov distance. On the example it chose lognormal decisively and recovered the truth:

```
family        KS         parameters
lognormal     0.007355   {"dist":"lognormal","mean":0.3504,"stdDev":0.1982}      (true: 0.35 and 0.20)
normal        0.1122     {"dist":"normal","mean":0.3508,"stdDev":0.2013}
exponential   0.2603     ...
```

It warns when nothing fits well (a mixture of fast and slow requests, for example, which one distribution would
misrepresent), when values are negative or zero (some families are skipped), and when there are too few samples. Use
`--column NAME` or a 0-based index when the file has several columns.

### `chronon fit-arrivals`

Counts arrivals in windows and merges neighbouring windows that cannot be told apart statistically, so noise does not
produce a jagged profile but a real change (a spike, a daily cycle) does produce a new segment. A window that straddles
a step is recognised and the breakpoint is placed inside it. On the example (truth: 8/s, then 20/s from 300 s, then 8/s
from 600 s):

```
from (s)    per second
0           8.173
300.3       20.23
600.5       8.13
```

It also reports a **dispersion index**: about 1 means Poisson-like arrivals, which is what the model assumes. A value well
above 1 means bursty traffic, and a Poisson model will understate queueing and tail latency. The segmentation allows for
that burstiness instead of mistaking bursts for rate changes.

### `chronon calibrate`

Runs the model and compares chosen outputs with measured values:

```json
{ "tolerance": 0.15, "periods": 1,
  "metrics": { "sink.p99": 1.215, "server.Utilisation": { "value": 0.534, "low": 0.52, "high": 0.55 } } }
```

| Verdict | Meaning |
|---|---|
| `match` | The measurement lies inside the range the model expects for a single measurement. The real system could plausibly have produced it. |
| `close` | Outside that range, but within the tolerance of the model's mean. |
| `off` | Further away. Exit code 3, so it can gate a build. |
| `missing` | The model has no value for that output. |

**Why "the range for a single measurement" and not the model's confidence interval.** A measurement is one sample of
a noisy quantity: tomorrow's p99 will differ from today's even if nothing changed. The model's confidence interval says
how precisely the *average* is known, and it shrinks as you add replications, so comparing one real day against it would
make a perfect model fail more often the more you simulate. The tool uses the 95% prediction interval,
`mean ± t × sd × √(1/periods + 1/replications)`, where `periods` is how many independent periods your measurement
averages over. This was found the hard way: on the example, a typical day (24th to 93rd percentile of the true system on
every metric) was first judged "off" by the narrower check.

## 3. What the validation taught

Because the ground truth is known, the whole chain could be tested:

| Model | Result against the true system (200 simulated days) |
|---|---|
| Chronon Sim with the **true** inputs | Agrees on every queue and latency metric (|z| ≤ 0.4). The engine is right. |
| Chronon Sim with the **fitted** inputs | Mean queue length 16% high, p99 and mean latency a few percent high. |

The gap comes entirely from input error. The fitted arrival rates came from one noisy day (10,961 arrivals, 1.5% above
the expected 10,800), and near capacity small input errors are amplified. `--sensitivity 5` shows this directly:

```
Sensitivity: the arrival rate off by 5% in each direction
output                      -5%       as modelled   +5%        span
sink.p99                    1.231     1.432         1.907      47% of model
queue.AverageQueueLength    0.7259    1.281         2.517      140% of model
```

So three honest rules follow:

1. **Close to capacity, an output is only as accurate as the measurement of its inputs.** Check sensitivity. A model of
   a system at 90% utilisation needs arrival and service times known to a percent or two for queue lengths to mean much.
2. **One period of data can only expose large errors.** The report prints the detection limit (here, about 43% in the
   noisiest output). The tool did reliably catch a model with 6 workers instead of 8 (latency 40 times too high), one
   with service times 30% too slow, and even 7 workers instead of 8. Smaller errors stay hidden until you have more
   periods.
3. **Passing is not proof.** It means the model is consistent with the data it was built from. Check it on a period it
   was not fitted on.

## 4. Pitfalls with real data

- **Fit service time from processing time, not end-to-end latency.** End-to-end latency already includes waiting; fitting
  it as a service time double counts queueing and makes the model far too pessimistic.
- **Use steady, representative periods.** Include the spikes you care about, but exclude outages and deploys unless you
  model them.
- **Use the same units.** The model works in seconds; use `--scale` (0.001 for milliseconds).
- **The fits assume independent, identically distributed samples.** Service times that drift (a slow dependency, a cold
  start every N requests) are not captured by a single distribution; the mixture warning will often be the sign.
- **Concurrency, retries, timeouts and limits come from configuration**, not from the fitting commands.

## Reproducing the experiments

```bash
python validation/make_calibration_example.py examples/calibration   # regenerate the synthetic export
pnpm vitest run packages/engine/test/crosscheck.test.ts              # engine vs SimPy (needs: pip install simpy)
CROSSCHECK_VERBOSE=1 pnpm vitest run packages/engine/test/crosscheck.test.ts   # print every comparison
pnpm vitest run packages/calibrate apps/cli                          # the fitting and calibration tests
```
