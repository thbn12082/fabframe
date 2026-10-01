"""KPIs computed by the framework from kernel callbacks, identical for every dispatcher.

Only events inside the measured window [start, end] count; the warm-up is
excluded.  All times inside the kernel are seconds.
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from typing import Dict, List, Optional

SECONDS_PER_DAY = 86400.0


class _Plugin:
    """Every callback the kernel invokes (simulation/plugins/interface.py), as no-ops.

    Kept import-free so ``fabframe verify`` works even when the kernel is broken.
    """

    def on_sim_init(self, instance): pass
    def on_sim_done(self, instance): pass
    def on_lots_release(self, instance, lots): pass
    def on_lot_done(self, instance, lot): pass
    def on_step_done(self, instance, lot, step): pass
    def on_dispatch(self, instance, machine, lots, machine_end_time, lot_end_time): pass
    def on_dispatch_decision(self, instance, machine, lots, decision_context=None): pass
    def on_machine_free(self, instance, machine): pass
    def on_lot_free(self, instance, lot): pass
    def on_breakdown(self, instance, event): pass
    def on_preventive_maintenance(self, instance, event): pass
    def on_cqt_violated(self, instance, machine, lot): pass
    def get_output_name(self): return None


class KpiRecorder(_Plugin):
    def __init__(self, start: float, end: float) -> None:
        self.start = float(start)
        self.end = float(end)
        self.completed: List[tuple] = []        # (product, release_at, due, done_at)
        self.cqt_violations = 0
        self.moves = 0
        self.dispatches = 0
        self.setups = 0
        self.batch_lots = 0
        self.breakdowns: List[tuple] = []       # (machine, start, length) — for audits
        self._busy_at_start: Optional[float] = None
        self._setup_at_start: Optional[float] = None
        self._daily = defaultdict(lambda: defaultdict(int))   # day index -> counters
        self._wip: Dict[int, int] = {}

    def _inside(self, t: float) -> bool:
        return self.start <= t <= self.end

    def _day(self, t: float) -> int:
        return min(int((t - self.start) // SECONDS_PER_DAY), self.n_days - 1)

    @property
    def n_days(self) -> int:
        return max(1, math.ceil((self.end - self.start) / SECONDS_PER_DAY - 1e-9))

    def sample_wip(self, day_index: int, wip: int) -> None:
        """WIP seen at the first decision after the end of day ``day_index``."""
        self._wip.setdefault(day_index, wip)

    # -- kernel callbacks ------------------------------------------------------
    def on_lot_done(self, instance, lot):
        if self._inside(lot.done_at):
            self.completed.append((lot.name, lot.release_at, lot.deadline_at, lot.done_at))
            day = self._daily[self._day(lot.done_at)]
            day["completed"] += 1
            day["on_time"] += lot.done_at <= lot.deadline_at

    def on_step_done(self, instance, lot, step):
        if step is not None and self._inside(instance.current_time):
            self.moves += 1
            self._daily[self._day(instance.current_time)]["moves"] += 1

    def on_cqt_violated(self, instance, machine, lot):
        if self._inside(instance.current_time):
            self.cqt_violations += 1
            self._daily[self._day(instance.current_time)]["cqt_violations"] += 1

    def on_dispatch(self, instance, machine, lots, machine_end_time, lot_end_time):
        if self._inside(instance.current_time):
            self.dispatches += 1
            self.batch_lots += len(lots)
            if machine.current_setup != "" and machine.last_setup != machine.current_setup:
                self.setups += 1
                self._daily[self._day(instance.current_time)]["setups"] += 1

    def on_breakdown(self, instance, event):
        self.breakdowns.append((event.machine.idx, event.timestamp, event.sampled_length))

    # -- window bookkeeping ----------------------------------------------------
    def mark_start(self, instance) -> None:
        self._busy_at_start = sum(m.utilized_time for m in instance.machines)
        self._setup_at_start = sum(m.setuped_time for m in instance.machines)

    def summary(self, instance) -> Dict[str, object]:
        days = (self.end - self.start) / SECONDS_PER_DAY
        n = len(self.completed)
        on_time = sum(1 for _, _, due, done in self.completed if done <= due)
        cycle = [(done - rel) / SECONDS_PER_DAY for _, rel, _, done in self.completed]
        tardy = [max(0.0, done - due) / 3600.0 for _, _, due, done in self.completed]
        machines = len(instance.machines)
        busy = sum(m.utilized_time for m in instance.machines) - (self._busy_at_start or 0.0)
        setup = sum(m.setuped_time for m in instance.machines) - (self._setup_at_start or 0.0)
        capacity = machines * (self.end - self.start)

        per_product: Dict[str, Dict[str, float]] = {}
        groups = defaultdict(list)
        for product, rel, due, done in self.completed:
            groups[product].append((rel, due, done))
        for product in sorted(groups):
            rows = groups[product]
            per_product[product] = {
                "completed": len(rows),
                "on_time_rate": _round(sum(1 for _, due, done in rows if done <= due) / len(rows)),
                "mean_cycle_time_days": _round(statistics.mean((d - r) / SECONDS_PER_DAY for r, _, d in rows)),
            }

        return {
            "days_measured": _round(days),
            "lots_completed": n,
            "throughput_per_day": _round(n / days) if days > 0 else None,
            "on_time_rate": _round(on_time / n) if n else None,
            "mean_cycle_time_days": _round(statistics.mean(cycle)) if cycle else None,
            "mean_tardiness_hours": _round(statistics.mean(tardy)) if tardy else None,
            "cqt_violations": self.cqt_violations,
            "moves": self.moves,
            "moves_per_day": _round(self.moves / days) if days > 0 else None,
            "dispatches": self.dispatches,
            "mean_batch_size": _round(self.batch_lots / self.dispatches) if self.dispatches else None,
            "setups": self.setups,
            "busy_share": _round(busy / capacity) if capacity > 0 else None,
            "setup_share": _round(setup / capacity) if capacity > 0 else None,
            "wip_end": len(instance.active_lots),
            "per_product": per_product,
            "daily": self._daily_rows(instance),
        }

    def _daily_rows(self, instance) -> List[Dict[str, object]]:
        rows = []
        for index in range(self.n_days):
            counters = self._daily.get(index, {})
            completed = counters.get("completed", 0)
            last = index == self.n_days - 1
            rows.append({
                "day": index + 1,
                "completed": completed,
                "on_time_rate": _round(counters.get("on_time", 0) / completed) if completed else None,
                "cqt_violations": counters.get("cqt_violations", 0),
                "moves": counters.get("moves", 0),
                "setups": counters.get("setups", 0),
                "wip": len(instance.active_lots) if last else self._wip.get(index),
            })
        return rows


def _round(value: float, digits: int = 6) -> float:
    return round(float(value), digits)
