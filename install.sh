#!/usr/bin/env bash
# Install the SPV preset and its launcher for the current user.
#
# Installs three things (this project is not an agent tool, so there is no SKILL.md to copy):
#   1. the dsh agent preset  -> $DSH_HOME/.agent-presets/spv/
#      (including prepare.sh and agentsmd-examples/, which the panel's prepare command uses)
#   2. the launcher          -> ~/.local/bin/spv
#   3. the service manager   -> ~/.local/bin/superagent-service
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
LAUNCHER=$BIN_DIR/spv
SERVICE=$BIN_DIR/superagent-service
JOBCTL=$BIN_DIR/jobctl
TARGET_PLUGIN_URL="file://$PRESET_DIR/spv-tools.js"
TARGET_CRON_URL="file://$PRESET_DIR/spv-cron-plugin.js"

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

# Render the preset into $1: preset.yml, agent.cordis.yml, preset-default.patch.yml, spv-tools.js, src/,
# prepare.sh and agentsmd-examples/.
#
# prepare.sh and the two AGENTS.md templates are installed here because the panel's prepare command runs
# from a user-level path, not from this development tree (docs/delivery-target.md, constraint 6).
render_into() {
  local dest=$1
  mkdir -p "$dest/src" "$dest/agentsmd-examples" || return 1
  if ! node "$SELF_DIR/scripts/render-preset.mjs" "$SELF_DIR/dsh" "$TARGET_PLUGIN_URL" "$TARGET_CRON_URL" "$dest" >/dev/null; then
    fail 'could not render the preset (scripts/render-preset.mjs failed)'
    fix 'run "node tools/wheelchair-agent/scripts/render-preset.mjs dsh file://<dir>/spv-tools.js file://<dir>/spv-cron-plugin.js <dir>" to see the error'
    return 1
  fi
  cp "$SELF_DIR/spv-tools.js" "$dest/spv-tools.js" || return 1
  cp "$SELF_DIR/spv-cron-plugin.js" "$dest/spv-cron-plugin.js" || return 1
  local file
  for file in queue.js paths.js dispatch.js outbox.js health.js spv-cron.js; do
    cp "$SELF_DIR/src/$file" "$dest/src/$file" || return 1
  done
  cp "$SELF_DIR/dsh/prepare.sh" "$dest/prepare.sh" || return 1
  chmod 0755 "$dest/prepare.sh"
  for file in proj-dev-agentsmd.md research-task-agentsmd.md; do
    cp "$SELF_DIR/docs/agentsmd-examples/$file" "$dest/agentsmd-examples/$file" || return 1
  done
  return 0
}

# Render the launcher into $1 with the preset directory substituted for @SPV_HOME@.
render_launcher() {
  local dest=$1
  sed "s|@SPV_HOME@|$PRESET_DIR|g" "$SELF_DIR/dsh/spv-launcher.sh" > "$dest" || return 1
  chmod 0755 "$dest"
}

# Render the service manager into $1: a straight copy, because it takes no substitutions.
render_service() {
  local dest=$1
  cp "$SELF_DIR/scripts/superagent-service.py" "$dest" || return 1
  chmod 0755 "$dest"
}

# Render jobctl into $1: also a straight copy.
render_jobctl() {
  local dest=$1
  cp "$SELF_DIR/scripts/jobctl.py" "$dest" || return 1
  chmod 0755 "$dest"
}

# ----------------------------------------------------------------- - check mode

check_preset() {
  local staged actual
  staged=$(mktemp -d) || { fail 'could not create a temporary directory'; return; }
  if ! render_into "$staged" >/dev/null 2>&1; then
    fail 'the preset sources cannot be rendered'
    fix "run: node $SELF_DIR/scripts/render-preset.mjs dsh $TARGET_PLUGIN_URL $PRESET_DIR"
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
  local expected="agent.cordis.yml agentsmd-examples/proj-dev-agentsmd.md agentsmd-examples/research-task-agentsmd.md package.json prepare.sh preset-default.patch.yml preset.yml spv-cron-plugin.js spv-tools.js src/dispatch.js src/health.js src/outbox.js src/paths.js src/queue.js src/spv-cron.js "
  if [ "$actual" = "$expected" ]; then
    ok 'the installed preset holds only the whitelisted files'
  else
    fail "the installed preset holds unexpected files: $(comm -13 <(printf '%s' "$expected" | tr ' ' '\n' | sort) <(printf '%s' "$actual" | tr ' ' '\n' | sort) | tr '\n' ' ')"
    fix 'delete them, or rerun: bash tools/wheelchair-agent/install.sh'
  fi
  rm -rf "$staged"
}

