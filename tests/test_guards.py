"""A faulty dispatcher can never crash or corrupt the simulation."""

import math

import pytest

from fabframe import Dispatcher, DispatcherError, run

from helpers import Trace


class Boom(Dispatcher):
    name = "boom"

    def score(self, lot, decision):
        raise RuntimeError("bug in rule")


class Mutator(Dispatcher):
    name = "mutator"

    def score(self, lot, decision):
        lot.priority = 99          # views are immutable
        return 0.0


class NotANumber(Dispatcher):
    name = "nan"

    def score(self, lot, decision):
        return math.nan


class Ragged(Dispatcher):
    name = "ragged"

    def score(self, lot, decision):
        return (1.0,) if lot.id % 2 else (1.0, 2.0)


class BoolScore(Dispatcher):
    name = "bool"

    def score(self, lot, decision):
        return True


@pytest.fixture(scope="module")
def fifo_trace():
    trace = Trace()
    run("fifo", days=0.5, seed=1, plugins=[trace])
    return trace


@pytest.mark.parametrize("bad,reason", [
    (Boom, "RuntimeError"), (Mutator, "AttributeError"), (NotANumber, "InvalidScore"),
    (BoolScore, "InvalidScore"),
])
def test_bad_dispatcher_falls_back_to_fifo(bad, reason, fifo_trace):
    trace = Trace()
    result = run(bad(), days=0.5, seed=1, plugins=[trace])
    assert result.fallbacks == result.decisions > 0
    assert any(key.startswith(reason) for key in result.fallback_reasons)
    # every decision fell back to FIFO, so the run is exactly the FIFO run
    assert trace.dispatches == fifo_trace.dispatches


def test_only_inconsistent_decisions_fall_back():
    # A decision whose candidates all share one parity gets consistent scores
    # and is valid; only mixed decisions are rejected.
    result = run(Ragged(), days=0.5, seed=1)
    assert 0 < result.fallbacks < result.decisions
    assert all(key.startswith("InvalidScore") for key in result.fallback_reasons)


def test_strict_mode_raises():
    with pytest.raises(DispatcherError, match="bug in rule"):
        run(Boom(), days=0.1, strict=True)


def test_views_are_read_only():
    seen = {}

    class Peek(Dispatcher):
        def score(self, lot, decision):
            seen["lot"], seen["decision"] = lot, decision
            return 0.0

    run(Peek(), days=0.05)
    with pytest.raises(AttributeError):
        seen["lot"].due = 0
    with pytest.raises(AttributeError):
        seen["decision"].now = 0
    with pytest.raises(TypeError):
        seen["decision"].candidates[0] = None


def test_invalid_arguments():
    with pytest.raises(ValueError):
        run("fifo", days=0)
    with pytest.raises(ValueError):
        run("fifo", days=1, rng="other")
    with pytest.raises(ValueError):
        run("fifo", dataset="XYZ", days=1)
