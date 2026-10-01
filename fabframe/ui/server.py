"""Local web UI: ``python -m fabframe ui``.

Standard library only.  Each simulation runs as its own ``python -m fabframe
run`` process, so a crashing dispatcher cannot take the UI down, a run can be
cancelled, and several runs can proceed in parallel.  Everything a run
produces lives in ``<workdir>/runs/ui/<run id>/``; dispatchers written in the
browser are saved to ``<workdir>/my_dispatchers/``.

The UI can save and execute Python code, so it listens on 127.0.0.1 only,
rejects requests whose Host header is not its own address (DNS rebinding), and
requires a per-session token plus a JSON body on every state-changing request
(cross-site requests from other pages cannot supply either).
"""

from __future__ import annotations

import ast
import inspect
import gzip
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

from .. import __version__, kernel
from ..dispatchers import ABOUT, BUILTINS
from ..replay import layout_from_files

PACKAGE_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = PACKAGE_DIR.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
JS = "text/javascript; charset=utf-8"
STATIC_TYPES = {"app.js": JS, "fab3d.js": JS, "style.css": "text/css; charset=utf-8"}
VENDOR_TYPES = {"three.module.min.js": JS, "three.core.min.js": JS, "OrbitControls.js": JS}
JSM_DIRS = {"postprocessing", "shaders", "math", "environments", "geometries", "utils"}
JSM_FILE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,60}\.js$")
# a built-in is shown as a file that runs on its own (so "copy to edit" works)
BUILTIN_HEADER = (
    "from __future__ import annotations\n\n"
    "import math\n"
    "import random\n\n"
    "from fabframe import DecisionView, Dispatcher, FabInfo, LotView\n\n\n"
)
# request bodies over MAX_BODY_BYTES are still read and dropped up to this size,
# so the client gets its 413 instead of a reset connection
DRAIN_LIMIT = 64 * 1024 * 1024
# the 3D replay of a UI run covers at most this many measured days (~0.6 MB/day on HVLM)
REPLAY_DAYS_MAX = 60.0

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,40}$")
FILE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_\-]{0,60}\.py$")
RUN_ID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{4}$")
MAX_CODE_BYTES = 200_000
MAX_BODY_BYTES = 400_000

TEMPLATE = '''"""Dispatcher của tôi. Điểm CAO chạy TRƯỚC."""

from fabframe import Dispatcher


class MyDispatcher(Dispatcher):
    name = "{name}"

    def score(self, lot, decision):
        # Bắt đầu từ luật tự viết Paper 4 đã chạy: ưu tiên trừ tỷ số tới hạn (CR). Sửa tuỳ ý.
        # Trả về một số, hoặc một tuple so sánh từ trái sang phải.
        # Các trường của lot và decision: README, mục "Dispatcher nhìn thấy gì".
        return lot.priority - lot.cr
'''


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _last_line(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 4096))
            lines = handle.read().decode("utf-8", "replace").strip().splitlines()
        return json.loads(lines[-1]) if lines else None
    except (OSError, ValueError, IndexError):
        return None


def _tail(path: Path, limit: int = 6000) -> str:
    try:
        data = path.read_bytes()
    except OSError:
        return ""
    return data[-limit:].decode("utf-8", "replace")


def _docstring_line(text: str) -> str:
    try:
        doc = ast.get_docstring(ast.parse(text)) or ""
    except SyntaxError:
        return ""
    return doc.strip().splitlines()[0] if doc.strip() else ""


