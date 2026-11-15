#!/bin/sh
# Exercise install.sh's cold-install gate end to end in a throwaway sandbox.
#
# Offline by construction: HOME, DSH_HOME, SPV_BIN_DIR and SPV_QUEUE_DIR all point inside the sandbox, a
# fake `dsh-tui` satisfies the prerequisite, and a fake probe replaces the /proc scan. The fake probe is
# the seam install.sh documents (`SPV_INSTALL_PROBE`): it prints the same key=value lines as
# `commands/superagent-service.py probe`, so the test states "the service/SPV session is running" as a
# fixture instead of depending on what happens to run on the machine. No real service, preset or dsh is
# touched.
#
# What it proves:
#   - a refusal exits 3, explains what is in use, and creates nothing under any install target (a virgin
#     refusal leaves the preset directory and the bin directory absent);
#   - exactly one outbox notice is written, and a repeated refusal does not add a second one;
#   - a missing queue is reported in one line, is not created, and still exits 3;
#   - the cold path installs, a second run is the idempotent "up to date", and --check then exits 0;
#   - --check is read-only while it reports an in-use holder, and the refused install leaves the
#     installed tree byte-identical.
#
# Usage: sh tests/test-install.sh [--keep]
#   --keep   leave the sandbox in place and print its path
# Exit status: 0 when every case passes, 1 otherwise.
set -u

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO=$(CDPATH= cd -- "$SELF_DIR/.." && pwd -P)
INSTALL=$REPO/install.sh
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

SB=$(mktemp -d "${TMPDIR:-/tmp}/spv-install-test.XXXXXX") || exit 1
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }

cleanup() {
  if [ "$KEEP" = 1 ]; then printf '\nsandbox kept at %s\n' "$SB"; else rm -rf "$SB"; fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- fixtures

mkdir -p "$SB/home" "$SB/tools" "$SB/dsh/profiles/superagent"

# The only thing install.sh needs from dsh-tui is that it resolves on PATH.
cat > "$SB/tools/dsh-tui" <<'FAKE'
#!/bin/sh
exit 0
FAKE
chmod +x "$SB/tools/dsh-tui"

# The probe seam: same output shape as `superagent-service.py probe`, driven by marker files so one test
# run can be cold, hot, or hot for only one of the two holders.
cat > "$SB/tools/fake-probe" <<'FAKE'
#!/bin/sh
if [ -f "$FAKE_PROBE_SERVICE" ]; then
  printf 'service_pids=4242\n'
else
  printf 'service_pids=\n'
fi
if [ -f "$FAKE_PROBE_SPV" ]; then
  printf 'spv_pids=4243 4244\n'
else
  printf 'spv_pids=\n'
fi
printf 'service_port=3082\npreset_patch=/fake/preset-default.patch.yml\n'
FAKE
chmod +x "$SB/tools/fake-probe"

SERVICE_MARKER=$SB/hot-service
SPV_MARKER=$SB/hot-spv
set_state() {
  rm -f "$SERVICE_MARKER" "$SPV_MARKER"
  case ${1:-} in
    service|both) : > "$SERVICE_MARKER" ;;
  esac
  case ${1:-} in
    spv|both) : > "$SPV_MARKER" ;;
  esac
}

run_install() {
  (
    export HOME="$SB/home" DSH_HOME="$SB/dsh" SPV_BIN_DIR="$SB/local-bin" \
      SPV_QUEUE_DIR="$SB/queue" SPV_INSTALL_PROBE="$SB/tools/fake-probe" \
      FAKE_PROBE_SERVICE="$SERVICE_MARKER" FAKE_PROBE_SPV="$SPV_MARKER" \
      SPV_SERVICE_PORT=3082 PATH="$SB/tools:$PATH"
    bash "$INSTALL" "$@"
  ) >"$SB/stdout" 2>"$SB/stderr"
}

# A content-and-path hash of every install target; used to prove a call wrote nothing.
install_snapshot() {
  {
    find "$SB/dsh" "$SB/local-bin" -print 2>/dev/null | sort
    find "$SB/dsh" "$SB/local-bin" -type f 2>/dev/null | sort | xargs -r sha256sum
  } | sha256sum | cut -d' ' -f1
}

notice_count() { find "$SB/queue/outbox" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' '; }
notice_file() {
  find "$SB/queue/outbox" -maxdepth 1 -name 'install-cold-refusal-*.json' -type f 2>/dev/null | head -1
}
notice_field() {
  node -e 'const m = require(process.argv[1]); process.stdout.write(String(m[process.argv[2]] ?? ""))' \
    "$(notice_file)" "$1" 2>/dev/null
}

# ------------------------------------------------------------------- cases

