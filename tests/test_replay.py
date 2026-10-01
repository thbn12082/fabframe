"""The 3D replay tells the truth: machine states rebuilt by the browser code
match what the kernel itself reported, and the recording is consistent."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from fabframe import run
from fabframe.kpi import _Plugin

ROOT = Path(__file__).resolve().parents[1]
FAB3D = ROOT / "fabframe" / "ui" / "static" / "fab3d.js"
NODE = shutil.which("node")
DAY = 86400.0


class KernelTruth(_Plugin):
    """0 idle, 1 busy (wafer-count maintenance included), 2 down / calendar PM,
    straight from kernel state."""

    def __init__(self, times):
        self.times = sorted(times)
        self.rows = []

    def on_dispatch(self, instance, machine, lots, machine_end, lot_end):
        while self.times and instance.current_time >= self.times[0]:
            self.times.pop(0)
            states = [2 if m.is_down else 0 if instance.free_machines[m.idx] else 1 for m in instance.machines]
            self.rows.append((instance.current_time, states))


class EndState(_Plugin):
    """WIP at the first dispatch past ``end`` (when the replay takes its last sample)."""

    def __init__(self, end):
        self.end = end
        self.wip = None

    def on_dispatch(self, instance, machine, lots, machine_end, lot_end):
        if self.wip is None and instance.current_time >= self.end:
            self.wip = len(instance.active_lots)


# (warm-up days, measured days, truth sample days relative to the window start)
CASES = {
    "cold": (0.0, 2.0, (0.05, 0.2, 0.37, 0.5, 0.71, 0.93, 1.4, 1.9)),
    # tools busy / down when the window opens must be carried in
    "warm": (0.6, 1.0, (0.0005, 0.002, 0.01, 0.05, 0.3, 0.8)),
}


@pytest.fixture(scope="module", params=sorted(CASES))
def recorded(request, tmp_path_factory):
    warmup, days, rel = CASES[request.param]
    folder = tmp_path_factory.mktemp("replay_" + request.param)
    start = warmup * DAY
    truth = KernelTruth([start + d * DAY for d in rel])
    result = run("critical-ratio", dataset="HVLM", days=days, seed=4, warmup_days=warmup, replay=folder, plugins=[truth])
    return folder, truth, result, start, days


def test_recording_is_consistent(recorded):
    folder, truth, result, start, days = recorded
    meta = json.loads((folder / "replay.json").read_text(encoding="utf-8"))
    assert meta["schema"] == "fabframe-replay/v3"
    assert [f["name"] for f in meta["layout"]["families"]] == meta["kernel_family_order"]
    assert all(f["group"] for f in meta["layout"]["families"])
    samples = meta["samples"]
    assert samples["completed"][-1] == result.kpi["lots_completed"]
    assert samples["cqt_violations"][-1] == result.kpi["cqt_violations"]
    assert samples["t"][-1] == round(days * DAY * 10)
    size = (folder / "replay.bin").stat().st_size
    assert size == max(s["offset"] + s["length"] * {"I": 4, "H": 2, "B": 1}[s["type"]] for s in meta["sections"])
    assert meta["dispatches"] > 5000 and meta["downs"] > 0 and meta["releases"] > 0


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_browser_states_match_kernel(recorded):
    folder, truth, result, start, days = recorded
    times = [round((t - start) * 10) for t, _ in truth.rows]
    out = subprocess.run([NODE, str(ROOT / "tests" / "replay_states.mjs"), str(FAB3D), str(folder), json.dumps(times)],
                         capture_output=True, text=True, encoding="utf-8", check=True)
    data = json.loads(out.stdout)
    total = mismatched = busy = 0
    for (t, kernel_states), T in zip(truth.rows, times):
        ours = data["forward"][str(T)]
        assert ours == data["backward"][str(T)], "scrubbing backwards must give the same picture"
        assert ours == data["zigzag"][str(T)], "seeking back and playing on must give the same picture"
        for k, o in zip(kernel_states, ours):
            total += 1
            busy += k == 1
            mismatched += k != o
    # times are stored in deciseconds, so a boundary within 0.05 s of a
    # sample instant may flip; anything beyond that is a real bug
    assert total > 5000 and busy > 1000
    assert mismatched <= total * 0.001, "%d of %d machine states differ" % (mismatched, total)


def test_last_sample_is_taken_at_the_window_end(tmp_path):
    """A replay shorter than the run ends with the state at its own end."""
    end = EndState(0.5 * DAY)
    run("fifo", dataset="HVLM", days=1.0, seed=1, replay=tmp_path, replay_days=0.5, plugins=[end])
    meta = json.loads((tmp_path / "replay.json").read_text(encoding="utf-8"))
    assert meta["replay_days"] == 0.5
    assert meta["samples"]["t"][-1] == round(0.5 * DAY * 10)
    assert meta["samples"]["wip"][-1] == end.wip


@pytest.mark.skipif(NODE is None, reason="node not installed")
def test_overlapping_pm_and_breakdown(tmp_path):
    """A breakdown inside a PM shows as down only while it lasts."""
    import array

    blob, sections = bytearray(), []

    def put(name, code, values):
        while len(blob) % 4:
            blob.append(0)
        data = array.array(code, values)
        sections.append({"name": name, "type": code, "offset": len(blob), "length": len(data)})
        blob.extend(data.tobytes())

    for name in ("t", "setup", "busy", "lot_end", "pm"):
        put(name, "I", [])
    for name, code in (("machine", "H"), ("nlots", "B"), ("next_family", "B")):
        put(name, code, [])
    put("d_start", "I", [200, 250])
    put("d_end", "I", [400, 300])
    put("d_machine", "H", [0, 0])
    put("d_kind", "B", [1, 0])
    for name, code in (("r_t", "I"), ("r_family", "B"), ("s_queue", "H")):
        put(name, code, [0] if name == "s_queue" else [])
    (tmp_path / "replay.bin").write_bytes(bytes(blob))
    meta = {"schema": "fabframe-replay/v3", "window": {"start_seconds": 0, "end_seconds": 100},
            "layout": {"areas": [], "families": [{"name": "F", "group": "Litho", "area": "litho", "machines": 1, "batch": False}],
                       "machine_family": [0]},
            "dispatches": 0, "downs": 2, "releases": 0, "sections": sections,
            "samples": {"t": [0], "wip": [0], "completed": [0], "cqt_violations": [0], "moves": [0]}}
    (tmp_path / "replay.json").write_text(json.dumps(meta), encoding="utf-8")
    times = [100, 220, 275, 350, 450]
    out = subprocess.run([NODE, str(ROOT / "tests" / "replay_states.mjs"), str(FAB3D), str(tmp_path), json.dumps(times), "raw"],
                         capture_output=True, text=True, encoding="utf-8", check=True)
    states = {int(t): row[0] for t, row in json.loads(out.stdout)["forward"].items()}
    idle, pm, down = 0, 3, 4
    assert states == {100: idle, 220: pm, 275: down, 350: pm, 450: idle}
