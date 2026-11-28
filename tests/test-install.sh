#!/bin/sh
# Exercise install.sh's cold-install gate end to end in a throwaway sandbox.
#
# Offline by construction: HOME, DSH_HOME, SPV_BIN_DIR and SPV_QUEUE_DIR all point inside the sandbox, a
# fake `dsh-tui` satisfies the prerequisite, and a fake probe replaces the /proc scan. The fake probe is
# the seam install.sh documents (`SPV_INSTALL_PROBE`): it prints the same key=value lines as
# `commands/superagent-service.py probe`, so the test states "the service/SPV session is running" as a
# fixture instead of depending on what happens to run on the machine. No real service or dsh is
# touched; case 17 briefly edits the checkout's source preset and restores it (also on INT/TERM);
# case 18 installs with --project, which records a deployment in the sandbox registry; case 19 covers
# the required/inferred --project.
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

SRC_BACKUP=
cleanup() {
  # Case 17 temporarily edits the checkout's source preset; put it back even if the run is interrupted.
  if [ -n "${SRC_BACKUP:-}" ] && [ -f "$SRC_BACKUP" ]; then
    cp "$SRC_BACKUP" "$REPO/preset/agent.cordis.yml" 2>/dev/null || true
  fi
  if [ "$KEEP" = 1 ]; then printf '\nsandbox kept at %s\n' "$SB"; else rm -rf "$SB"; fi
}
trap cleanup EXIT
on_signal() { cleanup; trap - EXIT; exit 130; }
trap on_signal INT TERM

# ---------------------------------------------------------------- fixtures

mkdir -p "$SB/home" "$SB/tools" "$SB/dsh/profiles/superagent"
# The two-profile sync needs the plugin checkout it links into `wca` and, for `wca-spv-tui`, the dsh-tui
# package plus the donor packages it borrows. They are empty markers: install only resolves and links
# paths, it never imports the packages.
mkdir -p "$SB/home/opt/dsh-plugins/dsh-superagent"
printf '{"name":"dsh-superagent","version":"0.0.0-test"}\n' > "$SB/home/opt/dsh-plugins/dsh-superagent/package.json"
mkdir -p "$SB/dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui"
mkdir -p "$SB/dsh/profiles/dsh-tui/node_modules/@mars-sea/dsh-commandcode-provider"
mkdir -p "$SB/dsh/profiles/dsh-tui/node_modules/billion-context"
printf '{"name":"dsh-profile-dsh-tui","private":true,"dependencies":{}}\n' > "$SB/dsh/profiles/dsh-tui/package.json"

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

# A deployment cannot be installed without a project anymore, so every call that does not say otherwise is
# pinned to the machine's own deployment. Cases that exercise the inference / required-project path call
# run_install_raw instead.
run_install_raw() {
  (
    export HOME="$SB/home" DSH_HOME="$SB/dsh" SPV_BIN_DIR="$SB/local-bin" \
      SPV_QUEUE_DIR="$SB/queue" SPV_INSTALL_PROBE="$SB/tools/fake-probe" \
      FAKE_PROBE_SERVICE="$SERVICE_MARKER" FAKE_PROBE_SPV="$SPV_MARKER" \
      SPV_SERVICE_PORT=3082 PATH="$SB/tools:$PATH" SPV_PROJECTS_ROOT="$SB/home/bioagentforge" \
      WHEELCHAIR_AGENT_HOME="$SB/home/.wheelchair-agent" \
      DSH_SUPERAGENT_STATE_DIR="$SB/dsh/state/superagent"
    unset SPV_INBOX_DIR SPV_PREPARE_LOG
    bash "$INSTALL" "$@"
  ) >"$SB/stdout" 2>"$SB/stderr"
}
# Fabricate an artifact and/or stamp without touching this checkout. Both are documented test seams
# (`SPV_INSTALL_CORE_ARTIFACT` / `SPV_INSTALL_CORE_STAMP`), unset in every normal install.
run_install_core() {
  artifact=$1
  stamp=$2
  shift 2
  (
    export SPV_INSTALL_CORE_ARTIFACT="$artifact" SPV_INSTALL_CORE_STAMP="$stamp"
    run_install_raw "$@"
  )
}