# (0) A virgin machine with both holders running: refuse, write nothing to an install target, and do not
# invent the queue the notice would go into.
set_state both
run_install
check '(0) virgin refusal exits 3' "$?" 3
check '(0) the refusal says it is refusing' "$(grep -c 'FAIL: refusing to install' "$SB/stderr")" 1
check '(0) the refusal names the service' "$(grep -c 'the superagent service (pid 4242, port 3082)' "$SB/stderr")" 1
check '(0) the refusal names the SPV session' "$(grep -c 'a live SPV session (pids 4243 4244)' "$SB/stderr")" 1
check '(0) the refusal gives the stop command' "$(grep -c 'wheelchair-agent service stop' "$SB/stderr")" 1
check '(0) no preset was created' "$([ -e "$SB/dsh/.agent-presets/spv" ] && echo present || echo absent)" absent
check '(0) no bin directory was created' "$([ -e "$SB/local-bin" ] && echo present || echo absent)" absent
check '(0) the missing queue is reported in one line' "$(grep -c '^note: no spv queue at .* (the service has never run)$' "$SB/stdout")" 1
check '(0) the missing queue was not created' "$([ -e "$SB/queue" ] && echo present || echo absent)" absent

# (1) With a queue in place: exactly one notice, its shape, and no second notice on a repeated refusal.
mkdir -p "$SB/queue"
run_install
check '(1) refusal with a queue exits 3' "$?" 3
check '(1) exactly one notice is written' "$(notice_count)" 1
check '(1) the notice kind is notice' "$(notice_field kind)" notice
check '(1) the notice id is derived from the blockers' \
  "$(notice_field id | grep -c '^install-cold-refusal-[0-9][0-9]*$')" 1
check '(1) the notice says a cold install is required' \
  "$(notice_field text | grep -c 'install.sh performs cold installs only')" 1
check '(1) the notice gives the stop command' "$(notice_field text | grep -c 'wheelchair-agent service stop')" 1
first_id=$(notice_field id)
run_install
check '(1) a repeated refusal still exits 3' "$?" 3
check '(1) a repeated refusal does not add a notice' "$(notice_count)" 1
check '(1) the repeated refusal keeps the same id' "$(notice_field id)" "$first_id"

# (2) The cold path is unchanged: install, then the idempotent second run, then --check exits 0.
set_state
run_install
check '(2) the cold install exits 0' "$?" 0
check '(2) the preset landed' "$([ -f "$SB/dsh/.agent-presets/spv/preset.yml" ] && echo yes || echo no)" yes
check '(2) the CLI landed' "$([ -x "$SB/local-bin/wheelchair-agent" ] && echo yes || echo no)" yes
check '(2) the webui package landed' \
  "$([ -f "$SB/dsh/profiles/superagent/node_modules/wheelchair-agent-webui/package.json" ] && echo yes || echo no)" yes
run_install
check '(2) the second cold install exits 0' "$?" 0
check '(2) the second cold install reports up to date' \
  "$(grep -q 'up to date' "$SB/stdout" && echo yes || echo no)" yes
check '(2) the second cold install replaced nothing' "$(grep -c '^OK: installed' "$SB/stdout")" 0
run_install --check
check '(2) --check exits 0 on a cold install' "$?" 0
check '(2) --check says a cold install is allowed' "$(grep -c 'a cold install is allowed' "$SB/stdout")" 1

# (3) --check while both holders run: it reports them and mutates nothing.
set_state both
before=$(install_snapshot)
run_install --check
check '(3) --check while in use exits 0' "$?" 0
check '(3) --check reports the service' "$(grep -c 'the superagent service is running (pid 4242, port 3082)' "$SB/stdout")" 1
check '(3) --check reports the SPV session' "$(grep -c 'a live SPV session holds the preset (pids 4243 4244)' "$SB/stdout")" 1
check '(3) --check changed nothing' "$(install_snapshot)" "$before"

# (4) A refused install after the cold install leaves the installed tree byte-identical.
before=$(install_snapshot)
run_install
check '(4) the hot install exits 3' "$?" 3
check '(4) the refused install changed nothing' "$(install_snapshot)" "$before"
check '(4) the refusal did not stack a second notice' "$(notice_count)" 1

# (5) A service-only refusal names the service and not the SPV session (the two detections are separate).
set_state service
run_install
check '(5) the service-only refusal exits 3' "$?" 3
check '(5) it names the service' "$(grep -c 'the superagent service (pid 4242' "$SB/stderr")" 1
check '(5) it does not invent an SPV session' "$(grep -c 'a live SPV session' "$SB/stderr")" 0
# A changed blocker set is a new refusal, so it gets its own id and its own notice. The previous notice
# stays in the outbox: notifications are additive, only retries of the same blockers are deduplicated.
check '(5) a changed blocker set writes a second notice' "$(notice_count)" 2
check '(5) the two notices have different ids' \
  "$(find "$SB/queue/outbox" -maxdepth 1 -name 'install-cold-refusal-*.json' -type f | wc -l | tr -d ' ')" 2

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
