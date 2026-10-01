"""Run one SMT2020 simulation with a pluggable dispatcher.

The loop is the kernel's own lot-for-machine greedy loop
(``simulation/greedy.py``): take an idle machine, rank its queue, let the
kernel's selector build the batch and pick the machine, dispatch.  The only
thing the framework replaces is how each waiting lot's sort key (``ptuple``)
is computed:

    ptuple = (min-run compatible first, CQT window running first, *your score)

Your score is negated because the kernel sorts ascending and a dispatcher
says "higher runs first".  The built-in FIFO and CR therefore reproduce the
kernel's rules bit for bit (see tests/test_equivalence.py).
"""

from __future__ import annotations

import json
import math
import platform
import sys
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Union

from . import __version__, kernel
from .api import DecisionView, Dispatcher, FabInfo, LotView, MachineView, SECONDS_PER_DAY
from .dispatchers.classic import FIFO
from .kpi import KpiRecorder
from .loader import load_dispatcher
from .replay import ReplayRecorder, layout_from_files
from .rng import SemanticRng

RNG_MODES = ("semantic", "legacy")


class DispatcherError(RuntimeError):
    """Raised in strict mode when a dispatcher fails or returns an invalid score."""


class InvalidScore(ValueError):
    pass


@dataclass
class RunResult:
    dispatcher: str
    dataset: str
    seed: int
    days: float
    warmup_days: float
    rng: str
    kpi: Dict[str, Any]
    decisions: int
    fallbacks: int
    fallback_reasons: Dict[str, int]
    dispatcher_seconds: float
    slowest_decision_ms: float
    wall_seconds: float
    end_time_seconds: float
    kernel_manifest_sha256: str
    python: str = field(default_factory=lambda: platform.python_version())
    fabframe: str = __version__

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def save(self, path: Union[str, Path]) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        return path


def _normalize(raw: List[Any]) -> List[tuple]:
    """Validate one decision's scores and turn them into ascending sort keys."""

    if not raw:
        return []
    first = raw[0]
    if isinstance(first, (tuple, list)):
        width = len(first)
        if width == 0:
            raise InvalidScore("empty score tuple")
        keys = []
        for value in raw:
            if not isinstance(value, (tuple, list)) or len(value) != width:
                raise InvalidScore("every candidate must return a tuple of length %d" % width)
            keys.append(tuple(-_number(item) for item in value))
        return keys
    return [(-_number(value),) for value in raw]


def _number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidScore("score must be a number, got %s" % type(value).__name__)
    if not math.isfinite(value):
        raise InvalidScore("score must be finite, got %r" % value)
    return value


class _Decider:
    """Builds read-only views, calls the dispatcher, falls back on failure."""

    def __init__(self, sim, strict: bool) -> None:
        self._get_setup = sim.dispatching_dispatcher.Dispatchers.get_setup
        self._strict = strict
        self._fallback = FIFO()
        self.decisions = 0
        self.fallbacks = 0
        self.reasons: Counter = Counter()
        self.seconds = 0.0
        self.slowest = 0.0

    def keys(self, dispatcher: Dispatcher, instance, machine) -> Dict[int, tuple]:
        now = instance.current_time
        lots = machine.waiting_lots
        setups = instance.setups
        get_setup = self._get_setup
        views = []
        for lot in lots:
            step = lot.actual_step
            remaining = lot.remaining_time
            views.append(LotView(
                lot.idx, lot.name, lot.part_name, lot.priority, lot.pieces,
                lot.release_at, lot.deadline_at, lot.free_since, now - lot.free_since,
                step.step_name, step.order, step.family, step.setup_needed,
                get_setup(step.setup_needed, machine, step.setup_time, setups),
                step.batch_min, step.batch_max, step.processing_time.avg(),
                remaining, len(lot.processed_steps), len(lot.remaining_steps),
                lot.cr(now), lot.deadline_at - now - remaining,
                lot.cqt_waiting is not None,
                None if lot.cqt_deadline is None else lot.cqt_deadline - now,
            ))
        views = tuple(views)
        decision = DecisionView(
            now,
            MachineView(machine.idx, machine.family, machine.group, machine.current_setup,
                        machine.min_runs_left, machine.min_runs_setup, machine.cascading),
            views, len(instance.active_lots), len(instance.done_lots),
        )
        self.decisions += 1
        started = time.perf_counter()
        try:
            scores = _normalize([dispatcher.score(view, decision) for view in views])
        except Exception as error:
            if self._strict:
                raise DispatcherError(
                    "%s failed at t=%.1fs on machine %d: %s: %s"
                    % (dispatcher.name, now, machine.idx, type(error).__name__, error)
                ) from error
            self.fallbacks += 1
            self.reasons["%s: %s" % (type(error).__name__, str(error)[:120])] += 1
            scores = _normalize([self._fallback.score(view, decision) for view in views])
        elapsed = time.perf_counter() - started
        self.seconds += elapsed
        self.slowest = max(self.slowest, elapsed)

        run_setup = machine.min_runs_setup
        free_of_min_run = machine.min_runs_left is None
        return {
            id(lot): (
                0 if free_of_min_run or run_setup == lot.actual_step.setup_needed else 1,
                0 if lot.cqt_waiting is not None else 1,
            ) + score
            for lot, score in zip(lots, scores)
        }


