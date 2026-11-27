#!/usr/bin/env python3
"""Wheelchair-agent round wheelchair-agent:R7 — issue #71.

Black box: a fake panel plus the real `wheelchair-agent` CLI. Before the fix,
dispatch completed `policy.sources` but never `executor.prepare`, so it wrote a
task file that the worker would pick up in an un-cloned directory. This script
never touches a real deployment: every sandbox is a temp dir and every panel is
a throwaway HTTP server on 127.0.0.1:0.

Families (one PASS/FAIL line each):
  1. empty prepare  -> dispatch PUTs executor once, then queues exactly one task;
  2. executor PUT 500 -> dispatch fails, names executor.prepare, queues nothing;
  3. custom prepare -> dispatch keeps it, sends no executor PUT, queues one task.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CLI = ROOT / "bin" / "wheelchair-agent.mjs"
NODE = shutil.which("node") or "node"
DEFAULT_PREPARE = "wheelchair-agent prepare"
PROJECT = "tools/alpha"

FAMILY_EMPTY = "空 executor.prepare：dispatch 先补 prepare 再落一个任务文件（#71）"
FAMILY_FAIL = "executor PUT 失败：dispatch 不落盘，错误点名 executor.prepare（#71）"
FAMILY_CUSTOM = "自定义 executor.prepare：dispatch 不覆盖、不发 PUT（#71）"


class Panel:
    """Minimal stand-in for the orchestrator panel's settings + state routes."""

    def __init__(self, prepare="", executor_status=200):
        self.prepare = prepare
        self.executor_status = executor_status
        self.revision = 5
        self.executor_revision = 7
        self.policy = {
            "rules": [],
            "sources": {"spv": {"allowed": [{"id": "operator", "name": "Ops"}]}},
        }
        self.puts = []
        panel = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _body(self):
                length = int(self.headers.get("content-length") or 0)
                return json.loads(self.rfile.read(length) or b"null")

            def _json(self, value, status=200):
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == "/orchestrator/api/settings":
                    self._json({
                        "blocks": {
                            "policy": {"revision": panel.revision, "value": panel.policy},
                            "executor": {"revision": panel.executor_revision, "value": {"prepare": panel.prepare}},
                        },
                        "sources": [],
                    })
                elif self.path == "/orchestrator/api/state":
                    self._json({"setup": {"accounts": {"repository": "nihaoWX/alpha"}}})
                else:
                    self._json({}, 404)

            def do_PUT(self):
                body = self._body()
                panel.puts.append((self.path, body))
                if self.path == "/orchestrator/api/settings/executor":
                    if panel.executor_status != 200:
                        self._json({"error": "executor exploded"}, panel.executor_status)
                        return
                    panel.prepare = body["value"]["prepare"]
                    panel.executor_revision += 1
                    self._json({"saved": True, "revision": panel.executor_revision})
                elif self.path == "/orchestrator/api/settings/policy":
                    panel.policy = body["value"]
                    panel.revision += 1
                    self._json({"saved": True, "revision": panel.revision})
                else:
                    self._json({}, 404)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    def executor_puts(self):
        return [body for path, body in self.puts if path == "/orchestrator/api/settings/executor"]


def make_box():
    base = Path(tempfile.mkdtemp(prefix="wca-r7-"))
    for name in ("home", "dsh", "data"):
        (base / name).mkdir()
    return base


def env_for(box):
    drop = {
        "SPV_QUEUE_DIR", "DSH_SUPERAGENT_URL", "DSH_SUPERAGENT_PORT",
        "SPV_SUPERAGENT_URL", "DSH_SUPERAGENT_PROFILE",
    }
    env = {key: value for key, value in os.environ.items() if key not in drop}
    env.update({
        "HOME": str(box / "home"),
        "DSH_HOME": str(box / "dsh"),
        "WHEELCHAIR_AGENT_HOME": str(box / "data"),
        "DSH_SUPERAGENT_STATE_DIR": str(box / "state"),
    })
    return env


def run_cli(box, *args):
    return subprocess.run(
        [NODE, str(CLI), *args],
        cwd=str(box),
        env=env_for(box),
        capture_output=True,
        text=True,
        timeout=60,
    )


