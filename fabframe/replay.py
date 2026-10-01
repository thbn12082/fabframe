"""Compact replay of a run for the 3D view.

Recorded from kernel callbacks only (it never changes the simulation):

* every dispatch: start, setup length, busy length (closed by the kernel's
  own "machine free"), wafer-count maintenance appended to it, when the lots
  reach their next step, machine, batch size and the family they go to next
  (taken when the kernel actually frees the lots, so sampling skips and
  rework are honoured);
* tools already busy or down when the window opens (after a warm-up) are
  carried in as rows starting at 0;
* every breakdown / preventive maintenance: machine, start, end;
* every ``sample_every`` seconds: queue length per tool family, WIP, completed
  lots, CQT violations and moves (cumulative).

A machine's busy length is closed by the kernel's own "machine free" callback,
so a breakdown that postpones the end of processing is reflected exactly.
Times are stored as deciseconds from the start of the recorded window.

Files: ``replay.json`` (layout + samples + section table) and ``replay.bin``
(little-endian columnar arrays; offsets in the JSON).
"""

from __future__ import annotations

import json
import struct
from array import array
from pathlib import Path
from typing import Dict, List, Optional

from .kpi import _Plugin

SCHEMA = "fabframe-replay/v3"
NO_FAMILY = 255
DS = 10.0  # deciseconds per second

AREAS = (
    # (area id, short label, family-name prefixes in match order)
    ("litho", "Litho", ("LithoMet", "Litho_REG", "LithoTrack", "Litho")),
    ("metro", "Metro", ("DefMet", "DefMEt", "TF_Met")),
    ("dryetch", "Dry etch", ("DE_",)),
    ("wetetch", "Wet etch", ("WE_",)),
    ("film", "Thin film", ("TF_",)),
    ("diel", "Dielectric", ("Dielectric",)),
    ("diff", "Diffusion", ("Diffusion",)),
    ("implant", "Implant", ("Implant",)),
    ("cmp", "CMP", ("Planar",)),
    ("epi", "EPI", ("EPI",)),
    ("delay", "Delay", ("Delay",)),
)


def area_of(family: str) -> str:
    for area_id, _, prefixes in AREAS:
        if any(family.startswith(p) for p in prefixes):
            if area_id == "litho" and family.startswith("LithoMet"):
                return "metro"
            return area_id
    return "other"


def layout_from_files(files) -> Dict[str, object]:
    """Machines in kernel order (FileInstance numbers them the same way)."""

    families: List[str] = []
    family_index: Dict[str, int] = {}
    family_group: Dict[str, str] = {}
    machines: List[int] = []
    for row in files["tool.txt.1l"]:
        family = row["STNFAM"]
        if family not in family_index:
            family_index[family] = len(families)
            families.append(family)
            family_group[family] = row["STNGRP"]
        for _ in range(int(row["STNQTY"])):
            machines.append(family_index[family])
    batch = set()
    for key, rows in files.items():
        if "route" in key:
            for r in rows:
                if r.get("PTPER") == "per_batch" and r.get("BATCHMX") not in ("", None):
                    batch.add(r["STNFAM"])
    counts = [0] * len(families)
    for f in machines:
        counts[f] += 1
    return {
        "areas": [{"id": a, "label": label} for a, label, _ in AREAS],
        "families": [
            {"name": name, "group": family_group[name], "area": area_of(name),
             "machines": counts[i], "batch": name in batch}
            for i, name in enumerate(families)
        ],
        "machine_family": machines,
    }


