# Current State

**可用**。两个东西都已跑通并端到端验证：

- **SPV 会话**：`spv` 命令启动，preset `spv`，cwd = `bioagentforge`，工具 `spv_dispatch` / `spv_result` / `spv_status`。
- **superagent**：常驻服务 `:3082`，`runtime/spv/github` 三处 `ready`，`setup.problem=null`。

派活链路：`spv_dispatch` → 文件队列 → superagent Ticket → worker（项目 clone 内执行）→ `outbox` → `spv_result` 取回。

# Completed

- **dsh 锁 `0.2.1-rc.3`**：superagent 的 `engines.dsh` 不满足 `0.2.2-rc.1`；`dsh-tui@0.19.0` 兼容该版本，两 profile 共用同一全局 dsh。见 `docs/setup/dsh-commandcode.md`。
- **superagent 落地**：clone 到 `tools/dsh-superagent/` 构建；profile `superagent`（stateDir、端口 3082、模型 provider 走 commandcode）。`dsh plugin add` 不写 `bundles`，需手动补。
- **GitHub Source**：`nihaoWX/bioagentforge`，CLI `~/.local/bin/gh`，60s 轮询。
- **`spv` Source 插件**（`spv-watch.js` + `src/spv.js`）：文件队列 pending→done（rename 即消费标记，无 cursor）+ outbox；Trigger 满足 explicit 三条件。
- **SPV preset**（`dsh/` → `~/.dsh/.agent-presets/spv/`）：`agent.cordis.yml` 挂 spv 工具 + `tool-fs` + bash + `agent-instructions` + compaction。
- **compaction 组**（`compaction-basic` + `command-compact` + `tool-result-pruner`）：TUI 原先告警「本预设既无压缩也不剪枝工具结果」。加上后 `/compact` 可用、达水位自动压缩，超长工具输出按 8192 字符截断（留头 4096 / 尾 1024）。剪枝器必须与 `compaction-basic` 同 realm（后者用 `ctx.get('toolResultPrune')` 读它）；`token-meter` 刻意留在 host plane，否则浏览器的上下文计量投影会随 preset mount/unmount 来去。
- **SPV 工具**（`spv-tools.js` + `src/{dispatch,outbox,paths}.js`）：`spv_dispatch` / `spv_result` / `spv_status`。`actor` 写死 `operator`，不接受参数。
- **`superagent-service.py`**：服务启停，不依赖进程名。原先上游脚本用 `ps -o ucomm=` 取进程名，WSL2 上 node 报 `MainThread`，于是 `status` 报 `pids: []`、`restart` 说「已在运行」却不重启、`stop` 停不掉。改为用监听套接字（`ss -lptnH 'sport = :<port>'`）+ `/proc/<pid>/cmdline` 扫 `--profile`，两者都是运行时事实。日志固定写 `$DSH_HOME/.artifacts/<profile>.log`（无 `--log` 时），避免随 cwd 散落。
- **`install.sh`**：装 preset + 启动器 + 服务管理命令，白名单拷贝、原子替换、幂等、`--check` 只读自检。
- **`tools/` 拆分 21 个独立仓库**：10 个 `git subtree split` 保留历史（tree 哈希逐一比对），9 个新建，2 个原有。零失败、零文件丢失。
- **端到端验证**：`spv_dispatch` 投递 → ack → worker 在项目 clone 内执行 → reply "已完成：…"，全程无残留。
- **防冒充验证**：superagent 源码与其 `cordis.patch.yml` 中均无 `spv_*`；两个 superagent preset 都不含 `spv-tools`。
- **install 四项验收**：首次装、重跑幂等（`up to date`）、改源后 `--check` = exit 2、还原后 = exit 0、已装目录无开发侧文件。

# In Progress

（无）

# Known Issues

