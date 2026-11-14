# Current State

**可用**：SPV 会话与 superagent 服务都已跑通并端到端验证。派活链路
`spv_dispatch` → 文件队列 → superagent Ticket → worker（项目 clone 内执行）→ `outbox` → `spv_result` 取回。

- **SPV 会话**：`spv` 命令启动（会自动拉起后端），preset `spv`，cwd = `bioagentforge`，
  工具 `spv_dispatch` / `spv_result` / `spv_status`，斜杠命令 `/spv-cron`。
- **superagent**：常驻服务 `:3082`，`runtime / spv / github` 三处 `ready`，`setup.problem=null`。

**入口**：`wheelchair-agent` 是唯一命令入口（`spv` / `prepare` / `service` / `jobctl` / `dispatch` /
`result` / `status` / `check`），`spv`、`superagent-service`、`jobctl` 保留为它的兼容名。
`src/` 已按 `shared/` `superagent/` `spv/` 三分，三条边界规则由 `tests/test-layout.sh` 机械断言。

# Completed

- **dsh 锁 `0.2.1-rc.3`**：superagent 的 `engines.dsh` 不满足 `0.2.2-rc.1`；`dsh-tui@0.19.0`
  兼容该版本，两 profile 共用同一全局 dsh。见 `docs/setup/dsh-commandcode.md`。
- **superagent 落地**：clone 到 `tools/dsh-superagent/` 构建；profile `superagent`（stateDir、
  端口 3082、模型 provider 走 commandcode）。`dsh plugin add` 不写 `bundles`，需手动补。
- **GitHub Source**：`nihaoWX/bioagentforge`，CLI `~/.local/bin/gh`，60s 轮询。
- **`spv` Source 插件**（`spv-watch.js` + `src/spv.js`）：文件队列 pending→done（rename 即消费
  标记，无 cursor）+ outbox；Trigger 满足 explicit 三条件。
- **SPV preset**（`preset/` → `~/.dsh/.agent-presets/spv/`）：`agent.cordis.yml` 挂 spv 工具 +
  `tool-fs` + bash + `agent-instructions` + compaction + `/spv-cron`。
- **compaction 组**（`compaction-basic` + `command-compact` + `tool-result-pruner`）：TUI 原先
  告警「本预设既无压缩也不剪枝工具结果」。加上后 `/compact` 可用、达水位自动压缩，超长工具输出
  按 8192 字符截断（留头 4096 / 尾 1024）。剪枝器必须与 `compaction-basic` 同 realm（后者用
  `ctx.get('toolResultPrune')` 读它）；`token-meter` 刻意留在 host plane，否则浏览器的上下文
  计量投影会随 preset mount/unmount 来去。
- **SPV 工具**（`spv-tools.js` + `src/{dispatch,outbox,paths,health}.js`）：`spv_dispatch` /
  `spv_result` / `spv_status`。`actor` 写死 `operator`，不接受参数。
  `spv_dispatch` 派活前探健康端点——队列目录在服务停止后仍然存在，只查目录会让任务写进没人读的地方。
- **`superagent-service.py`**：服务启停，不依赖进程名。原先上游脚本用 `ps -o ucomm=` 取进程名，
  WSL2 上 node 报 `MainThread`，于是 `status` 报 `pids: []`、`restart` 说「已在运行」却不重启、
  `stop` 停不掉。改为用监听套接字（`ss -lptnH 'sport = :<port>'`）+ `/proc/<pid>/cmdline` 扫
  `--profile`。日志固定写 `$DSH_HOME/.artifacts/<profile>.log`。`open` 子命令从日志取当前 token
  并调浏览器（WSL 下走 Windows 的 `Start-Process`）。
- **`jobctl`**：长任务交给 systemd user manager 持有。`submit` 用 `ExecStopPost` 让 systemd 在
  unit 停下时写一条任务进 spv 队列，所以下一阶段的触发器是作业自己的结束事件。
