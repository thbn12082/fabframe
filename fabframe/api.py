"""Everything a dispatcher author needs: the base class and read-only views.

A dispatcher never sees simulator objects.  At each decision the framework
copies the facts about one idle machine and the lots waiting for it into
immutable tuples, asks the dispatcher to ``score`` every candidate, and lets
the kernel's own selector form the batch.  Higher score runs first.
"""

from __future__ import annotations

from typing import NamedTuple, Optional, Sequence, Tuple, Union

Score = Union[float, int, Sequence[Union[float, int]]]

SECONDS_PER_DAY = 86400.0


class LotView(NamedTuple):
    """One lot waiting for the machine being decided.  Times are in seconds."""

    id: int
    product: str               # lot type, e.g. "Lot_3" (SMT2020 order name)
    part: str
    priority: int              # larger = more important (SMT2020 PRIOR)
    pieces: int
    release_at: float
    due: float                 # absolute due time
    ready_since: float         # when the lot became ready for this step
    waiting: float             # now - ready_since
    step_name: str
    step_index: int            # 1-based step number on the route
    family: str                # tool family of this step
    setup_needed: str          # '' when the step needs no particular setup
    setup_time: float          # setup this lot would cost on THIS machine
    batch_min: int             # in lots
    batch_max: int             # in lots; 1 = no batching
    step_time: float           # mean processing time of this step
    remaining_time: float      # mean processing time left, this step included
    steps_done: int
    steps_left: int            # after this step
    cr: float                  # critical ratio (due - now) / remaining_time
    slack: float               # due - now - remaining_time
    cqt_active: bool           # a queue-time window is running for this lot
    cqt_left: Optional[float]  # seconds until that window closes (may be < 0)


class MachineView(NamedTuple):
    id: int
    family: str
    group: str
    setup: str                 # current setup ('' = none)
    min_runs_left: Optional[int]
    min_runs_setup: Optional[str]
    cascading: bool


class DecisionView(NamedTuple):
    now: float                 # simulation time in seconds
    machine: MachineView
    candidates: Tuple[LotView, ...]
    wip: int                   # lots in the fab
    completed: int             # lots finished since the simulation started

    @property
    def day(self) -> float:
        return self.now / SECONDS_PER_DAY


class FabInfo(NamedTuple):
    dataset: str
    seed: int
    days: float
    warmup_days: float
    machine_families: Tuple[str, ...]
    machines: int


class Dispatcher:
    """Base class for a dispatching rule.

    Implement ``score``: return a number (or a tuple of numbers, compared left
    to right) for one candidate lot; the highest score is dispatched first.
    Every candidate in one decision must return the same kind of score.

    The framework always keeps two kernel guards in front of your score:
    lots compatible with a machine's pending minimum run come first, then lots
    whose queue-time (CQT) window is running.  Batching, setup-avoiding machine
    choice and the minimum-run guard are done by the kernel afterwards.
    """

    name = "dispatcher"

    def setup(self, fab: FabInfo) -> None:
        """Called once before the simulation starts.  Optional."""

    def score(self, lot: LotView, decision: DecisionView) -> Score:
        raise NotImplementedError("implement score(lot, decision)")


class FunctionDispatcher(Dispatcher):
    """Wraps a plain ``score(lot, decision)`` function."""

    def __init__(self, function, name: Optional[str] = None) -> None:
        self._function = function
        self.name = name or getattr(function, "__name__", "function")

    def score(self, lot: LotView, decision: DecisionView) -> Score:
        return self._function(lot, decision)
