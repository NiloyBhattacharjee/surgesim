"""Build a model that uses every component type and print it as JSON (used by the cross-language test)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from surgesim import Model, dist, minutes, ms  # noqa: E402

m = Model("orders (python)", duration=300, warm_up=30, replications=3, seed=9, description="Built with the Python SDK")

ok = m.entity_sink("ok")
failed = m.entity_sink("failed")
dlq = m.entity_sink("dlq")
orders = m.message_queue("orders", visibility_timeout=20, max_receive_count=3, dead_letter=dlq)
retry = m.retry_policy("retry", max_attempts=4, base_delay=ms(250), jitter="full", give_up=failed)
pool = m.worker_pool(
    "pool",
    concurrency=20,
    service_time=dist.lognormal(0.4, 0.2),
    cold_start_time=dist.constant(1),
    idle_timeout=minutes(1),
    failure_probability=0.05,
    queue=orders,
    next=ok,
    on_failure=retry,
)
limiter = m.rate_limiter("limiter", rate=60, burst=100, next=retry)
retry.link("next", orders)  # a forward reference / cycle
m.autoscaler("scaler", max_concurrency=80, target_utilisation=0.6, target=pool)
m.entity_generator("traffic", inter_arrival_time=dist.exponential(1 / 30), next=limiter)

m.assert_that(ok.output("p99"), "<=", 60, name="p99")
m.assert_that(pool.output("NumberThrottled"), "==", 0, statistic="max")
m.sample_every(10, [orders.output("Backlog"), pool.output("Concurrency")])

print(m.to_json())
