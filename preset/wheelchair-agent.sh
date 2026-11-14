#!/bin/sh
# The `wheelchair-agent` CLI shell, installed to ~/.local/bin/wheelchair-agent.
#
# The preset directory is baked in by install.sh, with the same placeholder substitution the SPV launcher
# uses, so this file needs no lookup of its own: it works from any cwd, with any PATH, and on a machine
# that has no wheelchair-agent checkout.
#
# Why a shell and not a symlink to cli.js: the CLI lives inside the preset directory, and a symlink would
# make `import.meta.url` resolve to the preset path anyway — but it would also break when the preset is
# replaced atomically (the symlink would point at a path that briefly does not exist). A two-line shell
# with the path baked in is the same trick the launcher already uses.
set -eu

SPV_PRESET_HOME='@SPV_HOME@'
SPV_CLI="$SPV_PRESET_HOME/cli.js"

if [ ! -f "$SPV_CLI" ]; then
  echo "FAIL: the wheelchair-agent CLI is missing at $SPV_CLI" >&2
  echo "fix: reinstall it with: bash <bioagentforge>/tools/wheelchair-agent/install.sh" >&2
  exit 1
fi

exec node "$SPV_CLI" "$@"
