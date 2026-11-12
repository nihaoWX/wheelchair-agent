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
- **SPV preset**（`dsh/` → `~/.dsh/.agent-presets/spv/`）：`agent.cordis.yml` 挂 spv 工具 + `tool-fs` + bash + `agent-instructions`。
- **SPV 工具**（`spv-tools.js` + `src/{dispatch,outbox,paths}.js`）：`spv_dispatch` / `spv_result` / `spv_status`。`actor` 写死 `operator`，不接受参数。
- **`install.sh`**：装 preset + 启动器，白名单拷贝、原子替换、幂等、`--check` 只读自检。
- **`tools/` 拆分 21 个独立仓库**：10 个 `git subtree split` 保留历史（tree 哈希逐一比对），9 个新建，2 个原有。零失败、零文件丢失。
- **端到端验证**：`spv_dispatch` 投递 → ack → worker 在项目 clone 内执行 → reply "已完成：…"，全程无残留。
- **防冒充验证**：superagent 源码与其 `cordis.patch.yml` 中均无 `spv_*`；两个 superagent preset 都不含 `spv-tools`。
- **install 四项验收**：首次装、重跑幂等（`up to date`）、改源后 `--check` = exit 2、还原后 = exit 0、已装目录无开发侧文件。

# In Progress

（无）

# Known Issues

- **`scripts/dsh-superagent status/stop/restart` 在 WSL2 下失效**：脚本用 `ps ucomm` 判进程名，node 的 comm 是 `MainThread`。按端口取 PID 再 `kill -INT`。这也是它「start 误报健康检查超时」的同一根因。
- **主会话固化第一次的 model 路由**：`initializeRoleModel` 不覆盖已有 `model/selection`。换 provider 后需删 `~/.dsh/sessions/--home-nihao-.dsh-state-superagent--/orchestrator-*` 与对应 `session_projcache`。
- **`dsh-tui update` 会把 dsh 升回 `0.2.2-rc.1`**，superagent 加载失败。需手动降回并带 `--allow-scripts`。
- **worker 的目录约束靠自觉**：prompt 未限制它只能在 ticket 目录内改动，冒烟测试时它曾 `find /home/nihao` 找到真实项目路径。
- **压缩时机仍未解决**：需要「已用 20% + 小阶段完成」的判断，要模型介入。
- **`spv` Source 的 `scope()` 未实现**：默认接收自己产生的全部 Trigger，够用于 explicit。
- **额度共享**：Eval + worker 都走 GOAT，与 cmd CLI 共用 5 小时 $20 / 每周 $50 窗口；`maxWorkers=2`。
- 每个拆出的子仓库用 `.git/info/exclude` 复制忽略规则，不改项目内 `.gitignore`。
- `tools/svg_grid/docs/PITFALLS/round-data/R22/meta.toml` 有一处 11-07 既有未提交修改，未触碰。

# Next Steps

1. 在真实 SPV 会话里跑一次完整任务（`spv` 启动 → 派活 → `spv_result`），观察 token 消耗。
2. 收紧 worker 的目录约束（prompt 层或项目 `AGENTS.md`）。
3. 视消耗决定是否给 worker 换更便宜的模型。
4. 稳定后再考虑 `observe` → `auto`。
