#!/bin/sh
# Issue #67 — tests/test-deployments.mjs must not start a real deployment.
#
# What used to happen: the migrate fixture wrote SPV_SERVICE_PORT=3082 and
# DSH_SUPERAGENT_PROFILE=superagent into the registry, then dispatched. Dispatch calls
# ensureDeploymentStarted(), and the fixture had no fake service manager, so it really ran
#   python3 commands/superagent-service.py start --profile superagent --patch <sandbox>/...
# on the host: a listener on 3082 and a tmux session wca-wheelchair-agent. A second run then
# died at tests/test-deployments.mjs:588 with "1 !== 0" because the first instance was still alive.
#
# The fix gives the fixture a kernel-chosen port, a live fake instance on that port and a fake
# python3 that records any service argv and refuses to start. This script pins the observable
# contract at the process boundary, independently of the test's own guard:
#   1. if 3082 is free, occupy it with a placeholder instance (never touch or kill an existing one);
#   2. run tests/test-deployments.mjs;
#   3. assert the host's 3082 listeners and tmux session list are identical before and after.
# ss/tmux are optional: when one cannot be read the matching check is SKIPped, never guessed.
#
# This is the copy at the short path the task named; canonical evidence (meta.toml) lives in
# docs/PITFALLS/round-data/wheelchair-agent:R5/ and query resolves that directory by ledger id.
# usage: sh docs/PITFALLS/round-data/R5/repro.sh    (from anywhere inside the checkout)
# exit: 0 = the test passed and the host is unchanged; non-zero = regression or unreadable check.

set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 2
root=$(git -C "$here" rev-parse --show-toplevel 2>/dev/null) || {
  echo "FAIL: not inside a git checkout: $here"
  exit 2
}
cd "$root" || exit 2

fail=0
placeholder_pid=""
cleanup() {
  if [ -n "$placeholder_pid" ]; then
    kill "$placeholder_pid" 2>/dev/null
    wait "$placeholder_pid" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

have_ss=0
command -v ss >/dev/null 2>&1 && have_ss=1
have_tmux=0
command -v tmux >/dev/null 2>&1 && have_tmux=1

snapshot_ss() {
  ss -lptnH 'sport = :3082' 2>/dev/null || true
}

# Prints session names, one per line. An absent tmux server means "no sessions", not unreadable.
snapshot_tmux() {
  out=$(tmux list-sessions -F '#{session_name}' 2>&1) || {
    case "$out" in
      *"no server running"*|*"no sessions"*) printf '' ; return 0 ;;
      *) return 1 ;;
    esac
  }
  printf '%s\n' "$out"
}

if [ "$have_ss" = 1 ]; then
  if [ -z "$(snapshot_ss)" ]; then
    node -e '
      const http = require("node:http");
      const body = JSON.stringify({ setup: { problem: { detail: "placeholder from docs/PITFALLS/round-data/R5/repro.sh (issue #67)" } } });
      http.createServer((req, res) => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(body);
      }).listen(3082, "127.0.0.1");
    ' &
    placeholder_pid=$!
    i=0
    while [ "$i" -lt 50 ]; do
      [ -n "$(snapshot_ss)" ] && break
      i=$((i + 1))
      sleep 0.1
    done
    if [ -n "$(snapshot_ss)" ]; then
      echo "occupying 3082 with placeholder pid $placeholder_pid"
    else
      echo "FAIL: could not occupy 3082"
      fail=1
    fi
  else
    echo "3082 already has a listener; leaving it alone"
  fi
else
  echo "SKIP: ss is not available; cannot check or occupy host port 3082"
fi

before_ss=""
if [ "$have_ss" = 1 ]; then
  before_ss=$(snapshot_ss)
fi
before_tmux="__SKIP__"
if [ "$have_tmux" = 1 ]; then
  before_tmux=$(snapshot_tmux) || {
    echo "SKIP: tmux sessions are unreadable"
    before_tmux="__SKIP__"
  }
else
  echo "SKIP: tmux is not available"
fi

echo "== node tests/test-deployments.mjs"
if node tests/test-deployments.mjs; then
  echo "PASS: tests/test-deployments.mjs exited 0"
else
  echo "FAIL: tests/test-deployments.mjs exited non-zero"
  fail=1
fi

if [ "$have_ss" = 1 ]; then
  after_ss=$(snapshot_ss)
  if [ "$before_ss" = "$after_ss" ]; then
    echo "PASS: host port 3082 listeners are unchanged"
  else
    echo "FAIL: host port 3082 listeners changed"
    printf 'before:\n%s\nafter:\n%s\n' "$before_ss" "$after_ss"
    fail=1
  fi
fi

if [ "$before_tmux" != "__SKIP__" ]; then
  after_tmux=$(snapshot_tmux) || after_tmux="__UNREADABLE__"
  if [ "$before_tmux" = "$after_tmux" ]; then
    echo "PASS: host tmux sessions are unchanged"
  else
    echo "FAIL: host tmux sessions changed"
    printf 'before:\n%s\nafter:\n%s\n' "$before_tmux" "$after_tmux"
    fail=1
  fi
fi

if [ "$fail" = 0 ]; then
  echo "RESULT: PASS"
else
  echo "RESULT: FAIL"
fi
exit "$fail"
