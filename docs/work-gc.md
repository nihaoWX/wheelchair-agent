# Reclaiming ticket clones (`work gc`)

dsh-superagent gives every Ticket one clone under its execution root (`settings.executor.directory`, default
`<stateDir>/work`). Once the Ticket ends, most of those clones are pure duplicates of their source repository at a
known commit. `wheelchair-agent work gc` deletes only the ones it can prove reproducible, records what is needed to
rebuild them, and runs the same pass once at service start.

## Safety gate

A directory is reclaimed only when **all three runtime facts** hold:

1. no process has its cwd inside it (`/proc/<pid>/cwd`, symlink followed). An unreadable process of another user is
   skipped (it cannot own one of our private clones), but an unreadable process of our own under a `hidepid` proc
   mount makes the whole scan unprovable, so nothing is reclaimed;
2. `git status --porcelain` is empty;
3. every commit is published: `git log @{u}..HEAD` is empty, or, without an upstream,
   `git rev-list origin/main..HEAD` counts zero. A clone with no remote at all is kept: it is the only copy.

A directory that fails one is kept and the operator sees the reason (`18 commits not pushed`, `1 untracked path`,
`cwd in use by pid 1234`). Anything that is not a ticket clone — no `.git`, a name that is not `<name>-<hex>`, or a
plain file — is reported as `unknown` and never deleted.

`--dry-run` prints every directory, its size, and `reclaim` or the reason it is kept, and changes nothing.

## Count floor and age window

The reconstructibility gate is what makes deletion *safe*. `--keep` (default **10**) is about the one thing that is
**not** reconstructible: following up on a recent Ticket re-prepares the ticket from the current `main`, while that
Ticket's worker session still remembers the old commit, so the newest few clones are worth keeping for a while. The
floor always applies, regardless of age; `--keep 0` disables it. `--keep-days` (default **0**) is an optional further
guard: `--keep-days 7` leaves passing directories that were modified in the last seven days alone. Neither option can
make an unsafe directory eligible.

## Record and `work restored`

Before a delete, one JSON object is appended to `<stateDir>/work-reclaimed.jsonl`: directory name and absolute path,
size in bytes, UTC time, `git rev-parse HEAD`, `git rev-parse origin/main` (or `null`), the branch, the upstream, and
the tracked remote's name and URL. The values are captured from the clone before any removal; the line is written
before the delete, so a failed write keeps the directory. If the delete itself then fails, a retraction line cancels
the record and `work restored` refuses to target the surviving directory.

```console
$ wheelchair-agent work restored agent-tool-dsh-install-0312cf6b4046
mkdir -p '/home/nihao/.dsh/state/superagent/work'
git clone 'https://github.com/nihaoWX/wheelchair-agent.git' '/home/nihao/.dsh/state/superagent/work/agent-tool-dsh-install-0312cf6b4046'
cd '...'
git fetch origin 'agent/install-cold-only-...'
git checkout --detach '0312cf6b...'
```

The command only reads the record file; it does not perform the clone. It prints the commands, so the rebuild stays a
copy-paste.

## Automatic run at mount

The `spv` Source plugin entry (`src/superagent/watch.js`) calls the same `src/shared/work.js` implementation once,
without awaiting it, so a slow disk or a failed gate can never delay or break the Source's own startup. It uses the
same defaults as the CLI, additionally keeps every directory an **open** Ticket still owns (the CLI cannot see Ticket
state, so the mount is never more aggressive), and logs one line:

```
wheelchair-agent work gc: reclaimed N, kept M, freed X MB
```

The root is `settings.executor.directory` from the running deployment. The CLI cannot read the panel settings, so set
`DSH_SUPERAGENT_WORK_DIR` to that directory when it is not `<stateDir>/work`, and `DSH_SUPERAGENT_STATE_DIR` when the
profile moved the state dir (both are shown by `wheelchair-agent work --help`).

## Manual check

```bash
wheelchair-agent work gc --dry-run       # plan only
wheelchair-agent work gc                 # delete what passes
wheelchair-agent work gc --keep 0        # let every passing clone go
```
