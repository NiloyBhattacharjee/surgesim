# Validating Surgesim against a real (small) system

`service.mjs` is a real queueing service (an HTTP server with a concurrency limit and a FIFO queue), `loadgen.mjs`
drives it with Poisson traffic, and `summarize.mjs` turns its log into the files the calibration commands read. The
procedure fits a model from one run and checks it against a second, separate run.

Unlike `examples/calibration/`, which is simulated, this measures an actual running program, so timer jitter, the
Node event loop and the operating system are all in the data.

## Procedure

Run the load plan twice with different seeds: A is used to fit the model, B to check it.

```bash
# Terminal 1
node validation/real-system/service.mjs --seed 1 --out validation/real-system/runs/A/service-log.jsonl
# Terminal 2 (it stops the service when it is done)
node validation/real-system/loadgen.mjs --seed 101 --plan 8x300,11x120,8x180
node validation/real-system/summarize.mjs validation/real-system/runs/A/service-log.jsonl
```

Repeat with `--seed 2` for the service, `--seed 102` for the load and `runs/B/` for the output.

Fit the model inputs from A (use `pnpm surgesim` instead of `npx @surgesim/cli` inside this repo after `pnpm build`):

```bash
npx @surgesim/cli fit validation/real-system/runs/A/service_times.csv --scale 0.001
npx @surgesim/cli fit-arrivals validation/real-system/runs/A/arrivals.csv --window 30
```

Copy `examples/calibration/model.json`, then set `capacity` to 4, `serviceTime` to the fitted distribution,
`rateProfile` to the fitted segments and `settings.duration` to the number `summarize.mjs` printed. Do not look at
run B while doing this. Then compare:

```bash
npx @surgesim/cli calibrate my-model.json --observed validation/real-system/runs/B/observed.json --sensitivity 5
```

`runs/` is git-ignored.

## What to look at

- `fit` should recover the service-time mean and spread the service printed at startup (plus a little timer jitter).
- `fit-arrivals` should find three segments near 8, 11 and 8 req/s and a dispersion index near 1.
- `calibrate`: utilisation and mean latency should match; the average queue length is the most sensitive metric.
- Do not fit the model from run B, and do not tune it until it matches. That would make the check meaningless.
