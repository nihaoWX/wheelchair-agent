# 重启的操作面：升级、脱钩、日志、检查与恢复

> 分册：`ARCHITECTURE/restart.md` 是重启总览；本文的小节编号在本文件内重新编号。

## 1. Upgrading, and dsh-tui's own handoffs

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


## 2. Why the command is detached

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


## 3. The log

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


## 4. Inspect, force, recover

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
