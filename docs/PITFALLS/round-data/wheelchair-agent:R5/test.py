#!/usr/bin/env python3
"""Wheelchair-agent round wheelchair-agent:R5 — issue #67.

R5 的证据本体是 `repro.sh`（两种现场：3082 空闲 / 3082 已有实例）。本文件只是
pitfalls-manager 约定的可执行入口：跑 `repro.sh` 并把它的退出码原样传出去，
让后续把 R5 列进 `run_before` 的轮次能真正复跑这份证据，而不是撞上"test.py missing"。
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[4]
EVIDENCE = HERE / "repro.sh"
FAMILY = "tests/test-deployments.mjs 跑完不碰宿主机的 3082 与 tmux 现场（#67）"


def main() -> int:
    if not EVIDENCE.is_file():
        print(f"FAIL {FAMILY}")
        print(f"missing evidence: {EVIDENCE}")
        return 1
    run = subprocess.run(["sh", str(EVIDENCE)], cwd=ROOT, capture_output=True, text=True)
    out = run.stdout + run.stderr
    if run.returncode != 0:
        print(f"FAIL {FAMILY}")
        print(f"repro.sh exit={run.returncode}")
        print(out[-4000:])
        return 1
    print(f"PASS {FAMILY}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
