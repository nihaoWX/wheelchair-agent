#!/bin/sh
# The managed prepare command for dsh-superagent tickets, installed by wheelchair-agent/install.sh.
#
# It runs once per new Ticket, before the Ticket's directory exists, with the execution environment's
# variables. Three jobs, in this order:
#
#   1. clone the project named by DSH_SUPERAGENT_SPV_PROJECT into DSH_SUPERAGENT_DIR;
#   2. give the Ticket's working copy a managed AGENTS.md matching the project type;
#   3. for tools/<name> only, make sure the project has a PRIVATE GitHub remote and point the Ticket's
#      clone at it, so a worker's `git push` and `gh pr create` reach the project, not the panel's
#      configured repository.
#
# The six binding constraints are in docs/delivery-target.md:
#   1. a repository this script creates is PRIVATE, never public;
#   2. creating a remote is external state, so it is logged (name, visibility, owner) and a failure
#      names the step that failed instead of continuing;
#   3. research/<name> is local-only: it never gets a remote and is never pushed;
#   4. every Ticket's working copy gets an AGENTS.md matching its project type;
#   5. that AGENTS.md is managed: missing => add, stale => overwrite (the template is the source of truth);
#   6. the templates come from the installed preset, not from a hard-coded development tree.
#
# Environment:
#   DSH_SUPERAGENT_SPV_PROJECT  tools/<name> or research/<name>; when empty, <root>/.superagent-project
#   DSH_SUPERAGENT_DIR          the Ticket's directory (required)
#   SPV_PROJECTS_ROOT           where the projects live; default $HOME/bioagentforge
#   SPV_PREPARE_TEMPLATES       template directory; default <this script's directory>/agentsmd-examples
#   SPV_PREPARE_DRY_RUN=1       do not mutate the project or GitHub; print what would be done (for tests)
#   SPV_PREPARE_LOG             traceability log; default $DSH_HOME/state/superagent/prepare.log
#
# Exit status: 0 when the Ticket is ready, 1 with a "FAILED at <step>" line otherwise.
set -eu

STEP=start
step() { printf 'prepare: %s\n' "$*" >&2; }
die() { printf 'prepare: FAILED at %s: %s\n' "$STEP" "$*" >&2; exit 1; }
dry_run() { [ "${SPV_PREPARE_DRY_RUN:-0}" = 1 ]; }

DSH_HOME_DIR=${DSH_HOME:-$HOME/.dsh}
LOG=${SPV_PREPARE_LOG:-$DSH_HOME_DIR/state/superagent/prepare.log}
log() {
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null || return 0
}

# Turn an ssh GitHub URL into its https form, so the Ticket's origin is the same shape everywhere.
normalize_url() {
  case $1 in
    git@github.com:*) printf 'https://github.com/%s\n' "${1#git@github.com:}" ;;
    ssh://git@github.com/*) printf 'https://github.com/%s\n' "${1#ssh://git@github.com/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# Print the project's GitHub remote URL, preferring origin, or nothing when it has none.
#
# Reads the configured URL with `git config`, not `git remote get-url`: the latter applies
# `url.<base>.insteadOf` rewriting, so a GitHub URL can come back as a local path and be missed.
github_remote() {
  local repo=$1 url remote
  for remote in origin $(git -C "$repo" remote 2>/dev/null || true); do
    url=$(git -C "$repo" config --get "remote.$remote.url" 2>/dev/null || true)
    case $url in *github.com*) normalize_url "$url"; return 0 ;; esac
  done
  return 0
}

# True when $1 is a git checkout, including a linked worktree whose .git is a file.
is_checkout() { git -C "$1" rev-parse --git-dir >/dev/null 2>&1; }

# Print the exclude file git actually reads for $1, which differs for a linked worktree.
exclude_file() {
  local dir=$1 path
  path=$(git -C "$dir" rev-parse --path-format=absolute --git-path info/exclude 2>/dev/null || true)
  if [ -n "$path" ]; then printf '%s\n' "$path"; else printf '%s\n' "$dir/.git/info/exclude"; fi
}

# ------------------------------------------------------------------ arguments

STEP=arguments
DIR=${DSH_SUPERAGENT_DIR:-}
[ -n "$DIR" ] || die 'DSH_SUPERAGENT_DIR is empty: the executor did not name the Ticket directory'
ROOT=${SPV_PROJECTS_ROOT:-$HOME/bioagentforge}
PROJECT=${DSH_SUPERAGENT_SPV_PROJECT:-}
if [ -z "$PROJECT" ] && [ -f "$ROOT/.superagent-project" ]; then
  # The fallback the panel's previous prepare command used, for Tickets that did not come from the spv queue.
  PROJECT=$(tr -d '\r\n' < "$ROOT/.superagent-project")
fi
[ -n "$PROJECT" ] || die "no project for this Ticket: DSH_SUPERAGENT_SPV_PROJECT is empty and $ROOT/.superagent-project does not name one"
case $PROJECT in
  tools/*) KIND=tools; NAME=${PROJECT#tools/} ;;
  research/*) KIND=research; NAME=${PROJECT#research/} ;;
  *) die "the project must be tools/<name> or research/<name>, got '$PROJECT'" ;;
esac
case $NAME in
  ''|.|..|*/*) die "the project name '$NAME' is not a single directory name" ;;
