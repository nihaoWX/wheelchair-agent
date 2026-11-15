#!/usr/bin/env bash
# Install the SPV preset, the `wheelchair-agent` CLI and its compatibility commands for the current user.
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
#
# Design rules (references/tool-install.md):
#   - nothing is hard-coded to one machine: paths derive from $HOME and this script's own directory;
#   - a missing prerequisite is a loud FAIL with the command that obtains it, never a silent workaround;
#   - copies, never symlinks; a whitelist, never the whole tree;
#   - atomic replacement through a staging directory, and idempotent (same content => "OK: up to date");
#   - --check is read-only, reports item by item, and exits 2 with a "fix:" line when anything is off.
#
# Usage: bash install.sh [--check]
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
PROFILE_DIR=$DSH_HOME_DIR/profiles/superagent
WEBUI_TARGET=$PROFILE_DIR/node_modules/wheelchair-agent-webui
SERVICE_PORT=${SPV_SERVICE_PORT:-3082}

CHECK=0
for arg in "$@"; do
  case $arg in
    --check) CHECK=1 ;;
    -h|--help)
      printf 'usage: bash install.sh [--check]\n'
      printf '  --check   read-only self-check; exit 2 when anything is not installed as expected\n'
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
  if ! node "$SELF_DIR/build/render-preset.mjs" "$SELF_DIR/preset" "$TARGET_PLUGIN_URL" "$TARGET_CRON_URL" "$dest" >/dev/null; then
    fail 'could not render the preset (build/render-preset.mjs failed)'
    fix "run: node $SELF_DIR/build/render-preset.mjs $SELF_DIR/preset $TARGET_PLUGIN_URL $TARGET_CRON_URL <dir>"
    return 1
  fi
  # Every copy reports its own failure: a missing source file must not leave a half-installed preset that
  # the panel's prepare command then cannot run.
  if ! cp "$SELF_DIR/bin/wheelchair-agent.mjs" "$dest/cli.js"; then
    fail 'cannot copy bin/wheelchair-agent.mjs to cli.js'
    fix "check that $SELF_DIR/bin/wheelchair-agent.mjs exists and is readable, then rerun this script"
    return 1
  fi
  for file in shared/queue.js shared/schema.js spv/check.js spv/cron-plugin.js spv/cron.js spv/dispatch.js spv/health.js spv/inbox.js spv/injector.js spv/outbox.js spv/paths.js spv/tools.js; do
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
  for pair in "spv/inbox.js:lib/core/inbox.js" "spv/dispatch.js:lib/core/dispatch.js" "spv/paths.js:lib/core/paths.js" "shared/queue.js:lib/shared/queue.js"; do
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
    fix "run: node $SELF_DIR/build/render-preset.mjs $SELF_DIR/preset $TARGET_PLUGIN_URL $TARGET_CRON_URL $PRESET_DIR"
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
  local expected="agent.cordis.yml agentsmd-examples/proj-dev-agentsmd.md agentsmd-examples/research-task-agentsmd.md cli.js commands/jobctl.py commands/superagent-service.py package.json prepare.sh preset-default.patch.yml preset.yml spv-launcher.sh src/shared/queue.js src/shared/schema.js src/spv/check.js src/spv/cron-plugin.js src/spv/cron.js src/spv/dispatch.js src/spv/health.js src/spv/inbox.js src/spv/injector.js src/spv/outbox.js src/spv/paths.js src/spv/tools.js "
  if [ "$actual" = "$expected" ]; then
    ok 'the installed preset holds only the whitelisted files'
  else
    fail "the installed preset holds unexpected files: $(comm -13 <(printf '%s' "$expected" | tr ' ' '\n' | sort) <(printf '%s' "$actual" | tr ' ' '\n' | sort) | tr '\n' ' ')"
    fix 'delete them, or rerun: bash tools/wheelchair-agent/install.sh'
  fi
  rm -rf "$staged"
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
# (lib/core/*.js, lib/shared/queue.js) match the checkout they were generated from.
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

# The PID of the running superagent service, or empty.
#
# Two sources, because neither alone is enough: `superagent-service status` knows the profile and the
# configured port, while the listening socket is the runtime fact when the status output is unavailable.
service_pid() {
  local out pid
  out=$("$SERVICE" status 2>/dev/null) || true
  pid=$(printf '%s\n' "$out" | sed -n 's/^pids:[[:space:]]*//p' | tr -d ' ' | cut -d, -f1)
  case $pid in ''|'(none)') pid='' ;; esac
  if [ -z "$pid" ] && command -v ss >/dev/null 2>&1; then
    pid=$(ss -lptnH "sport = :$SERVICE_PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)
  fi
  printf '%s' "$pid"
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
}

# ------------------------------------------------------------------ install mode

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
