# @surgesim/cli

The `surgesim` command for [Surgesim](https://github.com/NiloyBhattacharjee/surgesim): code-first discrete event simulation for cloud and distributed systems.

```bash
npx @surgesim/cli run model.json --html report.html
npx @surgesim/cli run model.json --assert "sink.p99<=2"     # exit code 3 if violated (use it in CI)
npx @surgesim/cli compare before.json after.json --html diff.html
npx @surgesim/cli import cdk.out/MyStack.template.json --out model.json
```

Install globally with `npm install -g @surgesim/cli` to get the `surgesim` command. Requires Node 20+ (TypeScript model
files need Node 22.18+).

Exit codes: `0` ok, `1` invalid model, `2` usage or I/O error, `3` an assertion failed.

Full documentation: https://github.com/NiloyBhattacharjee/surgesim#readme. Apache-2.0.
