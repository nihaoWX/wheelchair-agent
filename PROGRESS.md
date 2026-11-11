# Current State

superagent 已在本机跑通并完成配置，`spv` Source 已实现并**端到端验证通过**：本机文件队列 → Trigger → Ticket → worker → 结果回到队列。

- 服务：`tmux` session `dsh-superagent`，面板 `http://127.0.0.1:3082`，`runtime: ready`，health 里有 `spv`
- GitHub Source：`nihaoWX/bioagentforge` 正常轮询（60s）
- spv Source：`<stateDir>/spv/` 文件队列，2s 轮询，ready
- Policy allowed：github=`nihaoWX`，spv=`operator`
- accept mode：`observe`（explicit 请求不受影响，本来就会直接接单）
- 模型路由：`commandcode` / `deepseek/deepseek-v4-pro`（profile 里新挂，见下）
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
- **`spv` Source 插件**（`tools/wheelchair-agent/`）：纯 ESM JS，无构建步骤；文件队列 + rename 消费标记（无 cursor）；
  Trigger 满足 explicit 三条件（`human`/`addressed:'mention'`/`allowed`）；Channel 写 outbox。详见 `docs/spv-source.md`。
- **端到端验证**：2 个 smoke 任务（建/删文件、progress→ack→ready）都走完 Ticket → worker → 结果回队列；
  progress 确认未进 outbox。
- **profile 补挂模型 provider**：`@mars-sea/dsh-commandcode-provider` + `agent-default-model` 指 commandcode。
  原先没有 provider，Eval 一律 `MISSING_CREDENTIAL`。
- **`tools/` 拆分 20 个独立仓库**：10 个用 `git subtree split` 保留历史（tree 哈希逐一比对，零漂移），8 个新建单提交，2 个原有。零失败、零文件丢失（142370 文件前后一致）。根仓库 `.gitignore` 加 `tools/`。

# In Progress

（无）

# Known Issues

- **`scripts/dsh-superagent start` 会误报** `Startup health check timed out`，但服务实际在跑。用 `curl -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/state` 核实。
- **`scripts/dsh-superagent status/stop/restart` 在 WSL2 下认不出进程**：`ps` 的 `ucomm` 是 `MainThread` 而不是 `node`，脚本报 `pids: []`。`restart` 因此会打印 "existing orchestrator ... refusing duplicate startup" 而实际没重启。按端口找 PID 后 `kill -INT` 才可靠。
- **主会话会固化第一次的 model 路由**：`initializeRoleModel` 不覆盖已有 `model/selection`。补 provider 后若仍报 `MISSING_CREDENTIAL`，删 `~/.dsh/sessions/--home-nihao-.dsh-state-superagent--/orchestrator-*` 与对应 `session_projcache` 记录让它重建（Ticket 在 SQLite，不丢）。
- **`executor.prepare` 依赖 `/home/nihao/bioagentforge/.superagent-project`**（一行项目名）。该文件当前**不存在**，所以没有选定项目时 Ticket 会在 prepare 阶段失败。验证 spv 时临时创建后已删除。
- **`dsh-tui update` 会把 dsh 升回 `0.2.2-rc.1`**，届时 superagent 加载失败。需手动降回并带 `--allow-scripts` 重装。
- **额度共享**：superagent 的 Eval + worker 都走 GOAT 额度，与 cmd CLI 共用 5 小时 $20 / 每周 $50 窗口。`maxWorkers=2` 已限制并发。
- **superagent 是 alpha**（`0.2.1-alpha.2`），README 自述 research prototype。
- 每个新拆的子仓库用 `.git/info/exclude` 复制了根仓库的忽略规则，**不改项目内 `.gitignore`**。若某项目日后需要版本化自己的 ignore，需显式新建。
- `tools/svg_grid/docs/PITFALLS/round-data/R22/meta.toml` 有一处 11-07 的既有未提交修改，未触碰。

# Next Steps

1. 在入口会话里实际使用 `scripts/spv_send.py` / `spv_read.py --watch --consume` 派活收结果（`--help` 有用法）。
2. 确定 `.superagent-project` 的切换方式（当前需手工写文件），否则所有 Ticket 都会在 prepare 阶段失败。
3. 观察一个真实 Ticket 的 token 消耗，据此决定是否给 worker 指定更便宜的模型。
4. 稳定后再考虑把 `observe` 改成 `auto`（见 ARCHITECTURE D3 的取舍说明）。
