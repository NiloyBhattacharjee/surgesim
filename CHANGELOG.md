# Changelog

All notable changes to Surgesim are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the packages use [semantic versioning](https://semver.org/) (pre-1.0: minor versions may change behaviour).

## [Unreleased]

### Changed
- CLI errors are shorter: a usage error prints the error and a pointer to `surgesim --help` instead of the full help,
  an unknown command says so (it used to report `expected "surgesim run <model>"`), and a missing file reads
  `file not found` instead of Node's raw `ENOENT` message.
- The `run` table labels current-value outputs such as `QueueLength` and `BusyWorkers` as `(at end)`, and the
  `compare` summary puts the test it used on its own line.
- `surgesim compare` now decides whether an output "differs" with a t-test on the per-replication values instead of
  checking whether the two 95% confidence intervals overlap. When both runs used the same replication seeds it runs a
  paired t-test, which cancels the noise the runs share; otherwise it runs Welch's t-test. p-values are adjusted across
  all compared outputs (Benjamini-Hochberg), so the share of chance results among the outputs marked "differs" stays at
  or below 5%. Comparisons with the same seeds will flag more real differences than before.

### Added
- Bursty arrivals: `EntityGenerator` takes a `dispersionIndex` (default 1, Poisson). Above 1, arrivals come in
  simultaneous batches of geometric size, so arrival counts have variance that many times their mean, at the same
  average rate. `dispersionIndex` / `dispersion_index` in both SDKs. `surgesim fit-arrivals` adds it to the inputs it
  prints when the measured traffic is clearly bursty. On clustered traffic at 80% utilisation it brings p99 from 61% too
  low to within the noise of the ground truth (`validation/bursty_arrivals.mjs`). The input is capped at 1000. Models
  without it give identical results.
- Comparison reports show the 95% confidence interval of the change, the adjusted p-value, which test was used, a
  per-replication strip plot for the biggest differences, and a table of every per-replication value.
- Single-run reports list the per-replication value of every output.
- `@surgesim/engine` exports `welchTTest`, `pairedTTest`, `adjustPValues`, `tTwoSidedP`, `tCdf` and `tQuantile`
  (dependency-free).

## [0.1.3] - 2026-10-02

### Changed
- Renamed the project from Chronon Sim to Surgesim: packages are now `@surgesim/*` and the command is `surgesim`.

## [0.1.2] - 2026-10-02

### Fixed
- `fit-arrivals` lost rate steps when fitting a rate profile.

### Added
- Validation against a real running system, and a release-time check of the npm token format.

## [0.1.1] - 2026-10-02

### Added
- First npm release. Tag-triggered, automated publishing with safety checks and a releasing guide.

[Unreleased]: https://github.com/NiloyBhattacharjee/surgesim/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/NiloyBhattacharjee/surgesim/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/NiloyBhattacharjee/surgesim/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/NiloyBhattacharjee/surgesim/releases/tag/v0.1.1
