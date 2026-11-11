# Current State

superagent 已在本机跑通并完成配置，**可以接受任务**，但"自然语言入口"（spv Source）尚未实现。

- 服务：`tmux` session `dsh-superagent`，面板 `http://127.0.0.1:3082`，`runtime: ready`
- GitHub Source：`nihaoWX/bioagentforge` 正常轮询（60s）
- Policy：`nihaoWX` 已加入 allowed 列表
- accept mode：`observe`
- 21 个 `tools/*` 已全部成为独立 git 仓库，根仓库不再跟踪 `tools/`

# Completed

- **dsh 降至 `0.2.1-rc.3`**：superagent 的 `engines.dsh = ^0.2.1-alpha.2` 不满足 `0.2.2-rc.1`（semver 0.x 预发布规则）。`dsh-tui@0.19.0` 的 peer 列表含 `0.2.1-rc.3`，两个 profile 共用同一全局 dsh。文档已更新。
- **装 `gh`**：`~/.local/bin/gh` 2.103.3（tar.gz，无需 sudo），`gh auth login` 以 `nihaoWX` 登录。
- **构建 dsh-superagent**：clone 到 `tools/dsh-superagent/`，`pnpm install && pnpm build` 成功。
- **profile `superagent`**：`dsh superagent --from-default-profile web`，`stateDir=/home/nihao/.dsh/state/superagent`，端口 3082。
- **bundle 注册**：`dsh plugin add` 只写 `dependencies`，必须手动补进 `package.json` 的 `dsh.profile.bundles`，否则报 `patch: entry "dsh-superagent" not found`。
- **setup 通过**：GitHub Source 配 repository + cli 后 `setup.problem=null`、`runtime=ready`。
- **Policy 配置**：`sources.github.allowed = [nihaoWX]`，policyVersion 已刷新。
- **executor 配置**：`directory`、`prepare`（按项目 clone）、`maxWorkers=2`。
- **AGENTS.md 隔离机制实测验证**：嵌套 git 仓库下 `discoverBaselineInstructionFiles` 只返回项目自己的 `AGENTS.md`，根版不加载。
- **`tools/` 拆分 20 个独立仓库**：10 个用 `git subtree split` 保留历史（tree 哈希逐一比对，零漂移），8 个新建单提交，2 个原有。零失败、零文件丢失（142370 文件前后一致）。根仓库 `.gitignore` 加 `tools/`。

# In Progress

（无）

# Known Issues

- **spv Source 未实现**：目前只能通过 GitHub Issue 派活，无法"在本机打字派任务"。这是下一步。
- **`scripts/dsh-superagent start` 会误报** `Startup health check timed out`，但服务实际在跑。用 `curl -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/state` 核实。
- **`dsh-tui update` 会把 dsh 升回 `0.2.2-rc.1`**，届时 superagent 加载失败。需手动降回并带 `--allow-scripts` 重装。
- **额度共享**：superagent 的 Eval + worker 都走 GOAT 额度，与 cmd CLI 共用 5 小时 $20 / 每周 $50 窗口。`maxWorkers=2` 已限制并发。
- **superagent 是 alpha**（`0.2.1-alpha.2`），README 自述 research prototype。
- 每个新拆的子仓库用 `.git/info/exclude` 复制了根仓库的忽略规则，**不改项目内 `.gitignore`**。若某项目日后需要版本化自己的 ignore，需显式新建。
- `tools/svg_grid/docs/PITFALLS/round-data/R22/meta.toml` 有一处 11-07 的既有未提交修改，未触碰。

# Next Steps

1. 验证 `spv` Source 端到端（子 agent 正在实现）：本机队列 → Trigger → Ticket → worker → 结果回到队列。
2. 入口会话的派活工具已随 `spv` Source 一起提供（`scripts/spv_send.py` / `spv_read.py`）。
3. 验证降噪效果：确认 worker 的 `progress` 不出现在用户面前，只有 `ready`/`blocked` 上浮。
4. 观察一个真实 Ticket 的 token 消耗，据此决定是否给 worker 指定更便宜的模型。
5. 稳定后再考虑把 `observe` 改成 `auto`（见 ARCHITECTURE D3 的取舍说明）。