run_install() {
  has_project=0
  has_fingerprint=0
  for word in "$@"; do
    [ "$word" = "--project" ] && has_project=1
    case $word in --project=*) has_project=1 ;; --fingerprint) has_fingerprint=1 ;; esac
  done
  if [ "$has_project" -eq 0 ] && [ "$has_fingerprint" -eq 0 ]; then
    run_install_raw --project tools/wheelchair-agent "$@"
  else
    run_install_raw "$@"
  fi
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
  "$([ -f "$SB/dsh/profiles/wca/node_modules/wheelchair-agent-webui/package.json" ] && echo yes || echo no)" yes
check '(2) the data root and its subdirectories were created' \
  "$([ -d "$SB/home/.wheelchair-agent/logs" ] && [ -d "$SB/home/.wheelchair-agent/records" ] && [ -d "$SB/home/.wheelchair-agent/inbox" ] && echo yes || echo no)" yes
check '(2) install created the settings file' \
  "$([ -f "$SB/home/.wheelchair-agent/settings.json" ] && echo yes || echo no)" yes
check '(2) the shipped settings file carries every default' \
  "$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=s.values||{}; process.stdout.write(s.version===1&&s.revision===0&&Object.keys(v).length===13&&v["panel.port"]===3080&&v["panel.profileFrom"]==="superagent"&&v["webui.style"]==="fluid"&&v["merge.autoMerge"]===false&&v["inbox.intervalSeconds"]===60&&v["work.sweepOnMount"]===true&&Object.keys(s.templates).length===0&&Array.isArray(s.filled)&&s.filled.length===13?"yes":"no")' "$SB/home/.wheelchair-agent/settings.json" 2>/dev/null)" yes
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

# (9) --check reports the old layout and a pending migration, and stays read-only. Removing the data
# root also removed the installed panel overlay, so the profile check is red for that one fact: the
# panel cannot start until install writes it again.
rm -rf "$SB/home/.wheelchair-agent"
mkdir -p "$SB/dsh/state/superagent/inbox"
printf '{"version":1,"revision":1,"values":{}}\n' > "$SB/dsh/state/superagent/panel-settings.json"
printf '{"id":"old-1","kind":"pr"}\n' > "$SB/dsh/state/superagent/inbox/old-1.json"
set_state
before=$(install_snapshot)
run_install --check
check '(9) --check with an old layout exits 2 for the missing panel overlay' "$?" 2
check '(9) --check reports the old layout' "$(grep -c '^note: data layout: old' "$SB/stdout")" 1
check '(9) --check reports the pending migration' "$(grep -c '^note: migration: pending' "$SB/stdout")" 1
check '(9) --check names the missing panel overlay' "$(grep -c 'panel overlay is missing at' "$SB/stdout")" 1
check '(9) --check changed nothing' "$(install_snapshot)" "$before"
check '(9) --check did not move the old settings file' \
  "$([ -f "$SB/dsh/state/superagent/panel-settings.json" ] && echo present || echo absent)" present

# (9b) Both layouts at once (an installed older copy kept writing the old path) are reported and untouched.
mkdir -p "$SB/home/.wheelchair-agent"
printf '{"version":1,"revision":2,"values":{}}\n' > "$SB/home/.wheelchair-agent/settings.json"
before=$(install_snapshot)
run_install --check
check '(9b) --check with both layouts exits 2 for the missing panel overlay' "$?" 2
check '(9b) --check reports both layouts' "$(grep -c '^note: data layout: both' "$SB/stdout")" 1
check '(9b) --check still reports the pending old inbox' "$(grep -c '^note: migration: pending' "$SB/stdout")" 1
check '(9b) --check names the missing panel overlay' "$(grep -c 'panel overlay is missing at' "$SB/stdout")" 1
check '(9b) --check changed nothing' "$(install_snapshot)" "$before"

