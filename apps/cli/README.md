# @chronon-sim/cli

The `chronon` command for [Chronon Sim](https://github.com/NiloyBhattacharjee/chronon-sim): code-first discrete event simulation for cloud and distributed systems.

```bash
npx @chronon-sim/cli run model.json --html report.html
npx @chronon-sim/cli run model.json --assert "sink.p99<=2"     # exit code 3 if violated (use it in CI)
npx @chronon-sim/cli compare before.json after.json --html diff.html
npx @chronon-sim/cli import cdk.out/MyStack.template.json --out model.json
```

Install globally with `npm install -g @chronon-sim/cli` to get the `chronon` command. Requires Node 20+ (TypeScript model
files need Node 22.18+).

Exit codes: `0` ok, `1` invalid model, `2` usage or I/O error, `3` an assertion failed.

Full documentation: https://github.com/NiloyBhattacharjee/chronon-sim#readme. Apache-2.0.
