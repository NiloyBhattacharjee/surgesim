import doctest
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import surgesim  # noqa: E402
from surgesim import Model, ModelBuildError, dist, hours, minutes, ms, poisson_arrivals, seconds  # noqa: E402
from surgesim.model import _camel  # noqa: E402

EXAMPLES = os.path.join(os.path.dirname(__file__), "..", "..", "..", "examples")


def example(name):
    with open(os.path.join(EXAMPLES, name), encoding="utf8") as f:
        return json.load(f)


def by_name(model):
    """Component order is not significant, so compare components keyed by name."""
    return {**model, "components": {c["name"]: c for c in model["components"]}}


class RegressionAgainstTheExamples(unittest.TestCase):
    """Rebuilding the hand-written example models from Python must give exactly the same JSON."""

    def test_mm1(self):
        m = Model(
            "M/M/1 queue (lambda=0.8, mu=1)",
            description="Classic M/M/1. Theory: utilisation 0.8, Lq 3.2, Wq 4.0, W 5.0.",
            duration=50000,
            warm_up=5000,
            seed=42,
            replications=10,
        )
        arrivals = m.entity_generator("arrivals", inter_arrival_time=dist.exponential(1.25))
        queue = m.queue("queue")
        sink = m.entity_sink("sink")
        arrivals.link("next", queue)
        m.server("server", capacity=1, service_time=dist.exponential(1), queue=queue, next=sink)
        self.assertEqual(by_name(m.to_dict()), by_name(example("mm1.json")))

    def test_traffic_spike_with_a_time_series(self):
        m = Model(
            "Traffic spike: 50/s -> 250/s for 2 minutes",
            description="Capacity 100 workers x ~2/s each = ~200/s. The spike exceeds capacity, so the backlog grows for 120 s and then drains.",
            duration=600,
            warm_up=0,
            seed=7,
            replications=5,
        )
        traffic = m.entity_generator("traffic", mode="rateProfile", rate_profile=[[0, 50], [180, 250], [300, 50]])
        queue = m.queue("queue")
        sink = m.entity_sink("sink")
        traffic.link("next", queue)
        server = m.server("server", capacity=100, service_time=dist.lognormal(0.5, 0.25), queue=queue, next=sink)
        m.sample_every(5, [queue.output("QueueLength"), server.output("BusyWorkers")])
        self.assertEqual(by_name(m.to_dict()), by_name(example("traffic-spike.json")))


class Building(unittest.TestCase):
    def test_snake_case_arguments_become_the_formats_camel_case_keys(self):
        self.assertEqual(_camel("inter_arrival_time"), "interArrivalTime")
        self.assertEqual(_camel("max_receive_count"), "maxReceiveCount")
        self.assertEqual(_camel("serviceTime"), "serviceTime")  # already camel: unchanged
        self.assertEqual(_camel("concurrency"), "concurrency")
        m = Model("t", duration=1)
        pool = m.worker_pool("p", concurrency=2, service_time=1, on_throttle=m.entity_sink("rej"), cold_start_time=0.5)
        self.assertEqual(
            pool.to_dict(),
            {"type": "WorkerPool", "name": "p", "inputs": {"concurrency": 2, "serviceTime": 1, "coldStartTime": 0.5}, "links": {"onThrottle": "rej"}},
        )

    def test_none_arguments_are_dropped_and_empty_inputs_omitted(self):
        m = Model("t", duration=1)
        m.queue("q", max_length=None)
        self.assertEqual(m.to_dict()["components"], [{"type": "Queue", "name": "q"}])

    def test_settings_only_include_what_was_given(self):
        self.assertEqual(Model("t", duration=5).to_dict()["settings"], {"duration": 5})
        s = Model("t", duration=5, warm_up=1, seed=2, replications=3, ticks_per_second=1000).to_dict()["settings"]
        self.assertEqual(s, {"duration": 5, "warmUp": 1, "seed": 2, "replications": 3, "ticksPerSecond": 1000})

    def test_assertions_and_json_round_trip(self):
        m = Model("t", duration=1)
        sink = m.entity_sink("sink")
        m.assert_that(sink.output("p99"), "<=", 2, name="fast", statistic="ci95High")
        d = m.to_dict()
        self.assertEqual(d["assertions"], [{"output": "sink.p99", "op": "<=", "value": 2, "statistic": "ci95High", "name": "fast"}])
        self.assertEqual(json.loads(m.to_json()), d)
        self.assertEqual(json.loads(m.to_json(indent=None)), d)

    def test_cycles_through_link(self):
        m = Model("t", duration=1)
        ok = m.entity_sink("ok")
        retry = m.retry_policy("retry")
        pool = m.worker_pool("pool", concurrency=1, service_time=1, on_throttle=retry, next=ok)
        retry.link("next", pool)
        self.assertEqual(m.to_dict()["components"][1]["links"], {"next": "pool"})

    def test_custom_components(self):
        m = Model("t", duration=1)
        sink = m.entity_sink("sink")
        c = m.custom("MyThing", "thing", {"x": 1}, {"next": sink})
        self.assertEqual(c.to_dict(), {"type": "MyThing", "name": "thing", "inputs": {"x": 1}, "links": {"next": "sink"}})

    def test_stream(self):
        m = Model("t", duration=1)
        self.assertEqual(m.entity_generator("g", inter_arrival_time=1, stream="s1").to_dict()["stream"], "s1")


