# surgesim (Python SDK)

Describe a system in Python and compile it to the Surgesim JSON model format. Pure standard library, no
dependencies. The SDK never simulates anything: the JSON it emits is the contract, and the engine runs it.

```python
from surgesim import Model, dist

m = Model("checkout", duration=600, replications=5, seed=7)
done = m.entity_sink("done")
pool = m.worker_pool("workers", concurrency=50, service_time=dist.lognormal(0.5, 0.25), next=done)
m.entity_generator("traffic", inter_arrival_time=dist.exponential(0.02), next=pool)
m.assert_that(done.output("p99"), "<=", 2, name="p99 under 2 s")

open("model.json", "w").write(m.to_json())
```

```bash
surgesim run model.json --html report.html
```

Argument names are snake_case and become the format's camelCase keys (`service_time` -> `serviceTime`).
Mistakes raise `ModelBuildError` with structured `problems` (`component`, `key`, `message`). Semantic validation
(ranges, required inputs, link roles) is left to the engine, so `surgesim run` reports it the same way for every
authoring route. See [docs/sdk.md](../../docs/sdk.md) for the model it maps to.

`assert` is a Python keyword, so assertions are added with `assert_that(...)`.

## Tests

```bash
python -m unittest discover -s tests          # from sdks/python
```
