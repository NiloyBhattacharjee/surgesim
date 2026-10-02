"""The model builder: describe a system in Python, compile it to the JSON model format (version 1)."""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .specs import SPECS

MODEL_FORMAT_VERSION = 1

_OPS = ("<", "<=", ">", ">=", "==")
_STATISTICS = ("mean", "ci95Low", "ci95High", "min", "max")


class ModelBuildError(Exception):
    """An authoring mistake. ``problems`` is a list of ``{"component", "key", "message"}`` dicts, the same
    shape the engine's validation errors use."""

    def __init__(self, problems: List[Dict[str, Optional[str]]]):
        self.problems = problems
        lines = []
        for p in problems:
            where = ".".join(x for x in (p.get("component"), p.get("key")) if x) or "(model)"
            lines.append(f"  - {where}: {p['message']}")
        noun = "problem" if len(problems) == 1 else "problems"
        super().__init__(f"Model has {len(problems)} {noun}:\n" + "\n".join(lines))


def _camel(name: str) -> str:
    """``inter_arrival_time`` -> ``interArrivalTime``. Names already in camelCase pass through unchanged."""
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


class Component:
    """A component being authored. Create these with the ``Model`` builder methods."""

    def __init__(self, type: str, name: str, inputs: Dict[str, Any], stream: Optional[str] = None):  # noqa: A002
        self.type = type
        self.name = name
        self.inputs = inputs
        self.stream = stream
        self._links: Dict[str, "Component"] = {}

    def link(self, key: str, target: "Component") -> "Component":
        """Point a link at another component. Use this for forward references and cycles (a pool's
        ``on_throttle`` back to the retry policy that feeds it), which cannot be passed at creation."""
        self._links[_camel(key)] = target
        return self

    def output(self, key: str) -> str:
        """The id of one of this component's outputs, e.g. ``"sink.p99"``, for assertions and time series."""
        known = SPECS.get(self.type, {}).get("outputs")
        if known is not None and key not in known:
            raise ModelBuildError(
                [{"component": self.name, "key": key, "message": f"{self.type} has no output {key!r} (outputs: {', '.join(known)})"}]
            )
        return f"{self.name}.{key}"

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"type": self.type, "name": self.name}
        inputs = {k: v for k, v in self.inputs.items() if v is not None}
        if inputs:
            out["inputs"] = inputs
        if self._links:
            out["links"] = {k: target.name for k, target in self._links.items()}
        if self.stream is not None:
            out["stream"] = self.stream
        return out