class Errors(unittest.TestCase):
    def problems(self, fn):
        with self.assertRaises(ModelBuildError) as ctx:
            fn()
        return ctx.exception.problems

    def test_unknown_arguments_are_rejected_immediately_with_the_valid_ones_listed(self):
        m = Model("t", duration=1)
        problems = self.problems(lambda: m.worker_pool("pool", concurrency=1, service_time=1, concurency=3))
        self.assertEqual(len(problems), 1)
        self.assertEqual((problems[0]["component"], problems[0]["key"]), ("pool", "concurency"))
        self.assertIn("concurrency", problems[0]["message"])

    def test_duplicate_names(self):
        m = Model("t", duration=1)
        m.queue("q")
        self.assertEqual(self.problems(lambda: m.queue("q"))[0]["message"], "duplicate component name")
        self.assertEqual(self.problems(lambda: m.custom("Queue", "q"))[0]["key"], "name")

    def test_a_link_must_be_a_component(self):
        m = Model("t", duration=1)
        self.assertEqual(self.problems(lambda: m.entity_generator("g", next="sink"))[0]["message"], "a link must be another component")

    def test_links_to_other_models_are_caught_when_compiling(self):
        a, b = Model("a", duration=1), Model("b", duration=1)
        foreign = b.entity_sink("sink")
        a.entity_generator("gen", inter_arrival_time=1, next=foreign)
        problems = self.problems(a.to_dict)
        self.assertEqual((problems[0]["component"], problems[0]["key"]), ("gen", "next"))

    def test_output_keys_are_checked(self):
        sink = Model("t", duration=1).entity_sink("sink")
        self.assertEqual(sink.output("p99"), "sink.p99")
        problems = self.problems(lambda: sink.output("p98"))
        self.assertIn("no output 'p98'", problems[0]["message"])

    def test_bad_assertions(self):
        m = Model("t", duration=1)
        self.assertEqual(self.problems(lambda: m.assert_that("a.b", "=<", 1))[0]["key"], "op")
        self.assertEqual(self.problems(lambda: m.assert_that("a.b", "<", 1, statistic="median"))[0]["key"], "statistic")

    def test_the_message_names_every_problem(self):
        m = Model("t", duration=1)
        with self.assertRaises(ModelBuildError) as ctx:
            m.worker_pool("pool", nope=1, also_nope=2)
        self.assertIn("2 problems", str(ctx.exception))
        self.assertIn("pool.nope", str(ctx.exception))


class Helpers(unittest.TestCase):
    def test_distributions_match_the_formats_objects(self):
        self.assertEqual(dist.constant(2), {"dist": "constant", "value": 2})
        self.assertEqual(dist.uniform(1, 2), {"dist": "uniform", "min": 1, "max": 2})
        self.assertEqual(dist.normal(1, 2), {"dist": "normal", "mean": 1, "stdDev": 2})
        self.assertEqual(dist.triangular(1, 2, 3), {"dist": "triangular", "min": 1, "mode": 2, "max": 3})
        self.assertEqual(dist.lognormal(0.5, 0.25), {"dist": "lognormal", "mean": 0.5, "stdDev": 0.25})
        self.assertEqual(dist.empirical([(0, 1), (0.9, 2), (1, 5)]), {"dist": "empirical", "points": [[0, 1], [0.9, 2], [1, 5]]})
        self.assertEqual(poisson_arrivals(4), {"dist": "exponential", "mean": 0.25})

    def test_time_helpers_return_seconds(self):
        self.assertEqual([ms(250), seconds(3), minutes(2), hours(1)], [0.25, 3, 120, 3600])

    def test_the_package_exposes_a_version_and_the_format_version(self):
        self.assertEqual(surgesim.MODEL_FORMAT_VERSION, 1)
        self.assertRegex(surgesim.__version__, r"^\d+\.\d+\.\d+$")


class Doctests(unittest.TestCase):
    def test_docstring_examples_run(self):
        import surgesim.model as model_module

        result = doctest.testmod(model_module)
        self.assertEqual(result.failed, 0)
        self.assertGreater(result.attempted, 0)


if __name__ == "__main__":
    unittest.main()
