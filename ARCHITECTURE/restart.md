# Restarting deployments (`restart-all`, `/restart-wheelchair-agent`)

Since `#48` there is no bare `restart-all`: a restart always names its scope.

- `restart-all --project <p>` (what `/restart-wheelchair-agent` runs, with `<p>` resolved from the instance's
  `SPV_QUEUE_DIR`) restarts **one** deployment's instance and resumes that deployment's session. It does **not**
  run `install.sh`: the preset, webui, CLI and core are installed once for every deployment, so the install is a
  separate, machine-level step. The implementation is `src/spv/deployment-restart.js`, not this file.
- `restart-all --all` is the whole-machine cycle documented here: stop **every** registered instance, stop the
  SPV chain, run **one** `install.sh --project <installProject>`, start every instance back, bring the TUI back.
  `installProject` comes from the checkout being installed (its git origin or its path under `<projectsRoot>`);
  when neither identifies a deployment it must be passed explicitly. `--all --dry-run` needs `--detach` to print
  its plan from inside the SPV session, because the foreground form is refused by the ancestor guard.

`wheelchair-agent restart-all --all` therefore restarts everything a machine runs: the superagent instances, a
cold install of the preset, and the SPV TUI. `/restart-wheelchair-agent` does the per-deployment half through the
detached path, and `/restart-wheelchair-agent --all` arms this one. The point of one command is the **order**;
doing those three things by hand in the wrong order either hits the cold-install guard or leaves a
half-installed deployment.

The TUI comes back in the terminal that launched `wheelchair-agent spv`: that process survives the restart,
narrates every step and starts the launcher again there, resumed into the same SPV conversation when
`~/.dsh-tui/resume.txt` names one. tmux session `dsh-spv` is only the **fallback** for a terminal that is
gone (closed, or the CLI died with it), and it resumes the same way.

## The order, and why it is the only one

```
guard -> service stop -> stop the SPV chain -> install.sh -> service start -> bring the TUI back
```

`install.sh` is cold-install-only (PR #14): before writing anything it probes `/proc` for the service
(`--profile superagent`) and for a live SPV session (`--patch <preset>/preset-default.patch.yml`) and
refuses with exit 3 while either is alive. The restart never bypasses that guard; it makes the guard pass
by stopping both holders first:

1. **Guard the service's load.** `GET <url>/orchestrator/api/state` with `x-orchestrator-request: 1`.
   The three answers are treated differently:
   - **unreachable** (connection refused, timeout, reset, truncated body): nothing answers, so nothing can be
     working; the guard counts it as idle;
   - **answered but unreadable** (HTTP >= 400, a non-JSON body, or JSON without `load`): the service is alive
     and may be running work whose size cannot be read, so this **refuses** unless `--force`; `--force` prints
     that the amount of running work is unknown and proceeds;
   - **readable**: the counts are authoritative; `running > 0` or `queued > 0` refuses and names the work.

   `--force` also overrides a counted refusal and prints exactly what it is interrupting (running worker
   Sessions and queued tickets) before anything is stopped.
2. **Stop the service** (`wheelchair-agent service stop`). If this fails, abort without touching the TUI.
3. **Stop the SPV chain.** First, after the service stop and before the kill, a **stale `dsh-spv` tmux
   session** is closed: when tmux is available and `tmux has-session -t =dsh-spv` succeeds, the orchestrator
   runs `tmux kill-session -t =dsh-spv` and logs
   `note: closed the stale tmux session dsh-spv before the restart`. A failure only warns
   (`note: could not close the stale tmux session dsh-spv: …`) and never aborts. It is a `note:`, not a
   numbered step, so the plan keeps five steps. Safety: when this CLI itself runs inside `dsh-spv` (env
   `TMUX` and the name tmux reports), the session is not killed; the log says so instead.
   The chain is the `/proc`-identified set of processes carrying
   `--patch <preset>/preset-default.patch.yml` — the wrapper, `dsh-tui`, and its `dsh` child — **plus every
   live process that holds an open descriptor on the session's kernel lease** (`<session dir>/session.lock`
   or `<session dir>/session.v4.jsonl.zstd`, found through `/proc/<pid>/fd`). A holder named only by its
   file descriptor does not have to carry the patch. SIGTERM each, wait up to 10s, SIGKILL survivors, wait
   up to 5s. The kill set is that union minus this process, its ancestors and the service: those three are
   never signalled. If the chain cannot be identified, the command aborts **before** stopping anything,
   because a stopped service with no way to relaunch the TUI is the failure the operator would feel most.
   After the kill the orchestrator waits up to `WHEELCHAIR_RESTART_LEASE_MS` (default 15000ms; the offline
   tests lower it) for the descriptors to close, printing
   `restart: waiting for pid <pid> to release the session…` for each holder. Only then may the relaunch use
   `--resume`. A lease that cannot be freed inside the window is recorded in the marker as
   `leaseBlockedPid`, and the relaunch starts **without** `--resume`, printing one line:
   `restart: the previous session is still mounted by pid <pid>; starting a fresh session`. That is the fix
   for the resumed TUI dying with "it is mounted by another TUI terminal" and dropping the operator into
   the interactive safe-mode prompt.