class ReplayRecorder(_Plugin):
    def __init__(self, start: float, end: float, sample_every: float = 900.0) -> None:
        self.start = float(start)
        self.end = float(end)
        self.sample_every = float(sample_every)
        self._next_sample = self.start
        self._family_index: Dict[str, int] = {}
        # dispatch columns
        self.t = array("I")
        self.setup = array("I")
        self.busy = array("I")
        self.lot_end = array("I")
        self.pm = array("I")                     # wafer-count maintenance at the end of the busy time
        self.machine = array("H")
        self.nlots = array("B")
        self.next_family = array("B")
        self._open: Dict[int, int] = {}          # machine idx -> dispatch row still busy
        self._lot_row: Dict[int, int] = {}       # batch-first lot idx -> row awaiting its arrival
        self._pmed: Dict[int, float] = {}        # machine idx -> pmed_time already accounted for
        self._pre: Dict[int, tuple] = {}         # warm-up dispatches still running
        self._pre_downs: List[tuple] = []        # warm-up breakdowns / PMs still running
        self._entered = self.start <= 0
        # down columns
        self.d_start = array("I")
        self.d_end = array("I")
        self.d_machine = array("H")
        self.d_kind = array("B")                 # 0 breakdown, 1 preventive maintenance
        # releases: lots entering the fab
        self.r_t = array("I")
        self.r_family = array("B")
        # samples
        self.s_time: List[float] = []
        self.s_queue = array("H")
        self.s_wip: List[int] = []
        self.s_done: List[int] = []
        self.s_cqt: List[int] = []
        self.s_moves: List[int] = []
        self._done = 0
        self._cqt = 0
        self._moves = 0
        self.families: List[str] = []

    # -- helpers ------------------------------------------------------------------
    def _ds(self, t: float) -> int:
        return max(0, int(round((t - self.start) * DS)))

    def _inside(self, t: float) -> bool:
        return self.start <= t <= self.end

    def _sample(self, instance) -> None:
        queue = [0] * len(self.families)
        index = self._family_index
        for lot in instance.active_lots:
            if lot.waiting_machines and lot.actual_step is not None:
                queue[index[lot.actual_step.family]] += 1
        self.s_time.append(round((self._next_sample - self.start) * DS))
        self.s_queue.extend(min(q, 65535) for q in queue)
        self.s_wip.append(len(instance.active_lots))
        self.s_done.append(self._done)
        self.s_cqt.append(self._cqt)
        self.s_moves.append(self._moves)
        self._next_sample += self.sample_every

    def _maybe_sample(self, instance) -> None:
        while instance.current_time >= self._next_sample and self._next_sample <= self.end:
            self._sample(instance)
        # the end of the window rarely falls on the sample grid: take it the first
        # time the clock passes it, not after the whole run has finished
        end_ds = round((self.end - self.start) * DS)
        if instance.current_time >= self.end and (not self.s_time or self.s_time[-1] < end_ds):
            self._next_sample = self.end
            self._sample(instance)

    def _enter(self, instance) -> None:
        """First callback inside the window: carry in tools that are still busy / down."""
        if self._entered or instance.current_time < self.start:
            return
        self._entered = True
        for m, (setup_end, machine_end, lot_end, nlots, nxt, first_lot, pm) in sorted(self._pre.items()):
            busy = machine_end - self.start
            row = self._row(0, setup_end - self.start, busy, lot_end - self.start, m, nlots, nxt, min(pm, busy))
            self._open[m] = row
            if first_lot is not None:
                self._lot_row[first_lot] = row
        self._pre.clear()
        for m, ends_at, kind in self._pre_downs:
            if ends_at > self.start:
                self.d_start.append(0)
                self.d_end.append(self._ds(ends_at))
                self.d_machine.append(m)
                self.d_kind.append(kind)
        self._pre_downs.clear()

    def _row(self, t_ds, setup_s, busy_s, lot_s, machine, nlots, nxt, pm_s) -> int:
        row = len(self.t)
        self.t.append(t_ds)
        self.setup.append(int(round(max(0.0, setup_s) * DS)))
        self.busy.append(int(round(max(0.0, busy_s) * DS)))
        self.lot_end.append(int(round(max(0.0, lot_s) * DS)))
        self.pm.append(int(round(max(0.0, pm_s) * DS)))
        self.machine.append(machine)
        self.nlots.append(min(nlots, 255))
        self.next_family.append(self._family_index.get(nxt, NO_FAMILY) if nxt else NO_FAMILY)
        return row

    # -- kernel callbacks ---------------------------------------------------------
    def on_sim_init(self, instance):
        for machine in instance.machines:
            if machine.family not in self._family_index:
                self._family_index[machine.family] = len(self.families)
                self.families.append(machine.family)
            self._pmed[machine.idx] = machine.pmed_time

    def on_dispatch(self, instance, machine, lots, machine_end_time, lot_end_time):
        now = instance.current_time
        self._enter(instance)
        self._maybe_sample(instance)
        # Instance.dispatch adds wafer-count maintenance to machine_time and pmed_time
        pm = machine.pmed_time - self._pmed.get(machine.idx, 0.0)
        self._pmed[machine.idx] = machine.pmed_time
        first = lots[0]
        new_setup = machine.current_setup
        old_setup = getattr(machine, "last_setup", "")
        setup = 0.0
        if new_setup != "" and old_setup != new_setup:   # same rule as Instance.get_times
            step_setup = first.actual_step.setup_time
            if step_setup is not None:
                setup = step_setup
            elif (old_setup, new_setup) in instance.setups:
                setup = instance.setups[(old_setup, new_setup)]
            elif ("", new_setup) in instance.setups:
                setup = instance.setups[("", new_setup)]
        # provisional next step; replaced by the real one in on_lot_free
        nxt = first.remaining_steps[0].family if first.remaining_steps else None
        if now < self.start:
            self._pre[machine.idx] = (now + setup, machine_end_time, lot_end_time, len(lots), nxt, first.idx, pm)
            return
        if not self._inside(now):
            return
        row = self._row(self._ds(now), setup, machine_end_time - now, lot_end_time - now, machine.idx, len(lots), nxt, pm)
        self._open[machine.idx] = row
        self._lot_row[first.idx] = row

    def on_machine_free(self, instance, machine):
        if instance.current_time < self.start:
            self._pre.pop(machine.idx, None)
            return
        self._enter(instance)
        row = self._open.pop(machine.idx, None)
        if row is not None:
            self.busy[row] = max(0, self._ds(instance.current_time) - self.t[row])

    def on_lot_free(self, instance, lot):
        """The kernel has picked the lot's real next step (or finished it)."""
        if instance.current_time < self.start:
            for m, pre in self._pre.items():
                if pre[5] == lot.idx:
                    nxt = lot.actual_step.family if lot.actual_step is not None else None
                    self._pre[m] = (pre[0], pre[1], instance.current_time, pre[3], nxt, None, pre[6])
                    break
            return
        self._enter(instance)
        row = self._lot_row.pop(lot.idx, None)
        if row is None:
            return
        self.lot_end[row] = max(0, self._ds(instance.current_time) - self.t[row])
        nxt = lot.actual_step.family if lot.actual_step is not None else None
        self.next_family[row] = self._family_index.get(nxt, NO_FAMILY) if nxt else NO_FAMILY

    def _down(self, instance, event, kind):
        now = instance.current_time
        if now < self.start:
            self._pre_downs.append((event.machine.idx, getattr(event, "ends_at", now), kind))
            return
        self._enter(instance)
        if not self._inside(now):
            return
        self.d_start.append(self._ds(now))
        self.d_end.append(self._ds(getattr(event, "ends_at", now)))
        self.d_machine.append(event.machine.idx)
        self.d_kind.append(kind)

    def on_breakdown(self, instance, event):
        self._down(instance, event, 0)

    def on_preventive_maintenance(self, instance, event):
        # calendar PM time is added to pmed_time before this callback; it is not
        # part of any dispatch
        self._pmed[event.machine.idx] = event.machine.pmed_time
        self._down(instance, event, 1)

    def on_lots_release(self, instance, lots):
        now = instance.current_time
        if not self._inside(now):
            return
        for lot in lots:
            if lot.actual_step is None:
                continue
            self.r_t.append(self._ds(now))
            self.r_family.append(self._family_index.get(lot.actual_step.family, NO_FAMILY))

    def on_lot_done(self, instance, lot):
        if self._inside(lot.done_at):
            self._done += 1

    def on_cqt_violated(self, instance, machine, lot):
        if self._inside(instance.current_time):
            self._cqt += 1

    def on_step_done(self, instance, lot, step):
        if step is not None and self._inside(instance.current_time):
            self._moves += 1

    def finish(self, instance) -> None:
        self._enter(instance)
        self._maybe_sample(instance)
        if not self.s_time or self.s_time[-1] < round((self.end - self.start) * DS):
            self._next_sample = min(self._next_sample, self.end)
            self._sample(instance)
        # rows still open when the run stopped: use the kernel's pending (possibly
        # breakdown-postponed) machine-done / lot-done events
        pending_machine: Dict[int, float] = {}
        pending_lot: Dict[int, float] = {}
        for ev in instance.events.arr:
            name = type(ev).__name__
            if name == "MachineDoneEvent":
                for machine in ev.machines:
                    pending_machine[machine.idx] = ev.timestamp
            elif name == "LotDoneEvent":
                for lot in ev.lots:
                    pending_lot[lot.idx] = ev.timestamp
        for m, row in self._open.items():
            if m in pending_machine:
                self.busy[row] = max(0, self._ds(pending_machine[m]) - self.t[row])
        for lot_idx, row in self._lot_row.items():
            if lot_idx in pending_lot:
                self.lot_end[row] = max(0, self._ds(pending_lot[lot_idx]) - self.t[row])

    # -- output -------------------------------------------------------------------
    def save(self, folder: Path, layout: Dict[str, object], meta: Dict[str, object]) -> None:
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        sections = []
        blob = bytearray()

        def put(name, arr):
            # align every section to 4 bytes so typed-array views are valid
            while len(blob) % 4:
                blob.append(0)
            data = arr.tobytes() if struct.pack("=H", 1) == struct.pack("<H", 1) else _swap(arr)
            sections.append({"name": name, "type": arr.typecode, "offset": len(blob), "length": len(arr)})
            blob.extend(data)

        for name in ("t", "setup", "busy", "lot_end", "pm"):
            put(name, getattr(self, name))
        put("machine", self.machine)
        put("nlots", self.nlots)
        put("next_family", self.next_family)
        put("d_start", self.d_start)
        put("d_end", self.d_end)
        put("d_machine", self.d_machine)
        put("d_kind", self.d_kind)
        put("r_t", self.r_t)
        put("r_family", self.r_family)
        put("s_queue", self.s_queue)
        (folder / "replay.bin").write_bytes(bytes(blob))
        doc = {
            "schema": SCHEMA,
            "time_unit": "decisecond",
            "window": {"start_seconds": self.start, "end_seconds": self.end},
            "sample_every_seconds": self.sample_every,
            "layout": layout,
            "kernel_family_order": self.families,
            "dispatches": len(self.t),
            "downs": len(self.d_start),
            "releases": len(self.r_t),
            "sections": sections,
            "samples": {
                "t": self.s_time, "wip": self.s_wip, "completed": self.s_done,
                "cqt_violations": self.s_cqt, "moves": self.s_moves,
            },
            **meta,
        }
        (folder / "replay.json").write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")


def _swap(arr: array) -> bytes:
    copy = array(arr.typecode, arr)
    copy.byteswap()
    return copy.tobytes()