- **主会话固化第一次的 model 路由**：`initializeRoleModel` 不覆盖已有 `model/selection`。换 provider 后需删 `~/.dsh/sessions/--home-nihao-.dsh-state-superagent--/orchestrator-*` 与对应 `session_projcache`。
- **`dsh-tui update` 会把 dsh 升回 `0.2.2-rc.1`**，superagent 加载失败。需手动降回并带 `--allow-scripts`。
- **worker 的目录约束靠自觉**：prompt 未限制它只能在 ticket 目录内改动，冒烟测试时它曾 `find /home/nihao` 找到真实项目路径。
- **压缩时机仍未解决**：需要「已用 20% + 小阶段完成」的判断，要模型介入。
- **`spv` Source 的 `scope()` 未实现**：默认接收自己产生的全部 Trigger，够用于 explicit。
- **额度共享**：Eval + worker 都走 GOAT，与 cmd CLI 共用 5 小时 $20 / 每周 $50 窗口；`maxWorkers=2`。
- 每个拆出的子仓库用 `.git/info/exclude` 复制忽略规则，不改项目内 `.gitignore`。
- `tools/svg_grid/docs/PITFALLS/round-data/R22/meta.toml` 有一处 11-07 既有未提交修改，未触碰。

# 长任务

worker 的回合结束后，它留下的 shell job 最多再跑 30 分钟就被杀（`src/executor/dsh.ts` 的
`BACKGROUND_LIMIT_MS`），所以长时间分析不能留在 worker 会话里。

`jobctl` 把作业交给 systemd 的 user manager 持有：

```bash
jobctl submit --name md-001 --project research/xxx --thread md-001 \
              --next "读 results/md.log，分析稳定性并写报告" -- ./run_md.sh
jobctl status [unit...]
jobctl log md-001
jobctl verify --ticket <id>     # 机械证伪「worker 说它提交了」
jobctl cancel md-001
```

**下一阶段的触发器是作业自己的结束事件**，不是 worker 的自觉、不是全局 goal 状态、也不是定时轮询：
`ExecStopPost` 由 systemd 在 unit 停下时执行，写一条任务到 spv 队列。整个交接没有任何 agent 参与，
所以 worker 忘记、会话关闭、agent 重启都不影响它。

`jobctl` 自己记 `~/.local/state/jobctl/ledger.jsonl`，因为 `--collect` 会让结束的 unit 从 systemd 消失；
`verify` 同时查 systemd（机械事实）与账本（跨越 collect）。

## `/spv-cron`

每小时给 SPV 递一份简报（斜杠命令，模型与 worker 都碰不到）：

```
/spv-cron              # 开启，默认 60 分钟
/spv-cron every 30     # 改频率（5–1440）
/spv-cron status
/spv-cron off
```

两档简报：
- **无异常** → 轻推「推进用户任务」，不报警
- **有异常** → 点名具体的失败/停住的 unit，要求派子 agent 用 `jobctl status` / `log` 检查

因此「worker 压根没把作业挂上去」这种情况，顶多一小时内会被发现。

# Next Steps

1. 在真实 SPV 会话里跑一次完整任务（`spv` 启动 → 派活 → `spv_result`），观察 token 消耗。
2. 收紧 worker 的目录约束（prompt 层或项目 `AGENTS.md`）。
3. 视消耗决定是否给 worker 换更便宜的模型。
4. 稳定后再考虑 `observe` → `auto`。

日常命令：

```bash
superagent-service start     # 起后端（幂等；已在跑则直接报告）
superagent-service status    # exit 0 正常 / 1 未跑或异常 / 2 组件报错 / 3 等 setup
superagent-service restart   # 改过 spv Source 或 provider 配置后
superagent-service open      # 在浏览器打开带 token 的面板（token 每次启动都变，别复制旧的）
spv                          # 起 SPV 会话（会自动拉起后端）
```

**面板的 token 每次启动都变**，且 `dsh web` 没有固定 token 的开关。裸 `url:` 打开只会得到
`dsh web authentication required`。用 `superagent-service open`，或从 `status` 的 `panel:` 行取当前地址。
