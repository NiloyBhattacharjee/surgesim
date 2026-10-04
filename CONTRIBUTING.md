# Contributing to Surgesim

Thanks for your interest. Bug reports, model examples that break the engine, and pull requests are all welcome.

## Set up

You need Node 20+ and [pnpm](https://pnpm.io/) (the exact version is pinned in `package.json`).

```bash
pnpm install
pnpm build
pnpm test        # the full suite, including the cross-check against an independent simulator
pnpm typecheck
```

The Python SDK has its own tests: `pnpm test:py`. [docs/testing.md](docs/testing.md) explains what each suite covers.

## Ground rules

- **The engine stays portable.** `@surgesim/engine` uses no DOM and no Node APIs (no `fs`, no `process`) and has no runtime
  dependencies, so it runs in a Web Worker as well as in Node. File I/O, the clock and logging go behind the interfaces
  in `@surgesim/platform`. The demo's purity test fails if this is broken.
- **The JSON model format is a contract.** It is versioned and documented in [docs/model-format.md](docs/model-format.md),
  and the TypeScript and Python SDKs compile to it. Change it deliberately and update the document in the same pull
  request.
- **Simulations are deterministic.** Each component draws from its own random stream derived from (seed, component
  name). Never share a stream between components.
- **Components are callback state machines** scheduled on `kernel.schedule`: no generators, coroutines or blocking waits.
- **Validation returns structured errors** (component, key, message). Do not throw strings.
- **Statistical claims need tests against known values**: closed forms, published tables, or the SimPy reference in
  `validation/`, not only self-consistency.

## Pull requests

1. Open an issue first for anything large, so we can agree on the approach.
2. Keep the change focused, and add or update tests. `pnpm test` and `pnpm typecheck` must pass.
3. Update the README or the relevant page in `docs/` if users can see the change, and add a line under **Unreleased** in
   [CHANGELOG.md](CHANGELOG.md).
4. Write commit messages that say what changed and why.

## Reporting bugs

Use the bug report template. The most useful report includes the model file (or a cut-down version), the command you ran,
the installed version (`npm ls @surgesim/cli`), and what you expected to see. Security problems go through [SECURITY.md](SECURITY.md),
not public issues.

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
