# @chronon-sim/calibrate

Calibrate Chronon Sim models against real measurements. No Node or DOM APIs.

```ts
import { fitSamples, fitArrivalProfile, parseColumn, compareToObserved } from "@chronon-sim/calibrate";

const durations = parseColumn(csvText, { column: "duration_ms" }).values.map((ms) => ms / 1000);
const fit = fitSamples(durations);              // ranked distributions, best first
console.log(fit.best?.spec);                    // { dist: "lognormal", mean: 0.35, stdDev: 0.2 }

const arrivals = parseColumn(requestLog, { kind: "time" }).values;
console.log(fitArrivalProfile(arrivals, { windowSeconds: 30 }).rateProfile);   // [[0, 8.1], [300, 20.2], [600, 8.1]]

const verdicts = compareToObserved(results, { metrics: { "sink.p99": 1.2 } });  // match / close / off per metric
```

Also `scaleArrivals` and `scaleServiceTimes`, which return a copy of a model with traffic or service times changed, for
sensitivity analysis. See [docs/calibration.md](https://github.com/NiloyBhattacharjee/chronon-sim/blob/main/docs/calibration.md)
for the workflow, what each verdict means, and the pitfalls.

Part of [Chronon Sim](https://github.com/NiloyBhattacharjee/chronon-sim). Apache-2.0.
