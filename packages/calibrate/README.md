# @surgesim/calibrate

Calibrate Surgesim models against real measurements. No Node or DOM APIs.

```ts
import { fitSamples, fitArrivalProfile, parseColumn, compareToObserved } from "@surgesim/calibrate";

const durations = parseColumn(csvText, { column: "duration_ms" }).values.map((ms) => ms / 1000);
const fit = fitSamples(durations);              // ranked distributions, best first
console.log(fit.best?.spec);                    // { dist: "lognormal", mean: 0.35, stdDev: 0.2 }

const arrivals = parseColumn(requestLog, { kind: "time" }).values;
console.log(fitArrivalProfile(arrivals, { windowSeconds: 30 }).rateProfile);   // [[0, 8.1], [300, 20.2], [600, 8.1]]

const verdicts = compareToObserved(results, { metrics: { "sink.p99": 1.2 } });  // match / close / off per metric
```

## A complete example

Save this as `check.mjs` and run `npm install @surgesim/engine @surgesim/calibrate && node check.mjs`. It builds a
model, runs it and compares two of its outputs with measured values:

```js
import { loadModel, runModel } from "@surgesim/engine";
import { compareToObserved } from "@surgesim/calibrate";

// 1. A model: 8 requests/s into a queue, served by 4 workers whose service time is lognormal (mean 0.3 s).
const loaded = loadModel({
  version: 1,
  settings: { duration: 600, replications: 20, seed: 1 },
  components: [
    { type: "EntityGenerator", name: "traffic", inputs: { mode: "rateProfile", rateProfile: [[0, 8]] }, links: { next: "queue" } },
    { type: "Queue", name: "queue" },
    { type: "Server", name: "server", inputs: { capacity: 4, serviceTime: { dist: "lognormal", mean: 0.3, stdDev: 0.15 } }, links: { queue: "queue", next: "sink" } },
    { type: "EntitySink", name: "sink" },
  ],
});
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors)); // every problem is reported at once

// 2. Run it. `results.outputs` is an array with one summary per output ({ id, mean, ci95, ... }), not an object
//    keyed by name, so look an output up by its id, "<component name>.<output key>".
const results = runModel(loaded.model);
console.log(results.outputs.find((o) => o.id === "sink.p99")?.mean); // about 0.91 seconds

// 3. Compare with what you measured (seconds, and utilisation as a fraction). `periods` is how many independent
//    periods of data each measurement averages over (1 for a single day or run).
const comparison = compareToObserved(results, { periods: 1, metrics: { "sink.p99": 1.0, "server.Utilisation": 0.62 } });
for (const row of comparison.rows) console.log(row.id, row.observed, row.model, row.verdict); // match | close | off | missing
```

To get a model's inputs from measurements rather than guessing them, use `fitSamples` for service times and
`fitArrivalProfile` for traffic, as above.

Also `scaleArrivals` and `scaleServiceTimes`, which return a copy of a model with traffic or service times changed, for
sensitivity analysis. See [docs/calibration.md](https://github.com/NiloyBhattacharjee/surgesim/blob/main/docs/calibration.md)
for the workflow, what each verdict means, and the pitfalls.

Part of [Surgesim](https://github.com/NiloyBhattacharjee/surgesim). Apache-2.0.
