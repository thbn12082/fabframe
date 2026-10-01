"""The built-in rules order lots exactly as Paper 4's keys do.

Reference: FabResilienceLab ``policies/paper4_experts.py`` (GraphRuleExpert._key,
decide) with the candidate features of ``adapters/simulator/pyscfabsim_legacy.py``
and ``adapters/environment/fab_graph.py``, transcribed below for a candidate
batch of one lot.  Paper 4 works in minutes and fabframe in seconds; every
comparison below is unit-free (ratios and orders).
"""

import inspect
import math
import random
import zlib

import pytest

from fabframe.api import DecisionView, LotView, MachineView
from fabframe.dispatchers import BUILTINS
from fabframe.runner import _normalize
from fabframe.ui.server import BUILTIN_HEADER

NOW = 5 * 86400.0


def make_lot(rng, i, *, cqt, step_name=None, batch_min=1):
    priority = rng.choice((10, 20, 30))
    remaining = rng.uniform(3600.0, 30 * 86400.0)
    step_time = rng.choice((rng.uniform(60.0, 900.0), rng.uniform(3600.0, 20000.0)))
    # due dates from overdue to weeks away, so the ATC index both works and underflows
    due = NOW + rng.choice((-86400.0, 0.0, 1800.0, 7200.0, 86400.0, 20 * 86400.0)) + rng.uniform(0.0, 600.0)
    ready = NOW - rng.uniform(0.0, 86400.0)
    cqt_active = cqt and rng.random() < 0.5
    cqt_left = (rng.uniform(-3600.0, 3600.0) if rng.random() < 0.9 else None) if cqt_active else None
    return LotView(
        id=i, product="Lot_3", part="part_3", priority=priority, pieces=rng.choice((25, 25, 13)),
        release_at=0.0, due=due, ready_since=ready, waiting=NOW - ready,
        step_name=step_name or "step_%d" % i, step_index=rng.randint(1, 500), family="F",
        setup_needed=rng.choice(("", "S1", "S2")), setup_time=rng.choice((0.0, 0.0, 600.0, 1800.0)),
        batch_min=batch_min, batch_max=max(1, batch_min), step_time=step_time, remaining_time=remaining,
        steps_done=rng.randint(0, 600), steps_left=rng.randint(0, 600),
        cr=(due - NOW) / remaining, slack=due - NOW - remaining,
        cqt_active=cqt_active, cqt_left=cqt_left,
    )


def make_decision(lots, *, min_run=None):
    machine = MachineView(id=7, family="F", group="G", setup="S1",
                          min_runs_left=None if min_run is None else 3, min_runs_setup=min_run, cascading=False)
    return DecisionView(now=NOW, machine=machine, candidates=tuple(lots), wip=100, completed=10)


def fabframe_order(rule, decision):
    """What the runner hands the kernel: its two guards, then the rule's negated score."""

    scores = _normalize([rule.score(lot, decision) for lot in decision.candidates])
    m = decision.machine
    keys = {
        lot.id: (0 if m.min_runs_left is None or m.min_runs_setup == lot.setup_needed else 1,
                 0 if lot.cqt_active else 1) + score + (lot.id,)
        for lot, score in zip(decision.candidates, scores)
    }
    return sorted(keys, key=keys.get)


# ---- Paper 4, transcribed (paper4_experts.py:117-206; one lot per candidate)
def p4_features(lot, decision):
    m = decision.machine
    active = 1 if lot.cqt_active and lot.cqt_left is not None else 0
    return {
        "id": "%06d" % lot.id,                                    # candidate ids compare as text
        "min_run_violation": m.min_runs_left is not None and m.min_runs_setup != lot.setup_needed,
        "cqt_urgent": lot.cqt_active,
        "active_cqt_lot_count": active,
        "cqt_violation_lot_count": 1 if active and decision.now > decision.now + lot.cqt_left else 0,
        "setup_duration": lot.setup_time,
        "priority": float(lot.priority),
        "queue_entered_at": lot.ready_since,
        "due_at": lot.due,
        "critical_ratio": lot.cr,
        "batch_processing_time": lot.step_time,
        "atc_batch_due_at": lot.due,
        "atc_batch_priority": float(lot.priority),
        "route_occurrence_index": lot.steps_done,
        "srpt_work": lot.pieces * lot.remaining_time,
    }