def register(box, panel):
    run = run_cli(
        box, "deployment", "add", PROJECT, "--repo", "nihaoWX/alpha",
        "--state-dir", str(box / "state"), "--queue-dir", str(box / "state" / "spv"),
        "--port", str(panel.port),
    )
    return run


def pending_files(box):
    pending = box / "state" / "spv" / "pending"
    if not pending.is_dir():
        return []
    return sorted(path for path in pending.iterdir() if path.suffix == ".json" and not path.name.startswith("."))


def check_empty_prepare():
    with Panel(prepare="") as panel:
        box = make_box()
        try:
            added = register(box, panel)
            if added.returncode != 0:
                return [f"deployment add failed: {added.stderr[-800:]}"]
            sent = run_cli(box, "dispatch", "--project", PROJECT, "--task", "fill prepare first")
            problems = []
            if sent.returncode != 0:
                problems.append(f"dispatch exit={sent.returncode}: {(sent.stderr or sent.stdout)[-800:]}")
            puts = panel.executor_puts()
            if len(puts) != 1:
                problems.append(f"expected 1 executor PUT, saw {len(puts)}")
            elif puts[0].get("value", {}).get("prepare") != DEFAULT_PREPARE:
                problems.append(f"executor PUT body={puts[0]!r}")
            if panel.prepare != DEFAULT_PREPARE:
                problems.append(f"panel prepare={panel.prepare!r}")
            files = pending_files(box)
            if len(files) != 1:
                problems.append(f"expected 1 queued task, saw {len(files)}")
            return problems
        finally:
            shutil.rmtree(box, ignore_errors=True)


def check_failed_prepare():
    with Panel(prepare="", executor_status=500) as panel:
        box = make_box()
        try:
            added = register(box, panel)
            if added.returncode != 0:
                return [f"deployment add failed: {added.stderr[-800:]}"]
            sent = run_cli(box, "dispatch", "--project", PROJECT, "--task", "must not land")
            problems = []
            if sent.returncode == 0:
                problems.append("dispatch exited 0 even though executor.prepare could not be filled")
            if "executor.prepare could not be filled" not in sent.stderr:
                problems.append(f"stderr does not name executor.prepare: {sent.stderr[-800:]!r}")
            if "Nothing was queued" not in sent.stderr:
                problems.append(f"stderr lacks 'Nothing was queued': {sent.stderr[-800:]!r}")
            files = pending_files(box)
            if files:
                problems.append(f"queued {len(files)} task(s) despite the failure")
            if panel.prepare != "":
                problems.append(f"panel prepare changed to {panel.prepare!r}")
            return problems
        finally:
            shutil.rmtree(box, ignore_errors=True)


def check_custom_prepare():
    custom = "my own prepare --project tools/alpha"
    with Panel(prepare=custom) as panel:
        box = make_box()
        try:
            added = register(box, panel)
            if added.returncode != 0:
                return [f"deployment add failed: {added.stderr[-800:]}"]
            sent = run_cli(box, "dispatch", "--project", PROJECT, "--task", "keep my prepare")
            problems = []
            if sent.returncode != 0:
                problems.append(f"dispatch exit={sent.returncode}: {(sent.stderr or sent.stdout)[-800:]}")
            puts = panel.executor_puts()
            if puts:
                problems.append(f"a custom prepare must not be overwritten, saw {len(puts)} executor PUT(s)")
            if panel.prepare != custom:
                problems.append(f"panel prepare={panel.prepare!r}, expected the custom value")
            files = pending_files(box)
            if len(files) != 1:
                problems.append(f"expected 1 queued task, saw {len(files)}")
            return problems
        finally:
            shutil.rmtree(box, ignore_errors=True)


def main():
    failed = False
    for family, check in (
        (FAMILY_EMPTY, check_empty_prepare),
        (FAMILY_FAIL, check_failed_prepare),
        (FAMILY_CUSTOM, check_custom_prepare),
    ):
        try:
            problems = check()
        except Exception as error:  # noqa: BLE001 - evidence must report any crash as FAIL
            problems = [f"crashed: {error!r}"]
        if problems:
            failed = True
            print(f"FAIL {family}")
            for problem in problems:
                print(f"  - {problem}")
        else:
            print(f"PASS {family}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
