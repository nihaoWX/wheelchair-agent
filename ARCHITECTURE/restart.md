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

## 分册

| 想知道 | 读 |
|---|---|
| 唯一的顺序、每一步为什么不能换、前置守卫 | `ARCHITECTURE/restart/order.md` |
| 同一终端里的叙述者、`--resume` 的目标从哪来 | `ARCHITECTURE/restart/narrator.md` |
| 卡住的会话怎么释放、`kill` 集合与安全规则 | `ARCHITECTURE/restart/lease.md` |
| 升级与 dsh-tui 的交接、为什么脱钩、日志、检查与恢复 | `ARCHITECTURE/restart/operations.md` |

一句话记住顺序：`guard → service stop --all → 停 SPV 会话链 → install.sh --project → service start --all → 把 TUI 拉回来`。
每一对调换都会留下半装状态，或者让叙述者自己被杀掉。
