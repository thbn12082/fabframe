"""Web UI: API behaviour, run lifecycle and the local-only safety checks."""

import gzip
import http.client
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from fabframe.dispatchers import BUILTINS
from fabframe.ui.server import create_server


@pytest.fixture()
def ui(tmp_path):
    server, app, url = create_server(tmp_path, port=0, max_parallel=2)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
    thread.start()
    port = server.server_address[1]

    def call(method, path, body=None, token=True, host=None, content_type="application/json"):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=120)
        headers = {"Host": host or "127.0.0.1:%d" % port}
        data = None
        if body is not None or method in ("POST", "DELETE"):
            data = json.dumps(body or {}, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = content_type
            if token:
                headers["X-Fabframe-Token"] = app.token
        conn.request(method, path, body=data, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        try:
            return response.status, json.loads(raw)
        except ValueError:
            return response.status, raw.decode("utf-8", "replace")

    call.port = port
    yield call, app
    server.shutdown()
    server.server_close()
    app.shutdown()


def wait_for(call, run_id, states=("done", "failed", "cancelled"), timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, detail = call("GET", "/api/runs/" + run_id)
        if detail["state"] in states:
            return detail
        time.sleep(0.3)
    raise AssertionError("run did not finish: %r" % detail["state"])


def test_page_and_catalog(ui):
    call, app = ui
    status, html = call("GET", "/")
    assert status == 200 and app.token in html and "__FABFRAME_TOKEN__" not in html
    assert call("GET", "/static/app.js")[0] == 200
    status, info = call("GET", "/api/status")
    assert info["kernel_ok"] is True
    # the picker offers Paper 4's rules, in Paper 4's order under their usual names, and the
    # user's own files; nothing else (no tutorial examples)
    catalog = call("GET", "/api/dispatchers")[1]
    assert [d["id"] for d in catalog] == ["builtin:" + key for key in BUILTINS]
    assert [d["name"] for d in catalog] == [cls.name for cls in BUILTINS.values()]
    assert all(d["kind"] == "builtin" and "Paper 4" in d["doc"] for d in catalog)
    status, src = call("GET", "/api/source?id=builtin:fifo")
    assert status == 200 and "class FIFO" in src["code"] and src["editable"] is False
    assert call("GET", "/api/source?id=example:my_rule.py")[0] == 400


def test_security_checks(ui):
    call, app = ui
    assert call("GET", "/api/status", host="evil.example")[0] == 403
    assert call("POST", "/api/runs", {"dispatcher": "builtin:fifo"}, token=False)[0] == 403
    assert call("POST", "/api/runs", {"dispatcher": "builtin:fifo"}, content_type="text/plain")[0] == 415
    assert call("GET", "/api/source?id=mine:..%5C..%5Crunner.py")[0] == 400
    assert call("GET", "/api/runs/..%2F..%2Fx")[0] == 400
    assert call("GET", "/static/server.py")[0] == 404
    assert call("POST", "/api/dispatchers", {"name": "../x", "code": "x = 1"})[0] == 400


def test_save_check_run_and_delete(ui):
    call, app = ui
    status, template = call("GET", "/api/template?name=ui_rule")
    assert "Điểm CAO chạy TRƯỚC" in template["code"]          # Vietnamese text survives
    assert "return lot.priority - lot.cr" in template["code"]  # starts from Paper 4's own custom rule
    status, saved = call("POST", "/api/dispatchers", {"name": "ui_rule", "code": template["code"]})
    assert status == 200 and saved["id"] == "mine:ui_rule.py"
    assert (app.mine_dir / "ui_rule.py").read_text(encoding="utf-8") == template["code"]

    status, bad = call("POST", "/api/dispatchers", {"name": "broken", "code": "def score(:\n"})
    assert status == 400 and "cú pháp" in bad["error"]

    status, checked = call("POST", "/api/check", {"id": "mine:ui_rule.py"})
    assert checked["ok"] is True and checked["output"].startswith("OK")

    status, created = call("POST", "/api/runs", {"dispatcher": "mine:ui_rule.py", "days": 0.3, "seed": 1})
    assert status == 200
    run_id = created["run_id"]
    detail = wait_for(call, run_id)
    assert detail["state"] == "done", detail["log"]
    result = detail["result_full"]
    assert result["dispatcher"] == "ui-rule" and result["fallbacks"] == 0
    assert result["kpi"]["daily"] and detail["source"] == template["code"]
    assert detail["progress"]["state"] == "finished"
    status, raw = call("GET", "/api/runs/%s/result.json" % run_id)
    assert status == 200

    # replay: the run records its whole (short) window; parallel gzip requests
    # all get complete, identical data while the cache is being built
    status, meta = call("GET", "/api/runs/%s/replay.json" % run_id)
    assert status == 200 and meta["replay_days"] == 0.3 and meta["dataset"] == "HVLM"
    plain = (app.runs_dir / run_id / "replay.bin").read_bytes()
    assert len(plain) > 32768

    def fetch(_):
        conn = http.client.HTTPConnection("127.0.0.1", call.port, timeout=60)
        conn.request("GET", "/api/runs/%s/replay.bin" % run_id,
                     headers={"Host": "127.0.0.1:%d" % call.port, "Accept-Encoding": "gzip"})
        response = conn.getresponse()
        body = response.read()
        conn.close()
        return response.status, response.getheader("Content-Encoding"), body

    with ThreadPoolExecutor(6) as pool:
        replies = list(pool.map(fetch, range(12)))
    assert all(r[0] == 200 and r[1] == "gzip" and gzip.decompress(r[2]) == plain for r in replies)
    assert not list((app.runs_dir / run_id).glob("*.tmp"))

    # editing the file later does not change what the finished run recorded
    (app.mine_dir / "ui_rule.py").write_text("x = 1\n", encoding="utf-8")
    assert call("GET", "/api/runs/" + run_id)[1]["source"] == template["code"]

    assert call("DELETE", "/api/runs/" + run_id)[0] == 200
    assert call("GET", "/api/runs/" + run_id)[0] == 404


def test_failing_dispatcher_reports_check_error(ui):
    call, app = ui
    code = "def score(lot, decision):\n    return 'cao'\n"
    call("POST", "/api/dispatchers", {"name": "text_score", "code": code})
    status, checked = call("POST", "/api/check", {"id": "mine:text_score.py"})
    assert checked["ok"] is False and "InvalidScore" in checked["output"]


def test_cancel_and_validation(ui):
    call, app = ui
    assert call("POST", "/api/runs", {"dispatcher": "builtin:fifo", "days": 0})[0] == 400
    assert call("POST", "/api/runs", {"dispatcher": "builtin:nope", "days": 1})[0] == 404
    assert call("POST", "/api/runs", {"dispatcher": "builtin:fifo", "days": 1, "options": {"x;y": 1}})[0] == 400
    status, created = call("POST", "/api/runs", {"dispatcher": "builtin:atc", "days": 60, "options": {"k": 3}})
    run_id = created["run_id"]
    wait_for(call, run_id, states=("running",), timeout=60)
    assert call("DELETE", "/api/runs/" + run_id)[0] == 409          # must cancel first
    assert call("POST", "/api/runs/%s/cancel" % run_id)[0] == 200
    assert wait_for(call, run_id)["state"] == "cancelled"


def test_rejected_uploads_still_get_their_reply(ui):
    """A 413 for an oversized body, or a 403 before the body was read, reaches
    the client instead of a reset connection (Windows resets a socket closed
    with unread data)."""
    call, app = ui
    from fabframe.ui.server import MAX_BODY_BYTES
    big = json.dumps({"name": "x", "code": "#" * (MAX_BODY_BYTES + 100_000)}).encode("utf-8")
    for token, expected in ((app.token, 413), ("wrong", 403)) * 3:
        conn = http.client.HTTPConnection("127.0.0.1", call.port, timeout=60)
        conn.request("POST", "/api/dispatchers", body=big, headers={
            "Host": "127.0.0.1:%d" % call.port, "Content-Type": "application/json", "X-Fabframe-Token": token})
        response = conn.getresponse()
        assert response.status == expected
        assert "error" in json.loads(response.read())
        conn.close()
