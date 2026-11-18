# Reclaiming ticket clones (`work gc`)

dsh-superagent gives every Ticket one clone under its execution root (`settings.executor.directory`, default
`<stateDir>/work`). Once the Ticket ends, most of those clones are pure duplicates of their source repository at a
known commit. `wheelchair-agent work gc` deletes only the ones it can prove reproducible, records what is needed to
rebuild them, and runs the same pass once at service start.

## Safety

A directory is reclaimed only when **all three reconstructibility facts** hold:

1. no process has its cwd inside it (`/proc/<pid>/cwd`, symlink followed). An unreadable process of another user is
   skipped (it cannot own one of our private clones), but an unreadable process of our own under a `hidepid` proc
   mount makes the whole scan unprovable, so nothing is reclaimed;
2. `git status --porcelain` is empty;
3. every commit is published: `git log @{u}..HEAD` is empty, or, without an upstream,
   `git rev-list origin/main..HEAD` counts zero. A clone with no remote at all is kept: it is the only copy.

The cwd fact alone is not enough for a live Ticket: a worker's process cwd does not sit in the ticket directory between
tool calls. Both the CLI and the mount hook therefore ask for the open Tickets and keep every
`execution.directory` they report. The CLI asks the running service
(`GET <url>/orchestrator/api/tickets?state=open`); the mount hook reads the same list in process. They share one
resolver in `src/shared/work.js`, so the two paths cannot drift. A service that is not running is not a reason to keep
everything — nothing can be working — and the pass says the check was skipped. Any other failure (unreadable answer,
2xx body without the expected shape, unexpected ticket) **keeps everything** and says so.

A directory that fails one is kept and the operator sees the reason (`18 commits not pushed`, `1 untracked path`,
`cwd in use by pid 1234`, `open ticket <id> is using this directory`). Anything that is not a ticket clone — no
`.git`, a name that is not `<name>-<hex>`, or a plain file — is reported as `unknown` and never deleted.

`--dry-run` prints every directory, its size, and `reclaim` or the reason it is kept, and changes nothing.

## Optional guards

The gate plus the open-ticket list are what make deletion *safe*. Rebuilding is instant and cheap
(`work restored <ticket>`, from the record the gate writes), so keeping recent clones buys nothing that cannot be had
back in a moment; `--keep` therefore defaults to **0**. `--keep N` still protects the newest N passing directories when
someone asks for it, and `--keep-days 7` leaves passing directories modified in the last seven days alone. Both are
optional guards, not the safety mechanism, and neither can make an unsafe directory eligible.

## Record and `work restored`

Before a delete, one JSON object is appended to `<root>/records/work-reclaimed.jsonl` (default
`~/.wheelchair-agent/records/work-reclaimed.jsonl`; `$WHEELCHAIR_AGENT_HOME` moves the root): directory name and absolute path,
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
same defaults and the same shared open-ticket resolver as the CLI, prunes stale workspace records (below), and logs
one summary line plus one line per pruned workspace path:

```
wheelchair-agent work gc: pruned workspace /home/.../work/<ticket>
wheelchair-agent work gc: reclaimed N clones, pruned M workspaces, freed X MB
```

If the registry itself is unavailable, malformed, or points at a symlinked work root, the prune logs one
`workspace prune skipped: <reason>` line instead of silently reporting zero prunes.

## Stale workspace rows

dsh keeps a workspace record after its directory disappears, so the sidebar keeps rendering rows for reclaimed
clones. The mount pass removes such records after the clone pass: a record is deleted only when its canonical path is
a **child of the work root** and the directory is missing. Paths outside the work root (for example the operator's own
`~/bioagentforge`) are never considered; only the registry row is removed, so session ids, session logs and the
directories themselves are untouched, and dsh moves orphaned sessions to "Ungrouped" by itself. A missing, throwing or
malformed registry leaves everything alone, and one failed delete does not stop the others. A symlinked work root is
skipped rather than widening the canonical "child of the root" check.

The prune runs a few seconds after mount if the registry's asynchronous initialization has not finished yet, so it
does not silently miss the rows for the whole process. Like dsh itself, it treats a missing directory as gone: a
workspace whose directory is temporarily unmounted or renamed loses its row (the sessions remain, as "Ungrouped"), so
keep external workspaces mounted while the service starts if their grouping matters.

The CLI has no dsh context and therefore cannot prune workspace records. The stale rows go away at the next service
start, or immediately through dsh's own "Delete workspace" (删除工作区) action.

The root is `settings.executor.directory` from the running deployment. The CLI cannot read the panel settings, so set
`DSH_SUPERAGENT_WORK_DIR` to that directory when it is not `<stateDir>/work`, and `DSH_SUPERAGENT_STATE_DIR` when the
profile moved the state dir. Its management API URL comes from `SPV_SUPERAGENT_URL` (or the service manager's
`DSH_SUPERAGENT_URL`), defaulting to `http://127.0.0.1:3082`; all are shown by `wheelchair-agent work --help`.
