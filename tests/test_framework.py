"""Loader, built-ins, warm-up, KPIs, CLI and kernel integrity."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from fabframe import Dispatcher, FunctionDispatcher, kernel, run
from fabframe.dispatchers import ABOUT, BUILTINS
from fabframe.loader import LoadError, load_dispatcher

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "priority_minus_cr.py"


def test_kernel_intact():
    assert kernel.verify() == []


def test_kernel_tamper_detected(tmp_path):
    copy = tmp_path / "kernel"
    shutil.copytree(kernel.KERNEL_DIR, copy, ignore=shutil.ignore_patterns("__pycache__"))
    target = copy / "vendor" / "simulation" / "instance.py"
    target.write_bytes(target.read_bytes() + b"\n# edited\n")
    (copy / "vendor" / "simulation" / "extra.py").write_text("x = 1\n")
    problems = kernel.verify(copy)
    assert "changed vendor/simulation/instance.py" in problems
    assert "unexpected vendor/simulation/extra.py" in problems


def test_builtins_are_paper4_rules_in_paper4_order():
    # FabResilienceLab GraphRule ids, D1..D8 without minimum-batch, then the uniform lower bound
    assert list(BUILTINS) == ["fifo", "critical-ratio", "atc", "srpt", "atc-cqt", "srpt-cqt",
                              "cqt-savable-first", "uniform"]
    assert [cls.name for cls in BUILTINS.values()] == ["FIFO", "CR", "ATC", "SRPT", "ATC-CQT", "SRPT-CQT",
                                                       "CQT-savable-first", "Uniform"]
    assert set(ABOUT) == set(BUILTINS) and all(ABOUT.values())


@pytest.mark.parametrize("dataset", ["HVLM", "LVHM"])
@pytest.mark.parametrize("key", list(BUILTINS))
def test_every_builtin_runs_without_fallback(key, dataset):
    result = run(key, dataset=dataset, days=0.25, strict=True)
    assert result.dispatcher == BUILTINS[key].name
    assert result.fallbacks == 0
    assert result.kpi["moves"] > 0


def test_loader_forms(tmp_path):
    assert load_dispatcher("atc").name == "ATC"
    atc = load_dispatcher("atc", {"k": 3})
    assert atc.k == 3.0 and atc.name == "ATC (k=3)"
    assert load_dispatcher("atc-cqt", {"k": 0.5}).name == "ATC-CQT (k=0.5)"
    assert load_dispatcher(str(EXAMPLE)).name == "priority-minus-cr"
    assert load_dispatcher(str(EXAMPLE) + ":PriorityMinusCR").name == "priority-minus-cr"
    plain = tmp_path / "wait_rule.py"
    plain.write_text("def score(lot, decision):\n    return lot.waiting\n", encoding="utf-8")
    assert load_dispatcher(str(plain)).name == "wait_rule"
    fn = load_dispatcher(str(plain) + ":score")
    assert isinstance(fn, FunctionDispatcher) and fn.name == "score"
    assert load_dispatcher("fabframe.dispatchers.classic:SRPT").name == "SRPT"
    assert load_dispatcher(lambda lot, d: 0.0).name == "<lambda>"

    class Local(Dispatcher):
        name = "local"

        def score(self, lot, decision):
            return 0.0

    assert load_dispatcher(Local).name == "local"
    for bad in ("nope", "cr", "FIFO", str(EXAMPLE.with_name("missing.py")), str(EXAMPLE) + ":Missing", ""):
        with pytest.raises(LoadError):
            load_dispatcher(bad)
    for options in ({"unknown": 1}, {"k": 0}, {"k": -1.0}, {"k": True}, {"k": "3"}, {"k": float("inf")}):
        with pytest.raises(LoadError):
            load_dispatcher("atc", options)
    with pytest.raises(LoadError):
        load_dispatcher("fifo", {"k": 3})


def test_example_rule_runs():
    result = run(str(EXAMPLE), days=0.25, strict=True)
    assert result.dispatcher == "priority-minus-cr"
    assert result.fallbacks == 0 and result.kpi["moves"] > 0


def test_warmup_excluded_from_kpis():
    result = run("fifo", days=0.5, warmup_days=0.5, seed=0)
    assert result.kpi["days_measured"] == 0.5
    whole = run("fifo", days=1.0, seed=0)
    assert result.kpi["lots_completed"] < whole.kpi["lots_completed"]
    assert result.end_time_seconds >= 86400.0


def test_kpi_fields():
    kpi = run("critical-ratio", days=0.5, seed=0).kpi
    for key in ("lots_completed", "throughput_per_day", "on_time_rate", "mean_cycle_time_days",
                "cqt_violations", "moves", "setups", "busy_share", "wip_end", "per_product"):
        assert key in kpi
    assert 0.0 <= kpi["busy_share"] <= 1.0
    assert kpi["lots_completed"] == sum(p["completed"] for p in kpi["per_product"].values())


def _cli(*args, cwd):
    return subprocess.run([sys.executable, "-m", "fabframe", *args], cwd=cwd, capture_output=True,
                          text=True, encoding="utf-8", env={**__import__("os").environ, "PYTHONPATH": str(ROOT)})


def test_cli_run_check_verify(tmp_path):
    out = tmp_path / "r.json"
    done = _cli("run", "srpt", "--days", "0.2", "--quiet", "--out", str(out), cwd=tmp_path)
    assert done.returncode == 0, done.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["dispatcher"] == "SRPT" and data["kpi"]["moves"] > 0

    listed = _cli("list", cwd=tmp_path)
    assert listed.returncode == 0, listed.stderr
    rows = [line.split()[0] for line in listed.stdout.splitlines()[1:]]
    assert rows == list(BUILTINS)

    bad = tmp_path / "bad_rule.py"
    bad.write_text("from fabframe import Dispatcher\n"
                   "class Bad(Dispatcher):\n"
                   "    def score(self, lot, d):\n"
                   "        return 'high'\n", encoding="utf-8")
    checked = _cli("check", str(bad), "--days", "0.05", cwd=tmp_path)
    assert checked.returncode == 1 and "InvalidScore" in checked.stdout

    good = _cli("check", str(EXAMPLE), "--days", "0.05", cwd=tmp_path)
    assert good.returncode == 0 and good.stdout.startswith("OK")

    assert _cli("verify", cwd=tmp_path).returncode == 0


def test_ledger(tmp_path):
    path = tmp_path / "ledger.jsonl"
    result = run("fifo", days=0.05, ledger=path)
    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == result.decisions
    assert set(json.loads(lines[0])) == {"t", "phase", "machine", "queue", "lots"}