def p4_key(rule, f, now, mean_p, k=2.0):
    common = (1 if f["min_run_violation"] else 0, 0 if f["cqt_urgent"] else 1, f["setup_duration"], -f["priority"])
    if rule == "cqt-savable-first":
        savable = f["cqt_urgent"] and f["active_cqt_lot_count"] > f["cqt_violation_lot_count"]
        tier = 0 if savable else (1 if f["cqt_urgent"] else 2)
        return (common[0], tier, f["setup_duration"], -f["priority"], f["queue_entered_at"], f["due_at"], f["id"])
    if rule in ("atc-cqt", "srpt-cqt"):
        return common + p4_key(rule[:-4], f, now, mean_p, k)
    if rule == "atc":
        slack = max(f["atc_batch_due_at"] - now - f["batch_processing_time"], 0.0)
        score = f["atc_batch_priority"] / f["batch_processing_time"] * math.exp(-slack / (k * mean_p))
        return (-score, f["atc_batch_due_at"], f["route_occurrence_index"], f["id"])
    if rule == "srpt":
        return (f["srpt_work"], f["atc_batch_due_at"], f["route_occurrence_index"], f["id"])
    if rule == "fifo":
        return common + (f["queue_entered_at"], f["due_at"], f["id"])
    if rule == "critical-ratio":
        return common + (f["critical_ratio"], f["id"])
    raise AssertionError(rule)


def paper4_order(key, decision, k=2.0):
    """Paper 4's choice order over its candidates (every lot here is its own step, batch_min 1;
    a pending minimum run keeps only the lots with its setup when there are any:
    PySCFabSim simulation/gym/environment.py _valid_action_groups)."""

    lots = list(decision.candidates)
    m = decision.machine
    if m.min_runs_left is not None:
        lots = [lot for lot in lots if lot.setup_needed == m.min_runs_setup] or lots
    feats = [p4_features(lot, decision) for lot in lots]
    mean_p = math.fsum(f["batch_processing_time"] for f in feats) / len(feats)
    order = sorted(zip(feats, lots), key=lambda fc: p4_key(key, fc[0], decision.now, mean_p, k))
    return [lot.id for _, lot in order]


# ATC and SRPT carry no Paper 4 prefix, so the kernel guards must not split their lots
NO_PREFIX = {"atc", "srpt"}


RULE_CASES = [(key, 2.0) for key in ("fifo", "critical-ratio", "atc", "srpt", "atc-cqt", "srpt-cqt",
                                      "cqt-savable-first")] + [("atc", 0.5), ("atc-cqt", 8.0)]


@pytest.mark.parametrize("key,k", RULE_CASES)
def test_rule_orders_lots_like_paper4(key, k):
    rng = random.Random(zlib.crc32(("%s/%g" % (key, k)).encode()))
    for trial in range(300):
        cqt = key not in NO_PREFIX
        lots = [make_lot(rng, i, cqt=cqt) for i in range(rng.randint(2, 12))]
        min_run = None if key in NO_PREFIX or rng.random() < 0.6 else rng.choice(("S1", "S2"))
        decision = make_decision(lots, min_run=min_run)
        rule = BUILTINS[key](k=k) if "atc" in key else BUILTINS[key]()
        ours, theirs = fabframe_order(rule, decision), paper4_order(key, decision, k)
        # Paper 4's candidates lead (the rest fail the minimum run), in Paper 4's order
        assert ours[:len(theirs)] == theirs, (key, trial)


