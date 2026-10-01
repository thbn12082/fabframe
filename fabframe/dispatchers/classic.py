"""Paper 4's classical dispatching rules, written against the public Dispatcher API.

The set, ids and keys follow FabResilienceLab's ``GraphRule`` experts
(``policies/paper4_experts.py``, D1..D8) plus its uniform-random lower bound.
Paper 4 ranks candidate batches (one per step waiting at the machine); here
every waiting lot is scored and the kernel's selector forms the batch, so the
batch features become the lot's own: due, priority, wafers x remaining time.
Every rule also gets the framework's two kernel guards in front (lots fitting
a pending minimum run first, then lots whose CQT window is running), which
Paper 4's ATC and SRPT do not have.  Paper 4's minimum-batch rule (D3) is not
here: it ranks batches by size, a choice the kernel's selector makes itself.

FIFO and CR reproduce the kernel's own rules exactly: the kernel sorts
ascending by (setup time, -priority, ready time, due) for FIFO and by
(setup time, -priority, critical ratio) for CR.  Returning the negation of
each element under "higher runs first" gives the identical order, which the
equivalence tests check bit for bit.

Each class stands alone (no shared helpers, no base but Dispatcher): the web
UI shows it as a file that runs on its own, so "copy to edit" works.
"""

from __future__ import annotations

import math
import random

from ..api import DecisionView, Dispatcher, FabInfo, LotView


class FIFO(Dispatcher):
    """Paper 4 D1 (the kernel's FIFO): least setup, highest priority, earliest ready, earliest due."""

    name = "FIFO"

    def score(self, lot: LotView, decision: DecisionView):
        return (-lot.setup_time, lot.priority, -lot.ready_since, -lot.due)


class CR(Dispatcher):
    """Paper 4 D2 (the kernel's CR): least setup, highest priority, smallest critical ratio."""

    name = "CR"

    def score(self, lot: LotView, decision: DecisionView):
        return (-lot.setup_time, lot.priority, -lot.cr)


class ATC(Dispatcher):
    """Paper 4 D4: Apparent Tardiness Cost with look-ahead k (default 2).

    index = (priority / p) * exp(-max(0, due - now - p) / (k * p_mean)), with p
    the mean processing time of the lot's step and p_mean the mean of p over
    the steps Paper 4 would offer at this machine: those with at least
    batch_min lots waiting, only the pending minimum run's setup if any of
    them has it.  Ties: earlier due, then fewer steps done.  Computed in plain
    floating point as Paper 4 does, so a lot whose due date is far away gets
    index 0 (the exponential underflows) and such lots go by due date.
    """

    name = "ATC"

    def __init__(self, k: float = 2.0) -> None:
        if isinstance(k, bool) or not isinstance(k, (int, float)) or not math.isfinite(k) or k <= 0:
            raise ValueError("k must be a positive number")
        self.k = float(k)
        if self.k != 2.0:
            self.name = "%s (k=%g)" % (type(self).name, self.k)   # Paper 4 marks a non-default k too
        self._decision = None
        self._p_mean = 1.0

    def _mean_step_time(self, decision: DecisionView) -> float:
        steps = {}
        for c in decision.candidates:
            steps.setdefault(c.step_name, []).append(c)
        offered = [lots for lots in steps.values() if len(lots) >= lots[0].batch_min] or list(steps.values())
        machine = decision.machine
        if machine.min_runs_left is not None:
            offered = [lots for lots in offered if lots[0].setup_needed == machine.min_runs_setup] or offered
        return math.fsum(lots[0].step_time for lots in offered) / len(offered)

    def score(self, lot: LotView, decision: DecisionView):
        if decision is not self._decision:          # once per decision
            self._p_mean = self._mean_step_time(decision)
            self._decision = decision
        if lot.priority <= 0 or lot.step_time <= 0:
            raise ValueError("ATC needs a positive priority and processing time")
        slack = max(0.0, lot.due - decision.now - lot.step_time)
        index = lot.priority / lot.step_time * math.exp(-slack / (self.k * self._p_mean))
        return (index, -lot.due, -lot.steps_done)


class SRPT(Dispatcher):
    """Paper 4 D5: least remaining work (wafers x mean processing time left) first.

    Paper 4 sums the work over the lots of a candidate batch; ties: earlier
    due, then fewer steps done.
    """

    name = "SRPT"

    def score(self, lot: LotView, decision: DecisionView):
        return (-lot.pieces * lot.remaining_time, -lot.due, -lot.steps_done)


class ATC_CQT(Dispatcher):
    """Paper 4 D6: ATC behind FIFO's and CR's prefix (least setup, then highest priority).

    The ATC part is the same as the ATC rule's, look-ahead k included.
    """

    name = "ATC-CQT"

    def __init__(self, k: float = 2.0) -> None:
        if isinstance(k, bool) or not isinstance(k, (int, float)) or not math.isfinite(k) or k <= 0:
            raise ValueError("k must be a positive number")
        self.k = float(k)
        if self.k != 2.0:
            self.name = "%s (k=%g)" % (type(self).name, self.k)
        self._decision = None
        self._p_mean = 1.0

    def _mean_step_time(self, decision: DecisionView) -> float:
        steps = {}
        for c in decision.candidates:
            steps.setdefault(c.step_name, []).append(c)
        offered = [lots for lots in steps.values() if len(lots) >= lots[0].batch_min] or list(steps.values())
        machine = decision.machine
        if machine.min_runs_left is not None:
            offered = [lots for lots in offered if lots[0].setup_needed == machine.min_runs_setup] or offered
        return math.fsum(lots[0].step_time for lots in offered) / len(offered)

    def score(self, lot: LotView, decision: DecisionView):
        if decision is not self._decision:
            self._p_mean = self._mean_step_time(decision)
            self._decision = decision
        if lot.priority <= 0 or lot.step_time <= 0:
            raise ValueError("ATC needs a positive priority and processing time")
        slack = max(0.0, lot.due - decision.now - lot.step_time)
        index = lot.priority / lot.step_time * math.exp(-slack / (self.k * self._p_mean))
        return (-lot.setup_time, lot.priority, index, -lot.due, -lot.steps_done)


class SRPT_CQT(Dispatcher):
    """Paper 4 D7: SRPT behind FIFO's and CR's prefix (least setup, then highest priority)."""

    name = "SRPT-CQT"

    def score(self, lot: LotView, decision: DecisionView):
        return (-lot.setup_time, lot.priority, -lot.pieces * lot.remaining_time, -lot.due, -lot.steps_done)


class CQTSavableFirst(Dispatcher):
    """Paper 4 D8: FIFO, but among lots whose CQT window is running, those still
    before their CQT deadline go before those already past it."""

    name = "CQT-savable-first"

    def score(self, lot: LotView, decision: DecisionView):
        savable = lot.cqt_active and lot.cqt_left is not None and lot.cqt_left >= 0
        return (1 if savable else 0, -lot.setup_time, lot.priority, -lot.ready_since, -lot.due)


class Uniform(Dispatcher):
    """Paper 4's uniform-random lower bound: random order, drawn from the rule's
    own RNG (seeded with the run's seed) so it never touches the fab's."""

    name = "Uniform"

    def __init__(self) -> None:
        self._rng = random.Random(0)

    def setup(self, fab: FabInfo) -> None:
        self._rng = random.Random(fab.seed)

    def score(self, lot: LotView, decision: DecisionView):
        return self._rng.random()