- **`/spv-cron`**：每小时递简报的斜杠命令。
- **`install.sh`**：装 preset + `wheelchair-agent` CLI 薄壳 + `spv` / `superagent-service` / `jobctl`
  三个兼容名，白名单拷贝、原子替换、幂等、`--check` 只读自检（含**服务进程**的 PATH 校验）。
- **`tools/` 拆分 21 个独立仓库**：10 个 `git subtree split` 保留历史（tree 哈希逐一比对），
  9 个新建，2 个原有。零失败、零文件丢失。
- **端到端验证**：`spv_dispatch` 投递 → ack → worker 在项目 clone 内执行 → reply "已完成：…"。
- **防冒充验证**：superagent 源码与其 `cordis.patch.yml` 中均无 `spv_*`；两个 superagent preset
  都不含 `spv-tools`。
- **install 验收**：首次装、重跑幂等（`up to date`）、改源后 `--check` = exit 2、还原后 = exit 0、
  已装目录无开发侧文件。
- **交付目标随项目走**（2026-11-14，PR #1 待合并）：`install.sh` 把 `commands/prepare.sh` 与两份
  `AGENTS.md` 模板装进 preset 目录；`prepare.sh` 做 clone → 受管 `AGENTS.md`（缺则加、旧则覆盖）
  → `tools/` 私有远端与工单 `origin`；`research/` 永不配远端。`tests/test-prepare.sh` 77 条断言全过。
- **HARNESS 按架构拆分**（2026-11-14）：`ARCHITECTURE/` 从空目录变成三份分册
  （`decisions.md` / `layout.md` / `cli.md`），`ARCHITECTURE.md` 收缩为概览 + 索引。
- **CLI 化 + 目录重组**（2026-11-14，PR #2）：`bin/wheelchair-agent.mjs` 十个入口；`src/` 三分
  `shared/` `superagent/` `spv/`；`dsh/` → `preset/`、`scripts/` → `commands/` + `build/` + `tests/`；
  删 `index.js` 与两个 Python 队列脚本（队列格式从两份实现变一份）；`install.sh` 装 CLI 薄壳并读
  `/proc/<pid>/environ` 验证服务进程的 PATH；`tests/test-layout.sh` 机械断言三条边界规则。

# In Progress

- **CLI 化 + 目录重组**（PR #2，`agent/cli-restructure`）：实现完成、9 项验证全过，等合并。
  见 `ARCHITECTURE/layout.md`、`ARCHITECTURE/cli.md`。

# Known Issues

- **PR #1 未合并**（`https://github.com/nihaoWX/wheelchair-agent/pull/1`）：`mergeable: MERGEABLE`，
  分支 `agent/delivery-target-prepare-42ac195d0dc6`，+832/-32，7 文件。没有 merge CLI，需要人合。
  **风险**：面板已经指向已安装的 `prepare.sh`，但 `main` 里没有 `commands/prepare.sh`——谁从 `main`
  重跑 `install.sh`，preset 就会丢掉 `prepare.sh`，每个工单的 prepare 都失败。PR #2 的分支包含 PR #1
  的全部内容，合并 PR #2 即消掉这个风险。
- **探针仓 `nihaoWX/zzz-prepare-probe` 未删**（空、私有）：`gh repo delete` 需要 `delete_repo` scope，
  `gh auth refresh` 要操作者在浏览器里走 device code。
- **`docs/PITFALLS/` 里没有待处理报告**：R1/R2 已消费入账（`R1-F1` / `R2-F1`，裁决见 `R3-F1` /
  `R3-F2`），报告按流程删掉了。原文随时可取回：
  `git show 7dae586:docs/PITFALLS/wheelchair-agent-建议-仓库随项目走.md`。
- **主会话固化第一次的 model 路由**：`initializeRoleModel` 不覆盖已有 `model/selection`。换 provider
  后需删 `~/.dsh/sessions/--home-nihao-.dsh-state-superagent--/orchestrator-*` 与对应
  `session_projcache`。
