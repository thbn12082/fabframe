"""Reference runs straight on the kernel, and a trace plugin to compare runs exactly."""

from __future__ import annotations

import hashlib

from fabframe import kernel
from fabframe.kpi import _Plugin

DAY = 86400.0


class Trace(_Plugin):
    """Every dispatch and completion, with exact float times."""

    def __init__(self) -> None:
        self.dispatches = []
        self.done = []
        self.breakdowns = []

    def on_dispatch(self, instance, machine, lots, machine_end, lot_end):
        self.dispatches.append((instance.current_time, machine.idx, tuple(l.idx for l in lots), machine_end, lot_end))

    def on_lot_done(self, instance, lot):
        self.done.append((lot.idx, lot.done_at))

    def on_breakdown(self, instance, event):
        self.breakdowns.append((event.machine.idx, event.timestamp, event.sampled_length))

    def digest(self) -> str:
        return hashlib.sha256(repr((self.dispatches, self.done)).encode()).hexdigest()


def reference_run(dataset: str, days: float, seed: int, rule: str, plugins):
    """simulation/greedy.py's run loop, unchanged, with the kernel's own rule."""

    sim = kernel.load()
    files = sim.read.read_all(str(kernel.dataset_dir(dataset)), preprocessors=[])
    randomizer = sim.randomizer.Randomizer()
    randomizer.set_semantic_provider(None)
    randomizer.random.seed(seed)
    run_to = DAY * days
    instance = sim.file_instance.FileInstance(files, run_to, True, list(plugins))
    rule_fn = sim.dispatching_dispatcher.dispatcher_map[rule]
    while not instance.done:
        done = instance.next_decision_point()
        if done or instance.current_time > run_to:
            break
        machine, lots = sim.greedy.get_lots_to_dispatch_by_machine(instance, rule_fn)
        if lots is None:
            instance.usable_machines.remove(machine)
        else:
            instance.dispatch(machine, lots)
    instance.finalize()
    return instance
