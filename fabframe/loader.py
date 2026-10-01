"""Turn a dispatcher spec into a Dispatcher instance.

Accepted specs:
  * a built-in id: ``fifo``, ``critical-ratio``, ``atc`` ... (``fabframe list``)
  * a file: ``path/to/rule.py`` or ``path/to/rule.py:ClassName`` (Windows
    drive letters are fine: ``D:\\rules\\rule.py:PriorityMinusCR``)
  * an importable module: ``package.module:ClassName``
  * a Dispatcher instance or subclass, or a plain ``score(lot, decision)`` function
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import inspect
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from .api import Dispatcher, FunctionDispatcher
from .dispatchers import BUILTINS

_FILE_SPEC = re.compile(r"^(?P<path>.+\.py)(?::(?P<attr>[A-Za-z_]\w*))?$")
_MODULE_SPEC = re.compile(r"^(?P<module>[A-Za-z_][\w.]*):(?P<attr>[A-Za-z_]\w*)$")


class LoadError(ValueError):
    pass


def load_dispatcher(spec: Any, options: Optional[Dict[str, Any]] = None) -> Dispatcher:
    options = dict(options or {})
    if isinstance(spec, Dispatcher):
        if options:
            raise LoadError("options can only be passed when the framework creates the dispatcher")
        return spec
    if inspect.isclass(spec):
        return _instantiate(spec, options)
    if callable(spec):
        return FunctionDispatcher(spec)
    if not isinstance(spec, str) or not spec.strip():
        raise LoadError("dispatcher spec must be a name, a file path or module:Class")
    spec = spec.strip()
    if spec in BUILTINS:
        return _instantiate(BUILTINS[spec], options)
    match = _FILE_SPEC.match(spec)
    if match:
        module = _load_file(Path(match.group("path")))
        return _pick(module, match.group("attr"), options, spec)
    match = _MODULE_SPEC.match(spec)
    if match:
        try:
            module = importlib.import_module(match.group("module"))
        except ImportError as error:
            raise LoadError("cannot import %s: %s" % (match.group("module"), error)) from error
        return _pick(module, match.group("attr"), options, spec)
    raise LoadError(
        "unknown dispatcher %r: use a built-in (%s), a .py file or module:Class"
        % (spec, ", ".join(BUILTINS))
    )


def _load_file(path: Path):
    path = path.expanduser().resolve()
    if not path.is_file():
        raise LoadError("dispatcher file not found: %s" % path)
    name = "fabframe_user_" + hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:12]
    module_spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(module_spec)
    folder = str(path.parent)
    added = folder not in sys.path
    if added:
        sys.path.insert(0, folder)  # lets the rule import helper modules next to it
    try:
        module_spec.loader.exec_module(module)
    finally:
        if added:
            sys.path.remove(folder)
    return module


def _pick(module, attr: Optional[str], options: Dict[str, Any], spec: str) -> Dispatcher:
    if attr is not None:
        if not hasattr(module, attr):
            raise LoadError("%s has no attribute %r" % (spec, attr))
        target = getattr(module, attr)
    else:
        found = [
            value for value in vars(module).values()
            if inspect.isclass(value) and issubclass(value, Dispatcher)
            and value.__module__ == module.__name__
        ]
        if not found and callable(getattr(module, "score", None)):
            if options:
                raise LoadError("options are not supported for a plain score function")
            stem = Path(getattr(module, "__file__", "") or "score").stem
            return FunctionDispatcher(module.score, name=stem)
        if len(found) != 1:
            names = ", ".join(sorted(cls.__name__ for cls in found)) or "none"
            raise LoadError("%s defines %d Dispatcher classes (%s) and no score() function; "
                            "name one with :ClassName" % (spec, len(found), names))
        target = found[0]
    if inspect.isclass(target):
        return _instantiate(target, options)
    if isinstance(target, Dispatcher):
        return target
    if callable(target):
        if options:
            raise LoadError("options are not supported for a plain score function")
        return FunctionDispatcher(target, name=attr)
    raise LoadError("%s is not a Dispatcher class, instance or function" % spec)


def _instantiate(cls, options: Dict[str, Any]) -> Dispatcher:
    if not issubclass(cls, Dispatcher):
        raise LoadError("%s does not subclass fabframe.Dispatcher" % cls.__name__)
    try:
        return cls(**options)
    except (TypeError, ValueError) as error:
        raise LoadError("cannot create %s with options %r: %s" % (cls.__name__, options, error)) from error
