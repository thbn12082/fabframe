"""In semantic mode the fab's randomness does not depend on the dispatcher."""

from fabframe import run
from fabframe.rng import SemanticRng

from helpers import Trace


def test_breakdowns_identical_across_dispatchers():
    traces = {}
    for rule in ("fifo", "critical-ratio", "uniform"):
        trace = Trace()
        run(rule, dataset="HVLM", days=2.0, seed=5, rng="semantic", plugins=[trace])
        traces[rule] = trace
    assert len(traces["fifo"].breakdowns) > 10
    assert traces["fifo"].breakdowns == traces["critical-ratio"].breakdowns == traces["uniform"].breakdowns
    # the dispatchers really did behave differently
    assert traces["fifo"].dispatches != traces["critical-ratio"].dispatches


def test_same_inputs_same_result():
    first = run("critical-ratio", dataset="LVHM", days=1.0, seed=2)
    second = run("critical-ratio", dataset="LVHM", days=1.0, seed=2)
    assert first.kpi == second.kpi


def test_seed_changes_the_realisation():
    a, b = Trace(), Trace()
    run("fifo", days=1.0, seed=0, plugins=[a])
    run("fifo", days=1.0, seed=1, plugins=[b])
    assert a.breakdowns != b.breakdowns


def test_provider_values():
    rng = SemanticRng("HVLM", 0)
    context = {"component": "c", "draw_kind": "c", "subject_id": "machine:1", "operation_id": "x", "occurrence": 0}
    u = rng(context=context, family="uniform", parameters={"lower": 10.0, "upper": 20.0}, units="sec")
    assert 10.0 <= u < 20.0
    assert u == rng(context=dict(context), family="uniform", parameters={"lower": 10.0, "upper": 20.0}, units="sec")
    e = rng(context=dict(context, occurrence=1), family="exponential", parameters={"mean": 3600.0}, units="sec")
    assert e >= 0.0
    assert SemanticRng("HVLM", 1).unit("uniform", {}, "sec", context) != rng.unit("uniform", {}, "sec", context)
