# 同一终端里的叙述者与 `--resume`

> 分册：`ARCHITECTURE/restart.md` 是重启总览；本文的小节编号在本文件内重新编号。

## 1. Same terminal: the narrator

`wheelchair-agent spv` no longer `exec`s the launcher. It runs `sh <launcher> [args...]` as a child with
`stdio: 'inherit'` (so the TUI still owns the terminal, key bindings, signals and its exit status), and
waits. If the child exits and `<stateDir>/restart-armed.json` exists **and its `startedAt` is not older than
this launch** (one second of clock slack; a marker without `startedAt` is accepted for compatibility), the
CLI becomes the narrator. A marker left over from an earlier run is removed best-effort and the child's
normal exit status is returned, so a stale file can never turn a normal exit into a relaunch.

Three files under the state dir coordinate the two processes; there is no other protocol:

| file | writer | contents / purpose |
| --- | --- | --- |
| `restart-armed.json` | `restart-all --detach`, before the spawn | `{pid, armedPid, startedAt, log, logOffset, checkout, tmux, service, sessionId, sessionDir, leaseBlockedPid, force, noInstall}`; `pid` is the detached orchestrator, `logOffset` the log size after the arming lines, `sessionId`/`sessionDir` the session whose lease the relaunch must take, and `leaseBlockedPid` the holder a failed lease wait could not release (`null` until then). The CLI honours `leaseBlockedPid` only when `sessionId` matches the id it is about to resume and that pid is still a live fd holder, so a stale marker cannot force a fresh session |
| `restart-claimed.json` | the narrating CLI, as soon as it sees the marker | `{pid, at}`; tells the orchestrator a terminal owns the relaunch. It counts only while `pid` is alive: if the terminal dies after claiming, the orchestrator logs `note: the terminal that claimed the restart is gone; taking the tmux fallback` and takes tmux (a claim without a pid is accepted for compatibility) |
| `restart-fallback.json` | the orchestrator, immediately before tmux | `{pid, at, tmux}`; marks that tmux owns the relaunch. The narrator keeps tailing and reports the fallback only after a completion, or the failure that follows it |

What the operator sees, in order, between typing `/restart-wheelchair-agent` and the TUI coming back:

```
restart: stopping the service…
step 1/5: wheelchair-agent service stop -> exit 0
step 2/5: SIGTERM 1492054 1492075 1492089 -> sent 3, survivors 0
step 3/5: bash /home/me/bioagentforge/tools/wheelchair-agent/install.sh -> exit 0
step 4/5: wheelchair-agent service start -> exit 0
step 5/5: skipped; the terminal claimed the restart and relaunches the TUI here
restart complete (exit 0)
restart: done; starting the SPV session again…
```

When `~/.dsh-tui/resume.txt` is missing or unusable, one extra line appears before the fresh TUI starts:

```
restart: cannot resume the previous SPV session (no ~/.dsh-tui/resume.txt); starting a fresh one.
```

When the old session's descriptor outlives the process for a moment, the lease wait appears before the
completion and the relaunch still resumes it:

```
restart: waiting for pid 2315989 to release the session…
```

When the descriptor never closes inside the window, the relaunch starts fresh and says why — no `--resume`
is passed, so dsh-tui cannot reject the launch into the safe-mode prompt:

```
restart: the previous session is still mounted by pid 2315989; starting a fresh session
```

The narrator:

- prints `restart: stopping the service…` before it reads the log, so the terminal is never silent after
  the TUI disappears;
- tails the log from the marker's `logOffset` (from 0 if the file is shorter) and echoes each complete new
  line with the `[ISO] ` prefix stripped, keeping the step text and the exit code; partial trailing lines
  wait for the next write. Internal `restart-all:` lines (arming, mode/pid, preflight notes) stay in the
  log and are not echoed, unless they are failures;
- on `restart complete (exit 0)` prints `restart: done; starting the SPV session again…`, clears the three
  files and starts the launcher again **in the same terminal** with the operator's argv minus their session
  flags, plus `--resume <id>` from resume.txt (see “Resuming the SPV conversation”);
- on `restart failed (exit N)`, `install failed`, `restart aborted`, `FAIL: pids … survived SIGKILL`,
  `FAIL: refusing to restart`, `preflight failed`, `FAIL: the arming process … is still alive`,
  `FAIL: tmux session … not present` or `FAIL: could not relaunch`, prints `restart: failed — <line>`, the
  log path and the by-hand recovery, clears the files and exits 1 **without relaunching** into a broken
  deployment;
