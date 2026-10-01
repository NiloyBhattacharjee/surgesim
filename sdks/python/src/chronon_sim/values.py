"""Value helpers. Everything returns plain JSON-compatible values matching the model format."""

from __future__ import annotations

from typing import Dict, Union

Distribution = Dict[str, Union[str, float]]


class dist:  # noqa: N801 - lower-case on purpose: reads as ``dist.exponential(0.5)``
    """Builders for the distributions the format supports. All time parameters are in seconds."""

    @staticmethod
    def constant(value: float) -> Distribution:
        return {"dist": "constant", "value": value}

    @staticmethod
    def uniform(min: float, max: float) -> Distribution:  # noqa: A002
        return {"dist": "uniform", "min": min, "max": max}

    @staticmethod
    def exponential(mean: float) -> Distribution:
        """Exponential with the given mean (so rate = 1 / mean)."""
        return {"dist": "exponential", "mean": mean}

    @staticmethod
    def normal(mean: float, std_dev: float) -> Distribution:
        return {"dist": "normal", "mean": mean, "stdDev": std_dev}

    @staticmethod
    def triangular(min: float, mode: float, max: float) -> Distribution:  # noqa: A002
        return {"dist": "triangular", "min": min, "mode": mode, "max": max}

    @staticmethod
    def lognormal(mean: float, std_dev: float) -> Distribution:
        """Parameterised by the mean and standard deviation of the variable itself, not of its log."""
        return {"dist": "lognormal", "mean": mean, "stdDev": std_dev}


def ms(v: float) -> float:
    return v / 1000


def seconds(v: float) -> float:
    return v


def minutes(v: float) -> float:
    return v * 60


def hours(v: float) -> float:
    return v * 3600


def poisson_arrivals(per_second: float) -> Distribution:
    """A rate of ``per_second`` events per second, as a mean inter-arrival time distribution."""
    return dist.exponential(1 / per_second)
