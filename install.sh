#!/usr/bin/env bash
# Install the SPV preset, the `wheelchair-agent` CLI and its compatibility commands for the current user.
#
# Cold installs only. This script refuses to write while anything that loads the installed files is
# running: the superagent service (it mounts the webui package) and a live SPV session (it loads the
# preset's spv_* tools in-process). A half-applied install that still reports "up to date" is worse than a
# refusal: on 2026-11-15 a run while the service was up left a stale cli.js without `inbox` while saying
# "up to date".
#
# Before any write, the pre-flight asks commands/superagent-service.py for two runtime facts: the service
# PIDs (listening socket plus a /proc scan for `--profile superagent`) and the SPV-session PIDs (a
# /proc/*/cmdline scan for `--patch <preset>/preset-default.patch.yml`). It recognises a session started by
# the installed launcher, or by dsh/dsh-tui with that exact patch. It does not recognise a session that
# picked the preset at runtime with `/preset` after starting without `--patch`, or one using a different
# DSH_HOME. A false negative only lets an unsafe install through; refusing on a guess would block a safe
# cold install.
#
# Residual window: this is a pre-flight, not a lock. A service or SPV session started between the probe
# and the atomic moves is not detected, because the launchers do not take an install-time lock; the next
# run re-checks. The gate still precedes every write, so a holder that is already up is never half-applied.
#
# On a refusal it exits 3 (distinct from 1 install failure and 2 check failure), prints what is in use and
# the exact stop/install/start commands, writes no file under any install target, and queues exactly one
# `notice` for the SPV session through src/shared/queue.js. If the queue does not exist (the service has
# never run), it skips the notice, says so in one line, and keeps exit 3.
#
# --check is read-only and always allowed, even while everything is running. It reports the in-use holders
# as notes, plus the data root, which layout is on disk (new / old / both) and whether a first-run
# migration is pending; it exits 2 only when the installed files differ from this checkout.
#
# Exit status:
#   0  installed, or --check found everything as expected
#   1  install failed (missing prerequisite, probe failure or a copy failed)
#   2  --check found problems, or the arguments were invalid
#   3  refused: something is using the install targets (cold installs only)
#
# Installs (this project is not an agent tool, so there is no SKILL.md to copy):
#   1. the dsh agent preset  -> $DSH_HOME/.agent-presets/spv/
#      (the preset ymls, the SPV-side JS, cli.js, prepare.sh, commands/ and agentsmd-examples/)
#   2. the webui package     -> $DSH_HOME/profiles/superagent/node_modules/wheelchair-agent-webui/
#      (an independent dsh web client plugin whose inbox core is copied in, so a preset replacement
#       by another worktree cannot break it; its loader row is appended to the profile patch)
#   3. the CLI               -> ~/.local/bin/wheelchair-agent   (the one entry point)
#   4. compatibility names   -> ~/.local/bin/{spv,superagent-service,jobctl}
#      (thin wrappers: `exec wheelchair-agent <subcommand> "$@"`)
#   5. the data root          -> $WHEELCHAIR_AGENT_HOME, else ~/.wheelchair-agent
#      (settings.json, inbox/, records/, logs/; created empty and never deleted. The superagent
#       state directory still owns the spv/ queue and work/ root: that is the interface, not our data.)
#
# Design rules (references/tool-install.md):
#   - nothing is hard-coded to one machine: paths derive from $HOME and this script's own directory;
#   - a missing prerequisite is a loud FAIL with the command that obtains it, never a silent workaround;
#   - copies, never symlinks; a whitelist, never the whole tree;
#   - atomic replacement through a staging directory, and idempotent (same content => "OK: up to date");
#   - --check is read-only, reports item by item, and exits 2 with a "fix:" line when anything is off.
#
# Usage: bash install.sh [--check]
#        bash install.sh --help
set -uo pipefail

SELF_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PRESET_ID=spv
DSH_HOME_DIR=${DSH_HOME:-$HOME/.dsh}
PRESET_ROOT=$DSH_HOME_DIR/.agent-presets
PRESET_DIR=$PRESET_ROOT/$PRESET_ID
BIN_DIR=${SPV_BIN_DIR:-$HOME/.local/bin}
CLI=$BIN_DIR/wheelchair-agent
LAUNCHER=$BIN_DIR/spv
SERVICE=$BIN_DIR/superagent-service
JOBCTL=$BIN_DIR/jobctl
TARGET_PLUGIN_URL="file://$PRESET_DIR/src/spv/tools.js"
TARGET_CRON_URL="file://$PRESET_DIR/src/spv/cron-plugin.js"
TARGET_RESTART_URL="file://$PRESET_DIR/src/spv/restart-command.js"
PROFILE_ID=${DSH_SUPERAGENT_PROFILE:-superagent}
PROFILE_DIR=$DSH_HOME_DIR/profiles/$PROFILE_ID
WEBUI_TARGET=$PROFILE_DIR/node_modules/wheelchair-agent-webui
SERVICE_PROFILE=$PROFILE_ID
SERVICE_PORT=${SPV_SERVICE_PORT:-3082}
SERVICE_URL=${DSH_SUPERAGENT_URL:-http://127.0.0.1:$SERVICE_PORT}
DATA_ROOT=${WHEELCHAIR_AGENT_HOME:-$HOME/.wheelchair-agent}
LEGACY_STATE_DIR=${DSH_SUPERAGENT_STATE_DIR:-$DSH_HOME_DIR/state/superagent}

CHECK=0
for arg in "$@"; do
  case $arg in
    --check) CHECK=1 ;;
    -h|--help)
      printf 'usage: bash install.sh [--check]\n'
      printf '  --check   read-only self-check; exit 2 when anything is not installed as expected\n'
      printf 'exit 0 installed or checks pass; 1 install failed; 2 check failed or bad argument;\n'
      printf '     3 refused because the install targets are in use (cold installs only)\n'
      exit 0 ;;
    *)
      printf 'FAIL: unknown argument %s\n' "$arg" >&2
      printf 'fix: run "bash install.sh" with no arguments, or "bash install.sh --check"\n' >&2
      exit 2 ;;
  esac
