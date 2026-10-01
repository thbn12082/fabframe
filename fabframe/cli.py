"""Command line: python -m fabframe {run,check,list,verify} ..."""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional


def _options(pairs: List[str]) -> Dict[str, object]:
    options: Dict[str, object] = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep or not key.isidentifier():
            raise SystemExit("--option cần dạng ten=gia_tri, nhận được %r" % pair)
        try:
            options[key] = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            options[key] = value
    return options


def _default_out(result) -> Path:
    name = re.sub(r"[^\w.-]+", "_", result.dispatcher)
    return Path("runs") / ("%s_%s_seed%d_%gd.json" % (name, result.dataset, result.seed, result.days))


def _fmt(value, digits=3):
    return "-" if value is None else (("%." + str(digits) + "f") % value if isinstance(value, float) else str(value))


def _print_summary(result) -> None:
    k = result.kpi
    print("Dispatcher : %s   (%s, seed %d, %g ngày, warm-up %g ngày, RNG %s)"
          % (result.dispatcher, result.dataset, result.seed, result.days, result.warmup_days, result.rng))
    print("Lot hoàn tất          : %s  (%s lot/ngày)" % (k["lots_completed"], _fmt(k["throughput_per_day"], 2)))
    print("Tỉ lệ đúng hạn        : %s" % _fmt(k["on_time_rate"]))
    print("Cycle time trung bình : %s ngày" % _fmt(k["mean_cycle_time_days"], 2))
    print("Trễ hạn trung bình    : %s giờ" % _fmt(k["mean_tardiness_hours"], 2))
    print("Vi phạm CQT           : %s" % k["cqt_violations"])
    print("Bước gia công (moves) : %s  (%s/ngày)" % (k["moves"], _fmt(k["moves_per_day"], 0)))
    print("Số lần đổi setup      : %s" % k["setups"])
    print("Tỉ lệ máy bận / setup : %s / %s" % (_fmt(k["busy_share"]), _fmt(k["setup_share"])))
    print("WIP cuối kỳ           : %s lot" % k["wip_end"])
    print("Quyết định            : %d, dự phòng FIFO: %d, thời gian dispatcher %.2f s (chậm nhất %.1f ms)"
          % (result.decisions, result.fallbacks, result.dispatcher_seconds, result.slowest_decision_ms))
    for reason, count in result.fallback_reasons.items():
        print("   dự phòng %5d lần: %s" % (count, reason))
    print("Thời gian chạy        : %.1f s" % result.wall_seconds)


def _cmd_run(args) -> int:
    from .runner import run

    result = run(
        args.dispatcher, dataset=args.dataset, days=args.days, seed=args.seed,
        warmup_days=args.warmup_days, rng=args.rng, strict=args.strict,
        ledger=args.ledger, progress=not args.quiet, options=_options(args.option),
        events=args.events, replay=args.replay, replay_days=args.replay_days,
    )
    out = Path(args.out) if args.out else _default_out(result)
    result.save(out)
    _print_summary(result)
    print("Kết quả JSON          : %s" % out)
    return 0


def _cmd_check(args) -> int:
    from .runner import DispatcherError, run

    try:
        result = run(args.dispatcher, dataset=args.dataset, days=args.days, seed=0,
                     strict=True, options=_options(args.option))
    except DispatcherError as error:
        print("LỖI: dispatcher không hợp lệ\n  %s" % error)
        if error.__cause__ is not None:
            print("  nguyên nhân: %r" % (error.__cause__,))
        return 1
    print("OK: '%s' chạy %g ngày %s, %d quyết định, %d lot hoàn tất, dispatcher %.2f s"
          % (result.dispatcher, result.days, result.dataset, result.decisions,
             result.kpi["lots_completed"], result.dispatcher_seconds))
    return 0


def _cmd_list(args) -> int:
    from .dispatchers import ABOUT, BUILTINS

    print("Luật Paper 4 (chạy bằng mã ở cột đầu):")
    for key, cls in BUILTINS.items():
        print("  %-18s %-18s %s" % (key, cls.name, ABOUT.get(key, "")))
    return 0


def _cmd_verify(args) -> int:
    from . import kernel

    problems = kernel.verify()
    if problems:
        print("KERNEL BỊ THAY ĐỔI (%d vấn đề):" % len(problems))
        for problem in problems:
            print("  " + problem)
        return 1
    entries = kernel.read_manifest()
    print("Kernel nguyên vẹn: %d file khớp MANIFEST.sha256 (manifest %s)"
          % (len(entries), kernel.manifest_sha256()[:16]))
    return 0


def _cmd_ui(args) -> int:
    from .ui.server import serve

    return serve(Path(args.workdir), port=args.port, open_browser=not args.no_browser,
                 max_parallel=args.parallel)


def main(argv: Optional[List[str]] = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(prog="fabframe", description="Cắm dispatcher vào mô phỏng SMT2020 và chạy.")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p, days):
        p.add_argument("dispatcher", help="mã luật có sẵn (fifo, critical-ratio, atc... xem lệnh list), "
                                          "file.py[:Class] hoặc module:Class")
        p.add_argument("--dataset", default="HVLM", choices=["HVLM", "LVHM"])
        p.add_argument("--days", type=float, default=days)
        p.add_argument("-o", "--option", action="append", default=[], metavar="TEN=GIA_TRI",
                       help="tham số truyền vào hàm khởi tạo dispatcher, ví dụ -o k=3")

    p = sub.add_parser("run", help="chạy mô phỏng và in KPI")
    common(p, 7.0)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--warmup-days", type=float, default=0.0, help="chạy FIFO trước bao nhiêu ngày (không tính KPI)")
    p.add_argument("--rng", default="semantic", choices=["semantic", "legacy"])
    p.add_argument("--strict", action="store_true", help="dừng ngay khi dispatcher lỗi thay vì dùng FIFO dự phòng")
    p.add_argument("--out", help="file JSON kết quả (mặc định runs/<tên>_<dataset>_seed<s>_<n>d.json)")
    p.add_argument("--ledger", help="ghi nhật ký từng quyết định ra file JSONL")
    p.add_argument("--events", help="ghi tiến độ ra file JSONL (giao diện web dùng)")
    p.add_argument("--replay", help="thư mục ghi replay cho cảnh 3D (replay.json + replay.bin)")
    p.add_argument("--replay-days", type=float, default=30.0, help="ghi replay tối đa bao nhiêu ngày đầu (mặc định 30)")
    p.add_argument("--quiet", action="store_true")
    p.set_defaults(func=_cmd_run)

    p = sub.add_parser("check", help="chạy thử ngắn ở chế độ nghiêm ngặt để bắt lỗi dispatcher")
    common(p, 0.25)
    p.set_defaults(func=_cmd_check)

    p = sub.add_parser("list", help="liệt kê các luật có sẵn (bộ luật Paper 4)")
    p.set_defaults(func=_cmd_list)

    p = sub.add_parser("verify", help="kiểm kernel và dữ liệu khớp MANIFEST.sha256")
    p.set_defaults(func=_cmd_verify)

    p = sub.add_parser("ui", help="mở giao diện web (chỉ trên máy này)")
    p.add_argument("--port", type=int, default=8780)
    p.add_argument("--workdir", default=".", help="nơi lưu runs/ui và my_dispatchers (mặc định: thư mục hiện tại)")
    p.add_argument("--parallel", type=int, default=None, help="số mô phỏng chạy song song tối đa")
    p.add_argument("--no-browser", action="store_true", help="không tự mở trình duyệt")
    p.set_defaults(func=_cmd_ui)

    args = parser.parse_args(argv)
    return args.func(args)
