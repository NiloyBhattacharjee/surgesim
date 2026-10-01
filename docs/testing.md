# Testing

There are four layers, from fast and exact to slow and broad.

| Layer | Where | What it catches |
|---|---|---|
| **Example-based tests** | `packages/*/test`, `apps/*/test`, `sdks/python/tests` | Specific behaviours with hand-calculated answers: queue timelines, Erlang-B, token buckets, CLI exit codes. |
| **Property-based tests** | `packages/engine/test/properties.test.ts` | Rules that must hold for *any* input: the heap sorts, events run in the documented order, a model never loses a request, the loader never throws, a mutated model never crashes or hangs. |
| **Cross-checks** | `packages/sdk/test/python.test.ts`, `calibration` (see [calibration.md](calibration.md)) | Two independent routes agreeing: TypeScript SDK versus Python SDK, and the simulator versus an independent simulator. |
| **Continuous integration** | `.github/workflows/` | The same suite on Linux, macOS and Windows with Node 20 and 22, Python 3.9 to 3.13, plus the exit codes and the packaged install. |

```bash
pnpm test           # everything in TypeScript (about 270 tests, a few seconds)
pnpm test:py        # the Python SDK's own tests
pnpm typecheck
```

## Property-based tests

Instead of a handful of chosen examples, each property is checked against many generated inputs, using
[fast-check](https://fast-check.dev). When one fails, fast-check **shrinks** the input to a minimal case and prints the
**seed**. The seed is fixed by default so the suite is deterministic. You can search harder:

```bash
FC_SEED=12345 FC_RUNS=5000 FC_MUTATION_RUNS=50000 pnpm vitest run packages/engine/test/properties.test.ts
FC_VERBOSE=1 pnpm vitest run packages/engine/test/properties.test.ts -t "mutated model"   # prints how many mutations ran
```

| Variable | Meaning | Default |
|---|---|---|
| `FC_SEED` | Starting seed. A failure prints the seed that reproduces it. | 20241002 |
| `FC_RUNS` | Inputs per property. | 150 |
| `FC_MUTATION_RUNS` | Mutated models for the fuzz test (most are rejected by validation, so this is larger). | 1000 |
| `FC_VERBOSE` | Print the fuzzer's tally of rejected, run and stopped models. | off |

The most useful property is the **mutation fuzz**: it takes a valid model that uses every component, edits one random
place (to an edge-case number, another component's name, garbage, or nothing), and requires the result to be either
rejected with structured errors or simulated to the end. It also checks that a healthy share of the mutations really
ran, so it cannot pass by rejecting everything.

### What these tests have found

- A valid model with `interArrivalTime: 0` and no limit spun at one instant until the process crashed with an unreadable
  "Invalid array length" (or hung). The kernel now stops it after 10 million events at one instant, with a clear message.
- A lognormal time with an extreme mean or spread (a subnormal mean, or a standard deviation around 1e153) produced NaN,
  which reached the scheduler as an unexplained `RangeError`. The sampler now computes that term without overflow.
- A delay of more than about 285 years overflowed to Infinity and was rejected by the scheduler. Delays are now capped,
  because an event that far away never happens during the run.
- The loader skipped holes in arrays (`every()` ignores them), so a sparse `outputs` list was accepted and crashed later.

## Continuous integration

- `ci.yml` runs on every push to `main` and every pull request: type check, build, all tests and a smoke run of the built
  command line on **Node 20 and 22 × Linux, macOS, Windows**; the Python SDK on **3.9 to 3.13**; the exit codes of the
  capacity gates (0 passes, 3 limit violated, 1 invalid model); and `npm pack` of every package followed by installing
  the tarballs into an empty project and running the CLI from there.
- `fuzz.yml` runs weekly (and on demand) with a different seed and a much larger budget. A failure prints the seed.

The workflows were checked with [actionlint](https://github.com/rhysd/actionlint). The test suite was run locally on
Node 20, 22 and 24 and the Python tests on 3.11, 3.13 and 3.14. The matrix cells for macOS, Linux and Python 3.9 to 3.10
run only on GitHub, so they have not been observed yet.