done

PROBLEMS=0
ok()   { printf 'OK: %s\n' "$1"; }
note() { printf 'note: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; PROBLEMS=$((PROBLEMS + 1)); }
fix()  { printf 'fix: %s\n' "$1"; }

# -------------------------------------------------------------- in-use probe

# The runtime holders found by the pre-flight; each is a space-separated PID list, empty when none.
SERVICE_PIDS=''
SPV_PIDS=''

# Run the runtime probe: leave SERVICE_PIDS and SPV_PIDS set, both empty when nothing holds the targets.
#
# The probe is commands/superagent-service.py, deliberately not a second copy of its process hunt: that
# file already finds the service through the listening socket and /proc (because `ps` names the Node thread
# `MainThread` here), and its `probe` action also scans /proc for a live SPV session's `--patch` argument.
#
# SPV_INSTALL_PROBE is a test seam: tests/test-install.sh points it at a fake probe so both the refused and
# the cold path can be driven without real processes. Normal operation never sets it; when unset, the real
# python probe runs against the real /proc.
probe_in_use() {
  local out probe_cmd
  SERVICE_PIDS=''
  SPV_PIDS=''
  if [ -n "${SPV_INSTALL_PROBE:-}" ]; then
    if ! out=$("$SPV_INSTALL_PROBE" 2>&1); then
      fail "the in-use probe $SPV_INSTALL_PROBE failed"
      fix 'fix or unset SPV_INSTALL_PROBE, then rerun this script'
      return 1
    fi
  else
    # The profile and URL default to the same env vars the service manager honours, so a relocated
    # service is found through the socket and the /proc scan rather than a hardcoded 3082/superagent.
    probe_cmd=(python3 "$SELF_DIR/commands/superagent-service.py" probe
      --profile "$SERVICE_PROFILE" --url "$SERVICE_URL"
      --preset-patch "$PRESET_DIR/preset-default.patch.yml")
    if ! out=$("${probe_cmd[@]}" 2>&1); then
      fail 'the in-use pre-flight failed (commands/superagent-service.py probe)'
      fix "run: python3 $SELF_DIR/commands/superagent-service.py probe --profile $SERVICE_PROFILE --url $SERVICE_URL --preset-patch $PRESET_DIR/preset-default.patch.yml"
      return 1
    fi
  fi
  case $out in
    *service_pids=*spv_pids=*) ;;
    *)
      fail 'the in-use pre-flight did not print both service_pids and spv_pids, so the targets cannot be proven free'
      fix "run: python3 $SELF_DIR/commands/superagent-service.py probe --profile $SERVICE_PROFILE --url $SERVICE_URL --preset-patch $PRESET_DIR/preset-default.patch.yml"
      return 1 ;;
  esac
  SERVICE_PIDS=$(printf '%s\n' "$out" | sed -n 's/^service_pids=//p' | head -1)
  SPV_PIDS=$(printf '%s\n' "$out" | sed -n 's/^spv_pids=//p' | head -1)
  # The probe resolves the port from --url; keep the human-readable port in step with it.
  probe_port=$(printf '%s\n' "$out" | sed -n 's/^service_port=//p' | head -1)
  if [ -n "$probe_port" ]; then
    SERVICE_PORT=$probe_port
  fi
  return 0
}

# ---------------------------------------------------------------- prerequisites

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail 'node is not on PATH'
    fix 'install Node.js 22 or newer (https://nodejs.org/en/download), then rerun this script'
    return 1
  fi
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  if [ -z "${major}" ] || [ "${major}" -lt 22 ]; then
    fail "node $(node --version 2>/dev/null) is too old; this preset needs 22 or newer"
    fix 'install Node.js 22 or newer (https://nodejs.org/en/download), then rerun this script'
    return 1
  fi
  ok "node $(node --version)"
}

require_dsh_tui() {
  if ! command -v dsh-tui >/dev/null 2>&1; then
    fail 'dsh-tui is not on PATH, so the launcher would have nothing to start'
    fix 'install it with "npm install -g @deepseek-harness-tui/dsh-tui" and make sure npm'"'"'s global bin directory is on PATH'
    return 1
  fi
  ok "dsh-tui at $(command -v dsh-tui)"
}

# The service manager and the pre-flight are Python; a machine without python3 cannot run either.
# A test seam replaces the pre-flight, so it does not need python3.
require_python3() {
  if [ -n "${SPV_INSTALL_PROBE:-}" ]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    fail 'python3 is not on PATH, so the cold-install pre-flight cannot run'
    fix 'install Python 3 (https://www.python.org/downloads), then rerun this script'
    return 1
  fi
  ok "python3 $(python3 --version 2>&1 | sed 's/^Python //')"
}

# ------------------------------------------------------------------- rendering