check_prepare() {
  local installed=$PRESET_DIR/prepare.sh
  if [ ! -f "$installed" ]; then
    fail "the prepare command is not installed at $installed"
    fix 'run: bash tools/wheelchair-agent/install.sh'
  elif [ ! -x "$installed" ]; then
    fail "the prepare command at $installed is not executable"
    fix "run: chmod 0755 $installed"
  elif cmp -s "$SELF_DIR/dsh/prepare.sh" "$installed"; then
    ok "prepare command matches its source ($installed)"
  else
    fail "the prepare command at $installed differs from this checkout"
    fix 'run: bash tools/wheelchair-agent/install.sh'
  fi
  local file
  for file in proj-dev-agentsmd.md research-task-agentsmd.md; do
    if [ ! -f "$PRESET_DIR/agentsmd-examples/$file" ]; then
      fail "the AGENTS.md template $file is not installed at $PRESET_DIR/agentsmd-examples/$file"
      fix 'run: bash tools/wheelchair-agent/install.sh'
    elif cmp -s "$SELF_DIR/docs/agentsmd-examples/$file" "$PRESET_DIR/agentsmd-examples/$file"; then
      ok "AGENTS.md template $file matches its source"
    else
      fail "the AGENTS.md template $file at $PRESET_DIR/agentsmd-examples/$file differs from this checkout"
      fix 'run: bash tools/wheelchair-agent/install.sh'
    fi
  done
}

check_launcher() {
  if [ ! -f "$LAUNCHER" ]; then
    fail "the launcher is not installed at $LAUNCHER"
    fix 'run: bash tools/wheelchair-agent/install.sh'
    return
  fi
  if [ ! -x "$LAUNCHER" ]; then
    fail "the launcher at $LAUNCHER is not executable"
    fix "run: chmod 0755 $LAUNCHER"
    return
  fi
  local staged
  staged=$(mktemp) || { fail 'could not create a temporary file'; return; }
  if ! render_launcher "$staged"; then
    fail 'the launcher template cannot be rendered'
    fix 'check that dsh/spv-launcher.sh exists in this checkout'
    rm -f "$staged"
    return
  fi
  if cmp -s "$staged" "$LAUNCHER"; then
    ok "launcher matches its template ($LAUNCHER)"
  else
    fail "the launcher at $LAUNCHER differs from this checkout"
    fix 'run: bash tools/wheelchair-agent/install.sh'
  fi
  rm -f "$staged"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ok "$BIN_DIR is on PATH, so \"spv\" resolves" ;;
    *) note "$BIN_DIR is not on PATH; add it to use the \"spv\" command, or call $LAUNCHER directly" ;;
  esac
}

check_service() {
  if [ ! -f "$SERVICE" ]; then
    fail "the service manager is not installed at $SERVICE"
    fix 'run: bash tools/wheelchair-agent/install.sh'
    return
  fi
  if [ ! -x "$SERVICE" ]; then
    fail "the service manager at $SERVICE is not executable"
    fix "run: chmod 0755 $SERVICE"
    return
  fi
  if cmp -s "$SELF_DIR/scripts/superagent-service.py" "$SERVICE"; then
    ok "service manager matches its source ($SERVICE)"
  else
    fail "the service manager at $SERVICE differs from this checkout"
    fix 'run: bash tools/wheelchair-agent/install.sh'
  fi
  case ":$PATH:" in
    *":$BIN_DIR:"*) ok "$BIN_DIR is on PATH, so \"superagent-service\" resolves" ;;
    *) note "$BIN_DIR is not on PATH; add it to use the \"superagent-service\" command" ;;
  esac
}

