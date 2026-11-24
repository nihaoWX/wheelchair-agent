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

# The harness is hermetic even when the operator who runs it has real paths exported: install.sh
# honors WHEELCHAIR_AGENT_HOME / DSH_SUPERAGENT_STATE_DIR (and the explicit SPV_* overrides), so the
# environment is pinned below and the "inherited root" case proves nothing leaks into them.
INHERITED_ROOT=$SB/inherited-home
INHERITED_STATE=$SB/inherited-state
export WHEELCHAIR_AGENT_HOME="$INHERITED_ROOT"
export DSH_SUPERAGENT_STATE_DIR="$INHERITED_STATE"

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
  printf 'service_pids=99999999\n'
else
  printf 'service_pids=\n'
fi
if [ -f "$FAKE_PROBE_SPV" ]; then
  printf 'spv_pids=99999998 99999997\n'
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
      SPV_SERVICE_PORT=3082 PATH="$SB/tools:$PATH" \
      WHEELCHAIR_AGENT_HOME="$SB/home/.wheelchair-agent" \
      DSH_SUPERAGENT_STATE_DIR="$SB/dsh/state/superagent"
    unset SPV_INBOX_DIR SPV_PREPARE_LOG
    bash "$INSTALL" "$@"
  ) >"$SB/stdout" 2>"$SB/stderr"
}