- treats a dead orchestrator pid (dead for more than a second, with no completion line) as
  `the orchestrator exited without completing` and fails the same way; a marker with no pid at all fails
  after the same short startup grace with `the orchestrator did not start (the restart marker has no pid)`
  instead of waiting for the full timeout;
- stops waiting after `WHEELCHAIR_RESTART_NARRATE_MS` (default 600000ms), prints the log path and
  `fix: <checkout>/install.sh && wheelchair-agent service start && wheelchair-agent spv` (the install part
  is omitted for `--no-install` or when the marker has no checkout), clears the files and exits 1;
- when the orchestrator takes the tmux fallback (`restart-fallback.json`, or a log line saying
  `taking the tmux fallback`), keeps tailing: the appearance of the file is not success. On a later
  `restart complete (exit 0)` it prints `restart: the terminal did not claim the restart; the TUI is in
  tmux session dsh-spv`, `restart: attach with: tmux attach -t =dsh-spv`, the log path, and exits 0 without
  starting a second TUI. A fallback that then fails (for example `FAIL: tmux session … not present`) ends
  the narrator with exit 1 and the failure, not the success message.

### Resuming the SPV conversation

The relaunch must not drop the operator into a fresh conversation — and it must resume **the conversation the
command was typed in**, not whichever conversation a TUI opened most recently. The same-terminal loop and the
tmux fallback therefore take the session id from **two sources, in this order**:

1. **`--session <id>`**, passed by the command plugin from `invocation.agent.session.id` (`CommandInvocation`
   carries `agent`; `agent.session.id` is the invoking Session). It is accepted only when `resolveSession`
   finds that id's directory under the workspace `cwd`; otherwise the CLI prints
   `note: the invoking session <id> has no directory under <sessionsRoot>; using …` and falls through.
2. **`~/.dsh-tui/resume.txt`** (`os.homedir()`, so `HOME` points the tests at a sandbox), the file trimmed and
   validated as a UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`). It is a
   **global last-opened pointer**: it names whichever conversation any terminal opened last, so it is only a
   fallback — reading it as the primary source is exactly what made the restart resume another terminal's
   conversation and signal that terminal's process. When it is used, the CLI logs
   `note: no invoking session id was passed to restart-all; using <source> instead` or the
   `has no directory` note above. Nothing lists session directories or invents an id.

The dry run prints the decision: `session: <id> (<dir>)` and `resume: --resume <id> (invoking session)` or
`(…/~/.dsh-tui/resume.txt fallback)`; a lease holder outside the chain is listed separately as
`other: <pids> (another terminal; not signalled)` and never enters the kill set.

- The operator's own first launch keeps their args untouched. A relaunch we own **strips** `--resume`,
  `--resume=<id>`, `-c` and `--continue` first: an old explicit id can reopen the wrong conversation, and a
  bare `-c` with no usable resume.txt makes dsh-tui exit 1 (with no retry, because that launch did not add
  the flag itself).
- A resolved id makes the relaunch `wheelchair-agent spv --resume <id>`; the tmux fallback becomes
  `node <preset>/cli.js spv --resume <id>`. When neither source yields a usable id the relaunch drops the
  stale operator flag, prints one note and starts fresh.
- Missing (`no ~/.dsh-tui/resume.txt`), unreadable (`~/.dsh-tui/resume.txt is unreadable`) or invalid
  (`~/.dsh-tui/resume.txt does not contain a session id`) prints exactly one
  `restart: cannot resume the previous SPV session (<detail>); starting a fresh one.` line before the fresh
  session starts; it never dead-ends. The tmux path logs the same detail as a note instead.
- If a relaunch **we added `--resume` to** exits non-zero within about 2.5 seconds, dsh-tui rejected the
  resume: the CLI prints
  `restart: the resumed SPV session did not start (dsh-tui exited N); starting a fresh one.` and retries the
  launch once without the flag. The operator's own first start and a normal long-running exit are never
  retried.

A normal TUI exit (no marker) still ends `wheelchair-agent spv` with the child's status. The loop only
continues after a completed marked restart. `WHEELCHAIR_RESTART_CLAIM_MS` (orchestrator grace),
`WHEELCHAIR_RESTART_NARRATE_MS` (narrator timeout) and `WHEELCHAIR_RESTART_LEASE_MS` (the bounded wait for
the session lease, default 15000ms) are the test seams; `WHEELCHAIR_AGENT_LAUNCHER`
lets the offline tests point `spv` at a fake launcher. The launcher/TUI environment is scrubbed of the
armed-chain seams and of that launcher override; it carries `WHEELCHAIR_AGENT_SUPERVISED=1` so the slash
command can tell whether the terminal is watched.
