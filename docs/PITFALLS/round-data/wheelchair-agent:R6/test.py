#!/usr/bin/env python3
"""Wheelchair-agent round wheelchair-agent:R6 — issue #69.

Black-box: run the deployment test file and require it to stay under the
per-file bound. The old negative setup case waited out the 90 s default.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
FAMILY = "tests/test-deployments.mjs 整份文件 15 s 内退出（#69）"
LIMIT_S = 15.0


def main() -> int:
    started = time.monotonic()
    run = subprocess.run(
        ["node", "tests/test-deployments.mjs"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    elapsed = time.monotonic() - started
    if run.returncode != 0:
        print(f"FAIL {FAMILY}")
        print(f"exit={run.returncode} elapsed={elapsed:.2f}s")
        print((run.stdout + run.stderr)[-4000:])
        return 1
    if elapsed >= LIMIT_S:
        print(f"FAIL {FAMILY}")
        print(f"elapsed={elapsed:.2f}s >= {LIMIT_S:.0f}s")
        return 1
    print(f"PASS {FAMILY} ({elapsed:.2f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
