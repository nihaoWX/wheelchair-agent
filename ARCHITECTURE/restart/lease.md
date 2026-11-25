# 会话租约：释放卡住的会话与安全规则

> 分册：`ARCHITECTURE/restart.md` 是重启总览；本文的小节编号在本文件内重新编号。

## 1. Releasing a stuck session

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


## 2. Safety rules

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
