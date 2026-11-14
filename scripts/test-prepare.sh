#!/bin/sh
# Exercise dsh/prepare.sh end to end in a throwaway sandbox.
#
# It never touches github.com: the create path runs against a fake `gh` on PATH and a git
# `url.<base>.insteadOf` that redirects https://github.com/<owner>/ to local bare repositories. Every
# case asserts on the resulting git state, not on the script's own output.
#
# Usage: sh scripts/test-prepare.sh [--keep]
#   --keep   leave the sandbox in place and print its path
# Exit status: 0 when every case passes, 1 otherwise.
set -u

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO=$(CDPATH= cd -- "$SELF_DIR/.." && pwd -P)
PREPARE=$REPO/dsh/prepare.sh
TEMPLATES=$REPO/docs/agentsmd-examples
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

SB=$(mktemp -d "${TMPDIR:-/tmp}/spv-prepare-test.XXXXXX") || exit 1
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

mkdir -p "$SB/projects/tools" "$SB/projects/research" "$SB/work" "$SB/bin" "$SB/remotes"

# A project with a commit and a GitHub remote.
git init -q -b main "$SB/projects/tools/with-remote"
printf 'a\n' > "$SB/projects/tools/with-remote/a.txt"
git -C "$SB/projects/tools/with-remote" add -A
git -C "$SB/projects/tools/with-remote" -c user.name=t -c user.email=t@t commit -qm init
git -C "$SB/projects/tools/with-remote" remote add origin https://github.com/testowner/with-remote.git

# A project with a commit and no remote.
git init -q -b main "$SB/projects/tools/no-remote"
printf 'b\n' > "$SB/projects/tools/no-remote/b.txt"
git -C "$SB/projects/tools/no-remote" add -A
git -C "$SB/projects/tools/no-remote" -c user.name=t -c user.email=t@t commit -qm init

# A project with no .git at all.
mkdir -p "$SB/projects/tools/no-git"
printf 'c\n' > "$SB/projects/tools/no-git/c.txt"

# A project whose AGENTS.md is tracked, so the managed copy needs skip-worktree.
git init -q -b main "$SB/projects/tools/tracked"
printf 'OLD RULES\n' > "$SB/projects/tools/tracked/AGENTS.md"
printf 'd\n' > "$SB/projects/tools/tracked/d.txt"
git -C "$SB/projects/tools/tracked" add -A
git -C "$SB/projects/tools/tracked" -c user.name=t -c user.email=t@t commit -qm init
git -C "$SB/projects/tools/tracked" remote add origin https://github.com/testowner/tracked.git

# A research project with .git and no remote.
git init -q -b main "$SB/projects/research/a-task"
printf 'e\n' > "$SB/projects/research/a-task/e.txt"
git -C "$SB/projects/research/a-task" add -A
git -C "$SB/projects/research/a-task" -c user.name=t -c user.email=t@t commit -qm init

# A research project with no .git.
mkdir -p "$SB/projects/research/no-git-task"
printf 'f\n' > "$SB/projects/research/no-git-task/f.txt"

# A tools project whose name collides with an existing non-empty repository.
git init -q -b main "$SB/projects/tools/collides"
printf 'g\n' > "$SB/projects/tools/collides/g.txt"
git -C "$SB/projects/tools/collides" add -A
git -C "$SB/projects/tools/collides" -c user.name=t -c user.email=t@t commit -qm init

# A tools project whose name collides with an existing PUBLIC repository.
git init -q -b main "$SB/projects/tools/public-collision"
printf 'h\n' > "$SB/projects/tools/public-collision/h.txt"
git -C "$SB/projects/tools/public-collision" add -A
git -C "$SB/projects/tools/public-collision" -c user.name=t -c user.email=t@t commit -qm init