esac
SRC=$ROOT/$PROJECT
[ -d "$SRC" ] || die "the project directory does not exist: $SRC"
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || die "cannot resolve the script's own directory"
TEMPLATES=${SPV_PREPARE_TEMPLATES:-$SELF_DIR/agentsmd-examples}

# ------------------------------------------------- tools: a project needs a repo

# A tools project without .git cannot be cloned, cannot be pushed and cannot carry a PR. The operator's
# instruction is to configure it automatically rather than fail, so initialise it and commit what is there.
if [ "$KIND" = tools ] && [ ! -d "$SRC/.git" ]; then
  STEP=git-init
  if dry_run; then
    step "dry run: would git init $SRC and commit its files"
  else
    step "the project has no .git; initialising one at $SRC"
    git -C "$SRC" init --quiet -b main || die "git init $SRC failed"
    if ! git -C "$SRC" rev-parse --verify HEAD >/dev/null 2>&1; then
      command -v gh >/dev/null 2>&1 || die 'gh is not on PATH, so the initial commit cannot be attributed to the agent account'
      OWNER=$(gh api user --jq .login 2>/dev/null) || die 'cannot read the GitHub account (gh api user); gh must be authenticated'
      ID=$(gh api user --jq .id 2>/dev/null) || die 'cannot read the GitHub account id (gh api user)'
      if [ -n "$(git -C "$SRC" status --porcelain 2>/dev/null || true)" ]; then
        git -C "$SRC" add -A || die "git add -A in $SRC failed"
        git -C "$SRC" -c user.name="$OWNER" -c "user.email=$ID+$OWNER@users.noreply.github.com" \
          commit --quiet -m 'chore: initial commit (created by the ticket prepare command)' \
          || die "the initial commit in $SRC failed"
        step "committed the project's files as $OWNER"
        log "initialised $SRC and committed its files as $OWNER"
      else
        step "the project is empty, so there is nothing to commit"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------- clone

STEP=clone
if is_checkout "$DIR"; then
  step "the Ticket directory already holds a git checkout; not cloning again"
elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null || true)" ]; then
  step "the Ticket directory already exists and is not empty; not cloning again"
else
  mkdir -p "$(dirname "$DIR")" || die "cannot create $(dirname "$DIR")"
  if [ -d "$SRC/.git" ]; then
    git clone --quiet --no-hardlinks "$SRC" "$DIR" || die "git clone $SRC $DIR failed"
    step "cloned $SRC"
  else
    mkdir -p "$DIR"
    rsync -a --exclude .git "$SRC"/ "$DIR"/ || die "rsync $SRC/ $DIR/ failed"
    step "copied $SRC (the project has no .git)"
  fi
fi

# ------------------------------------------------------------------ AGENTS.md

STEP=agentsmd
case $KIND in
  tools) TEMPLATE=$TEMPLATES/proj-dev-agentsmd.md ;;
  research) TEMPLATE=$TEMPLATES/research-task-agentsmd.md ;;
esac
[ -f "$TEMPLATE" ] || die "the $KIND template is not installed at $TEMPLATE; run install.sh"
TARGET=$DIR/AGENTS.md
if [ -f "$TARGET" ] && cmp -s "$TEMPLATE" "$TARGET"; then
  step "the Ticket's AGENTS.md already matches $TEMPLATE"
else
  if [ -f "$TARGET" ]; then
    step "overwrote the Ticket's stale AGENTS.md with $TEMPLATE"
    log "overwrote $TARGET with $TEMPLATE"
  else
    step "installed the Ticket's AGENTS.md from $TEMPLATE"
    log "installed $TARGET from $TEMPLATE"
  fi
  cp "$TEMPLATE" "$TARGET" || die "cannot write $TARGET"
  # The managed file is ticket scaffolding, not project content: keep it out of `git status` and out of a
  # worker's `git add -A` / `git commit -a`, so it never becomes an accidental part of a PR. It stays
  # readable, which is the point of installing it.
  #
  # An untracked AGENTS.md is hidden with the repository's own exclude file. A tracked one needs
  # skip-worktree, because an exclude entry does not apply to tracked files. The cost is that a later
  # rebase or merge whose upstream changed AGENTS.md stops with "local changes would be overwritten";
  # that is loud and recoverable, unlike a managed file silently landing in a PR.
  if is_checkout "$DIR"; then
    if git -C "$DIR" ls-files --error-unmatch AGENTS.md >/dev/null 2>&1; then
      git -C "$DIR" update-index --skip-worktree AGENTS.md \
        || die "cannot mark the tracked AGENTS.md as skip-worktree in $DIR"
      step "AGENTS.md is tracked by the project; the managed copy is hidden from git (skip-worktree)"
    else
      EXCLUDE=$(exclude_file "$DIR")
      mkdir -p "$(dirname "$EXCLUDE")" 2>/dev/null || true
      if ! grep -qxF '/AGENTS.md' "$EXCLUDE" 2>/dev/null; then
        printf '/AGENTS.md\n' >> "$EXCLUDE" || die "cannot write $EXCLUDE"
      fi
    fi
  fi
