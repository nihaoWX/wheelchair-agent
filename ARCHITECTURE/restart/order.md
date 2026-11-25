# 重启链：唯一的顺序与每一步的道理

> 分册：`ARCHITECTURE/restart.md` 是重启总览；本文的小节编号在本文件内重新编号。

## 1. The order, and why it is the only one

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