# Fake gh: records its calls, creates a local bare repository instead of a GitHub one.
cat > "$SB/bin/gh" <<'FAKE'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
case $1 in
  api)
    case $2 in
      user) case $* in *'.id'*) echo 12345 ;; *) echo testowner ;; esac ;;
      repos/*/branches) echo "${FAKE_GH_BRANCHES:-0}" ;;
      *) echo "fake gh: unhandled api $*" >&2; exit 1 ;;
    esac ;;
  repo)
    case $2 in
      view)
        case $* in
          *'--json visibility'*) echo "${FAKE_GH_VISIBILITY:-PRIVATE}" ;;
          *'--json owner'*) echo "${FAKE_GH_OWNER:-testowner}" ;;
          *) [ "${FAKE_GH_EXISTS:-0}" = 1 ] && echo '{"name":"x"}' || exit 1 ;;
        esac ;;
      create)
        name=${3#*/}
        git init -q --bare "$FAKE_GH_REMOTES/$name.git"
        echo "https://github.com/$3" ;;
      *) echo "fake gh: unhandled repo $*" >&2; exit 1 ;;
    esac ;;
  *) echo "fake gh: unhandled $*" >&2; exit 1 ;;
esac
FAKE
chmod +x "$SB/bin/gh"

# Redirect https://github.com/testowner/<name> to the local bare repositories.
cat > "$SB/gitconfig" <<EOF
[url "$SB/remotes/"]
	insteadOf = https://github.com/testowner/
EOF

# Run the prepare script for one case; extra arguments are VAR=value overrides.
run() {
  project=$1
  name=$2
  shift 2
  (
    export PATH="$SB/bin:$PATH" GIT_CONFIG_GLOBAL="$SB/gitconfig" \
      FAKE_GH_LOG="$SB/gh-calls.log" FAKE_GH_REMOTES="$SB/remotes" \
      SPV_PROJECTS_ROOT="$SB/projects" SPV_PREPARE_LOG="$SB/prepare.log" \
      SPV_PREPARE_TEMPLATES="$TEMPLATES" \
      DSH_SUPERAGENT_SPV_PROJECT="$project" DSH_SUPERAGENT_DIR="$SB/work/$name"
    for assignment in "$@"; do export "$assignment"; done   # after the defaults, so a case can override them
    sh "$PREPARE"
  ) 2>"$SB/stderr"
}

origin_of() { git -C "$1" config --get remote.origin.url 2>/dev/null || true; }
same_as() { cmp -s "$1" "$2" && echo yes || echo no; }

# ------------------------------------------------------------------- cases

# (a) tools project that already has a GitHub remote.
run tools/with-remote a
check '(a) exit status' "$?" 0
check '(a) ticket origin is the GitHub URL' "$(origin_of "$SB/work/a")" https://github.com/testowner/with-remote.git
check '(a) AGENTS.md is the project-development template' \
  "$(same_as "$SB/work/a/AGENTS.md" "$TEMPLATES/proj-dev-agentsmd.md")" yes
check '(a) the managed AGENTS.md is not in git status' "$(git -C "$SB/work/a" status --porcelain)" ''

# (b) tools project with no remote, dry run: nothing is created.
run tools/no-remote b SPV_PREPARE_DRY_RUN=1
check '(b) exit status' "$?" 0
check '(b) the project still has no remote' "$(git -C "$SB/projects/tools/no-remote" remote)" ''
check '(b) the ticket origin is still the local path' "$(origin_of "$SB/work/b")" "$SB/projects/tools/no-remote"
check '(b) the dry run names the repository it would create' \
  "$(grep -c 'would create the PRIVATE repository testowner/no-remote' "$SB/stderr")" 1

# (b2) tools project with no .git, dry run: nothing is initialised.
run tools/no-git b2 SPV_PREPARE_DRY_RUN=1
check '(b2) exit status' "$?" 0
check '(b2) the project still has no .git' "$([ -d "$SB/projects/tools/no-git/.git" ] && echo present || echo absent)" absent

# (b3) tools project with no remote, real path against the fake gh: a PRIVATE repository is created,
# pushed, and the ticket's origin points at it.
run tools/no-remote b3
check '(b3) exit status' "$?" 0
check '(b3) the project origin is the GitHub URL' "$(origin_of "$SB/projects/tools/no-remote")" https://github.com/testowner/no-remote.git
check '(b3) the repository was created with --private' "$(grep -c 'repo create testowner/no-remote --private' "$SB/gh-calls.log")" 1
check '(b3) the branch was pushed' "$(git -C "$SB/remotes/no-remote.git" branch --list main)" '  main'
check '(b3) the ticket origin is the GitHub URL' "$(origin_of "$SB/work/b3")" https://github.com/testowner/no-remote.git
check '(b3) the creation is logged with owner and visibility' \
  "$(grep -c 'created PRIVATE repository testowner/no-remote (owner testowner)' "$SB/prepare.log")" 1