# Render the preset into $1.
#
# The preset directory is the installed SPV-side package: the rendered ymls, the SPV-side JS
# (src/spv/, src/shared/), cli.js, prepare.sh, commands/ and agentsmd-examples/. The superagent-side
# JS (src/superagent/) is deliberately absent: that profile loads it through its own node_modules link
# and it never enters the preset directory (ARCHITECTURE/layout.md).
#
# prepare.sh and the two AGENTS.md templates are installed here because the panel's prepare command runs
# from a user-level path, not from this development tree (docs/delivery-target.md, constraint 6).
render_into() {
  local dest=$1 file
  if ! mkdir -p "$dest/src/shared" "$dest/src/spv" "$dest/commands" "$dest/agentsmd-examples"; then
    fail "cannot create the staging directories under $dest"
    fix 'check that the temporary directory is writable, then rerun this script'
    return 1
  fi
  if ! node "$SELF_DIR/build/render-preset.mjs" "$SELF_DIR/preset" "$TARGET_PLUGIN_URL" "$TARGET_CRON_URL" "$dest" "$TARGET_RESTART_URL" >/dev/null; then
    fail 'could not render the preset (build/render-preset.mjs failed)'
    fix "run: node $SELF_DIR/build/render-preset.mjs $SELF_DIR/preset $TARGET_PLUGIN_URL $TARGET_CRON_URL <dir> $TARGET_RESTART_URL"
    return 1
  fi
  # Every copy reports its own failure: a missing source file must not leave a half-installed preset that
  # the panel's prepare command then cannot run.
  if ! cp "$SELF_DIR/bin/wheelchair-agent.mjs" "$dest/cli.js"; then
    fail 'cannot copy bin/wheelchair-agent.mjs to cli.js'
    fix "check that $SELF_DIR/bin/wheelchair-agent.mjs exists and is readable, then rerun this script"
    return 1
  fi
  for file in shared/home.js shared/hook-events.js shared/hooks.js shared/queue.js shared/schema.js shared/settings.js shared/work.js spv/check.js spv/cron-plugin.js spv/cron.js spv/dispatch.js spv/health.js spv/hook.js spv/inbox.js spv/injector.js spv/outbox.js spv/paths.js spv/restart-command.js spv/restart-ux.js spv/restart.js spv/session.js spv/tools.js; do
    if ! cp "$SELF_DIR/src/$file" "$dest/src/$file"; then
      fail "cannot copy src/$file from this checkout"
      fix "check that $SELF_DIR/src/$file exists and is readable, then rerun this script"
      return 1
    fi
  done
  for file in jobctl.py superagent-service.py; do
    if ! cp "$SELF_DIR/commands/$file" "$dest/commands/$file"; then
      fail "cannot copy commands/$file from this checkout"
      fix "check that $SELF_DIR/commands/$file exists and is readable, then rerun this script"
      return 1
    fi
    chmod 0755 "$dest/commands/$file" || { fail "cannot make $dest/commands/$file executable"; return 1; }
  done
  if ! cp "$SELF_DIR/commands/prepare.sh" "$dest/prepare.sh"; then
    fail 'cannot copy commands/prepare.sh from this checkout'
    fix "check that $SELF_DIR/commands/prepare.sh exists and is readable, then rerun this script"
    return 1
  fi
  chmod 0755 "$dest/prepare.sh" || { fail "cannot make $dest/prepare.sh executable"; return 1; }
  for file in proj-dev-agentsmd.md research-task-agentsmd.md; do
    if ! cp "$SELF_DIR/docs/agentsmd-examples/$file" "$dest/agentsmd-examples/$file"; then
      fail "cannot copy docs/agentsmd-examples/$file from this checkout"
      fix "check that $SELF_DIR/docs/agentsmd-examples/$file exists and is readable, then rerun this script"
      return 1
    fi
  done
  if ! render_launcher "$dest/spv-launcher.sh"; then
    fail 'cannot render preset/spv-launcher.sh'
    fix "check that $SELF_DIR/preset/spv-launcher.sh exists and is readable, then rerun this script"
    return 1
  fi
  return 0
}

# Render the SPV launcher into $1 with the preset directory substituted for @SPV_HOME@.
render_launcher() {
  local dest=$1
  sed "s|@SPV_HOME@|$PRESET_DIR|g" "$SELF_DIR/preset/spv-launcher.sh" > "$dest" || return 1
  chmod 0755 "$dest"
}

# Render the CLI shell into $1: the preset directory is baked in, so the shell needs no lookup of its own.
render_cli() {
  local dest=$1
  sed "s|@SPV_HOME@|$PRESET_DIR|g" "$SELF_DIR/preset/wheelchair-agent.sh" > "$dest" || return 1
  chmod 0755 "$dest"
}

# Render one compatibility wrapper into $1: `exec wheelchair-agent <subcommand> "$@"`.
#
# The names stay because worker prompts, AGENTS.md and docs/ refer to them; the CLI subcommand is the
# canonical form and these are the compatibility layer (ARCHITECTURE/cli.md).
render_wrapper() {
  local dest=$1 sub=$2
  {
    printf '#!/bin/sh\n'
    printf '# Installed by wheelchair-agent/install.sh: a compatibility name for `wheelchair-agent %s`.\n' "$sub"
    printf '# The CLI subcommand is the canonical form; this file exists because prompts and docs use the name.\n'
    printf 'exec wheelchair-agent %s "$@"\n' "$sub"
  } > "$dest" || return 1
  chmod 0755 "$dest"
}