4. **Cold install** (`bash <checkout>/install.sh`). If it fails, the restart aborts and the service is left
   stopped **on purpose**: a half-installed deployment that still answers is worse than one that is
   visibly down. `--no-install` skips this step and restarts only the service and the TUI.
5. **Start the service** back. If this fails, the restart fails and **no TUI is relaunched**: a fresh TUI
   against a dead service would only hide the failure and show a backend-less session. The log says the
   TUI was not relaunched and names the fix (`fix the service and run "wheelchair-agent spv"`); the
   command exits 1.
6. **Bring the TUI back.** The default is the terminal that launched `wheelchair-agent spv` (see “Same
   terminal: the narrator”); it resumes the conversation **this command was typed in** — the invoking
   Session's id reaches the CLI as `--session`, and only when that id is unavailable does it fall back to
   `~/.dsh-tui/resume.txt` (see “Resuming the SPV conversation”). **Every launch
   that uses `--resume` waits for the session lease first** — the in-place relaunch does it in the CLI loop
   before starting the launcher, and the tmux fallback's first `spv --resume <id>` launch does the same in
   the CLI it starts. The wait is bounded by `WHEELCHAIR_RESTART_LEASE_MS` (default 15000ms), prints
   `restart: waiting for pid <pid> to release the session…`, and on timeout drops `--resume`, prints
   `restart: the previous session is still mounted by pid <pid>; starting a fresh session`, and starts
   fresh. A holder **outside the restart chain** — another terminal's TUI — is never signalled:
   `releaseSession` filters holders through `holderInRestartChain` (`/proc` ancestry against the chain pids),
   waits the same bounded window, and then prints
   `restart: session <id> is occupied by another terminal (pid <pid>); not preempted; this launch is a new
   session` and starts fresh. Only an explicit `session release` (which passes no chain) still releases every
   non-service holder. An ordinary launch without a resume id never waits. After steps 1-4
   the orchestrator waits up to `WHEELCHAIR_RESTART_CLAIM_MS` (default 5000ms) for that terminal to claim
   the restart. When the claim arrives it records
   `step 5/5: skipped; the terminal claimed the restart and relaunches the TUI here` and stops; it does
   **not** launch tmux. When no claim arrives, the terminal is gone, so the orchestrator writes
   `<stateDir>/restart-fallback.json`, records `note: no terminal claim within <ms>ms; taking the tmux
   fallback`, and launches tmux as before: `tmux new-window` when session `dsh-spv` exists,
   `tmux new-session -d` otherwise. The launch is an absolute `node <presetDir>/cli.js spv` argv, using the
   **installed preset** CLI (after the cold install, the newly installed one), because the tmux server has
   its own `PATH` (it may have been started from another shell) and a checkout CLI's `spv` command would run
   the checkout's unrendered `preset/spv-launcher.sh` template instead of the installed launcher. The
   invoking CLI is only a fallback when the preset has no `cli.js`. The fallback launch carries
   `--resume <id>` when the restart resolved a session id **and the lease is free**; when the
   earlier wait failed (the marker's `leaseBlockedPid`, or a holder still present at this point) it launches
   without `--resume` and logs `note: the tmux fallback starts without --resume`; when resume.txt itself is
   unusable it logs
   `note: cannot resume the previous SPV session (…); the tmux fallback starts a fresh SPV session` and
   launches without it. `tmux new-session -d` exits 0 even when the command in the new pane dies
   immediately, so the orchestrator then polls `tmux has-session -t =dsh-spv` for up to two seconds; an
   absent session marks the step failed and the restart exits 1. tmux is optional: when it is missing the
   preflight only notes that the fallback is unavailable; a claimed restart still succeeds, and an
   unclaimed one logs `FAIL: tmux is not on PATH; the fallback TUI was not started` plus
   `restart failed (exit 1)` instead of relaunching.

## Same terminal: the narrator

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

## Releasing a stuck session

The lease is a kernel fact, not a command line: a process holds it while it has an open descriptor on
`<session dir>/session.lock` or `<session dir>/session.v4.jsonl.zstd`. `restart-all` names those holders by
scanning `/proc/<pid>/fd` (exact paths, live processes only) and waits for them; the same scan is available
by hand when a terminal is gone but its session still says "mounted by another TUI terminal":

```bash
wheelchair-agent session release --dry-run                  # resume.txt's session, else newest workspace session
wheelchair-agent session release --session <id> --dry-run
wheelchair-agent session release --session <id>
```

`--dry-run` prints the session directory and every holder as `pid <pid>  <cmdline>`, and sends no signal. A
holder that is the superagent service is marked `(superagent service; not released)` and the dry run says
the release would refuse; this process and its ancestors are marked `(this process or an ancestor; not
signalled)`. Without `--dry-run` the command skips this process and its ancestors with one note (they are the
CLI and its terminal), SIGTERMs the rest, prints `sent SIGTERM to pid <pid>`, waits, prints
`sent SIGKILL to pid <pid>` for survivors, and finally `released session <id>`. These cases refuse rather
than signalling or claiming success:

- **The service holds the session.** The superagent service is never ours to stop, and skipping it would
  leave the lease held, so the whole release is refused before any signal:

  ```
  FAIL: the session is held by the superagent service (pid <pid>); refusing to release it
  fix: stop the superagent service first (wheelchair-agent service stop), or pass --session <the TUI session id>
  ```

- **A skipped self/ancestor holder still holds it after the others are gone.** The lease was not freed, so
  the command fails instead of printing `released session`:

  ```
  FAIL: pid <pid> still holds the session and was not signalled
  ```

- **Every holder is this process or an ancestor.** Killing them would kill the CLI itself and would not free
  the lease:

  ```
  FAIL: the only holder(s) are this process or its ancestor chain; refusing to kill them
  ```

A holder that survives SIGKILL is a `FAIL` and exit 1. The wait is bounded by
`WHEELCHAIR_RESTART_LEASE_MS` (default 15000ms) with **one shared deadline** across the TERM and KILL
phases. Because the operator specified the kill set as `session.lock` **or** `session.v4.jsonl.zstd`, a
process holding only the log (a read-only `zstdcat`/export) remains in the kill set; the lease wait and
`session release`'s success condition only require `session.lock`, so such a reader cannot block a relaunch.
If an export must not be interrupted, copy/read the log from a stopped session. The session is the one
named by `--session`; without it,
the id in `~/.dsh-tui/resume.txt` is resolved exactly as `restart-all` does (this workspace first, then any
project directory), because that is the operator's SPV conversation. If resume.txt names an id whose
directory cannot be found, the command fails rather than targeting another session; only when resume.txt is
absent, invalid or unreadable does it fall back to the newest session directory of the current workspace. The
root is `DSH_TUI_SESSION_ROOT` or `DSH_HOME/sessions`, and the project directory is dsh's own `projectKey(cwd)`
(for example `/home/nihao/bioagentforge` -> `--home-nihao-bioagentforge--`). If dsh-tui still refuses, a
resume is not possible without terminating that pid; use `--session <id>` from the error message and read the
dry run before sending the signal.

## Upgrading, and dsh-tui's own handoffs

The in-place return only works when the terminal is supervised by a `wheelchair-agent spv` from this
version. **One-time rollout:** a session started before the narrator existed has no supervising CLI, so its
first restart after the upgrade necessarily comes back in tmux `dsh-spv`; the arm output says so. After that
restart, start a fresh `wheelchair-agent spv` in a terminal and the in-place return applies from then on.

Some dsh-tui commands end the supervising CLI themselves (`/update`, `/restart`, and the `/backend`
handoff). The TUI comes back in that terminal, but the narrator is gone until you run
`wheelchair-agent spv` there again. Until you do, a later `/restart-wheelchair-agent` has no terminal to
claim the restart and falls back to tmux.

Do **not** pass `--patch` to `wheelchair-agent spv`: the CLI itself would then carry the preset patch, so
the `/proc` chain includes the supervising process, the restart signals it, and the in-place return is
forfeited (only the tmux fallback remains). Use the installed launcher's default patch.

## Why the command is detached

When `/restart-wheelchair-agent` runs, it is itself inside the SPV session that has to die. A process
cannot gracefully stop its own ancestors and then restart itself, so the slash command is thin: it runs the
CLI's guard, arms a detached orchestrator (`restart-all --detach`), prints where the TUI comes back and
where the log is, and tells the operator the session is about to end while the terminal stays open. It does
not claim to have restarted anything itself.

The armed child runs `restart-all --run` in its own process group (`detached: true`), so the session's
SIGTERM does not reach it. It first waits until its parent link to the arming process is gone, then re-runs
the guard and the ancestor check (which is now meaningful), and performs the steps. If that wait times out
it logs and exits without mutating anything. The `spv` CLI is normally not in the kill chain (`/proc`
identifies the chain by `--patch`, which only the launcher/dsh processes carry), so it survives and can
narrate. Passing `--patch` to `wheelchair-agent spv` breaks that: the CLI carries the patch, is included in
the chain, and is signalled with it — the in-place narrator is then lost.

`WHEELCHAIR_RESTART_CHAIN` and `WHEELCHAIR_RESTART_PRESET_PATCH` are private to that armed child: only
`--run` reads them, and only to re-verify the armed chain against `/proc`. The chain variable carries the
patch-carrying pids **only**; an fd holder seen at arm time is not put there (it may exit before `--run`),
and `--run` rescans the current holders itself. A dry run, a foreground run and
the arming preflight always use the CLI's preset patch and scan `/proc` themselves, so a stale value leaked
into a shell cannot displace the real chain. The orchestrator also strips those private variables (chain,
parent pid, preset patch and session dir) from every service/install/tmux child it starts.

## The log

Every run appends to `<root>/logs/restart-all.log` (default
`~/.wheelchair-agent/logs/restart-all.log`; `$WHEELCHAIR_AGENT_HOME` moves the root), one
`[ISO timestamp] text` line per entry. A pre-upgrade `~/.dsh/state/superagent/restart-all.log` is
moved there once, and the old path stays readable if that move fails:

```
[2026-11-15T12:00:00.000Z] restart-all: pid 1492000, mode detached, force=no, install=yes, chain 1492054 1492075 1492089, service 1491900
[2026-11-15T12:00:00.400Z] step 1/5: wheelchair-agent service stop -> exit 0
[2026-11-15T12:00:00.600Z] step 2/5: SIGTERM 1492054 1492075 1492089 -> sent 3, survivors 0
[2026-11-15T12:00:00.700Z] restart: waiting for pid 1492089 to release the session…
[2026-11-15T12:00:01.100Z] step 3/5: bash /home/me/bioagentforge/tools/wheelchair-agent/install.sh -> exit 0
[2026-11-15T12:00:02.000Z] step 4/5: wheelchair-agent service start -> exit 0
[2026-11-15T12:00:02.100Z] step 5/5: skipped; the terminal claimed the restart and relaunches the TUI here
[2026-11-15T12:00:02.100Z] restart complete (exit 0)
```

The start line records the mode, `--force`/`--no-install`, the chain and the service pids; the end line
records the exit code. The log is append-only and is the audit trail when the operator's console has
already gone away. `--dry-run` creates no log and runs no command; the marker is written only after
preflight passes, and never on a guard refusal.

## Safety rules

- The kill set is the `/proc` chain identified by `--patch <preset>/preset-default.patch.yml` plus every
  live `/proc/<pid>/fd` holder of the session's `session.lock` / `session.v4.jsonl.zstd`; never the
  orchestrator's own pid, its ancestors, or the service.
- In the detached child the armed chain is re-verified against `/proc` right before mutation: every pid must
  still carry the same `--patch` **or** be a current fd holder of the marker's session dir, or the command
  fails with "the armed SPV chain is stale or changed" and stops nothing. This guards against pid reuse and
  a stale environment.
- Nothing is signalled when the guard refused, when the chain is empty, when the checkout or `tmux` is
  missing, or when the orchestrator is still a descendant of the session.
- The install gate is never bypassed: `install.sh` runs only after both holders are gone, the chain is
  dead, and the session lease wait has ended, and its exit code decides whether the service is started
  again.
- A relaunch that uses `--resume` first waits for the lease and drops the flag when it cannot be freed; the
  safe-mode prompt is never reached by our launch. The `session release` command refuses to signal when
  every holder is the caller or its ancestor chain.
- A failed install or a service that does not start leaves the service stopped and **relaunches nothing**;
  the narrator reports the failure and exits 1.
- The marker/claim/fallback handshake prevents a double TUI: the orchestrator skips tmux when the terminal
  claims, and the narrator skips its relaunch when the fallback file (or log line) says tmux took over. A
  stale marker is cleared at the start of every `wheelchair-agent spv`, so it can never turn a normal exit
  into a relaunch.
- A child of the shell, not a shell: every command is `spawnSync` with an argv array, so pids and paths
  cannot be reinterpreted by a shell.

## Inspect, force, recover

```bash
wheelchair-agent restart-all --dry-run         # plan: service pid, SPV pids, session lease holders, every command
wheelchair-agent restart-all --dry-run --force # same plan while workers are running
wheelchair-agent restart-all                   # do it in the foreground (not from inside the SPV session)
wheelchair-agent restart-all --detach          # what the slash command uses
wheelchair-agent session release --dry-run     # resume.txt's session, else newest workspace: list the lease holders
wheelchair-agent session release --session <id> # terminate the holders and wait for the lease to be free
```

Run from inside the SPV session, the foreground form refuses: "the orchestrator is still a descendant of
the SPV session it must replace". Use `--detach` (or `/restart-wheelchair-agent`) there.

If the install step failed, the service is stopped and the log names the failing command and the last lines
of `install.sh`'s output. An exit 3 is the cold-install guard refusing because a holder is still alive;
nothing was installed and the service is left stopped. **Do not rerun `restart-all --force` here**: after
the SPV chain is dead there is no live session for it to identify, so it refuses before touching anything.
Recover by hand, in the order the guard accepts:

```bash
bash <checkout>/install.sh && wheelchair-agent service start && wheelchair-agent spv
```

If the service did not start after a successful install, the terminal keeps its shell: fix the service,
then `wheelchair-agent service start && wheelchair-agent spv`. If the narrator times out, it prints the
same log path and recovery command before exiting 1; nothing is relaunched for you.

The log path is printed when the command starts and by the narrator on every failure; in the tmux fallback
case the log is the only record.
