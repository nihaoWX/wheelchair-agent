#!/usr/bin/env bash
# Enforce the three mechanical rules of ARCHITECTURE/layout.md.
#
# The rules exist because the layout has to *show* a boundary the code already keeps:
#   1. src/superagent/ and src/spv/ never import each other (two independent programs, one queue format);
#   2. bin/ never imports src/superagent/ (the CLI is the operator's tool, the Source kind is the service's);
#   3. nothing under src/ or bin/ imports a dsh package (the preset is a plain user-level directory, so a
#      bare `@deepseek-ai/*` specifier does not resolve there and the whole preset fails to mount).
#
# Rule 3 is the one that has already bitten: src/spv/tools.js registers raw JSON Schema for exactly this
# reason. A grep is enough because the failure mode is a literal import specifier, not a dynamic one.
#
# Usage: bash tests/test-layout.sh
# Exit status: 0 when every rule holds, 1 otherwise.
set -u

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO=$(CDPATH= cd -- "$SELF_DIR/.." && pwd -P)
cd "$REPO" || exit 1

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; printf '      %s\n' "$2"; }

# Print every import/export-from specifier in the given files, one per line, as `<file>: <specifier>`.
#
# Matches `import ... from '<specifier>'`, `export ... from '<specifier>'` and bare `import '<specifier>'`,
# including multi-line import lists (the specifier is always on the `from` line). Comments are not
# stripped: a commented-out import of a forbidden package is still a mistake worth failing on.
specifiers() {
  grep -HnE "^[[:space:]]*(import|export)[[:space:]].*from[[:space:]]*['\"]|^[[:space:]]*import[[:space:]]*['\"]" "$@" 2>/dev/null \
    | sed -E "s/^([^:]+):[0-9]+:.*from[[:space:]]*['\"]([^'\"]+)['\"].*/\1: \2/; s/^([^:]+):[0-9]+:[[:space:]]*import[[:space:]]*['\"]([^'\"]+)['\"].*/\1: \2/"
}

# Files of one directory tree, as a sorted list; empty when the directory does not exist.
files_under() {
  [ -d "$1" ] && find "$1" -type f -name '*.js' -o -type f -name '*.mjs' | sort
}

# ---------------------------------------------------------------- rule 1

# src/superagent/ must not import src/spv/, and src/spv/ must not import src/superagent/.
#
# Both directions are checked separately so a failure names which side crossed the line. A relative
# specifier is resolved against the importing file's directory, which is what makes `../spv/x.js` from
# src/superagent/ a violation while `../shared/queue.js` is not.
rule1() {
  local file spec target side other violations=''
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    case $file in
      src/superagent/*) side=superagent; other=spv ;;
      src/spv/*) side=spv; other=superagent ;;
      *) continue ;;
    esac
    while IFS= read -r spec; do
      [ -n "$spec" ] || continue
      case $spec in
        ./*|../*) target=$(cd "$(dirname "$file")" && cd "$(dirname "$spec")" 2>/dev/null && pwd -P) || continue ;;
        *) continue ;;
      esac
      if [ "$target" = "$REPO/src/$other" ]; then
        violations="$violations
      $file imports $spec"
      fi
    done < <(specifiers "$file" | sed -E 's/^[^:]+: //')
  done < <(files_under src/superagent; files_under src/spv)
  if [ -z "$violations" ]; then
    ok 'rule 1: src/superagent/ and src/spv/ do not import each other'
  else
    bad 'rule 1: src/superagent/ and src/spv/ do not import each other' "cross-side import(s):$violations"
  fi
}

# ---------------------------------------------------------------- rule 2

# bin/ must not import src/superagent/: the CLI is the operator's tool, the Source kind is the service's.
rule2() {
  local file spec violations=''
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    while IFS= read -r spec; do
      [ -n "$spec" ] || continue
      case $spec in
        *superagent*) violations="$violations
      $file imports $spec" ;;
      esac
    done < <(specifiers "$file" | sed -E 's/^[^:]+: //')
  done < <(files_under bin)
  if [ -z "$violations" ]; then
    ok 'rule 2: bin/ does not import src/superagent/'
  else
    bad 'rule 2: bin/ does not import src/superagent/' "the CLI must not depend on the Source kind:$violations"
  fi
}

# ---------------------------------------------------------------- rule 3

# Nothing under src/ or bin/ may import a dsh package, bare or scoped.
#
# `@deepseek-ai/*` is the concrete case; the broader pattern also catches a future `dsh-*` package, because
# the reason is the same: this package is a plain directory a user-level preset points at, so nothing from
# the dsh install tree resolves from here.
rule3() {
  local file spec violations=''
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    while IFS= read -r spec; do
      [ -n "$spec" ] || continue
      case $spec in
        @deepseek-ai/*|@deepseek-harness*|dsh-*|dsh)
          violations="$violations
      $file imports $spec" ;;
      esac
    done < <(specifiers "$file" | sed -E 's/^[^:]+: //')
  done < <(files_under src; files_under bin)
  if [ -z "$violations" ]; then
    ok 'rule 3: src/ and bin/ import no dsh package'
  else
    bad 'rule 3: src/ and bin/ import no dsh package' \
      "a bare dsh specifier does not resolve from the preset directory, so the preset would fail to mount:$violations"
  fi
}

# ---------------------------------------------------------------- sanity

# The rules above are only meaningful if the trees they scan exist and hold files. A typo in a path would
# otherwise turn every rule green by scanning nothing.
sanity() {
  local missing=''
  for dir in src/shared src/superagent src/spv bin; do
    [ -d "$dir" ] || missing="$missing $dir"
  done
  if [ -n "$missing" ]; then
    bad 'the layout directories exist' "missing:$missing"
    return
  fi
  local count
  count=$(files_under src | wc -l)
  if [ "$count" -lt 10 ]; then
    bad 'src/ holds the expected modules' "found only $count JS files under src/, so the rules above scanned almost nothing"
    return
  fi
  ok "the layout directories exist and src/ holds $count JS files"
}

sanity
rule1
rule2
rule3

# Deliberate failure for the auto-merge gate test; this branch is never merged.
bad 'deliberate failure' 'this branch exists only to prove that auto-merge waits for ci'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