# (10) A relative WHEELCHAIR_AGENT_HOME fails loudly before any install write.
set_state
before=$(install_snapshot)
(
  export HOME="$SB/home" DSH_HOME="$SB/dsh" SPV_BIN_DIR="$SB/local-bin" \
    SPV_QUEUE_DIR="$SB/queue" SPV_INSTALL_PROBE="$SB/tools/fake-probe" \
    FAKE_PROBE_SERVICE="$SERVICE_MARKER" FAKE_PROBE_SPV="$SPV_MARKER" \
    SPV_SERVICE_PORT=3082 WHEELCHAIR_AGENT_HOME=relative/root PATH="$SB/tools:$PATH"
  bash "$INSTALL" --project tools/wheelchair-agent
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

# (17) The headline scenario: a merged PR changes the checkout's *source* preset, not the installed copy.
# A comment-only source change must pass --check; a real value change in the same file must fail it.
SRC_CORDIS=$REPO/preset/agent.cordis.yml
SRC_BACKUP=$SB/source-agent.cordis.yml.bak
cp "$SRC_CORDIS" "$SRC_BACKUP"
printf '\n# a comment-only source change (as in a merged docs PR)\n' >> "$SRC_CORDIS"
before=$(install_snapshot)
run_install --check
check '(17) --check exits 0 on a comment-only source preset change' "$?" 0
check '(17) --check says the source preset matches' \
  "$(grep -c '^OK: preset matches its sources' "$SB/stdout")" 1
check '(17) --check does not call the source preset stale' \
  "$(grep -c 'the installed preset at .* differs from this checkout' "$SB/stdout")" 0
check '(17) the comment-only source --check changed nothing' "$(install_snapshot)" "$before"
printf 'extra: 1\n' >> "$SRC_CORDIS"
run_install --check
check '(17) --check exits 2 on a real source preset change' "$?" 2
check '(17) --check reports the source preset differs' \
  "$(grep -c 'the installed preset at .* differs from this checkout' "$SB/stdout")" 1
cp "$SRC_BACKUP" "$SRC_CORDIS"
rm -f "$SRC_BACKUP"
run_install --check
check '(17) --check is clean again after restoring the source' "$?" 0

# (18) --project records the successful install as that project's deployment, through the installed CLI
# and the real registry writer. A rerun is idempotent, a plain install (no --project) is refused without a
# match, --check stays read-only, and a malformed project is rejected before any work.
DEPLOYMENTS="$SB/home/.wheelchair-agent/deployments.json"
registry_value() {
  node -e 'const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).deployments; const e=d.find(x=>x.project===process.argv[2])||{}; process.stdout.write(String(e[process.argv[3]] ?? ""))' \
    "$DEPLOYMENTS" "$1" "$2" 2>/dev/null
}
registry_top() {
  node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const d=v.deployments; process.stdout.write(String(process.argv[2]==="version" ? v.version : d.length))' \
    "$DEPLOYMENTS" "$1" 2>/dev/null
}
set_state
rm -f "$DEPLOYMENTS"
# `deployment add` records the GitHub repository of the project checkout; make the checkouts (and their
# origins) real so the registry writer infers them exactly as it would on the operator's machine.
mkdir -p "$SB/home/bioagentforge/tools/demo" "$SB/home/bioagentforge/tools/demo2"
git -C "$SB/home/bioagentforge/tools/demo" init -q
git -C "$SB/home/bioagentforge/tools/demo" remote add origin https://github.com/nihaoWX/demo.git
git -C "$SB/home/bioagentforge/tools/demo2" init -q
git -C "$SB/home/bioagentforge/tools/demo2" remote add origin https://github.com/nihaoWX/demo2.git
run_install --project tools/demo
check '(18) the --project install exits 0' "$?" 0
check '(18) the install wrote the deployment registry' "$([ -f "$DEPLOYMENTS" ] && echo yes || echo no)" yes
check '(18) the registry has version 1' "$(registry_top version)" 1
check '(18) the registry holds exactly one deployment' "$(registry_top count)" 1
check '(18) the entry names the project' "$(registry_value tools/demo project)" tools/demo
check '(18) the entry uses the project state directory' "$(registry_value tools/demo stateDir)" "$SB/dsh/state/superagent/demo"
check '(18) the entry queue is <stateDir>/spv' "$(registry_value tools/demo queueDir)" "$SB/dsh/state/superagent/demo/spv"
check '(18) the entry records the checkout repository' "$(registry_value tools/demo repository)" nihaoWX/demo
check '(18) the entry records the first free port' "$(registry_value tools/demo port)" 3082
check '(18) the install rendered the instance overlay' "$([ -f "$SB/home/.wheelchair-agent/deployments/demo.yml" ] && echo yes || echo no)" yes
check '(18) the overlay carries the port and state directory' \
  "$(grep -c 'port: 3082' "$SB/home/.wheelchair-agent/deployments/demo.yml")" 1
check '(18) the overlay names the project state directory' \
  "$(grep -c "^    stateDir: .*$SB/dsh/state/superagent/demo\"" "$SB/home/.wheelchair-agent/deployments/demo.yml")" 1