class UiApp:
    def __init__(self, workdir: Path, max_parallel: Optional[int] = None) -> None:
        self.workdir = Path(workdir).resolve()
        self.runs_dir = self.workdir / "runs" / "ui"
        self.mine_dir = self.workdir / "my_dispatchers"
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.mine_dir.mkdir(parents=True, exist_ok=True)
        self.token = secrets.token_urlsafe(24)
        self.max_parallel = max_parallel or max(1, min(4, (os.cpu_count() or 2) - 2))
        self._lock = threading.Lock()
        self._procs: Dict[str, subprocess.Popen] = {}
        self._queue: List[str] = []
        self._cancelled: set = set()
        self._layouts: Dict[str, Any] = {}
        self._gz_locks: Dict[Path, threading.Lock] = {}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._scheduler, name="fabframe-ui-scheduler", daemon=True)
        self._thread.start()

    # -- dispatchers -----------------------------------------------------------
    def _files(self, folder: Path) -> List[Path]:
        if not folder.is_dir():
            return []
        return sorted(p for p in folder.glob("*.py") if FILE_RE.match(p.name) and p.is_file())

    def dispatchers(self) -> List[Dict[str, Any]]:
        # Paper 4's rules in its own order under their usual names, then the user's files
        items = [{"id": "builtin:" + key, "kind": "builtin", "name": cls.name,
                  "doc": ABOUT.get(key, ""), "editable": False} for key, cls in BUILTINS.items()]
        for path in self._files(self.mine_dir):
            text = path.read_text(encoding="utf-8", errors="replace")
            items.append({"id": "mine:" + path.name, "kind": "mine", "name": path.stem,
                          "doc": _docstring_line(text), "editable": True})
        return items

    def _resolve(self, dispatcher_id: Any) -> Dict[str, Any]:
        if not isinstance(dispatcher_id, str) or ":" not in dispatcher_id:
            raise ApiError(400, "dispatcher id không hợp lệ")
        kind, _, name = dispatcher_id.partition(":")
        if kind == "builtin":
            if name not in BUILTINS:
                raise ApiError(404, "không có dispatcher có sẵn tên %s" % name)
            return {"kind": kind, "spec": name, "name": name, "path": None}
        if kind != "mine" or not FILE_RE.match(name):
            raise ApiError(400, "dispatcher id không hợp lệ")
        path = self.mine_dir / name
        if not path.is_file():
            raise ApiError(404, "không tìm thấy file %s" % name)
        return {"kind": kind, "spec": str(path), "name": path.stem, "path": path}

    def source(self, dispatcher_id: str) -> Dict[str, Any]:
        info = self._resolve(dispatcher_id)
        if info["kind"] == "builtin":
            code = BUILTIN_HEADER + inspect.getsource(BUILTINS[info["name"]])
        else:
            code = info["path"].read_text(encoding="utf-8", errors="replace")
        return {"id": dispatcher_id, "name": info["name"], "code": code, "editable": info["kind"] == "mine"}

    def template(self, name: str = "my_dispatcher") -> Dict[str, Any]:
        return {"name": name, "code": TEMPLATE.format(name=name.replace("_", "-"))}

    def save(self, body: Dict[str, Any]) -> Dict[str, Any]:
        name, code = body.get("name"), body.get("code")
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise ApiError(400, "tên file chỉ gồm chữ không dấu, số và _, bắt đầu bằng chữ (tối đa 41 ký tự)")
        if not isinstance(code, str) or not code.strip():
            raise ApiError(400, "code trống")
        try:
            size = len(code.encode("utf-8"))
        except UnicodeEncodeError:
            raise ApiError(400, "code chứa ký tự không hợp lệ (lỗi mã hoá UTF-8)")
        if size > MAX_CODE_BYTES:
            raise ApiError(400, "code quá dài")
        try:
            compile(code, name + ".py", "exec")
        except SyntaxError as error:
            raise ApiError(400, "lỗi cú pháp dòng %s: %s" % (error.lineno, error.msg))
        path = self.mine_dir / (name + ".py")
        path.write_text(code, encoding="utf-8", newline="\n")
        return {"id": "mine:" + path.name}

    def check(self, body: Dict[str, Any]) -> Dict[str, Any]:
        info = self._resolve(body.get("id"))
        cmd = [sys.executable, "-m", "fabframe", "check", info["spec"], "--days", "0.05"]
        try:
            done = subprocess.run(cmd, cwd=str(self.workdir), env=self._env(), capture_output=True,
                                  text=True, encoding="utf-8", errors="replace", timeout=300,
                                  creationflags=self._flags())
        except subprocess.TimeoutExpired:
            return {"ok": False, "output": "Quá 5 phút mà chưa chạy xong 0,05 ngày: dispatcher quá chậm."}
        return {"ok": done.returncode == 0, "output": (done.stdout + done.stderr).strip()[-8000:]}

    # -- runs --------------------------------------------------------------------
    @staticmethod
    def _env() -> Dict[str, str]:
        env = dict(os.environ)
        env["PYTHONPATH"] = str(PROJECT_DIR) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        return env

    @staticmethod
    def _flags() -> int:
        return getattr(subprocess, "CREATE_NO_WINDOW", 0)

    def create_run(self, body: Dict[str, Any]) -> Dict[str, Any]:
        info = self._resolve(body.get("dispatcher"))
        dataset = body.get("dataset", "HVLM")
        if dataset not in kernel.DATASETS:
            raise ApiError(400, "dataset phải là HVLM hoặc LVHM")
        days = self._number(body.get("days", 7), "số ngày", 0.01, 365)
        warmup = self._number(body.get("warmup_days", 0), "warm-up", 0, 365)
        seed = body.get("seed", 0)
        if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 10**9:
            raise ApiError(400, "seed phải là số nguyên từ 0")
        rng = body.get("rng", "semantic")
        if rng not in ("semantic", "legacy"):
            raise ApiError(400, "rng không hợp lệ")
        options = body.get("options") or {}
        if not isinstance(options, dict) or len(options) > 20:
            raise ApiError(400, "tham số không hợp lệ")
        for key, value in options.items():
            if not NAME_RE.match(str(key)) or not (isinstance(value, (int, float, str, bool)) and len(str(value)) <= 200):
                raise ApiError(400, "tham số %r không hợp lệ" % (key,))

        run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
        folder = self.runs_dir / run_id
        folder.mkdir(parents=True)
        request = {"dispatcher_id": body["dispatcher"], "dispatcher_name": info["name"], "dataset": dataset,
                   "days": days, "seed": seed, "warmup_days": warmup, "rng": rng, "options": options,
                   "created_at": _now()}
        request["spec"] = info["spec"]
        if info["path"] is not None:   # keep the exact code that ran, under its own name
            shutil.copyfile(info["path"], folder / info["path"].name)
            request["snapshot"] = info["path"].name
        _write_json(folder / "request.json", request)
        _write_json(folder / "status.json", {"state": "queued", "queued_at": _now()})
        with self._lock:
            self._queue.append(run_id)
        return {"run_id": run_id}

    @staticmethod
    def _number(value: Any, label: str, low: float, high: float) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
            raise ApiError(400, "%s phải trong khoảng %g–%g" % (label, low, high))
        return float(value)

    def _start(self, run_id: str) -> None:
        folder = self.runs_dir / run_id
        request = _read_json(folder / "request.json")
        snapshot = request.get("snapshot")
        spec = str(folder / snapshot) if snapshot else request["spec"]
        cmd = [sys.executable, "-m", "fabframe", "run", spec,
               "--dataset", request["dataset"], "--days", repr(request["days"]),
               "--seed", str(request["seed"]), "--warmup-days", repr(request["warmup_days"]),
               "--rng", request["rng"], "--out", str(folder / "result.json"),
               "--events", str(folder / "events.jsonl"), "--replay", str(folder),
               "--replay-days", repr(float(min(request["days"], REPLAY_DAYS_MAX))), "--quiet"]
        for key, value in request["options"].items():
            cmd += ["-o", "%s=%r" % (key, value)]
        log = open(folder / "log.txt", "w", encoding="utf-8")
        try:
            proc = subprocess.Popen(cmd, cwd=str(self.workdir), env=self._env(), stdout=log,
                                    stderr=subprocess.STDOUT, creationflags=self._flags())
        finally:
            log.close()
        self._procs[run_id] = proc
        _write_json(folder / "status.json", {"state": "running", "started_at": _now()})

    def _scheduler(self) -> None:
        while not self._stop.wait(0.3):
            with self._lock:
                for run_id, proc in list(self._procs.items()):
                    code = proc.poll()
                    if code is None:
                        continue
                    del self._procs[run_id]
                    status = _read_json(self.runs_dir / run_id / "status.json") or {}
                    if run_id in self._cancelled:
                        state = "cancelled"
                    else:
                        ok = code == 0 and (self.runs_dir / run_id / "result.json").is_file()
                        state = "done" if ok else "failed"
                    status.update({"state": state, "returncode": code, "finished_at": _now()})
                    _write_json(self.runs_dir / run_id / "status.json", status)
                while self._queue and len(self._procs) < self.max_parallel:
                    run_id = self._queue.pop(0)
                    try:
                        self._start(run_id)
                    except Exception as error:  # keep the scheduler alive
                        _write_json(self.runs_dir / run_id / "status.json",
                                    {"state": "failed", "error": str(error), "finished_at": _now()})

    def _state(self, run_id: str, status: Dict[str, Any]) -> str:
        state = status.get("state", "failed")
        if state in ("running", "queued") and run_id not in self._procs and run_id not in self._queue:
            return "interrupted"   # the UI was restarted while this run was active
        return state

    def _run_dir(self, run_id: str) -> Path:
        if not isinstance(run_id, str) or not RUN_ID_RE.match(run_id):
            raise ApiError(400, "run id không hợp lệ")
        folder = self.runs_dir / run_id
        if not folder.is_dir():
            raise ApiError(404, "không có lần chạy %s" % run_id)
        return folder

    def _summary(self, folder: Path) -> Dict[str, Any]:
        run_id = folder.name
        request = _read_json(folder / "request.json") or {}
        status = _read_json(folder / "status.json") or {}
        item = {"run_id": run_id, "request": request, "state": self._state(run_id, status),
                "has_replay": (folder / "replay.json").is_file(),
                "status": status, "progress": _last_line(folder / "events.jsonl")}
        result = _read_json(folder / "result.json")
        if result:
            k = result.get("kpi", {})
            item["result"] = {
                "dispatcher": result.get("dispatcher"),
                "throughput_per_day": k.get("throughput_per_day"),
                "on_time_rate": k.get("on_time_rate"),
                "mean_cycle_time_days": k.get("mean_cycle_time_days"),
                "cqt_violations": k.get("cqt_violations"),
                "lots_completed": k.get("lots_completed"),
                "fallbacks": result.get("fallbacks"),
                "wall_seconds": result.get("wall_seconds"),
            }
        return item

    def runs(self) -> List[Dict[str, Any]]:
        folders = sorted((p for p in self.runs_dir.iterdir() if p.is_dir() and RUN_ID_RE.match(p.name)),
                         key=lambda p: p.name, reverse=True)
        with self._lock:
            return [self._summary(p) for p in folders]

    def run_detail(self, run_id: str) -> Dict[str, Any]:
        folder = self._run_dir(run_id)
        with self._lock:
            item = self._summary(folder)
        item["result_full"] = _read_json(folder / "result.json")
        item["log"] = _tail(folder / "log.txt")
        snapshot = (item["request"] or {}).get("snapshot")
        path = folder / snapshot if snapshot and FILE_RE.match(snapshot) else None
        item["source"] = path.read_text(encoding="utf-8", errors="replace") if path and path.is_file() else None
        return item

    def result_file(self, run_id: str) -> Path:
        path = self._run_dir(run_id) / "result.json"
        if not path.is_file():
            raise ApiError(404, "lần chạy chưa có kết quả")
        return path

    def layout(self, dataset: str) -> Dict[str, Any]:
        if dataset not in kernel.DATASETS:
            raise ApiError(400, "dataset phải là HVLM hoặc LVHM")
        with self._lock:
            cached = self._layouts.get(dataset)
        if cached is None:
            sim = kernel.load()
            cached = layout_from_files(sim.read.read_all(str(kernel.dataset_dir(dataset)), preprocessors=[]))
            with self._lock:
                self._layouts[dataset] = cached
        return cached

    def replay_file(self, run_id: str, name: str) -> Path:
        path = self._run_dir(run_id) / name
        if name not in ("replay.json", "replay.bin") or not path.is_file():
            raise ApiError(404, "lần chạy này không có replay")
        return path

    def gzipped(self, path: Path) -> bytes:
        """Compressed copy, cached next to the source and rebuilt only when the
        source is newer. One writer per file; concurrent readers never see a
        half-written cache (and a cache Windows keeps locked is simply skipped)."""
        packed = path.with_name(path.name + ".gz")
        with self._lock:
            lock = self._gz_locks.setdefault(packed, threading.Lock())
        with lock:
            try:
                if packed.stat().st_mtime >= path.stat().st_mtime:
                    return packed.read_bytes()
            except OSError:
                pass
            data = gzip.compress(path.read_bytes(), compresslevel=6)
            tmp = packed.with_name("%s.%s.tmp" % (packed.name, secrets.token_hex(4)))
            try:
                tmp.write_bytes(data)
                os.replace(tmp, packed)
            except OSError:
                try:
                    tmp.unlink()
                except OSError:
                    pass
            return data

    def cancel(self, run_id: str) -> Dict[str, Any]:
        folder = self._run_dir(run_id)
        with self._lock:
            if run_id in self._queue:
                self._queue.remove(run_id)
                _write_json(folder / "status.json", {"state": "cancelled", "finished_at": _now()})
            elif run_id in self._procs:
                self._cancelled.add(run_id)
                self._procs[run_id].terminate()
            else:
                raise ApiError(409, "lần chạy này không còn đang chạy")
        return {"ok": True}

    def delete(self, run_id: str) -> Dict[str, Any]:
        folder = self._run_dir(run_id)
        with self._lock:
            if run_id in self._procs or run_id in self._queue:
                raise ApiError(409, "huỷ lần chạy trước khi xoá")
            shutil.rmtree(folder)
        return {"ok": True}

    def status(self) -> Dict[str, Any]:
        problems = kernel.verify()
        return {"version": __version__, "python": platform.python_version(),
                "kernel_ok": not problems, "kernel_problems": problems[:10],
                "manifest": kernel.manifest_sha256()[:16], "workdir": str(self.workdir),
                "runs_dir": str(self.runs_dir), "mine_dir": str(self.mine_dir),
                "max_parallel": self.max_parallel}

    def shutdown(self) -> None:
        self._stop.set()
        with self._lock:
            for run_id, proc in self._procs.items():
                self._cancelled.add(run_id)
                proc.terminate()
        self._thread.join(timeout=5)
        for run_id, proc in list(self._procs.items()):
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            _write_json(self.runs_dir / run_id / "status.json", {"state": "cancelled", "finished_at": _now()})