def run(
    dispatcher: Union[str, Dispatcher, Any],
    *,
    dataset: str = "HVLM",
    days: float = 7.0,
    seed: int = 0,
    warmup_days: float = 0.0,
    rng: str = "semantic",
    strict: bool = False,
    ledger: Optional[Union[str, Path]] = None,
    progress: bool = False,
    options: Optional[Dict[str, Any]] = None,
    plugins: Sequence[Any] = (),
    events: Optional[Union[str, Path]] = None,
    replay: Optional[Union[str, Path]] = None,
    replay_days: float = 30.0,
) -> RunResult:
    """Simulate ``warmup_days`` under FIFO, then ``days`` under ``dispatcher``.

    ``plugins`` are extra observers receiving the kernel callbacks listed in
    ``fabframe.kpi._Plugin``; they must not change the simulation.
    ``events`` names a JSONL file that receives progress lines while running
    (used by the web UI).  ``replay`` names a folder that receives
    ``replay.json`` + ``replay.bin`` for the 3D view, covering the first
    ``replay_days`` of the measured window.
    """

    sim = kernel.load()
    disp = load_dispatcher(dispatcher, options)
    if not (isinstance(days, (int, float)) and days > 0 and math.isfinite(days)):
        raise ValueError("days must be a positive number")
    if not (isinstance(warmup_days, (int, float)) and warmup_days >= 0 and math.isfinite(warmup_days)):
        raise ValueError("warmup_days must be a non-negative number")
    if rng not in RNG_MODES:
        raise ValueError("rng must be one of %s" % ", ".join(RNG_MODES))
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("seed must be an integer")

    wall_started = time.perf_counter()
    files = sim.read.read_all(str(kernel.dataset_dir(dataset)), preprocessors=[])
    randomizer = sim.randomizer.Randomizer()
    randomizer.seed(seed)
    randomizer.set_semantic_provider(SemanticRng(dataset, seed) if rng == "semantic" else None)
    ledger_file = None
    events_file = None
    try:
        warm_end = warmup_days * SECONDS_PER_DAY
        run_to = (warmup_days + days) * SECONDS_PER_DAY
        recorder = KpiRecorder(start=warm_end, end=run_to)
        replay_recorder = None
        if replay is not None:
            replay_end = min(run_to, warm_end + max(0.0, float(replay_days)) * SECONDS_PER_DAY)
            replay_recorder = ReplayRecorder(start=warm_end, end=replay_end)
        observers = [recorder] + ([replay_recorder] if replay_recorder else []) + list(plugins)
        instance = sim.file_instance.FileInstance(files, run_to, True, observers)
        disp.setup(FabInfo(
            dataset, seed, float(days), float(warmup_days),
            tuple(sorted(instance.family_machines)), len(instance.machines),
        ))
        warmup_disp = FIFO()
        decider = _Decider(sim, strict)
        select = sim.greedy.get_lots_to_dispatch_by_machine
        if ledger is not None:
            Path(ledger).parent.mkdir(parents=True, exist_ok=True)
            ledger_file = open(ledger, "w", encoding="utf-8")
        if events is not None:
            Path(events).parent.mkdir(parents=True, exist_ok=True)
            events_file = open(events, "w", encoding="utf-8")
        event_step = min(SECONDS_PER_DAY, run_to / 50.0)
        next_event = event_step
        next_wip_day = 0

        def emit(state: str) -> None:
            events_file.write(json.dumps({
                "state": state,
                "sim_days": round(min(instance.current_time, run_to) / SECONDS_PER_DAY, 4),
                "total_days": round(run_to / SECONDS_PER_DAY, 4),
                "phase": "run" if measuring else "warmup",
                "completed": len(recorder.completed),
                "wip": len(instance.active_lots),
                "cqt_violations": recorder.cqt_violations,
                "decisions": decider.decisions,
                "fallbacks": decider.fallbacks,
            }) + "\n")
            events_file.flush()

        measuring = warm_end <= 0
        if measuring:
            recorder.mark_start(instance)
        printed_day = -1
        while not instance.done:
            finished = instance.next_decision_point()
            if finished or instance.current_time > run_to:
                break
            if not measuring and instance.current_time >= warm_end:
                recorder.mark_start(instance)
                measuring = True
            while measuring and instance.current_time >= warm_end + (next_wip_day + 1) * SECONDS_PER_DAY:
                recorder.sample_wip(next_wip_day, len(instance.active_lots))
                next_wip_day += 1
            if events_file is not None and instance.current_time >= next_event:
                emit("running")
                while next_event <= instance.current_time:
                    next_event += event_step
            for machine in instance.usable_machines:
                break
            keys = decider.keys(disp if measuring else warmup_disp, instance, machine)
            chosen, lots = select(instance, lambda lot, t, m, s: keys[id(lot)], machine=machine)
            if lots is None:
                instance.usable_machines.remove(chosen)
            else:
                instance.dispatch(chosen, lots)
            if ledger_file is not None:
                ledger_file.write(json.dumps({
                    "t": instance.current_time, "phase": "run" if measuring else "warmup",
                    "machine": chosen.idx, "queue": len(keys),
                    "lots": None if lots is None else [lot.idx for lot in lots],
                }) + "\n")
            if progress and int(instance.current_time // SECONDS_PER_DAY) > printed_day:
                printed_day = int(instance.current_time // SECONDS_PER_DAY)
                sys.stderr.write("\r  ngày %d/%g" % (printed_day, warmup_days + days))
                sys.stderr.flush()
        instance.finalize()
        if replay_recorder is not None:
            replay_recorder.finish(instance)
            replay_recorder.save(Path(replay), layout_from_files(files), {
                "dispatcher": disp.name, "dataset": dataset, "seed": seed,
                "days": float(days), "warmup_days": float(warmup_days),
                "replay_days": round((replay_recorder.end - replay_recorder.start) / SECONDS_PER_DAY, 6),
            })
        if events_file is not None:
            emit("finished")
        if progress:
            sys.stderr.write("\n")
    finally:
        randomizer.set_semantic_provider(None)
        if ledger_file is not None:
            ledger_file.close()
        if events_file is not None:
            events_file.close()

    return RunResult(
        dispatcher=disp.name,
        dataset=dataset,
        seed=seed,
        days=float(days),
        warmup_days=float(warmup_days),
        rng=rng,
        kpi=recorder.summary(instance),
        decisions=decider.decisions,
        fallbacks=decider.fallbacks,
        fallback_reasons=dict(decider.reasons.most_common(10)),
        dispatcher_seconds=round(decider.seconds, 3),
        slowest_decision_ms=round(decider.slowest * 1000.0, 3),
        wall_seconds=round(time.perf_counter() - wall_started, 3),
        end_time_seconds=instance.current_time,
        kernel_manifest_sha256=kernel.manifest_sha256(),
    )
