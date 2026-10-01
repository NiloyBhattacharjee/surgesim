"""Chronon Sim Python SDK: describe a system in Python, compile it to the JSON model format.

The SDK never simulates anything. The JSON it emits is the contract; the engine (``chronon run``) runs it.
"""

from .model import MODEL_FORMAT_VERSION, Component, Model, ModelBuildError
from .specs import SPECS
from .values import dist, hours, minutes, ms, poisson_arrivals, seconds

__all__ = [
    "MODEL_FORMAT_VERSION",
    "Component",
    "Model",
    "ModelBuildError",
    "SPECS",
    "dist",
    "hours",
    "minutes",
    "ms",
    "poisson_arrivals",
    "seconds",
]
__version__ = "0.1.0"