def make_handler(app: UiApp, allowed_hosts: set):
    class Handler(BaseHTTPRequestHandler):
        server_version = "fabframe-ui"

        def log_message(self, fmt, *args):   # keep the terminal quiet
            pass

        # a client that announces a body and never sends it cannot hold a thread
        timeout = 15

        # -- plumbing --------------------------------------------------------
        def _send(self, status: int, body: bytes, content_type: str, extra: Optional[Dict[str, str]] = None,
                  cache: str = "no-store"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status: int, data: Any):
            self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def _guard(self, mutating: bool) -> None:
            if self.headers.get("Host", "") not in allowed_hosts:
                raise ApiError(403, "host không được phép")
            if mutating:
                if not secrets.compare_digest(self.headers.get("X-Fabframe-Token", ""), app.token):
                    raise ApiError(403, "thiếu hoặc sai token phiên; tải lại trang")
                if not self.headers.get("Content-Type", "").startswith("application/json"):
                    raise ApiError(415, "cần Content-Type application/json")

        def _length(self) -> int:
            try:
                return max(0, int(self.headers.get("Content-Length") or 0))
            except ValueError:
                return 0

        def _drain(self) -> None:
            """Consume the request body before any reply. Closing a socket with
            unread data makes Windows reset the connection, and the client can
            lose the reply (e.g. a 403 for a rejected POST, or a 413). Bodies are
            read in chunks and dropped, up to DRAIN_LIMIT."""
            if self._body_read:
                return
            self._body_read = True
            left = self._length()
            if left > DRAIN_LIMIT:
                self.close_connection = True
                return
            try:
                while left > 0:
                    chunk = self.rfile.read(min(left, 65536))
                    if not chunk:
                        break
                    left -= len(chunk)
            except OSError:                    # client went away or stalled past the timeout
                self.close_connection = True

        def _body(self) -> Dict[str, Any]:
            length = self._length()
            if length > MAX_BODY_BYTES:
                raise ApiError(413, "dữ liệu gửi lên quá lớn")
            raw = self.rfile.read(length)
            self._body_read = True
            try:
                data = json.loads(raw or b"{}")
            except ValueError:
                raise ApiError(400, "JSON không hợp lệ")
            if not isinstance(data, dict):
                raise ApiError(400, "cần một object JSON")
            return data

        def _dispatch(self, method: str) -> None:
            self._body_read = False
            try:
                self._guard(method in ("POST", "DELETE"))
                url = urlparse(self.path)
                parts = [p for p in url.path.split("/") if p]
                query = parse_qs(url.query)
                if method == "GET":
                    self._drain()
                    self._get(parts, query)
                elif method == "POST":
                    self._post(parts, self._body())
                elif method == "DELETE":
                    self._drain()
                    if len(parts) == 3 and parts[:2] == ["api", "runs"]:
                        self._json(200, app.delete(parts[2]))
                    else:
                        raise ApiError(404, "không có")
            except ApiError as error:
                self._reply_error(error.status, str(error))
            except Exception as error:   # never leak a traceback page, never die
                self._reply_error(500, "%s: %s" % (type(error).__name__, error))

        def _reply_error(self, status: int, message: str) -> None:
            self._drain()
            try:
                self._json(status, {"error": message})
            except OSError:                    # the client is gone: nothing left to tell it
                self.close_connection = True

        def _get(self, parts: List[str], query: Dict[str, List[str]]) -> None:
            if not parts:
                html = (STATIC_DIR / "index.html").read_text(encoding="utf-8").replace("__FABFRAME_TOKEN__", app.token)
                self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
            elif len(parts) == 2 and parts[0] == "static" and parts[1] in STATIC_TYPES:
                self._send(200, (STATIC_DIR / parts[1]).read_bytes(), STATIC_TYPES[parts[1]])
            elif len(parts) == 3 and parts[:2] == ["static", "vendor"] and parts[2] in VENDOR_TYPES:
                self._send(200, (STATIC_DIR / "vendor" / parts[2]).read_bytes(), VENDOR_TYPES[parts[2]],
                           cache="max-age=86400")
            elif (len(parts) == 5 and parts[:3] == ["static", "vendor", "jsm"] and parts[3] in JSM_DIRS
                  and JSM_FILE_RE.match(parts[4]) and (STATIC_DIR / "vendor" / "jsm" / parts[3] / parts[4]).is_file()):
                self._send(200, (STATIC_DIR / "vendor" / "jsm" / parts[3] / parts[4]).read_bytes(), JS,
                           cache="max-age=86400")
            elif parts == ["api", "layout"]:
                self._json(200, app.layout(query.get("dataset", ["HVLM"])[0]))
            elif len(parts) == 4 and parts[:2] == ["api", "runs"] and parts[3] in ("replay.json", "replay.bin"):
                path = app.replay_file(parts[2], parts[3])
                kind = "application/json; charset=utf-8" if parts[3].endswith(".json") else "application/octet-stream"
                if "gzip" in self.headers.get("Accept-Encoding", "") and path.stat().st_size > 32768:
                    self._send(200, app.gzipped(path), kind, {"Content-Encoding": "gzip"})
                else:
                    self._send(200, path.read_bytes(), kind)
            elif parts == ["api", "status"]:
                self._json(200, app.status())
            elif parts == ["api", "dispatchers"]:
                self._json(200, app.dispatchers())
            elif parts == ["api", "source"]:
                self._json(200, app.source(query.get("id", [""])[0]))
            elif parts == ["api", "template"]:
                name = query.get("name", ["my_dispatcher"])[0]
                self._json(200, app.template(name if NAME_RE.match(name) else "my_dispatcher"))
            elif parts == ["api", "runs"]:
                self._json(200, app.runs())
            elif len(parts) == 3 and parts[:2] == ["api", "runs"]:
                self._json(200, app.run_detail(parts[2]))
            elif len(parts) == 4 and parts[:2] == ["api", "runs"] and parts[3] == "result.json":
                path = app.result_file(parts[2])
                self._send(200, path.read_bytes(), "application/json; charset=utf-8",
                           {"Content-Disposition": 'attachment; filename="%s.json"' % parts[2]})
            else:
                raise ApiError(404, "không có")

        def _post(self, parts: List[str], body: Dict[str, Any]) -> None:
            if parts == ["api", "dispatchers"]:
                self._json(200, app.save(body))
            elif parts == ["api", "check"]:
                self._json(200, app.check(body))
            elif parts == ["api", "runs"]:
                self._json(200, app.create_run(body))
            elif len(parts) == 4 and parts[:2] == ["api", "runs"] and parts[3] == "cancel":
                self._json(200, app.cancel(parts[2]))
            else:
                raise ApiError(404, "không có")

        def do_GET(self):
            self._dispatch("GET")

        def do_HEAD(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_DELETE(self):
            self._dispatch("DELETE")

    return Handler


def create_server(workdir: Path, port: int = 8780, max_parallel: Optional[int] = None):
    """Bind 127.0.0.1 on ``port`` (0 = any free port); return (server, app, url)."""

    app = UiApp(workdir, max_parallel)
    last_error: Optional[OSError] = None
    for candidate in ([port] if port == 0 else range(port, port + 10)):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), make_handler(app, set()))
            break
        except OSError as error:
            last_error = error
    else:
        app.shutdown()
        raise last_error
    actual = server.server_address[1]
    allowed = {"127.0.0.1:%d" % actual, "localhost:%d" % actual}
    server.RequestHandlerClass = make_handler(app, allowed)
    server.daemon_threads = True
    return server, app, "http://127.0.0.1:%d/" % actual


def serve(workdir: Path, port: int = 8780, open_browser: bool = True, max_parallel: Optional[int] = None) -> int:
    server, app, url = create_server(workdir, port, max_parallel)
    print("fabframe UI đang chạy: %s" % url)
    print("Thư mục làm việc: %s  (kết quả trong runs\\ui, dispatcher của bạn trong my_dispatchers)" % app.workdir)
    print("Bấm Ctrl+C để dừng.")
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        print("\nĐang dừng...")
    finally:
        server.server_close()
        app.shutdown()
    return 0
