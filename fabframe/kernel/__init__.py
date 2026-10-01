"""Pinned SMT2020 simulation kernel (vendored PySCFabSim-release, MIT licence).

The kernel's modules import each other as the top-level package ``simulation``.
``load()`` puts the vendored copy on ``sys.path`` and refuses to run when any
vendored byte differs from ``MANIFEST.sha256`` or when a different
``simulation`` package was imported first.  See ``PROVENANCE.md``.
"""

from __future__ import annotations

import hashlib
import importlib
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, List, Optional

KERNEL_DIR = Path(__file__).resolve().parent
VENDOR_DIR = KERNEL_DIR / "vendor"
DATASETS_DIR = KERNEL_DIR / "datasets"
MANIFEST = KERNEL_DIR / "MANIFEST.sha256"
DATASETS = ("HVLM", "LVHM")

_MODULES = (
    "randomizer", "tools", "classes", "events", "event_queue", "instance",
    "file_instance", "read", "greedy", "plugins.interface",
    "dispatching.dispatcher",
)


class KernelError(RuntimeError):
    """The vendored kernel is missing, modified or shadowed."""


def read_manifest(manifest: Path = MANIFEST) -> Dict[str, str]:
    """Map each pinned path (relative to the kernel directory) to its SHA-256."""

    entries: Dict[str, str] = {}
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        digest, name = line.split(maxsplit=1)
        entries[name.lstrip("*")] = digest
    return entries


def verify(kernel_dir: Path = KERNEL_DIR) -> List[str]:
    """Return every difference from the manifest; an empty list means intact."""

    kernel_dir = Path(kernel_dir)
    expected = read_manifest(kernel_dir / "MANIFEST.sha256")
    problems = []
    for relative, digest in sorted(expected.items()):
        path = kernel_dir / relative
        if not path.is_file():
            problems.append("missing " + relative)
        elif hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            problems.append("changed " + relative)
    # An extra module would silently change what ``import simulation.x`` loads.
    for path in sorted((kernel_dir / "vendor").rglob("*.py")):
        relative = path.relative_to(kernel_dir).as_posix()
        if relative not in expected:
            problems.append("unexpected " + relative)
    return problems


def manifest_sha256() -> str:
    return hashlib.sha256(MANIFEST.read_bytes()).hexdigest()


def dataset_dir(dataset: str) -> Path:
    if dataset not in DATASETS:
        raise ValueError("dataset must be one of %s, got %r" % (", ".join(DATASETS), dataset))
    return DATASETS_DIR / ("SMT2020_" + dataset)


def _inside_vendor(module) -> bool:
    try:
        Path(module.__file__).resolve().relative_to(VENDOR_DIR)
        return True
    except (AttributeError, TypeError, ValueError):
        return False


_loaded: Optional[SimpleNamespace] = None


def load() -> SimpleNamespace:
    """Verify and import the kernel once per process; return its modules."""

    global _loaded
    if _loaded is not None:
        return _loaded
    problems = verify()
    if problems:
        raise KernelError(
            "kernel files differ from MANIFEST.sha256 (%d problem(s)): %s"
            % (len(problems), "; ".join(problems[:5]))
        )
    existing = sys.modules.get("simulation")
    if existing is not None and not _inside_vendor(existing):
        raise KernelError("another 'simulation' package is already imported: %r" % existing)
    vendor = str(VENDOR_DIR)
    if vendor not in sys.path:
        sys.path.insert(0, vendor)
    modules = {}
    for name in _MODULES:
        module = importlib.import_module("simulation." + name)
        if not _inside_vendor(module):
            raise KernelError("simulation.%s was loaded from outside the vendored kernel" % name)
        modules[name.replace(".", "_")] = module
    _loaded = SimpleNamespace(**modules)
    return _loaded
