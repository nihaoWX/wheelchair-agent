# Definition

`wheelchair-agent` 是把 **dsh-superagent 的工作规则**接到本机的落地项目，用途是替代此前 `tools/cao` 承担的 agent 编排职责——CAO 只保留"能起终端"这一硬件能力，编排/授权/消息规则交给 superagent。

用户期望：

- **`superagent` 的流程原封不动**：Ticket / Mandate / Eval / Report 六级状态、`observe` 模式、准入表、发言权分离，一概不增不减。
- **入口是本机自然语言**：用户在一个 cmd 会话（cwd = `/home/nihao/bioagentforge`）里打字，由它派活；不再由用户直接对 worker 说话。
- **降噪是架构保证，不是规则约束**：worker 的 `progress` 报不到用户面前（`reportRelay` 返回 `undefined`），用户只看到"完成"和"需要决策"两类消息。
- **每个 worker 只看自己项目的规则**：靠"目录内有无 `.git`"让 DSH 的 `ancestorChain` 停在项目根，从而只加载该项目的 `AGENTS.md`。

不做什么：

- 不改 superagent 的核心（`src/core`）、不改它的 Web 面板。
- 不自己实现 Ticket/Mandate 数据层——用 superagent 自己的 SQLite。
- 不装第二套 DSH：`dsh-tui` 与 `superagent` 两个 profile 共用同一个全局 `dsh`。

# Structure

```
tools/wheelchair-agent/          # 本项目（独立 git 仓库）
├── AGENTS.md                    # 项目版 agent 规则（DSH 靠它做隔离）
├── ARCHITECTURE.md              # 本文档
├── PROGRESS.md                  # 当前状态
└── docs/                        # 设计依据与踩坑

/home/nihao/bioagentforge/
├── AGENTS.md                    # 根版规则：cwd=仓库根时加载（用户直连的会话）
├── .dsh/state/superagent/       # superagent 的 stateDir（DB、锁、worker 目录）
│   └── work/<name>-<ticket>/    # 每个 Ticket 一个 worker 目录
└── tools/dsh-superagent/        # superagent 源码（独立仓库，本地构建）

~/.dsh/profiles/superagent/      # DSH profile：加载 dsh-superagent bundle
```

## 关键机制：AGENTS.md 的隔离靠 `.git`

DSH 的 `dsh-agent-instructions` 这样找规则文件：

```js
findProjectRoot(cwd, markers=[".git"])   // 从 cwd 向上找第一个含 .git 的目录
ancestorChain(projectRoot, cwd)          // 该目录到 cwd 的整条链
// 链上每个目录的 AGENTS.md 全部加载（从宽到窄）
```

**实测结论**（`/tmp/agents-test`）：

| cwd | 加载的 AGENTS.md |
|---|---|
| `bioagentforge/`（根有 `.git`） | 只有根版 |
| `.../tools/proj/`（自带 `.git`） | **只有 proj 版，根版不加载** |

所以 2026-11-11 把 `tools/` 下 20 个目录全部拆成独立 git 仓库，正是为了让"项目 worker 只读自己项目的规则"成立，而不是靠提示词约定。

## 角色与信息流

```
用户
  ↓ 打字（cwd = bioagentforge，读根版 AGENTS.md）
入口会话（cmd，长期存活）
  ↓ 派任务（下一步实现的 spv Source）
superagent 主会话（后台，读不到代码，只做准入/路由/对人说话）
  ↓ Assignment
worker（cwd = 项目目录，读项目版 AGENTS.md）
  ↓ orchestrator_report
Ticket 状态（progress 不转发；ready/blocked/failed 才上浮）
  ↓
用户只收到"完成"或"需要决策"
```

边界（superagent 原生，勿改）：

- worker **不能**直接对人说话，只能 `orchestrator_report`。
- 主会话 **不能**读代码/日志/技术讨论，`prompts/shared.md` 明写 "Outside an assessment, the orchestrator must not inspect code"。
- 主会话 **不能**替 worker 翻译问题（`Do not translate worker questions into your own technical decisions`）。

## 配置现状（superagent profile）

| 项 | 值 |
|---|---|
| GitHub Source | `nihaoWX/bioagentforge`，CLI `/home/nihao/.local/bin/gh`，60s 轮询 |
| Policy allowed | `nihaoWX`（仅本人可派活） |
| accept mode | `observe`（默认：只记录"本来会做什么"，不自动接） |
| executor.directory | `/home/nihao/.dsh/state/superagent/work` |
| executor.maxWorkers | 2 |
| executor.prepare | 从 `/home/nihao/bioagentforge/.superagent-project` 读项目名，`git clone --no-hardlinks tools/<项目>` 到 worker 目录 |
| 面板 | `http://127.0.0.1:3082/?token=<日志里的 token>` |

`prepare` 项目选择：写 `tools/<项目名>` 的项目名到 `/home/nihao/bioagentforge/.superagent-project`（一行），或用 `SUPERAGENT_PROJECT` 环境变量覆盖。文件优先，便于改而不动服务。

## 与 `tools/cao` 的关系

CAO 暂置闲置。它保留的价值只剩"能起 tmux 终端 + 能跑 cmd"，编排工具（`assign`/`handoff`/`send_message`/`workflow_*`）在 superagent 接管后不再使用。**不删、不改、不授权**——留着作为退路。

## 参考索引

| 资料 | 位置 |
|---|---|
| superagent 设计文档（9 篇） | `docs/repositories/dsh-superagent-prototype/docs/` |
| DSH 安装与 GOAT 接入 | `docs/setup/dsh-commandcode.md` |
| superagent 源码 | `tools/dsh-superagent/`（独立仓库） |
| CAO 旧方案（归档） | `tools/cao/ARCHITECTURE.md` |
