"""Order-independent randomness for the fab's exogenous events.

With the kernel's legacy RNG every draw comes from one shared stream, so a
different dispatcher consumes draws in a different order and silently changes
breakdown times and processing durations.  The kernel (Paper 4 edit P2) can
instead hand each draw a stable context: which machine, lot, step visit or
calendar it belongs to, plus a per-context occurrence counter.  This provider
turns that context into the value by hashing, so the same physical event gets
the same value no matter which dispatcher runs or in which order.
"""

from __future__ import annotations

import hashlib
import json
import math

SCHEMA = "fabframe-semantic-rng/v1"


class SemanticRng:
    def __init__(self, dataset: str, seed: int) -> None:
        self._prefix = "%s|%s|%d|" % (SCHEMA, dataset, int(seed))

    def unit(self, family: str, parameters: dict, units: str, context: dict) -> float:
        """Uniform value in [0, 1) determined only by the arguments."""

        key = json.dumps(
            {"context": context, "family": family, "parameters": parameters, "units": units},
            sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False,
        )
        digest = hashlib.sha256((self._prefix + key).encode("utf-8")).digest()
        return (int.from_bytes(digest[:8], "big") >> 11) * (1.0 / 9007199254740992.0)

    def __call__(self, *, context, family, parameters, units):
        u = self.unit(family, parameters, units, context)
        if family == "uniform":
            lower, upper = parameters["lower"], parameters["upper"]
            return lower + (upper - lower) * u
        if family == "exponential":
            return -parameters["mean"] * math.log(1.0 - u)
        raise ValueError("unsupported distribution family %r" % family)