check '(18) the entry records the profile' "$(registry_value tools/demo profile)" wca
stamp_sha=$(node -e 'const fs=require("fs"); try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).commit ?? "")) } catch {}' "$STAMP" 2>/dev/null)
check '(18) the entry records the commit from installed.json' "$(registry_value tools/demo installedSha)" "$stamp_sha"
check '(18) installed.json really carries the checkout commit' "$stamp_sha" "$(git -C "$REPO" rev-parse HEAD)"
check '(18) the install reports what it registered' \
  "$(grep -c "^OK: deployment registry: tools/demo -> $SB/dsh/state/superagent/demo/spv$" "$SB/stdout")" 1
cp "$DEPLOYMENTS" "$SB/registry-18.json"

run_install --project tools/demo
check '(18) the rerun exits 0' "$?" 0
check '(18) the rerun leaves the registry byte-identical' "$(cmp -s "$DEPLOYMENTS" "$SB/registry-18.json" && echo same || echo different)" same
check '(18) the rerun says the entry is unchanged' \
  "$(grep -c 'already registered with these values; nothing changed' "$SB/stdout")" 1

run_install --project tools/demo2
check '(18) a second project install exits 0' "$?" 0
check '(18) the second project gets its own state directory' "$(registry_value tools/demo2 stateDir)" "$SB/dsh/state/superagent/demo2"
check '(18) the second project gets the next free port' "$(registry_value tools/demo2 port)" 3083
check '(18) the second project renders its own instance' "$([ -f "$SB/home/.wheelchair-agent/deployments/demo2.yml" ] && echo yes || echo no)" yes
check '(18) the second project records the same commit' "$(registry_value tools/demo2 installedSha)" "$stamp_sha"
cp "$DEPLOYMENTS" "$SB/registry-18.json"

run_install_raw
check '(18) a plain install without --project is refused now' "$?" 2
check '(18) the refusal explains migration and the project flag' "$(grep -c 'FAIL: install.sh needs --project' "$SB/stderr")" 1
check '(18) a refused plain install leaves the registry byte-identical' "$(cmp -s "$DEPLOYMENTS" "$SB/registry-18.json" && echo same || echo different)" same

run_install --check --project tools/beta
check '(18) --check --project exits 0' "$?" 0
check '(18) --check --project writes nothing' "$(cmp -s "$DEPLOYMENTS" "$SB/registry-18.json" && echo same || echo different)" same
check '(18) --check --project says it is read-only' \
  "$(grep -c '^note: --check is read-only: the deployment entry and instance overlay for tools/beta are written by a real install, nothing was written now$' "$SB/stdout")" 1
check '(18) --check did not register the project' "$(registry_value tools/beta project)" ''

run_install --project notaproject
check '(18) a malformed project is a usage error' "$?" 2
check '(18) the usage error names the expected shape' \
  "$(grep -c '^FAIL: --project must be "tools/<name>" or "research/<name>", got notaproject$' "$SB/stderr")" 1
check '(18) the rejected install left the registry byte-identical' \
  "$(cmp -s "$DEPLOYMENTS" "$SB/registry-18.json" && echo same || echo different)" same
run_install --project tools/
check '(18) an empty project name is a usage error' "$?" 2
check '(18) the empty-name error changed the registry' \
  "$(cmp -s "$DEPLOYMENTS" "$SB/registry-18.json" && echo same || echo different)" same

# (19) --project is required: without it install.sh may only infer a unique registered deployment from this
# checkout's repository/path. Zero or several matches stop with the registry listed; a unique match proceeds
# and --check stays read-only either way.
set_state
rm -rf "$SB/home/bioagentforge"
rm -f "$DEPLOYMENTS"
mkdir -p "$SB/home/bioagentforge/tools/wheelchair-agent" "$SB/home/bioagentforge/tools/other"
for repo in wheelchair-agent other; do
  git -C "$SB/home/bioagentforge/tools/$repo" init -q
  git -C "$SB/home/bioagentforge/tools/$repo" remote add origin "$(git -C "$REPO" config --get remote.origin.url)"
