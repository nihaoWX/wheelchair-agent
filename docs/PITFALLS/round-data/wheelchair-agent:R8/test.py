#!/usr/bin/env python3
"""R8 evidence: panel.profileFrom is gone from the schema, and old files carrying it still load.

Black box: drives the same `wheelchair-agent-core settings` CLI the panel uses.
rc=0 means both families pass.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CANDIDATES = [
    os.environ.get("WHEELCHAIR_AGENT_CORE"),
    str(ROOT / "build" / "artifacts" / "wheelchair-agent-core-linux-x64"),
    shutil.which("wheelchair-agent-core"),
]
CORE = next((Path(c) for c in CANDIDATES if c and Path(c).is_file()), None)
if CORE is None:
    print("SKIP 找不到 Rust core；先 bash build/build-core.sh（或设置 WHEELCHAIR_AGENT_CORE 指向它）")
    sys.exit(0)

FAILED = []


def core(request):
    proc = subprocess.run(
        [str(CORE), "settings"],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        cwd=ROOT,
        timeout=60,
    )
    if proc.returncode != 0:
        raise AssertionError(f"core exited {proc.returncode}: {proc.stderr.strip()}")
    envelope = json.loads(proc.stdout)
    if envelope.get("ok") is not True:
        raise AssertionError(f"core refused: {envelope}")
    return envelope["data"]


def check(family, probe):
    try:
        probe()
    except AssertionError as error:
        FAILED.append(family)
        print(f"FAIL {family}: {error}")
    else:
        print(f"PASS {family}")


def schema_has_no_retired_key():
    specs = core({"op": "specs"})["specs"]
    assert "panel.profileFrom" not in specs, "settings specs 仍列出 panel.profileFrom"
    assert not [key for key in specs if "profileFrom" in key], sorted(specs)


def legacy_value_is_dropped_silently():
    data = core({
        "op": "resolve",
        "fillMissing": True,
        "values": {"panel.profileFrom": "superagent", "panel.profilFrom": "typo"},
        "filled": ["panel.profileFrom"],
        "env": {},
    })
    assert "panel.profileFrom" not in data["values"], data["values"]
    assert "panel.profileFrom" not in data["effective"], data["effective"]
    warnings = data.get("valuesWarnings") or []
    assert not any("panel.profileFrom" in w for w in warnings), warnings
    assert any("panel.profilFrom" in w for w in warnings), warnings
    fill = data.get("fill") or {}
    assert "panel.profileFrom" not in (fill.get("values") or {}), fill
    assert "panel.profileFrom" not in (fill.get("filled") or []), fill


check("settings 表不再宣传已退休的 panel.profileFrom", schema_has_no_retired_key)
check("旧文件残留值静默丢弃、真错键仍告警", legacy_value_is_dropped_silently)
sys.exit(1 if FAILED else 0)