# (b4) tools project with no .git, real path: initialised, committed, created, pushed.
run tools/no-git b4
check '(b4) exit status' "$?" 0
check '(b4) the project now has a commit' "$(git -C "$SB/projects/tools/no-git" rev-list --count HEAD)" 1
check '(b4) the initial commit is attributed to the agent account' \
  "$(git -C "$SB/projects/tools/no-git" log -1 --format='%an <%ae>')" \
  'testowner <12345+testowner@users.noreply.github.com>'
check '(b4) the ticket origin is the GitHub URL' "$(origin_of "$SB/work/b4")" https://github.com/testowner/no-git.git

# (c) research project with .git: no remote is created, the research template is installed.
run research/a-task c
check '(c) exit status' "$?" 0
check '(c) the project still has no remote' "$(git -C "$SB/projects/research/a-task" remote)" ''
check '(c) the ticket origin is still the local path' "$(origin_of "$SB/work/c")" "$SB/projects/research/a-task"
check '(c) AGENTS.md is the research-task template' \
  "$(same_as "$SB/work/c/AGENTS.md" "$TEMPLATES/research-task-agentsmd.md")" yes
check '(c) the research template keeps the local-only rule' \
  "$(grep -c 'local-only' "$SB/work/c/AGENTS.md")" 1

# (c2) research project with no .git: copied, no .git invented, research template installed.
run research/no-git-task c2
check '(c2) exit status' "$?" 0
check '(c2) the ticket has no .git' "$([ -d "$SB/work/c2/.git" ] && echo present || echo absent)" absent
check '(c2) AGENTS.md is the research-task template' \
  "$(same_as "$SB/work/c2/AGENTS.md" "$TEMPLATES/research-task-agentsmd.md")" yes

# (d) a stale AGENTS.md is overwritten, and a rerun is idempotent.
printf 'STALE\n' > "$SB/work/a/AGENTS.md"
run tools/with-remote a
check '(d) exit status' "$?" 0
check '(d) the stale AGENTS.md was overwritten' \
  "$(same_as "$SB/work/a/AGENTS.md" "$TEMPLATES/proj-dev-agentsmd.md")" yes
check '(d) the rerun did not clone again' "$(grep -c 'not cloning again' "$SB/stderr")" 1

# (e) a tracked AGENTS.md is overwritten and hidden from git.
run tools/tracked e
check '(e) exit status' "$?" 0
check '(e) the tracked AGENTS.md was overwritten' \
  "$(same_as "$SB/work/e/AGENTS.md" "$TEMPLATES/proj-dev-agentsmd.md")" yes
check '(e) the tracked AGENTS.md is hidden from git status' "$(git -C "$SB/work/e" status --porcelain)" ''
check '(e) the tracked AGENTS.md carries skip-worktree' "$(git -C "$SB/work/e" ls-files -v AGENTS.md | cut -c1)" S

# (f) a name collision with an existing non-empty repository fails loudly and changes nothing.
run tools/collides f FAKE_GH_EXISTS=1 FAKE_GH_BRANCHES=1
check '(f) exit status' "$?" 1
check '(f) the failure names the step' "$(grep -c 'FAILED at remote-create' "$SB/stderr")" 1
check '(f) the project was not given a remote' "$(git -C "$SB/projects/tools/collides" remote)" ''

# (g) a name collision with an existing PUBLIC repository is refused (constraint 1).
run tools/public-collision g FAKE_GH_EXISTS=1 FAKE_GH_VISIBILITY=PUBLIC
check '(g) exit status' "$?" 1
check '(g) the refusal names the visibility' "$(grep -c 'already exists and is PUBLIC' "$SB/stderr")" 1
check '(g) the project was not given a remote' "$(git -C "$SB/projects/tools/public-collision" remote)" ''