done
run_install --project tools/wheelchair-agent
check '(19) the wheelchair-agent deployment installs' "$?" 0
inferred_registry=$(sha256sum "$DEPLOYMENTS" | cut -d' ' -f1)

run_install_raw --check
check '(19) --check infers the unique deployment' "$?" 0
check '(19) the inferred project is reported' "$(grep -c '^note: inferred deployment: tools/wheelchair-agent' "$SB/stdout")" 1
check '(19) inferred --check did not touch the registry' "$(sha256sum "$DEPLOYMENTS" | cut -d' ' -f1)" "$inferred_registry"

run_install --project tools/other
check '(19) a second project installs' "$?" 0
run_install_raw --check
check '(19) an ambiguous checkout is refused' "$?" 2
check '(19) the ambiguity names both projects' "$(grep -c 'matches more than one registered deployment: tools/other, tools/wheelchair-agent' "$SB/stderr")" 1

before_none=$(sha256sum "$DEPLOYMENTS" | cut -d' ' -f1)
rm -rf "$SB/home/bioagentforge/tools/wheelchair-agent" "$SB/home/bioagentforge/tools/other"
run_install_raw --check
check '(19) a checkout matching no deployment is refused' "$?" 2
check '(19) the zero-match error says so' "$(grep -c 'does not match a registered deployment' "$SB/stderr")" 1
check '(19) the zero-match error lists the registry' "$(grep -c 'registered deployments: tools/other, tools/wheelchair-agent' "$SB/stderr")" 1
check '(19) the refused inference left the registry alone' "$(sha256sum "$DEPLOYMENTS" | cut -d' ' -f1)" "$before_none"
rm -rf "$SB/home/bioagentforge"

# ---- case 20: a stale core artifact is not silently "consistent"
FAKE_CORE=$SB/fake-core
cp "$REPO/build/artifacts/wheelchair-agent-core-linux-x64" "$FAKE_CORE"
chmod 0755 "$FAKE_CORE"
FAKE_STAMP=$SB/fake-core-stamp.json
cat > "$FAKE_STAMP" <<'JSON'
{"version":1,"commit":"deadbeef","builtAt":"2000-01-01T00:00:00.000Z","sources":"sha256:0000000000000000000000000000000000000000000000000000000000000000","cargo":"cargo 0.0.0","artifact":{"file":"fake-core","sha256":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}}
JSON
before_stale=$(install_snapshot)
run_install_core "$FAKE_CORE" "$FAKE_STAMP" --check --project tools/wheelchair-agent
check '(20) --check fails for a stale core artifact' "$?" 2
check '(20) stale --check names the build command' "$(grep -c 'predates the current Rust sources; run "bash build/build-core.sh"' "$SB/stdout")" 1
check '(20) stale --check wrote nothing' "$(install_snapshot)" "$before_stale"

run_install_core "$FAKE_CORE" "$FAKE_STAMP" --project tools/wheelchair-agent
check '(20) a real install refuses a stale core artifact' "$?" 1
check '(20) stale install says it refused' "$(grep -c 'refusing to install it' "$SB/stdout")" 1
check '(20) stale install wrote nothing' "$(install_snapshot)" "$before_stale"

run_install_core "$FAKE_CORE" "$FAKE_STAMP" --fingerprint
check '(20) --fingerprint stays successful while stale' "$?" 0
check '(20) --fingerprint wrote nothing' "$(install_snapshot)" "$before_stale"

# A pre-stamp checkout has no core-stamp.json: an artifact older than the Rust sources must still fail.
OLD_CORE=$SB/old-core
cp "$REPO/build/artifacts/wheelchair-agent-core-linux-x64" "$OLD_CORE"
chmod 0755 "$OLD_CORE"
touch -t 200001010000 "$OLD_CORE"
run_install_core "$OLD_CORE" "$SB/no-such-stamp.json" --check --project tools/wheelchair-agent
check '(20) --check falls back to mtime without a stamp' "$?" 2
check '(20) mtime fallback is named' "$(grep -c 'mtime fallback' "$SB/stdout")" 1
check '(20) mtime fallback still names the build command' "$(grep -c 'build/build-core.sh' "$SB/stdout")" 3

