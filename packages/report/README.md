# @surgesim/report

Turns Surgesim run results into one self-contained HTML file: assertions, headline numbers, latency percentiles,
charts over time and a results table. It loads nothing from the network, and the same results always produce the
same bytes.

```ts
import { renderReport, renderComparison } from "@surgesim/report";

const html = renderReport(results);
const diff = renderComparison({ label: "before", results: a }, { label: "after", results: b });
```

Details: [docs/reports.md](https://github.com/NiloyBhattacharjee/surgesim/blob/main/docs/reports.md).

Part of [Surgesim](https://github.com/NiloyBhattacharjee/surgesim). Apache-2.0.
