# Restarting the deployment (`restart-all`)

`wheelchair-agent restart-all` restarts everything this deployment runs: the superagent service, a cold
install of the preset, and the SPV TUI session. `/restart-wheelchair-agent` in an SPV session does the
same thing through the detached path. The point of one command is the **order**; doing those three things
by hand in the wrong order either hits the cold-install guard or leaves a half-installed deployment.

## The order, and why it is the only one

```
guard -> service stop -> stop the SPV chain -> install.sh -> service start -> relaunch the TUI
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
3. **Stop the SPV chain.** The chain is the `/proc`-identified set of processes carrying
   `--patch <preset>/preset-default.patch.yml` — the wrapper, `dsh-tui`, and its `dsh` child. SIGTERM
   each, wait up to 10s, SIGKILL survivors, wait up to 5s. The kill set is the chain minus this process,
   its ancestors and the service: those three are never signalled. If the chain cannot be identified, the
   command aborts **before** stopping anything, because a stopped service with no way to relaunch the TUI
   is the failure the operator would feel most.
4. **Cold install** (`bash <checkout>/install.sh`). If it fails, the restart aborts and the service is left
   stopped **on purpose**: a half-installed deployment that still answers is worse than one that is
   visibly down. `--no-install` skips this step and restarts only the service and the TUI.
5. **Start the service** back. If this fails, the TUI is still relaunched because its launcher retries the
   service and reports it; the command exits 1.
6. **Relaunch the TUI in tmux session `dsh-spv`.** The orchestrator cannot put a TUI back on the
   operator's terminal after that terminal's session is gone, so it starts one in tmux and says so.
   It uses `tmux new-window` when the session already exists and `tmux new-session -d` otherwise. The launch
   is an absolute `node <presetDir>/cli.js spv` argv, using the **installed preset** CLI (after the cold
   install, the newly installed one), because the tmux server has its own `PATH` (it may have been started
   from another shell) and a checkout CLI's `spv` command would run the checkout's unrendered
   `preset/spv-launcher.sh` template instead of the installed launcher. The invoking CLI is only a fallback
   when the preset has no `cli.js`. `tmux new-session -d` exits 0 even when the command in the new pane dies
   immediately, so the orchestrator then polls `tmux has-session -t =dsh-spv` for up to two seconds; an
   absent session marks the step failed and the restart exits 1.

## Why the command is detached

When `/restart-wheelchair-agent` runs, it is itself inside the SPV session that has to die. A process
cannot gracefully stop its own ancestors and then restart itself, so the slash command is thin: it runs the
CLI's guard, arms a detached orchestrator (`restart-all --detach`), prints where the TUI will come back and
where the log is, and tells the operator the session is about to end. It does not claim to have restarted
anything itself.

The armed child runs `restart-all --run` in its own process group (`detached: true`), so the session's
SIGTERM does not reach it. It first waits until its parent link to the arming process is gone, then re-runs
the guard and the ancestor check (which is now meaningful), and performs the steps. If that wait times out
it logs and exits without mutating anything.

## The log

Every run appends to `<root>/logs/restart-all.log` (default
`~/.wheelchair-agent/logs/restart-all.log`; `$WHEELCHAIR_AGENT_HOME` moves the root), one
`[ISO timestamp] text` line per entry. A pre-upgrade `~/.dsh/state/superagent/restart-all.log` is
moved there once, and the old path stays readable if that move fails:

```
[2026-11-15T12:00:00.000Z] step 1/5: wheelchair-agent service stop -> exit 0
[2026-11-15T12:00:00.400Z] step 2/5: SIGTERM 1492054 1492075 1492089 -> sent 3, survivors 0
[2026-11-15T12:00:01.100Z] step 3/5: bash /home/me/bioagentforge/tools/wheelchair-agent/install.sh -> exit 0
[2026-11-15T12:00:02.000Z] step 4/5: wheelchair-agent service start -> exit 0
[2026-11-15T12:00:02.500Z] step 5/5: tmux new-session ... -> exit 0
[2026-11-15T12:00:02.500Z] restart complete (exit 0)
```

The start line records the mode, `--force`/`--no-install`, the chain and the service pids; the end line
records the exit code. The log is append-only and is the audit trail when the operator's console has
already gone away. `--dry-run` creates no log and runs no command.

## Safety rules

- The kill set is exactly the `/proc` chain identified by `--patch <preset>/preset-default.patch.yml`;
  never the orchestrator's own pid, its ancestors, or the service.
- In the detached child the armed chain is re-verified against `/proc` right before mutation: every pid must
  still carry the same `--patch`, or the command fails with "the armed SPV chain is stale or changed" and
  stops nothing. This guards against pid reuse and a stale environment.
- Nothing is signalled when the guard refused, when the chain is empty, when the checkout or `tmux` is
  missing, or when the orchestrator is still a descendant of the session.
- The install gate is never bypassed: `install.sh` runs only after both holders are gone, and its exit code
  decides whether the service is started again.
- A child of the shell, not a shell: every command is `spawnSync` with an argv array, so pids and paths
  cannot be reinterpreted by a shell.

## Inspect, force, recover

```bash
wheelchair-agent restart-all --dry-run         # plan: service pid, SPV pids, checkout, log, every command
wheelchair-agent restart-all --dry-run --force # same plan while workers are running
wheelchair-agent restart-all                   # do it in the foreground (not from inside the SPV session)
wheelchair-agent restart-all --detach          # what the slash command uses
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

The log path is printed when the command starts and the failing exit code is on the console when it still
exists; in the detached case the log is the only record.