# (h) an existing empty PRIVATE repository is adopted, so a rerun after a partial failure recovers.
git init -q -b main "$SB/projects/tools/adoptable"
printf 'i\n' > "$SB/projects/tools/adoptable/i.txt"
git -C "$SB/projects/tools/adoptable" add -A
git -C "$SB/projects/tools/adoptable" -c user.name=t -c user.email=t@t commit -qm init
# The repository already exists on GitHub, so the local stand-in for it must exist too.
git init -q --bare "$SB/remotes/adoptable.git"
run tools/adoptable h FAKE_GH_EXISTS=1
check '(h) exit status' "$?" 0
check '(h) the existing repository was adopted' "$(grep -c 'adopting the existing empty PRIVATE repository' "$SB/stderr")" 1
check '(h) the adopted repository was not created again' "$(grep -c 'repo create testowner/adoptable' "$SB/gh-calls.log")" 0
check '(h) the ticket origin is the GitHub URL' "$(origin_of "$SB/work/h")" https://github.com/testowner/adoptable.git

# (i) bad input fails with the step named.
run '' i
check '(i) an empty project fails at arguments' "$(grep -c 'FAILED at arguments' "$SB/stderr")" 1
run other/thing i2
check '(i2) an unknown project kind fails at arguments' "$(grep -c 'FAILED at arguments' "$SB/stderr")" 1
run tools/missing i3
check '(i3) a missing project fails at arguments' "$(grep -c 'FAILED at arguments' "$SB/stderr")" 1

# (j) the fallback file is honoured when the Ticket names no project.
printf 'tools/with-remote\n' > "$SB/projects/.superagent-project"
run '' j
check '(j) the fallback project is used' "$(origin_of "$SB/work/j")" https://github.com/testowner/with-remote.git
rm -f "$SB/projects/.superagent-project"

# (l) a project directory that sits inside another repository but has no .git of its own is treated as
# having no repository: it must not be cloned as part of the enclosing repository.
mkdir -p "$SB/enclosing/tools/nested"
git init -q -b main "$SB/enclosing"
printf 'j\n' > "$SB/enclosing/tools/nested/j.txt"
git -C "$SB/enclosing" add -A
git -C "$SB/enclosing" -c user.name=t -c user.email=t@t commit -qm init
run tools/nested l SPV_PROJECTS_ROOT="$SB/enclosing" SPV_PREPARE_DRY_RUN=1
check '(l) exit status' "$?" 0
check '(l) the enclosing repository was not cloned' "$([ -d "$SB/work/l/.git" ] && echo present || echo absent)" absent
check '(l) the project was copied, not cloned' "$(grep -c 'copied .*tools/nested' "$SB/stderr")" 1

# (m) a linked worktree is recognised as a checkout, so it is not cloned again.
git -C "$SB/projects/tools/with-remote" worktree add -q "$SB/work/m" -b ticket-branch
run tools/with-remote m
check '(m) exit status' "$?" 0
check '(m) the worktree was not cloned again' "$(grep -c 'not cloning again' "$SB/stderr")" 1
check '(m) the worktree origin is the GitHub URL' "$(origin_of "$SB/work/m")" https://github.com/testowner/with-remote.git

# (n) the copy path works without rsync on PATH.
mkdir -p "$SB/no-rsync"
for tool in git sh cp mkdir rm ls grep cmp cat date dirname basename tr head cut env mktemp sleep; do
  real=$(command -v "$tool" 2>/dev/null) && ln -sf "$real" "$SB/no-rsync/$tool"
done
(
  export PATH="$SB/no-rsync"
  export GIT_CONFIG_GLOBAL="$SB/gitconfig" SPV_PROJECTS_ROOT="$SB/projects" \
    SPV_PREPARE_LOG="$SB/prepare.log" SPV_PREPARE_TEMPLATES="$TEMPLATES" \
    DSH_SUPERAGENT_SPV_PROJECT=research/no-git-task DSH_SUPERAGENT_DIR="$SB/work/n"
  sh "$PREPARE"
) 2>"$SB/stderr"
check '(n) exit status without rsync' "$?" 0
check '(n) the project was copied without rsync' "$(grep -c 'copied .*no-git-task' "$SB/stderr")" 1
check '(n) the ticket has the project file' "$(cat "$SB/work/n/f.txt" 2>/dev/null)" f