fi

# ------------------------------------------------------- tools: GitHub remote

if [ "$KIND" = tools ]; then
  STEP=remote
  URL=$(github_remote "$SRC")
  if [ -z "$URL" ]; then
    STEP=remote-create
    command -v gh >/dev/null 2>&1 || die 'gh is not on PATH, so a private GitHub repository cannot be created'
    OWNER=$(gh api user --jq .login 2>/dev/null) || die 'cannot read the GitHub account (gh api user); gh must be authenticated'
    REPO=$OWNER/$NAME
    URL=https://github.com/$REPO.git
    BRANCH=$(git -C "$SRC" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
    HAS_COMMITS=0
    git -C "$SRC" rev-parse --verify HEAD >/dev/null 2>&1 && HAS_COMMITS=1
    if gh repo view "$REPO" --json name >/dev/null 2>&1; then
      # A previous run may have created the repository and failed before adding the remote. Adopt it only
      # when it is ours, private and still empty; anything else is a collision the operator must resolve.
      VISIBILITY=$(gh repo view "$REPO" --json visibility --jq .visibility 2>/dev/null) || die "cannot read the visibility of $REPO"
      REPO_OWNER=$(gh repo view "$REPO" --json owner --jq .owner.login 2>/dev/null) || die "cannot read the owner of $REPO"
      BRANCHES=$(gh api "repos/$REPO/branches" --jq 'length' 2>/dev/null) || die "cannot list the branches of $REPO"
      [ "$VISIBILITY" = PRIVATE ] || die "$REPO already exists and is $VISIBILITY; refusing to use it (constraint 1: only private repositories)"
      [ "$REPO_OWNER" = "$OWNER" ] || die "$REPO already exists under $REPO_OWNER, not $OWNER; refusing to adopt it"
      [ "$BRANCHES" = 0 ] || die "$REPO already exists and holds $BRANCHES branch(es), but the project has no GitHub remote; refusing to adopt a repository that may belong to something else. Point the project at it by hand: git -C $SRC remote add origin $URL"
      step "adopting the existing empty PRIVATE repository $REPO (owner $REPO_OWNER, visibility $VISIBILITY)"
      log "adopted existing empty PRIVATE repository $REPO (owner $REPO_OWNER) for $SRC"
    elif dry_run; then
      step "dry run: would create the PRIVATE repository $REPO (owner $OWNER)"
      log "dry run: would create $REPO (owner $OWNER) for $SRC"
    else
      gh repo create "$REPO" --private >/dev/null 2>&1 || die "gh repo create $REPO --private failed"
      step "created the PRIVATE repository $REPO (owner $OWNER, visibility private)"
      log "created PRIVATE repository $REPO (owner $OWNER) for $SRC"
    fi
    if dry_run; then
      step "dry run: would add the remote and push ${BRANCH:-<no branch>} to $REPO"
    else
      if git -C "$SRC" remote get-url origin >/dev/null 2>&1; then REMOTE=github; else REMOTE=origin; fi
      git -C "$SRC" remote add "$REMOTE" "$URL" || die "cannot add the remote $REMOTE to $SRC"
      if [ "$HAS_COMMITS" = 1 ] && [ -n "$BRANCH" ]; then
        git -C "$SRC" push --quiet "$REMOTE" "HEAD:refs/heads/$BRANCH" || die "git push to $REPO failed"
        step "pushed $BRANCH to $REPO"
        log "pushed $BRANCH to $REPO"
      else
        step "the project has no commit to push, so the repository stays empty until the first one"
      fi
    fi
  else
    step "the project already has a GitHub remote: $URL"
  fi
  STEP=remote-clone
  if dry_run; then
    step "dry run: would point the Ticket's origin at $URL"
    log "dry run: would point $DIR origin at $URL"
  else
    is_checkout "$DIR" || die "the Ticket directory has no git checkout, so its origin cannot point at $URL"
    if git -C "$DIR" remote get-url origin >/dev/null 2>&1; then
      git -C "$DIR" remote set-url origin "$URL" || die "cannot point the Ticket's origin at $URL"
    else
      git -C "$DIR" remote add origin "$URL" || die "cannot add the origin $URL to the Ticket"
    fi
    # Read the configured value, not `remote get-url`: git rewrites URLs through `url.<base>.insteadOf`,
    # so the resolved value can differ from what is configured. What must hold is that origin is the
    # GitHub URL and no longer the local project path.
    ACTUAL=$(git -C "$DIR" config --get remote.origin.url 2>/dev/null || true)
    [ "$ACTUAL" = "$URL" ] || die "the Ticket's origin is '$ACTUAL', expected '$URL'"
    step "the Ticket's origin now points at $URL"
    log "Ticket $DIR origin -> $URL"
  fi
fi

STEP=done
step "ready: $PROJECT -> $DIR"
