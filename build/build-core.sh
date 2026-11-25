#!/usr/bin/env bash
# Build the Rust core binary and place it where `src/shared/work.js` looks for it.
#
# The planner runs as a separate process (not a Node addon), so a Rust panic or abort kills only this
# command. The artifact name carries the platform, matching the scope this ticket works on. Pure cargo:
# no npm package and no post-processing beyond stripping the executable.
#
# Idempotent: cargo decides what to rebuild, and an unchanged artifact is simply copied over itself.
# Non-zero on any cargo/strip failure. Prints the resulting artifact path on success.
#
# Usage: bash build/build-core.sh
set -euo pipefail

SELF_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(cd -- "$SELF_DIR/.." && pwd -P)
ARTIFACT_DIR=$REPO/build/artifacts
ARTIFACT=$ARTIFACT_DIR/wheelchair-agent-core-linux-x64

cd "$REPO"
cargo build --release

mkdir -p "$ARTIFACT_DIR"
cp "$REPO/target/release/wheelchair-agent-core" "$ARTIFACT"
strip "$ARTIFACT"
# Record which Rust sources (and, when available, which commit) produced this artifact. install.sh
# compares the stamp instead of only installed bytes, so a rebuilt checkout and an installed copy that
# agree with each other but predate the sources can no longer pass --check silently.
commit=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || printf 'unknown')
cargo_version=$(cargo --version 2>/dev/null || printf 'unknown')
node "$REPO/src/shared/core-stamp.js" write --root "$REPO" --artifact "$ARTIFACT" \
  --commit "$commit" --cargo "$cargo_version" >/dev/null
printf '%s\n' "$ARTIFACT"