# The fresh artifact this checkout built must pass, if the build wrote a stamp.
if [ -f "$REPO/build/artifacts/core-stamp.json" ]; then
  run_install_raw --check --project tools/wheelchair-agent
  check '(20) a freshly built artifact passes --check' "$?" 0
  check '(20) fresh --check reports source agreement' "$(grep -c 'core artifact was built from these Rust sources' "$SB/stdout")" 1
fi

run_install_core "$FAKE_CORE" "$FAKE_STAMP" --project tools/wheelchair-agent --allow-stale-core
check '(20) --allow-stale-core installs anyway' "$?" 0
check '(20) the escape hatch warns' "$(grep -c 'WARNING: installing a stale Rust core artifact' "$SB/stderr")" 1

# ---- case 21: an older panel host holding panel.port is reported, never killed
# The pre-#58 panel was a plain `cli.js panel --foreground` host. A cold install reuses panel.port and
# replaces webui/lib/client.js underneath it, so the browser gets the new bundle from the old page shell.
# Both `--check` and a real install name the holder and the exact commands (the install must not signal it),
# and detection reads /proc and settings only. The process table is a sandbox (WHEELCHAIR_PROC_ROOT) and the
# listener is injected (SPV_INSTALL_PANEL_HOLDER), so nothing real is inspected or signalled.
FAKE_PROC=$SB/install-proc
LEGACY_PID=4910
rm -rf "$FAKE_PROC"
mkdir -p "$FAKE_PROC/$LEGACY_PID"
printf 'node\0%s/cli.js\0panel\0--foreground\0--port\03080\0' "$SB/local-bin" > "$FAKE_PROC/$LEGACY_PID/cmdline"
export WHEELCHAIR_PROC_ROOT="$FAKE_PROC"
export SPV_INSTALL_PANEL_HOLDER="$LEGACY_PID"

# Case 20 left a fabricated stale core installed; a real install restores the checkout's artifact and is
# also the "after install" path that must report the older host.
run_install_raw --project tools/wheelchair-agent
check '(21) the install succeeds with the older panel host running' "$?" 0
check '(21) the install reports the older panel host' "$(grep -c 'note: port 3080 is held by pid 4910, an older panel host' "$SB/stdout")" 1
check '(21) the install does not fail over the panel' "$(grep -c '^FAIL:' "$SB/stdout")" 0

before_panel=$(install_snapshot)
run_install_raw --check --project tools/wheelchair-agent
check '(21) --check succeeds while reporting the older panel host' "$?" 0
check '(21) --check names the port and pid' "$(grep -c 'note: port 3080 is held by pid 4910, an older panel host' "$SB/stdout")" 1
check '(21) --check gives the replacement commands' "$(grep -c 'then "wheelchair-agent panel start --detach"' "$SB/stdout")" 1
check '(21) reporting the older host wrote nothing' "$(install_snapshot)" "$before_panel"

# A current panel instance (shared wca profile + the installed overlay) is what the install itself
# starts: no note for it, and the overlay path keeps it out of the old shape.
printf 'node\0/usr/bin/dsh\0--profile\0wca\0--patch\0%s/deployments/panel.yml\0--no-open\0' "$SB/home/.wheelchair-agent" > "$FAKE_PROC/$LEGACY_PID/cmdline"
run_install_raw --check --project tools/wheelchair-agent
check '(21) a current panel instance passes --check' "$?" 0
check '(21) a current panel instance needs no note' "$(grep -c 'an older panel host' "$SB/stdout")" 0

# The intermediate panel profile (`wheelchair-agent` + the preset overlay) predates the shared wca
# profile. It still owes the port, so it is reported exactly like the pre-#58 host.
printf 'node\0/usr/bin/dsh\0--profile\0wheelchair-agent\0--patch\0%s/.agent-presets/spv/panel.patch.yml\0--no-open\0' "$SB/dsh" > "$FAKE_PROC/$LEGACY_PID/cmdline"
run_install_raw --check --project tools/wheelchair-agent
check '(21) the intermediate panel profile is reported as older' "$(grep -c 'note: port 3080 is held by pid 4910, an older panel host' "$SB/stdout")" 1
unset WHEELCHAIR_PROC_ROOT SPV_INSTALL_PANEL_HOLDER

