"""The framework must not change the simulation: built-in FIFO and CR run through
fabframe reproduce the kernel's own greedy loop dispatch for dispatch."""

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from fabframe import run

from helpers import Trace, reference_run

ORIGINAL_TREE = Path(r"D:\điều phối\tool mô phỏng bán dẫn\PySCFabSim-release")


@pytest.mark.parametrize("dataset,days,rule,kernel_rule", [
    ("HVLM", 2.0, "fifo", "fifo"),
    ("HVLM", 2.0, "critical-ratio", "cr"),
    ("LVHM", 1.0, "fifo", "fifo"),
    ("LVHM", 1.0, "critical-ratio", "cr"),
])
def test_builtin_rule_matches_kernel_greedy_bit_for_bit(dataset, days, rule, kernel_rule):
    reference = Trace()
    ref_instance = reference_run(dataset, days, 3, kernel_rule, [reference])

    ours = Trace()
    result = run(rule, dataset=dataset, days=days, seed=3, rng="legacy", plugins=[ours])

    assert len(ours.dispatches) > 1000
    assert ours.dispatches == reference.dispatches
    assert ours.done == reference.done
    assert result.end_time_seconds == ref_instance.current_time
    assert result.fallbacks == 0


@pytest.mark.skipif(not ORIGINAL_TREE.is_dir(), reason="original PySCFabSim-release tree not present")
def test_vendored_kernel_matches_original_tree():
    """Same greedy FIFO run from the untouched original folder, in a separate process."""

    script = textwrap.dedent(r"""
        import hashlib, sys
        sys.dont_write_bytecode = True
        sys.path.insert(0, sys.argv[1])
        from simulation.read import read_all
        from simulation.file_instance import FileInstance
        from simulation.randomizer import Randomizer
        from simulation.greedy import get_lots_to_dispatch_by_machine
        from simulation.dispatching.dispatcher import dispatcher_map
        import simulation
        assert simulation.__file__.startswith(sys.argv[1]), simulation.__file__
        trace = []
        class P:
            def __getattr__(self, name):
                return lambda *a, **k: None
            def on_dispatch(self, inst, m, lots, me, le):
                trace.append((inst.current_time, m.idx, tuple(l.idx for l in lots), me, le))
        files = read_all(sys.argv[1] + r"\datasets\SMT2020_HVLM", preprocessors=[])
        Randomizer().random.seed(3)
        run_to = 86400 * 1.0
        inst = FileInstance(files, run_to, True, [P()])
        while not inst.done:
            if inst.next_decision_point() or inst.current_time > run_to:
                break
            m, lots = get_lots_to_dispatch_by_machine(inst, dispatcher_map["fifo"])
            if lots is None:
                inst.usable_machines.remove(m)
            else:
                inst.dispatch(m, lots)
        print(hashlib.sha256(repr(trace).encode()).hexdigest())
    """)
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    out = subprocess.run([sys.executable, "-c", script, str(ORIGINAL_TREE)],
                         capture_output=True, text=True, encoding="utf-8", env=env, check=True)
    ours = Trace()
    run("fifo", dataset="HVLM", days=1.0, seed=3, rng="legacy", plugins=[ours])
    import hashlib
    assert out.stdout.strip() == hashlib.sha256(repr(ours.dispatches).encode()).hexdigest()