def test_far_due_lots_fall_back_to_due_order_as_in_paper4():
    rng = random.Random(3)
    lots = [make_lot(rng, i, cqt=False) for i in range(6)]
    lots = [lot._replace(due=NOW + (40 + i) * 86400.0, step_time=60.0) for i, lot in enumerate(reversed(lots))]
    decision = make_decision(lots)
    rule = BUILTINS["atc"]()
    assert all(rule.score(lot, decision)[0] == 0.0 for lot in lots)       # exp underflows, as in Paper 4
    assert fabframe_order(rule, decision) == [lot.id for lot in sorted(lots, key=lambda lot: lot.due)]


def test_atc_mean_step_time_uses_the_steps_paper4_offers():
    rng = random.Random(5)
    rule = BUILTINS["atc"]()
    a = [make_lot(rng, i, cqt=False, step_name="A", batch_min=2)._replace(step_time=100.0, setup_needed="S1") for i in range(3)]
    b = [make_lot(rng, 10, cqt=False, step_name="B", batch_min=2)._replace(step_time=900.0, setup_needed="S2")]
    c = [make_lot(rng, 20 + i, cqt=False, step_name="C", batch_min=1)._replace(step_time=400.0, setup_needed="S2")
         for i in range(2)]
    # B has fewer lots than its batch minimum: not a Paper 4 candidate
    assert rule._mean_step_time(make_decision(a + b + c)) == pytest.approx((100.0 + 400.0) / 2)
    # a pending minimum run keeps only the steps with its setup, when there are any
    assert rule._mean_step_time(make_decision(a + b + c, min_run="S2")) == pytest.approx(400.0)
    assert rule._mean_step_time(make_decision(a + b + c, min_run="S9")) == pytest.approx(250.0)
    # nothing offerable: every step counts
    assert rule._mean_step_time(make_decision(b)) == pytest.approx(900.0)


def test_atc_recomputes_its_mean_for_every_decision():
    rng = random.Random(9)
    rule = BUILTINS["atc"]()
    lots = [make_lot(rng, i, cqt=False)._replace(due=NOW + 3600.0) for i in range(4)]
    first, second = make_decision(lots), make_decision(lots[:2])     # same time, same machine
    rule.score(lots[0], first)
    assert rule._p_mean == pytest.approx(sum(l.step_time for l in lots) / 4)
    rule.score(lots[0], second)
    assert rule._p_mean == pytest.approx(sum(l.step_time for l in lots[:2]) / 2)


def test_cqt_savable_first_tiers():
    rng = random.Random(11)
    base = make_lot(rng, 0, cqt=False)._replace(setup_time=0.0, priority=10, ready_since=NOW - 100.0, due=NOW + 1e5)
    savable = base._replace(id=1, cqt_active=True, cqt_left=10.0, ready_since=NOW - 1.0)
    on_time = base._replace(id=2, cqt_active=True, cqt_left=0.0, ready_since=NOW - 2.0)
    late = base._replace(id=3, cqt_active=True, cqt_left=-5.0, ready_since=NOW - 1e4)
    none = base._replace(id=4, ready_since=NOW - 1e5)
    order = fabframe_order(BUILTINS["cqt-savable-first"](), make_decision([none, late, savable, on_time]))
    assert order == [2, 1, 3, 4]        # savable (earliest ready first), then past the deadline, then no CQT


@pytest.mark.parametrize("key", list(BUILTINS))
def test_builtin_source_runs_on_its_own(key):
    """The web UI shows a built-in as BUILTIN_HEADER + its class; "copy to edit" saves that as
    a file, so it must run on its own and score exactly like the original."""

    cls = BUILTINS[key]
    namespace = {"__name__": "copied_rule"}
    exec(compile(BUILTIN_HEADER + inspect.getsource(cls), "copied_rule.py", "exec"), namespace)
    copy = namespace[cls.__name__]
    original, copied = cls(), copy()
    rng = random.Random(21)
    for _ in range(20):
        decision = make_decision([make_lot(rng, i, cqt=True) for i in range(6)], min_run=rng.choice((None, "S1")))
        assert [copied.score(l, decision) for l in decision.candidates] == \
               [original.score(l, decision) for l in decision.candidates]