# Render the webui package into $1: the package's own files plus the core modules it imports.
#
# The installed package must be self-contained: another worktree running its own install.sh can
# replace the shared preset at any time, and a panel that imported the preset's inbox core would
# then fail to load on the next service restart. The copies below are generated here from this
# checkout and are never edited by hand, so there is still one implementation (webui/README.md).
render_webui_into() {
  local dest=$1 file src target pair
  if ! mkdir -p "$dest/lib/core" "$dest/lib/shared"; then
    fail "cannot create the staging directories under $dest"
    fix 'check that the staging directory is writable, then rerun this script'
    return 1
  fi
  if ! cp "$SELF_DIR/webui/package.json" "$dest/package.json"; then
    fail 'cannot copy webui/package.json from this checkout'
    fix "check that $SELF_DIR/webui/package.json exists and is readable, then rerun this script"
    return 1
  fi
  for file in index.js client.js; do
    if ! cp "$SELF_DIR/webui/lib/$file" "$dest/lib/$file"; then
      fail "cannot copy webui/lib/$file from this checkout"
      fix "check that $SELF_DIR/webui/lib/$file exists and is readable, then rerun this script"
      return 1
    fi
  done
  # `settings.js` lives in `lib/shared/` (not `lib/core/`) for the same reason `queue.js` does: the copied
  # `lib/core/inbox.js` imports `../shared/settings.js`, and `lib/core/` is for the src/spv files.
  for pair in "spv/inbox.js:lib/core/inbox.js" "spv/dispatch.js:lib/core/dispatch.js" "spv/paths.js:lib/core/paths.js" "shared/home.js:lib/shared/home.js" "shared/hook-events.js:lib/shared/hook-events.js" "shared/hooks.js:lib/shared/hooks.js" "shared/queue.js:lib/shared/queue.js" "shared/settings.js:lib/shared/settings.js"; do
    src=${pair%%:*}
    target=${pair##*:}
    if ! cp "$SELF_DIR/src/$src" "$dest/$target"; then
      fail "cannot copy src/$src into the webui package"
      fix "check that $SELF_DIR/src/$src exists and is readable, then rerun this script"
      return 1
    fi
  done
  return 0
}

# ----------------------------------------------------------------- - check mode

check_preset() {
  local staged actual
  staged=$(mktemp -d) || { fail 'could not create a temporary directory'; return; }
  if ! render_into "$staged" >/dev/null 2>&1; then
    fail 'the preset sources cannot be rendered'
    fix "run: node $SELF_DIR/build/render-preset.mjs $SELF_DIR/preset $TARGET_PLUGIN_URL $TARGET_CRON_URL $PRESET_DIR $TARGET_RESTART_URL"
    rm -rf "$staged"
    return
  fi
  if [ ! -d "$PRESET_DIR" ]; then
    fail "the preset is not installed at $PRESET_DIR"
    fix 'run: bash tools/wheelchair-agent/install.sh'
    rm -rf "$staged"
    return
  fi
  if diff -r "$staged" "$PRESET_DIR" >/dev/null 2>&1; then
    ok "preset matches its sources ($PRESET_DIR)"
  else
    fail "the installed preset at $PRESET_DIR differs from this checkout"
    diff -r "$staged" "$PRESET_DIR" 2>&1 | sed -n '1,8p' | sed 's/^/     /'
    fix 'run: bash tools/wheelchair-agent/install.sh'
  fi
  actual=$(find "$PRESET_DIR" -type f | sed "s|^$PRESET_DIR/||" | sort | tr '\n' ' ')
  local expected="agent.cordis.yml agentsmd-examples/proj-dev-agentsmd.md agentsmd-examples/research-task-agentsmd.md cli.js commands/jobctl.py commands/superagent-service.py package.json prepare.sh preset-default.patch.yml preset.yml spv-launcher.sh src/shared/home.js src/shared/hook-events.js src/shared/hooks.js src/shared/queue.js src/shared/schema.js src/shared/settings.js src/shared/work.js src/spv/check.js src/spv/cron-plugin.js src/spv/cron.js src/spv/dispatch.js src/spv/health.js src/spv/hook.js src/spv/inbox.js src/spv/injector.js src/spv/outbox.js src/spv/paths.js src/spv/restart-command.js src/spv/restart-ux.js src/spv/restart.js src/spv/session.js src/spv/tools.js "
  local missing extras
  missing=$(comm -23 <(printf '%s' "$expected" | tr ' ' '\n' | sort) <(printf '%s' "$actual" | tr ' ' '\n' | sort) | tr '\n' ' ')
  extras=$(comm -13 <(printf '%s' "$expected" | tr ' ' '\n' | sort) <(printf '%s' "$actual" | tr ' ' '\n' | sort) | tr '\n' ' ')
  missing=${missing% }
  extras=${extras% }
  if [ -z "$missing" ] && [ -z "$extras" ]; then
    ok 'the installed preset holds only the whitelisted files'
  else
    if [ -n "$missing" ]; then
      fail "the installed preset is missing: $missing"
      fix 'rerun: bash tools/wheelchair-agent/install.sh'
    fi
    if [ -n "$extras" ]; then
      fail "the installed preset holds unexpected files: $extras"
      fix 'delete them, or rerun: bash tools/wheelchair-agent/install.sh'
    fi
  fi
  rm -rf "$staged"
}

# The data root and the one-shot migration it may still need. Informational only: a missing root is what a
# pre-upgrade install looks like, and an "old" layout is a valid state until the next reader migrates it.
# --check is read-only, so this only stats; it never creates the root or moves a file.
check_data_root() {
  case $DATA_ROOT in
    /*) ;;
    *)
      fail "WHEELCHAIR_AGENT_HOME must be an absolute path, got ${WHEELCHAIR_AGENT_HOME:-$DATA_ROOT}"
      fix 'set WHEELCHAIR_AGENT_HOME to an absolute directory, or unset it to use ~/.wheelchair-agent'
      return ;;
  esac
  if [ -d "$DATA_ROOT" ]; then
    ok "data root: $DATA_ROOT"
  else
    note "data root: $DATA_ROOT (not created yet; a real install creates it)"
  fi
  local new=0 old=0 pending=0
  present() { [ "$1" = dir ] && [ -d "$2" ] && [ -n "$(ls -A "$2" 2>/dev/null)" ] || { [ "$1" = file ] && [ -e "$2" ]; }; }
  # settings
  [ -e "$DATA_ROOT/settings.json" ] && new=1
  [ -e "$LEGACY_STATE_DIR/panel-settings.json" ] && old=1
  if [ ! -e "$DATA_ROOT/settings.json" ] && [ -e "$LEGACY_STATE_DIR/panel-settings.json" ]; then pending=1; fi
  # inbox (a directory counts as data only when it holds at least one entry); $SPV_INBOX_DIR is explicit
  if [ -z "${SPV_INBOX_DIR:-}" ]; then
    present dir "$DATA_ROOT/inbox" && new=1
    present dir "$LEGACY_STATE_DIR/inbox" && old=1
    if ! present dir "$DATA_ROOT/inbox" && present dir "$LEGACY_STATE_DIR/inbox"; then pending=1; fi
  fi
  # append-only files
  local pair current legacy
  for pair in "records/work-reclaimed.jsonl:work-reclaimed.jsonl" "logs/restart-all.log:restart-all.log" "logs/prepare.log:prepare.log"; do
    current=${pair%%:*}
    legacy=${pair##*:}
    # An explicit $SPV_PREPARE_LOG is outside the root and never migrates.
    if [ "$legacy" = prepare.log ] && [ -n "${SPV_PREPARE_LOG:-}" ]; then continue; fi
    [ -e "$DATA_ROOT/$current" ] && new=1
    [ -e "$LEGACY_STATE_DIR/$legacy" ] && old=1
    if [ ! -e "$DATA_ROOT/$current" ] && [ -e "$LEGACY_STATE_DIR/$legacy" ]; then pending=1; fi
  done
  # An install-created empty root is the new layout; old data alone still reports "old".
  if [ "$new" -eq 0 ] && [ "$old" -eq 0 ] && [ -d "$DATA_ROOT" ]; then new=1; fi
  if [ "$new" -eq 1 ] && [ "$old" -eq 1 ]; then
    note "data layout: both (new data under $DATA_ROOT, old data still under $LEGACY_STATE_DIR)"
  elif [ "$new" -eq 1 ]; then
    note "data layout: new ($DATA_ROOT)"
  elif [ "$old" -eq 1 ]; then
    note "data layout: old (our data is still under $LEGACY_STATE_DIR; the first reader moves it)"
  else
    note "data layout: none (nothing of ours is on disk yet)"
  fi
  if [ "$pending" -eq 1 ]; then
    note "migration: pending (the first reader moves it to $DATA_ROOT; $LEGACY_STATE_DIR stays readable on failure)"
  else
    note "migration: none"
  fi
}

# The loader row must be a real `name:` line, not a comment that happens to mention the package.
#
# This is a grep, not a YAML parse: a `name:` line under some unrelated block still passes, and a
# duplicate id is not detected. That residual is acceptable for a one-line append; dsh's own config
# validation is the authority on the composed tree.
loader_row_present() {
  local patch=$1
  [ -f "$patch" ] && grep -qE "^[[:space:]]*name:[[:space:]]*['\"]wheelchair-agent-webui['\"]" "$patch"
}

# Compare the installed webui package with what this checkout would write, and prove the loader row
# without which dsh would never mount it. The `diff -r` also proves the self-contained core copies
# (lib/core/*.js, lib/shared/queue.js and lib/shared/settings.js) match the checkout they were generated from.
check_webui() {
  local staged patch=$PROFILE_DIR/cordis.patch.yml
  staged=$(mktemp -d) || {
    fail 'could not create a temporary directory for the webui check'
    fix 'check that $TMPDIR (or /tmp) is writable, then rerun: bash install.sh --check'
    return
  }
  if ! render_webui_into "$staged" >/dev/null 2>&1; then
    fail 'the webui package cannot be rendered from this checkout'
    fix "run: bash $SELF_DIR/install.sh"
    rm -rf "$staged"
    return
  fi
  if [ ! -d "$WEBUI_TARGET" ]; then
    fail "the webui package is not installed at $WEBUI_TARGET"
    fix 'run: bash install.sh'
    rm -rf "$staged"
    return
  fi
  if diff -r "$staged" "$WEBUI_TARGET" >/dev/null 2>&1; then
    ok "webui package matches its sources ($WEBUI_TARGET)"
  else
    fail "the installed webui package at $WEBUI_TARGET differs from this checkout"
    diff -r "$staged" "$WEBUI_TARGET" 2>&1 | sed -n '1,8p' | sed 's/^/     /'
    fix 'run: bash install.sh'
  fi
  rm -rf "$staged"
  if loader_row_present "$patch"; then
    ok "the webui loader row is present in $patch"
  else
    fail "the webui loader row is missing from $patch, so dsh never mounts the package"
    fix 'run: bash install.sh'
  fi
}

# Compare one installed file with what this checkout would write there.
check_rendered() {
  local label=$1 installed=$2 render=$3 staged
  if [ ! -f "$installed" ]; then
    fail "the $label is not installed at $installed"
    fix 'run: bash tools/wheelchair-agent/install.sh'
    return
  fi
  if [ ! -x "$installed" ]; then
    fail "the $label at $installed is not executable"
    fix "run: chmod 0755 $installed"
    return
  fi
  staged=$(mktemp) || { fail 'could not create a temporary file'; return; }
  if ! "$render" "$staged"; then
    fail "the $label cannot be rendered from this checkout"
    rm -f "$staged"
    return
  fi
  if cmp -s "$staged" "$installed"; then
    ok "$label matches this checkout ($installed)"
  else
    fail "the $label at $installed differs from this checkout"
    fix 'run: bash tools/wheelchair-agent/install.sh'
  fi
  rm -f "$staged"
}

check_cli() {
  check_rendered 'CLI' "$CLI" render_cli
  case ":$PATH:" in
    *":$BIN_DIR:"*) ok "$BIN_DIR is on PATH, so \"wheelchair-agent\" resolves" ;;
    *) note "$BIN_DIR is not on PATH; add it to use the \"wheelchair-agent\" command, or call $CLI directly" ;;
  esac
}

check_launcher() {
  check_rendered 'SPV launcher' "$LAUNCHER" render_launcher
}

check_service() {
  check_rendered 'service manager wrapper' "$SERVICE" 'render_service_wrapper'
}

check_jobctl() {
  check_rendered 'jobctl wrapper' "$JOBCTL" 'render_jobctl_wrapper'
}

render_service_wrapper() { render_wrapper "$1" service; }
render_jobctl_wrapper() { render_wrapper "$1" jobctl; }

# The first running superagent service PID, or empty.
#
# The pre-flight already found every service PID (listening socket plus /proc), so this reuses that list
# instead of running the process hunt a second time.
service_pid() {
  printf '%s' "${SERVICE_PIDS%% *}"
}

# Verify the *service process's* PATH, not this shell's.
#
# The panel's prepare command is executed by the superagent service, so `wheelchair-agent` must resolve
# inside that process. `$PATH` here says nothing about it: the service may have been started from a
# different shell, or before BIN_DIR was added. /proc/<pid>/environ is the only place that answers it.
#
# A stopped service is not a failure: the operator may install before starting it. Say so and move on.
check_service_path() {
  local pid path entry found=0
  pid=$(service_pid)
  if [ -z "$pid" ]; then
    note 'the superagent service is not running, so its PATH was not checked; start it and rerun --check'
    return
  fi
  if [ ! -r "/proc/$pid/environ" ]; then
    note "cannot read /proc/$pid/environ for pid $pid, so the service PATH was not checked"
    return
  fi
  path=$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^PATH=//p' | head -1)
  if [ -z "$path" ]; then
    fail "the service process (pid $pid) has no PATH in its environment"
    fix 'restart it from a shell where PATH is set: wheelchair-agent service restart'
    return
  fi
  local IFS=:
  for entry in $path; do
    if [ "$entry" = "$BIN_DIR" ]; then found=1; break; fi
  done
  unset IFS
  if [ "$found" -eq 1 ]; then
    ok "the service process (pid $pid) has $BIN_DIR on its PATH, so \"wheelchair-agent prepare\" resolves"
  else
    fail "the service process (pid $pid) does not have $BIN_DIR on its PATH, so the panel's \"wheelchair-agent prepare\" would fail with command not found"
    fix "add $BIN_DIR to the PATH the service is started with, then: wheelchair-agent service restart"
  fi
}

check_prerequisites() {
  require_node || true
  require_dsh_tui || true
  require_python3 || true
}

# ---------------------------------------------------------------------- refusal

# What is in use, one line per holder. Empty when the probe found nothing.
in_use_lines() {
  if [ -n "$SERVICE_PIDS" ]; then
    printf '  - the superagent service (pid %s, port %s)\n' "$(service_pid)" "$SERVICE_PORT"
  fi
  if [ -n "$SPV_PIDS" ]; then
    printf '  - a live SPV session (pids %s)\n' "$SPV_PIDS"
  fi
}

# The exact commands that clear the refusal, install and start everything again.
#
# Absolute paths (shell-quoted with %q) so the lines still work when BIN_DIR is not on PATH or the
# checkout path contains spaces, and only the holders actually present are told to stop.
refusal_commands() {
  if [ -n "$SERVICE_PIDS" ]; then
    printf '  %q service stop\n' "$CLI"
  fi
  if [ -n "$SPV_PIDS" ]; then
    printf '  # exit the SPV session (Ctrl-D); it cannot be stopped from here\n'
  fi
  printf '  bash %q\n' "$SELF_DIR/install.sh"
  if [ -n "$SERVICE_PIDS" ]; then
    printf '  %q service start\n' "$CLI"
  fi
  printf '  %q spv\n' "$CLI"
}

# The refusal body, shared by the terminal and the SPV notice so both say the same thing.
refusal_text() {
  printf 'Cold install refused: the wheelchair-agent install targets are in use.\n\n'
  printf 'In use:\n'
  in_use_lines
  printf '\ninstall.sh performs cold installs only, so nothing was installed or changed.\n\n'
  printf 'Stop what is in use, install, then start it again:\n'
  refusal_commands
  printf '\nTell the operator that the install is waiting on this restart.\n'
}

# A deterministic id for this refusal: identical blockers replace one outbox file (two runs do not stack
# two notices), while a changed blocker set is a new notice. cksum is POSIX, so no hashing tool is assumed.
notice_id_for_blockers() {
  printf 'install-cold-refusal-%s' \
    "$(printf '%s|%s' "$SERVICE_PIDS" "$SPV_PIDS" | cksum | cut -d' ' -f1)"
}

# Queue one `notice` for the SPV session; never fail the refusal because nobody could be notified.
#
# build/refusal-notice.mjs uses writeMessage() from src/shared/queue.js, the same outbox channel the
# `spv` Source writes results into, and prints `skipped:` when the queue does not exist. That skipped
# line is the one-line explanation, and the exit code stays 3 either way.
refusal_notice() {
  local out id
  id=$(notice_id_for_blockers)
  if ! out=$(refusal_text | node "$SELF_DIR/build/refusal-notice.mjs" "$id" 2>&1); then
    note "could not queue the SPV refusal notice: $out"
    return 0
  fi
  case $out in
    queued:*) note "queued one notice for the SPV session: ${out#queued: }" ;;
    skipped:*) note "${out#skipped: }" ;;
    *) note "$out" ;;
  esac
  return 0
}

# Refuse the hot install: explain, notify SPV, touch nothing, exit 3.
refuse_install() {
  printf 'FAIL: refusing to install: the files this script installs are in use (cold installs only).\n' >&2
  refusal_text >&2
  refusal_notice
  exit 3
}

# ------------------------------------------------------------------ install mode

# Create the data root and its empty subdirectories. Idempotent and additive: an existing inbox, settings
# file or log is never touched or deleted. A relative WHEELCHAIR_AGENT_HOME is a loud failure, not a path
# resolved against the checkout.
create_data_root() {
  case $DATA_ROOT in
    /*) ;;
    *)
      fail "WHEELCHAIR_AGENT_HOME must be an absolute path, got ${WHEELCHAIR_AGENT_HOME:-$DATA_ROOT}"
      fix 'set WHEELCHAIR_AGENT_HOME to an absolute directory, or unset it to use ~/.wheelchair-agent'
      return 1 ;;
  esac
  if mkdir -p "$DATA_ROOT/logs" "$DATA_ROOT/records" "$DATA_ROOT/inbox"; then
    ok "data root: $DATA_ROOT"
    return 0
  fi
  fail "cannot create the data root $DATA_ROOT"
  fix "check that $DATA_ROOT (and its parent) is writable, or set WHEELCHAIR_AGENT_HOME, then rerun this script"
  return 1
}

# Create the settings file ship-empty instead of warning about it. Empty `values` means "use the
# built-in defaults", so a later default change still reaches this machine; the installer must never
# write resolved values. Existing files are left untouched (the Node helper opens with `wx`).
#
# This is a reader, so it can also complete the one-shot data migration when an old layout exists
# (`settingsFile()`/`resolveData()` do that before the existence test); the helper returns the path it
# actually used, and we report that path rather than assuming the new one. The Node URL is built with
# pathToFileURL so a checkout path containing `#`, `?` or `%` cannot corrupt the import.
ensure_settings_file() {
  local out
  if out=$(node --input-type=module -e \
      'import { pathToFileURL } from "node:url"; const { ensureSettingsFile } = await import(pathToFileURL(process.argv[1]).href); const result = ensureSettingsFile(); process.stdout.write(result.file)' \
      "$SELF_DIR/src/shared/settings.js" 2>&1); then
    if [ -f "$out" ]; then
      ok "settings file: $out"
      return 0
    fi
    fail "the settings helper reported $out, but no file exists there"
    fix "check the data root and its permissions, then rerun this script"
    return 1
  fi
  fail "cannot create the settings file under $DATA_ROOT"
  printf '%s\n' "$out" | sed 's/^/      /'
  fix "check that $DATA_ROOT is writable, fix the error above, then rerun this script"
  return 1
}

install_preset() {
  local staged backup
  staged=$(mktemp -d) || { fail 'could not create a staging directory'; return 1; }
  if ! render_into "$staged"; then
    rm -rf "$staged"
    # render_into already reported the specific failure; this keeps the exit status honest even if it did not.
    [ "$PROBLEMS" -gt 0 ] || fail 'the preset could not be rendered'
    return 1
  fi
  mkdir -p "$PRESET_ROOT" || { rm -rf "$staged"; fail "cannot create $PRESET_ROOT"; return 1; }
  if [ -d "$PRESET_DIR" ] && diff -r "$staged" "$PRESET_DIR" >/dev/null 2>&1; then
    ok "up to date: $PRESET_DIR"
    rm -rf "$staged"
    return 0
  fi
  # Atomic replacement: move the old directory aside, move the staged one into place, then drop the old one.
  backup="$PRESET_ROOT/.$PRESET_ID.previous.$$"
  if [ -d "$PRESET_DIR" ]; then
    mv "$PRESET_DIR" "$backup" || { rm -rf "$staged"; fail "cannot move $PRESET_DIR aside"; return 1; }
  fi
  if mv "$staged" "$PRESET_DIR"; then
    rm -rf "$backup"
    ok "installed preset: $PRESET_DIR"
    return 0
  fi
  [ -d "$backup" ] && mv "$backup" "$PRESET_DIR"
  rm -rf "$staged"
  fail "cannot move the staged preset into $PRESET_DIR"
  return 1
}

# Install one rendered file into BIN_DIR atomically; `$2` is the render function, `$3` its extra argument.
install_bin() {
  local target=$1 render=$2 extra=${3:-} staged
  mkdir -p "$BIN_DIR" || { fail "cannot create $BIN_DIR"; return 1; }
  staged="$BIN_DIR/.$(basename "$target").staged.$$"
  if ! "$render" "$staged" "$extra"; then
    rm -f "$staged"
    fail "could not render $(basename "$target")"
    return 1
  fi
  if [ -f "$target" ] && cmp -s "$staged" "$target"; then
    rm -f "$staged"
    ok "up to date: $target"
    return 0
  fi
  if mv -f "$staged" "$target"; then
    ok "installed: $target"
    return 0
  fi
  rm -f "$staged"
  fail "cannot move the staged file into $target"
  return 1
}

# Install the webui package into the superagent profile, atomically and idempotently.
#
# The profile is operator state created by dsh: if it is missing we refuse rather than invent one,
# because a node_modules directory without the profile's own manifests would not boot. The package is
# copied into node_modules and the profile's package.json is deliberately untouched, so a pnpm install
# against the profile may prune it; `--check` detects that and rerunning this script restores it.
install_webui() {
  local staged backup
  if [ ! -d "$PROFILE_DIR" ]; then
    fail "the dsh profile superagent is not installed at $PROFILE_DIR"
    fix 'start the superagent profile once ("wheelchair-agent service start") so dsh creates it, then rerun this script'
    return 1
  fi
  if ! mkdir -p "$PROFILE_DIR/node_modules"; then
    fail "cannot create $PROFILE_DIR/node_modules"
    fix "check that $PROFILE_DIR is writable, then rerun this script"
    return 1
  fi
  # Stage next to the target (same filesystem), so the final move is an atomic rename rather than a copy
  # that could leave a half-written package behind.
  staged=$(mktemp -d "$PROFILE_DIR/node_modules/.wheelchair-agent-webui.stage.XXXXXX") || {
    fail "could not create a staging directory under $PROFILE_DIR/node_modules"
    fix "check that $PROFILE_DIR/node_modules is writable, then rerun this script"
    return 1
  }
  if ! render_webui_into "$staged"; then
    rm -rf "$staged"
    [ "$PROBLEMS" -gt 0 ] || fail 'the webui package could not be rendered'
    return 1
  fi
  if [ -d "$WEBUI_TARGET" ] && diff -r "$staged" "$WEBUI_TARGET" >/dev/null 2>&1; then
    ok "up to date: $WEBUI_TARGET"
    rm -rf "$staged"
    return 0
  fi
  backup="$PROFILE_DIR/node_modules/.wheelchair-agent-webui.previous.$$"
  if [ -d "$WEBUI_TARGET" ]; then
    mv "$WEBUI_TARGET" "$backup" || {
      rm -rf "$staged"
      fail "cannot move $WEBUI_TARGET aside"
      fix "check that $PROFILE_DIR/node_modules is writable and no other process is installing, then rerun this script"
      return 1
    }
  fi
  if mv "$staged" "$WEBUI_TARGET"; then
    rm -rf "$backup"
    ok "installed webui package: $WEBUI_TARGET"
    return 0
  fi
  [ -d "$backup" ] && mv "$backup" "$WEBUI_TARGET"
  rm -rf "$staged"
  fail "cannot move the staged webui package into $WEBUI_TARGET"
  fix "check that $PROFILE_DIR/node_modules is writable and no other process is installing, then rerun this script"
  return 1
}

# Append the loader row that makes dsh mount the package. dsh-client-modules only scans bare package
# specifiers for `dsh.client`, so the row is the only way the browser bundle is discovered.
#
# Idempotent: `loader_row_present` makes a re-run a no-op, and appending (never rewriting) keeps the
# operator's existing patch intact.
ensure_webui_loader() {
  local patch=$PROFILE_DIR/cordis.patch.yml
  if [ ! -d "$PROFILE_DIR" ]; then
    fail "cannot add the webui loader row: $PROFILE_DIR does not exist"
    fix 'start the superagent profile once, then rerun this script'
    return 1
  fi
  if loader_row_present "$patch"; then
    ok "webui loader row present: $patch"
    return 0
  fi
  {
    printf '\n# Review inbox panel (webui/): an independent package because dsh-client-modules only\n'
    printf '# scans bare package specifiers for dsh.client declarations.\n'
    printf -- '- insert:\n'
    printf '    - id: wheelchair-webui\n'
    printf "      name: 'wheelchair-agent-webui'\n"
  } >> "$patch" || {
    fail "cannot append the webui loader row to $patch"
    fix "check that $patch is writable (or delete a stale lock file), then rerun this script"
    return 1
  }
  ok "added the webui loader row to $patch"
}

# --------------------------------------------------------------------------- main

if [ "$CHECK" -eq 1 ]; then
  check_prerequisites
  # Report the in-use holders (the cold-install gate). This is a note, never a refusal: --check is
  # read-only and must stay usable while everything runs. When python3 is missing, require_python3
  # already failed; do not add a second, redundant probe failure.
  if [ -n "${SPV_INSTALL_PROBE:-}" ] || command -v python3 >/dev/null 2>&1; then
    if probe_in_use; then
      if [ -n "$SERVICE_PIDS" ]; then
        note "the superagent service is running (pid $(service_pid), port $SERVICE_PORT); --check is read-only and does not refuse"
      fi
      if [ -n "$SPV_PIDS" ]; then
        note "a live SPV session holds the preset (pids $SPV_PIDS); a real install would refuse with exit 3 until it exits"
      fi
      if [ -z "$SERVICE_PIDS" ] && [ -z "$SPV_PIDS" ]; then
        note 'no running service or SPV session holds the install targets; a cold install is allowed'
      fi
    fi
  else
    note 'python3 is missing, so the in-use pre-flight was skipped; --check cannot prove a cold install is allowed'
  fi
  check_data_root
  check_preset
  check_webui
  check_cli
  check_launcher
  check_service
  check_jobctl
  check_service_path
  if [ "$PROBLEMS" -gt 0 ]; then
    printf '\n%d check(s) failed.\n' "$PROBLEMS"
    exit 2
  fi
  printf '\nAll checks passed.\n'
  exit 0
fi

if ! require_node; then
  printf '\n1 problem(s) blocked the install.\n'
  exit 1
fi
if ! require_dsh_tui; then
  printf '\n1 problem(s) blocked the install.\n'
  exit 1
fi
if ! require_python3; then
  printf '\n1 problem(s) blocked the install.\n'
  exit 1
fi

# The gate: everything below writes, so this must pass first. A probe failure is an install failure (1),
# not a refusal (3): the targets were not proven free, and guessing either way is worse than stopping.
if ! probe_in_use; then
  printf '\n1 problem(s) blocked the install.\n'
  exit 1
fi
if [ -n "$SERVICE_PIDS" ] || [ -n "$SPV_PIDS" ]; then
  refuse_install
fi

if ! create_data_root; then
  printf '\n1 problem(s) blocked the install.\n'
  exit 1
fi
if ! ensure_settings_file; then
  printf '\n1 problem(s) blocked the install.\n'
  exit 1
fi
install_preset
install_webui
ensure_webui_loader
install_bin "$CLI" render_cli
install_bin "$LAUNCHER" render_launcher
install_bin "$SERVICE" render_service_wrapper
install_bin "$JOBCTL" render_jobctl_wrapper

if [ "$PROBLEMS" -gt 0 ]; then
  printf '\n%d step(s) failed.\n' "$PROBLEMS"
  exit 1
fi

printf '\nDone. Start the superagent service, then the SPV session:\n'
printf '  wheelchair-agent service start   # the backend that executes tickets\n'
printf '  wheelchair-agent spv             # the agent you talk to\n'
# Only when the preset really landed: printing a command for a file that is not there would send the
# operator to a prepare command that fails on every ticket.
if [ -f "$PRESET_DIR/prepare.sh" ]; then
  # The command name, not an absolute path: the panel value must survive a changed DSH_HOME or user name,
  # and the service process's PATH is what resolves it (checked by --check).
  printf '\nPaste this into the panel (Settings -> Execution -> Prepare command):\n'
  printf '  wheelchair-agent prepare\n'
fi