# ---- case 22: the single-deployment profile moved from "superagent" to "wca" whole; --check never
# migrates, install does it once. The old name must not silently pass --check, a real install renames the
# directory (so node_modules links and the webui package follow), and a directory already at the new name
# wins while the old one is only reported: deleting it is the operator's call.
mv "$SB/dsh/profiles/wca" "$SB/dsh/profiles/superagent"
before_migrate=$(install_snapshot)
run_install_raw --check --project tools/wheelchair-agent
check '(22) --check does not pass with only the old superagent profile' "$?" 2
check '(22) --check names the old profile in the copy-paste fix' "$(grep -c 'the old "superagent" profile is still installed' "$SB/stdout")" 1
check '(22) --check says to run install.sh to move it' "$(grep -c 'fix: run "bash install.sh" from the wheelchair-agent checkout' "$SB/stdout")" 1
check '(22) --check wrote nothing' "$(install_snapshot)" "$before_migrate"

run_install_raw --project tools/wheelchair-agent
check '(22) the install migrates the old profile' "$?" 0
check '(22) the install reports the whole-directory move' "$(grep -c 'migrated: superagent -> wca' "$SB/stdout")" 1
check '(22) the new profile exists' "$([ -d "$SB/dsh/profiles/wca" ] && echo yes)" yes
check '(22) the old profile is gone' "$([ ! -e "$SB/dsh/profiles/superagent" ] && echo yes)" yes
check '(22) the moved profile keeps the webui package' "$([ -f "$SB/dsh/profiles/wca/node_modules/wheelchair-agent-webui/package.json" ] && echo yes)" yes
check '(22) the moved profile records its links' "$([ -f "$SB/dsh/profiles/wca/profile-links.json" ] && echo yes)" yes

mkdir -p "$SB/dsh/profiles/superagent"
printf 'stale\n' > "$SB/dsh/profiles/superagent/keep-me"
run_install_raw --project tools/wheelchair-agent
check '(22) both names: the install still succeeds' "$?" 0
check '(22) both names: the note names the leftover directory' "$(grep -c 'profiles/superagent still exists; the deployments now use "wca"' "$SB/stdout")" 1
check '(22) both names: the old directory is not deleted' "$(cat "$SB/dsh/profiles/superagent/keep-me" 2>/dev/null)" 'stale'
rm -rf "$SB/dsh/profiles/superagent"

# ---- case 23: the browser-shaped SPV host is opt-in through spv.surface. --check in that shape asks for
# the wca-spv-web profile and the deployments/spv.yml overlay; the install renders both, then --check is
# clean again. The terminal profile must survive the switch untouched.
before_web=$(install_snapshot)
( export WHEELCHAIR_AGENT_SPV_SURFACE=web; run_install_raw --check --project tools/wheelchair-agent )
check '(23) web-shaped --check fails while wca-spv-web is missing' "$?" 2
check '(23) it names the missing browser profile' "$(grep -c 'profile "wca-spv-web" is missing' "$SB/stdout")" 1
check '(23) it says how to render it' "$(grep -q 'wheelchair-agent profiles sync' "$SB/stdout" && echo yes)" yes
check '(23) web-shaped --check wrote nothing' "$(install_snapshot)" "$before_web"

( export WHEELCHAIR_AGENT_SPV_SURFACE=web; run_install_raw --project tools/wheelchair-agent )
check '(23) the install renders the browser SPV profile' "$?" 0
check '(23) wca-spv-web exists' "$([ -d "$SB/dsh/profiles/wca-spv-web" ] && echo yes)" yes
check '(23) the SPV browser overlay exists' "$([ -f "$SB/home/.wheelchair-agent/deployments/spv.yml" ] && echo yes)" yes
check '(23) the terminal profile survives the switch' "$([ -d "$SB/dsh/profiles/wca-spv-tui" ] && echo yes)" yes
( export WHEELCHAIR_AGENT_SPV_SURFACE=web; run_install_raw --check --project tools/wheelchair-agent )
check '(23) web-shaped --check passes after the install' "$?" 0
check '(23) it reports the three profiles' "$(grep -c 'the wca, wca-spv-tui and wca-spv-web profiles' "$SB/stdout")" 1

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