class Model:
    """A system under construction. Add components with the builder methods, connect them with the
    ``next=`` / ``queue=`` / ... arguments (or :meth:`Component.link` for cycles), then call :meth:`to_dict`.

    >>> m = Model("checkout", duration=600, replications=5)
    >>> sink = m.entity_sink("done")
    >>> pool = m.worker_pool("workers", concurrency=50, service_time=0.5, next=sink)
    >>> _ = m.entity_generator("traffic", inter_arrival_time=0.02, next=pool)
    >>> _ = m.assert_that(sink.output("p99"), "<=", 2)
    """

    def __init__(
        self,
        name: str,
        *,
        duration: float,
        warm_up: Optional[float] = None,
        seed: Optional[int] = None,
        replications: Optional[int] = None,
        ticks_per_second: Optional[int] = None,
        description: Optional[str] = None,
    ):
        self.name = name
        self.description = description
        self._settings: Dict[str, Any] = {"duration": duration}
        for key, value in (("warmUp", warm_up), ("seed", seed), ("replications", replications), ("ticksPerSecond", ticks_per_second)):
            if value is not None:
                self._settings[key] = value
        self._components: Dict[str, Component] = {}
        self._assertions: List[Dict[str, Any]] = []
        self._time_series: Optional[Dict[str, Any]] = None

    # ---- components

    def _make(self, type: str, name: str, props: Dict[str, Any]) -> Component:  # noqa: A002
        spec = SPECS[type]
        problems: List[Dict[str, Optional[str]]] = []
        if name in self._components:
            problems.append({"component": name, "key": "name", "message": "duplicate component name"})
        if not isinstance(name, str) or name.strip() == "":
            problems.append({"component": str(name), "key": "name", "message": "must be a non-empty string"})
        inputs: Dict[str, Any] = {}
        links: List[Tuple[str, Component]] = []
        stream: Optional[str] = None
        for raw_key, value in props.items():
            if value is None:
                continue
            key = _camel(raw_key)
            if key == "stream":
                stream = value
            elif key in spec["links"]:
                if not isinstance(value, Component):
                    problems.append({"component": name, "key": key, "message": "a link must be another component"})
                else:
                    links.append((key, value))
            elif key in spec["inputs"]:
                inputs[key] = value
            else:
                valid_in = ", ".join(spec["inputs"]) or "none"
                valid_links = ", ".join(spec["links"]) or "none"
                problems.append(
                    {"component": name, "key": raw_key, "message": f"unknown argument for {type} (inputs: {valid_in}; links: {valid_links})"}
                )
        if problems:
            raise ModelBuildError(problems)
        component = Component(type, name, inputs, stream)
        for key, target in links:
            component.link(key, target)
        self._components[name] = component
        return component

    def entity_generator(self, name: str, **props: Any) -> Component:
        """Arrivals: a fixed or random inter-arrival time, or a piecewise-constant Poisson rate profile."""
        return self._make("EntityGenerator", name, props)

    def queue(self, name: str, **props: Any) -> Component:
        """FIFO queue with an optional ``max_length``."""
        return self._make("Queue", name, props)

    def server(self, name: str, **props: Any) -> Component:
        """``capacity`` parallel workers pulling from a Queue (``queue=`` is required by the engine)."""
        return self._make("Server", name, props)

    def entity_sink(self, name: str, **props: Any) -> Component:
        """Consumes entities and records their time in system."""
        return self._make("EntitySink", name, props)

    def message_queue(self, name: str, **props: Any) -> Component:
        """SQS-style queue: visibility timeout, redelivery, dead-letter queue."""
        return self._make("MessageQueue", name, props)

    def worker_pool(self, name: str, **props: Any) -> Component:
        """Concurrency-limited workers with cold starts, throttling and failures."""
        return self._make("WorkerPool", name, props)

    def retry_policy(self, name: str, **props: Any) -> Component:
        """Retries failed attempts with exponential backoff and jitter."""
        return self._make("RetryPolicy", name, props)

    def rate_limiter(self, name: str, **props: Any) -> Component:
        """Token-bucket rate limiter."""
        return self._make("RateLimiter", name, props)

    def autoscaler(self, name: str, **props: Any) -> Component:
        """Target-tracking autoscaler for a WorkerPool."""
        return self._make("Autoscaler", name, props)

    def custom(self, type: str, name: str, inputs: Optional[Dict[str, Any]] = None, links: Optional[Dict[str, Component]] = None) -> Component:  # noqa: A002
        """Add a component of any type, including ones from a custom engine registry."""
        if name in self._components:
            raise ModelBuildError([{"component": name, "key": "name", "message": "duplicate component name"}])
        component = Component(type, name, dict(inputs or {}))
        for key, target in (links or {}).items():
            component.link(key, target)
        self._components[name] = component
        return component

    # ---- assertions, sampling, output

    def assert_that(
        self,
        output: str,
        op: str,
        value: float,
        *,
        statistic: Optional[str] = None,
        name: Optional[str] = None,
    ) -> "Model":
        """Require a threshold to hold after the run (the CLI exits with code 3 otherwise).

        ``output`` is an id from ``component.output("p99")``.
        """
        problems: List[Dict[str, Optional[str]]] = []
        if op not in _OPS:
            problems.append({"component": None, "key": "op", "message": f"must be one of {', '.join(_OPS)}"})
        if statistic is not None and statistic not in _STATISTICS:
            problems.append({"component": None, "key": "statistic", "message": f"must be one of {', '.join(_STATISTICS)}"})
        if problems:
            raise ModelBuildError(problems)
        a: Dict[str, Any] = {"output": output, "op": op, "value": value}
        if statistic is not None:
            a["statistic"] = statistic
        if name is not None:
            a["name"] = name
        self._assertions.append(a)
        return self

    def sample_every(self, interval_seconds: float, outputs: Iterable[str]) -> "Model":
        """Sample these outputs every ``interval_seconds``, for backlog-over-time plots."""
        self._time_series = {"interval": interval_seconds, "outputs": list(outputs)}
        return self

    def to_dict(self) -> Dict[str, Any]:
        """Compile to the JSON model format. Raises :class:`ModelBuildError` if a link points at a
        component that is not part of this model."""
        problems: List[Dict[str, Optional[str]]] = []
        for c in self._components.values():
            for key, target in c._links.items():
                if self._components.get(target.name) is not target:
                    problems.append({"component": c.name, "key": key, "message": f'links to "{target.name}", which is not a component of this model'})
        if problems:
            raise ModelBuildError(problems)
        settings = dict(self._settings)
        if self._time_series is not None:
            settings["timeSeries"] = self._time_series
        model: Dict[str, Any] = {"version": MODEL_FORMAT_VERSION, "name": self.name}
        if self.description is not None:
            model["description"] = self.description
        model["settings"] = settings
        model["components"] = [c.to_dict() for c in self._components.values()]
        if self._assertions:
            model["assertions"] = list(self._assertions)
        return model

    def to_json(self, indent: Optional[int] = 2) -> str:
        """The model as a JSON string."""
        return json.dumps(self.to_dict(), indent=indent)
