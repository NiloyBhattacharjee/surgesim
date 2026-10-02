# HTML reports and comparisons

```bash
surgesim run model.json --html report.html                 # run, then write the report
surgesim run model.json --json results.json                # save results...
surgesim report results.json --html report.html            # ...render them later, without re-running
surgesim compare base.json candidate.json --html diff.html # two results files, or two models (they are run first)
```

A report is **one self-contained HTML file**: inline CSS, inline SVG charts, one small inline script for hover.
It loads nothing from the network, so it can be attached to a PR, a ticket or an email, and opened offline.
The same results always produce the same bytes (there are no timestamps), so reports diff cleanly.

## A report contains

- **Assertions**, if the model has any, as PASS / FAIL rows (an icon and a word, never color alone).
- **Headlines**: tiles for the numbers that usually matter (p99 latency, completions, utilisation, peak queue length,
  throttled share, dead-lettered, retry amplification, cost), each with its 95% confidence interval.
- **Latency**: p50 / p95 / p99 bars per sink, with a whisker for the 95% interval across replications.
- **Over time**: one chart per sampled series (backlog, concurrency, ...). The line is the mean across replications; the
  shaded band spans the smallest to the largest replication. Hover (or focus and use the arrow keys) for a crosshair and
  a tooltip. Each chart has a **table view** with every value, so nothing depends on hovering.
- **All results**: every output of every component with mean, interval, standard deviation and n.

Charts follow one rule: one y-axis per chart. Different measures get different charts, never a dual axis.

## A comparison contains

- both runs' assertions side by side,
- **Biggest differences**: the largest changes among outputs that *differ*,
- a table of every shared output: both means, the change (**B minus A**, in the output's own unit), the percentage,
  and a verdict,
- both runs overlaid on each shared time series (A is a blue circle, B an orange square, so the two are distinguishable
  without color).

**"Differs" means the two 95% confidence intervals do not overlap.** That is a conservative check: two runs can
still differ when their intervals overlap slightly, but if the intervals are separate the difference is not noise. It
needs 2+ replications on both sides; with one replication the verdict reads "needs 2+ replications" and nothing is
called significant. Arrows show direction only. Whether higher is *better* depends on the output, and the report
does not guess.

Outputs present on only one side are listed rather than dropped. Series are only overlaid when both runs sampled at the
same times.

## Embedding

`@surgesim/report` is plain TypeScript with no Node or DOM APIs: `renderReport(results)` and
`renderComparison({label, results}, {label, results})` return strings. Use them in a build step, a server, or in the
browser (see the demo).

## Theming and print

Colors are CSS variables. The page follows the OS light/dark setting, or set `data-theme="light"` / `"dark"` on
`<html>`. Printing hides tooltips and keeps cards together; `forced-colors` mode switches the lines to system colors and
dashes the second series.