# A content-and-path hash of every install target; used to prove a call wrote nothing.
install_snapshot() {
  {
    find "$SB/dsh" "$SB/local-bin" "$SB/home" -print 2>/dev/null | sort
    find "$SB/dsh" "$SB/local-bin" "$SB/home" -type f 2>/dev/null | sort | while IFS= read -r file; do
      sha256sum "$file"
      stat -c '%a %n' "$file"
    done
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
check '(0) the refusal names the service' "$(grep -c 'the superagent service (pid 99999999, port 3082)' "$SB/stderr")" 1
check '(0) the refusal names the SPV session' "$(grep -c 'a live SPV session (pids 99999998 99999997)' "$SB/stderr")" 1
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
check '(1) the notice names the service blocker' \
  "$(notice_field text | grep -c 'the superagent service (pid 99999999, port 3082)')" 1
check '(1) the notice names the SPV blocker' \
  "$(notice_field text | grep -c 'a live SPV session (pids 99999998 99999997)')" 1
check '(1) the notice gives the stop command' "$(notice_field text | grep -c 'service stop')" 1
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
check '(2) the Rust core binary landed' \
  "$([ -x "$SB/local-bin/wheelchair-agent-core" ] && echo yes || echo no)" yes
check '(2) the CLI landed' "$([ -x "$SB/local-bin/wheelchair-agent" ] && echo yes || echo no)" yes
check '(2) the webui package landed' \
  "$([ -f "$SB/dsh/profiles/superagent/node_modules/wheelchair-agent-webui/package.json" ] && echo yes || echo no)" yes
check '(2) the data root and its subdirectories were created' \
  "$([ -d "$SB/home/.wheelchair-agent/logs" ] && [ -d "$SB/home/.wheelchair-agent/records" ] && [ -d "$SB/home/.wheelchair-agent/inbox" ] && echo yes || echo no)" yes
check '(2) install created the settings file' \
  "$([ -f "$SB/home/.wheelchair-agent/settings.json" ] && echo yes || echo no)" yes
check '(2) the shipped settings file carries every default' \
  "$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=s.values||{}; process.stdout.write(s.version===1&&s.revision===0&&Object.keys(v).length===8&&v["webui.style"]==="fluid"&&v["inbox.intervalSeconds"]===60&&v["work.sweepOnMount"]===true&&Object.keys(s.templates).length===0&&Array.isArray(s.filled)&&s.filled.length===8?"yes":"no")' "$SB/home/.wheelchair-agent/settings.json" 2>/dev/null)" yes
check '(2) the shipped settings file reads back the built-in defaults' \
  "$(WHEELCHAIR_AGENT_HOME="$SB/home/.wheelchair-agent" DSH_SUPERAGENT_STATE_DIR="$SB/dsh/state/superagent" node --input-type=module -e 'import { pathToFileURL } from "node:url"; const { resolveSettings } = await import(pathToFileURL(process.argv[1]).href); const s = resolveSettings(); process.stdout.write(s.fileState === "ok" && s.effective["webui.style"] === "fluid" && s.effective["inbox.intervalSeconds"] === 60 ? "yes" : "no")' "$REPO/src/shared/settings.js" 2>/dev/null)" yes
check '(2) the shipped settings file is mode 0644' \
  "$(stat -c '%a' "$SB/home/.wheelchair-agent/settings.json" 2>/dev/null)" 644
check '(2) an inherited data root was not used' \
  "$([ -e "$INHERITED_ROOT/settings.json" ] && echo yes || echo no)" no
check '(2) an inherited state dir was not used' \
  "$([ -e "$INHERITED_STATE/panel-settings.json" ] && echo yes || echo no)" no
# A hand-edited settings file survives a re-install: the helper opens with `wx` and never rewrites.
printf '{"version":1,"revision":9,"values":{"webui.style":"minimal"},"templates":{}}\n' > "$SB/home/.wheelchair-agent/settings.json"
run_install
check '(2) the second cold install exits 0' "$?" 0
check '(2) the second cold install reports up to date' \
  "$(grep -q 'up to date' "$SB/stdout" && echo yes || echo no)" yes
check '(2) the second cold install replaced nothing' "$(grep -c '^OK: installed' "$SB/stdout")" 0
check '(2) a hand-edited settings file is left alone' \
  "$(grep -c '"webui.style":"minimal"' "$SB/home/.wheelchair-agent/settings.json")" 1
run_install --check
check '(2) --check exits 0 on a cold install' "$?" 0
check '(2) --check says a cold install is allowed' "$(grep -c 'a cold install is allowed' "$SB/stdout")" 1
check '(2) --check reports the data root' "$(grep -c '^OK: data root: ' "$SB/stdout")" 1
check '(2) --check reports the new layout' "$(grep -c '^note: data layout: new' "$SB/stdout")" 1
check '(2) --check reports no pending migration' "$(grep -c '^note: migration: none' "$SB/stdout")" 1

# (3) --check while both holders run: it reports them and mutates nothing.
set_state both
before=$(install_snapshot)
run_install --check
check '(3) --check while in use exits 0' "$?" 0
check '(3) --check reports the service' "$(grep -c 'the superagent service is running (pid 99999999, port 3082)' "$SB/stdout")" 1
check '(3) --check reports the SPV session' "$(grep -c 'a live SPV session holds the preset (pids 99999998 99999997)' "$SB/stdout")" 1
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
check '(5) it names the service' "$(grep -c 'the superagent service (pid 99999999' "$SB/stderr")" 1
check '(5) it does not invent an SPV session' "$(grep -c 'a live SPV session' "$SB/stderr")" 0
# A changed blocker set is a new refusal, so it gets its own id and its own notice. The previous notice
# stays in the outbox: notifications are additive, only retries of the same blockers are deduplicated.
check '(5) a changed blocker set writes a second notice' "$(notice_count)" 2
check '(5) the two notices have different ids' \
  "$(find "$SB/queue/outbox" -maxdepth 1 -name 'install-cold-refusal-*.json' -type f | wc -l | tr -d ' ')" 2

# (6) The SPV detection alone must also refuse: an implementation that only checked the service would
# pass every earlier case.
set_state spv
run_install
check '(6) the SPV-only refusal exits 3' "$?" 3
check '(6) it names the SPV session' "$(grep -c 'a live SPV session (pids 99999998 99999997)' "$SB/stderr")" 1
check '(6) it does not invent a service' "$(grep -c 'the superagent service' "$SB/stderr")" 0
check '(6) it does not print a service stop command' "$(grep -c 'service stop' "$SB/stderr")" 0

# (7) A notification that cannot be written must not change the refusal: still exit 3, still no writes,
# and one note explains the failed notice. Skipped for root, where the permission fence does not apply.
if [ "$(id -u)" -ne 0 ]; then
  chmod 0500 "$SB/queue" "$SB/queue/outbox"
  before=$(install_snapshot)
  run_install
  status=$?
  chmod 0700 "$SB/queue" "$SB/queue/outbox"
  check '(7) an unwritable queue still refuses with 3' "$status" 3
  check '(7) the failed notice is reported in one line' \
    "$(grep -c '^note: could not queue the SPV refusal notice' "$SB/stdout")" 1
  check '(7) the failed notice changed nothing' "$(install_snapshot)" "$before"
fi

# (8) The real probe (no test seam) must not count itself as the service. It is invoked with `--profile`
# on its own command line, so without the self-PID skip a genuinely cold machine looks occupied. The
# unused profile and port make the expected answer empty regardless of what runs on this machine.
real_probe=$(python3 "$REPO/commands/superagent-service.py" probe \
  --profile spv-install-test-no-such-profile --url http://127.0.0.1:0 \
  --preset-patch "$SB/no-such-preset-default.patch.yml" 2>&1)
check '(8) the real probe does not count itself as the service' \
  "$(printf '%s\n' "$real_probe" | sed -n 's/^service_pids=//p')" ''
check '(8) the real probe does not count itself as an SPV session' \
  "$(printf '%s\n' "$real_probe" | sed -n 's/^spv_pids=//p')" ''
check '(8) the real probe reports the port from the URL' \
  "$(printf '%s\n' "$real_probe" | sed -n 's/^service_port=//p')" 0

# (9) --check reports the old layout and a pending migration, and stays read-only.
rm -rf "$SB/home/.wheelchair-agent"
mkdir -p "$SB/dsh/state/superagent/inbox"
printf '{"version":1,"revision":1,"values":{}}\n' > "$SB/dsh/state/superagent/panel-settings.json"
printf '{"id":"old-1","kind":"pr"}\n' > "$SB/dsh/state/superagent/inbox/old-1.json"
set_state
before=$(install_snapshot)
run_install --check
check '(9) --check with an old layout exits 0' "$?" 0
check '(9) --check reports the old layout' "$(grep -c '^note: data layout: old' "$SB/stdout")" 1
check '(9) --check reports the pending migration' "$(grep -c '^note: migration: pending' "$SB/stdout")" 1
check '(9) --check changed nothing' "$(install_snapshot)" "$before"
check '(9) --check did not move the old settings file' \
  "$([ -f "$SB/dsh/state/superagent/panel-settings.json" ] && echo present || echo absent)" present

# (9b) Both layouts at once (an installed older copy kept writing the old path) are reported and untouched.
mkdir -p "$SB/home/.wheelchair-agent"
printf '{"version":1,"revision":2,"values":{}}\n' > "$SB/home/.wheelchair-agent/settings.json"
before=$(install_snapshot)
run_install --check
check '(9b) --check with both layouts exits 0' "$?" 0
check '(9b) --check reports both layouts' "$(grep -c '^note: data layout: both' "$SB/stdout")" 1
check '(9b) --check still reports the pending old inbox' "$(grep -c '^note: migration: pending' "$SB/stdout")" 1
check '(9b) --check changed nothing' "$(install_snapshot)" "$before"

# (10) A relative WHEELCHAIR_AGENT_HOME fails loudly before any install write.
set_state
before=$(install_snapshot)
(
  export HOME="$SB/home" DSH_HOME="$SB/dsh" SPV_BIN_DIR="$SB/local-bin" \
    SPV_QUEUE_DIR="$SB/queue" SPV_INSTALL_PROBE="$SB/tools/fake-probe" \
    FAKE_PROBE_SERVICE="$SERVICE_MARKER" FAKE_PROBE_SPV="$SPV_MARKER" \
    SPV_SERVICE_PORT=3082 WHEELCHAIR_AGENT_HOME=relative/root PATH="$SB/tools:$PATH"
  bash "$INSTALL"
) >"$SB/stdout" 2>"$SB/stderr"
check '(10) a relative data root exits 1' "$?" 1
check '(10) the failure names the absolute-path rule' \
  "$(grep -c 'WHEELCHAIR_AGENT_HOME must be an absolute path' "$SB/stdout")" 1
check '(10) the relative install changed nothing' "$(install_snapshot)" "$before"

# (11) --check compares the installed core binary with the checkout: stale is exit 2, a rerun repairs it.
set_state
run_install
check '(11) the pre-tamper install exits 0' "$?" 0
printf 'stale' >> "$SB/local-bin/wheelchair-agent-core"
run_install --check
check '(11) --check exits 2 on a stale core binary' "$?" 2
check '(11) --check reports the core binary differs' \
  "$(grep -c 'the Rust core binary at .* differs from this checkout' "$SB/stdout")" 1
run_install
check '(11) the repairing cold install exits 0' "$?" 0
run_install --check
check '(11) --check is clean after the repair' "$?" 0

# (12) A fresh install records the stamp; --check and --fingerprint are read-only and the stamp's
# components describe the files that were actually installed.
set_state
rm -rf "$SB/home/.wheelchair-agent"
run_install
check '(12) the fresh install exits 0' "$?" 0
STAMP=$SB/home/.wheelchair-agent/installed.json
PRESET_DIR_TEST=$SB/dsh/.agent-presets/spv
check '(12) the install wrote the stamp' "$([ -f "$STAMP" ] && echo yes || echo no)" yes
check '(12) the stamp is mode 0644' "$(stat -c '%a' "$STAMP" 2>/dev/null)" 644
check '(12) the stamp has version 1, four components and the sandbox preset dir' \
  "$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const names=["preset","webui","bin","core"]; const okc=names.every(n=>s.components[n]&&typeof s.components[n].digest==="string"&&s.components[n].files&&typeof s.components[n].files==="object"); process.stdout.write(s.version===1&&okc&&s.targets&&s.targets.presetDir===process.argv[2]?"yes":"no")' "$STAMP" "$PRESET_DIR_TEST" 2>/dev/null)" yes
before=$(install_snapshot)
run_install --check
check '(12) --check exits 0 after a fresh install' "$?" 0
check '(12) --check reports the stamp matches' \
  "$(grep -c '^OK: install stamp matches the installed files$' "$SB/stdout")" 1
check '(12) --check changed nothing, stamp included' "$(install_snapshot)" "$before"
run_install --fingerprint
check '(12) --fingerprint exits 0' "$?" 0
check '(12) --fingerprint printed parseable JSON' \
  "$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(v.version===1&&v.components&&v.components.preset?"yes":"no")' "$SB/stdout" 2>/dev/null)" yes
check '(12) --fingerprint changed nothing, stamp included' "$(install_snapshot)" "$before"

# (13) Two fingerprint runs are identical, and the shell's fingerprint equals the stamp's components:
# install.sh and the stamp share one implementation.
run_install --fingerprint
cp "$SB/stdout" "$SB/fingerprint-1.json"
run_install --fingerprint
cp "$SB/stdout" "$SB/fingerprint-2.json"
check '(13) two --fingerprint runs print identical JSON' \
  "$(cmp -s "$SB/fingerprint-1.json" "$SB/fingerprint-2.json" && echo same || echo different)" same
check '(13) the fingerprint components equal the stamp components' \
  "$(node -e 'const fs=require("fs"); const {isDeepStrictEqual}=require("node:util"); const fp=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const st=JSON.parse(fs.readFileSync(process.argv[2],"utf8")); process.stdout.write(isDeepStrictEqual(fp.components,st.components)?"yes":"no")' "$SB/fingerprint-1.json" "$STAMP" 2>/dev/null)" yes

# (14) A comment-only edit of the installed YAML is not stale; a real key is. Neither --check run writes.
printf '\n# a comment-only change\n' >> "$PRESET_DIR_TEST/agent.cordis.yml"
before=$(install_snapshot)
run_install --check
check '(14) --check exits 0 on a comment-only preset edit' "$?" 0
check '(14) --check says the preset still matches' \
  "$(grep -c '^OK: preset matches its sources' "$SB/stdout")" 1
check '(14) --check does not call the preset stale' \
  "$(grep -c 'the installed preset at .* differs from this checkout' "$SB/stdout")" 0
check '(14) the comment-only --check changed nothing' "$(install_snapshot)" "$before"
printf 'extra: 1\n' >> "$PRESET_DIR_TEST/agent.cordis.yml"
before=$(install_snapshot)
run_install --check
check '(14) --check exits 2 on a real preset edit' "$?" 2
check '(14) --check reports the preset differs' \
  "$(grep -c 'the installed preset at .* differs from this checkout' "$SB/stdout")" 1
check '(14) the stale --check changed nothing' "$(install_snapshot)" "$before"

# (15) A machine that predates the stamp passes --check with a note; the next install writes one again.
run_install
check '(15) the repairing install exits 0' "$?" 0
rm -f "$STAMP"
before=$(install_snapshot)
run_install --check
check '(15) --check without a stamp exits 0' "$?" 0
check '(15) --check notes that no stamp exists yet' \
  "$(grep -c '^note: no install stamp yet' "$SB/stdout")" 1
check '(15) --check without a stamp changed nothing' "$(install_snapshot)" "$before"
run_install
check '(15) the reinstall exits 0' "$?" 0
check '(15) the reinstall wrote the stamp again' "$([ -f "$STAMP" ] && echo yes || echo no)" yes

# (16) A corrupt stamp is a loud --check failure, not a silent "no stamp".
printf 'garbage\n' > "$STAMP"
run_install --check
check '(16) --check exits 2 on an unreadable stamp' "$?" 2
check '(16) --check says the stamp is unreadable' \
  "$(grep -c "the install stamp at .* is unreadable" "$SB/stdout")" 1
run_install
check '(16) the repairing install exits 0' "$?" 0
run_install --check
check '(16) --check is clean after rewriting the stamp' "$?" 0

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