check_jobctl() {
  if [ ! -f "$JOBCTL" ]; then
    fail "jobctl is not installed at $JOBCTL"
    fix 'run: bash tools/wheelchair-agent/install.sh'
    return
  fi
  if [ ! -x "$JOBCTL" ]; then
    fail "jobctl at $JOBCTL is not executable"
    fix "run: chmod 0755 $JOBCTL"
    return
  fi
  if cmp -s "$SELF_DIR/scripts/jobctl.py" "$JOBCTL"; then
    ok "jobctl matches its source ($JOBCTL)"
  else
    fail "jobctl at $JOBCTL differs from this checkout"
    fix 'run: bash tools/wheelchair-agent/install.sh'
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

install_launcher() {
  local staged
  mkdir -p "$BIN_DIR" || { fail "cannot create $BIN_DIR"; return 1; }
  staged="$BIN_DIR/.spv.staged.$$"
  if ! render_launcher "$staged"; then
    rm -f "$staged"
    fail 'could not render the launcher'
    return 1
  fi
  if [ -f "$LAUNCHER" ] && cmp -s "$staged" "$LAUNCHER"; then
    rm -f "$staged"
    ok "up to date: $LAUNCHER"
    return 0
  fi
  if mv -f "$staged" "$LAUNCHER"; then
    ok "installed launcher: $LAUNCHER"
    return 0
  fi
  rm -f "$staged"
  fail "cannot move the staged launcher into $LAUNCHER"
  return 1
}

install_service() {
  local staged
  mkdir -p "$BIN_DIR" || { fail "cannot create $BIN_DIR"; return 1; }
  staged="$BIN_DIR/.superagent-service.staged.$$"
  if ! render_service "$staged"; then
    rm -f "$staged"
    fail 'could not render the service manager'
    return 1
  fi
  if [ -f "$SERVICE" ] && cmp -s "$staged" "$SERVICE"; then
    rm -f "$staged"
    ok "up to date: $SERVICE"
    return 0
  fi
  if mv -f "$staged" "$SERVICE"; then
    ok "installed service manager: $SERVICE"
    return 0
  fi
  rm -f "$staged"
  fail "cannot move the staged service manager into $SERVICE"
  return 1
}

install_jobctl() {
  local staged
  mkdir -p "$BIN_DIR" || { fail "cannot create $BIN_DIR"; return 1; }
  staged="$BIN_DIR/.jobctl.staged.$$"
  if ! render_jobctl "$staged"; then
    rm -f "$staged"
    fail 'could not render jobctl'
    return 1
  fi
  if [ -f "$JOBCTL" ] && cmp -s "$staged" "$JOBCTL"; then
    rm -f "$staged"
    ok "up to date: $JOBCTL"
    return 0
  fi
  if mv -f "$staged" "$JOBCTL"; then
    ok "installed jobctl: $JOBCTL"
    return 0
  fi
  rm -f "$staged"
  fail "cannot move the staged jobctl into $JOBCTL"
  return 1
}

# --------------------------------------------------------------------------- main

if [ "$CHECK" -eq 1 ]; then
  check_prerequisites
  check_preset
  check_prepare
  check_launcher
  check_service
  check_jobctl
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
install_launcher
install_service
install_jobctl

if [ "$PROBLEMS" -gt 0 ]; then
  printf '\n%d step(s) failed.\n' "$PROBLEMS"
  exit 1
fi

printf '\nDone. Start the superagent service, then the SPV session:\n'
printf '  superagent-service start   # the backend that executes tickets\n'
printf '  spv                        # the agent you talk to\n'
# The absolute path, not $DSH_HOME: the prepare command runs with the execution environment's variables,
# and DSH_* names are stripped from a child environment, so a $DSH_HOME reference would silently fall back.
printf '\nPaste this into the panel (Settings -> Execution -> Prepare command):\n'
printf '  sh %s/prepare.sh\n' "$PRESET_DIR"