- **`dsh-tui update` 会把 dsh 升回 `0.2.2-rc.1`**，superagent 加载失败。需手动降回并带
  `--allow-scripts`。
- **worker 的目录约束靠自觉**：prompt 未限制它只能在 ticket 目录内改动，冒烟测试时它曾
  `find /home/nihao` 找到真实项目路径。
- **压缩时机仍未解决**：需要「已用 20% + 小阶段完成」的判断，要模型介入。
- **`spv` Source 的 `scope()` 未实现**：默认接收自己产生的全部 Trigger，够用于 explicit。
- **额度共享**：Eval + worker 都走 GOAT，与 cmd CLI 共用 5 小时 $20 / 每周 $50 窗口；`maxWorkers=2`。
- 每个拆出的子仓库用 `.git/info/exclude` 复制忽略规则，不改项目内 `.gitignore`。
- `tools/svg_grid/docs/PITFALLS/round-data/R22/meta.toml` 有一处 11-07 既有未提交修改，未触碰。
- **`~/.dsh/profiles/dsh-tui/node_modules/wheelchair-agent` 是 11-12 的真实目录副本**（不是软链，
  只有 4 个文件），无任何 yml 引用它。仓库外，由 SPV 处理。

# Next Steps

1. **合并 PR #2**（CLI 化 + 目录重组）与 **PR #1**（交付目标随项目走）：PR #2 的分支已包含 PR #1 的
   全部内容，所以合并 PR #2 就同时消掉 `main` 缺 `prepare.sh` 的风险；PR #1 随后可关。
2. **面板的 prepare 值已改成 `wheelchair-agent prepare`**（2026-11-14，经管理 API 保存，revision 8）。
   换机器或换 `DSH_HOME` 后重跑 `wheelchair-agent check` 确认它仍然正确。
3. 给 `tools/` 下缺远端的那 15 个项目建私有 GitHub 仓库（操作者自己的事，不是 agent 的）。
4. 收缩 worker 的目录约束（prompt 层或项目 `AGENTS.md`）。
5. 视消耗决定是否给 worker 换更便宜的模型。
6. 稳定后再考虑 `accept mode` 从 `observe` → `auto`。

日常命令：

```bash
wheelchair-agent service start     # 起后端（幂等；已在跑则直接报告）
wheelchair-agent service status    # exit 0 正常 / 1 未跑或异常 / 2 组件报错 / 3 等 setup
wheelchair-agent service restart   # 改过 spv Source 或 provider 配置后
wheelchair-agent service open      # 在浏览器打开带 token 的面板（token 每次启动都变，别复制旧的）
wheelchair-agent spv               # 起 SPV 会话（会自动拉起后端）
wheelchair-agent check             # 运行时健康：服务 / preset / 面板 prepare 值 / prepare dry run
```

`spv`、`superagent-service`、`jobctl` 仍然可用：它们是 `wheelchair-agent <子命令>` 的兼容名。

**面板的 token 每次启动都变**，且 `dsh web` 没有固定 token 的开关。裸 `url:` 打开只会得到
`dsh web authentication required`。用 `superagent-service open`，或从 `status` 的 `panel:` 行取当前地址。

改 `provider/`、`src/`、`preset/`、`commands/`、`bin/` 之后：重跑 `bash install.sh`（幂等）；
改 `dsh-superagent/` 之后：`pnpm build` + `wheelchair-agent service restart`。

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

`jobctl` 自己记 `~/.local/state/jobctl/ledger.jsonl`，因为 `--collect` 会让结束的 unit 从 systemd
消失；`verify` 同时查 systemd（机械事实）与账本（跨越 collect）。

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

定时器由插件自己持有，不用 `dsh-schedule`——后者需要 Web 组合的 Session controller，文档明说不能
在仅 SDK/headless 下单独挂载，而 SPV 跑在 dsh-tui 下。**代价**：会话关掉巡检就停（可以接受，
因为没有会话就没人接收简报）。