# (o) a research project that already has a GitHub remote is left completely alone: no push, no change.
git init -q -b main "$SB/projects/research/has-remote"
printf 'k\n' > "$SB/projects/research/has-remote/k.txt"
git -C "$SB/projects/research/has-remote" add -A
git -C "$SB/projects/research/has-remote" -c user.name=t -c user.email=t@t commit -qm init
git -C "$SB/projects/research/has-remote" remote add origin https://github.com/testowner/has-remote.git
before=$(git -C "$SB/projects/research/has-remote" rev-parse HEAD)
run research/has-remote o
check '(o) exit status' "$?" 0
check '(o) the research project keeps its own remote' \
  "$(git -C "$SB/projects/research/has-remote" config --get remote.origin.url)" \
  https://github.com/testowner/has-remote.git
check '(o) the research project was not pushed' "$(git -C "$SB/projects/research/has-remote" rev-parse HEAD)" "$before"
check '(o) the ticket origin still points at the local project' "$(origin_of "$SB/work/o")" "$SB/projects/research/has-remote"
check '(o) no repository was created for it' "$(grep -c 'repo create testowner/has-remote' "$SB/gh-calls.log")" 0

# (p) a tools project whose origin is a local path gets a GitHub remote, and the local path is kept as
# a second remote instead of being overwritten.
git init -q -b main "$SB/projects/tools/local-origin"
printf 'l\n' > "$SB/projects/tools/local-origin/l.txt"
git -C "$SB/projects/tools/local-origin" add -A
git -C "$SB/projects/tools/local-origin" -c user.name=t -c user.email=t@t commit -qm init
git -C "$SB/projects/tools/local-origin" remote add origin "$SB/projects/tools/with-remote"
run tools/local-origin p
check '(p) exit status' "$?" 0
check '(p) the local origin was kept as a second remote' \
  "$(git -C "$SB/projects/tools/local-origin" config --get remote.github.url)" \
  https://github.com/testowner/local-origin.git
check '(p) the ticket origin is the GitHub URL' "$(origin_of "$SB/work/p")" https://github.com/testowner/local-origin.git

# (q) a project on a detached HEAD still gets its commits pushed, to main.
git init -q -b main "$SB/projects/tools/detached"
printf 'm\n' > "$SB/projects/tools/detached/m.txt"
git -C "$SB/projects/tools/detached" add -A
git -C "$SB/projects/tools/detached" -c user.name=t -c user.email=t@t commit -qm init
git -C "$SB/projects/tools/detached" checkout -q --detach HEAD
run tools/detached q
check '(q) exit status' "$?" 0
check '(q) the detached commits were pushed to main' "$(git -C "$SB/remotes/detached.git" branch --list main)" '  main'
check '(q) the ticket origin is the GitHub URL' "$(origin_of "$SB/work/q")" https://github.com/testowner/detached.git

# (r) an existing PUBLIC remote is used (the project already had it) but called out loudly.
git init -q -b main "$SB/projects/tools/public-existing"
printf 'n\n' > "$SB/projects/tools/public-existing/n.txt"
git -C "$SB/projects/tools/public-existing" add -A
git -C "$SB/projects/tools/public-existing" -c user.name=t -c user.email=t@t commit -qm init
git -C "$SB/projects/tools/public-existing" remote add origin https://github.com/testowner/public-existing.git
run tools/public-existing r FAKE_GH_EXISTS=1 FAKE_GH_VISIBILITY=PUBLIC
check '(r) exit status' "$?" 0
check '(r) the public remote is used' "$(origin_of "$SB/work/r")" https://github.com/testowner/public-existing.git
check '(r) the public remote is called out' "$(grep -c 'WARNING: testowner/public-existing is PUBLIC' "$SB/stderr")" 1

# (k) a missing template fails at agentsmd instead of leaving the Ticket without rules.
run tools/with-remote k SPV_PREPARE_TEMPLATES=/nonexistent
check '(k) exit status' "$?" 1
check '(k) the failure names the step' "$(grep -c 'FAILED at agentsmd' "$SB/stderr")" 1

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
