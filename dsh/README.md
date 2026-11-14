# SPV preset

一个独立于 superagent 的 dsh agent preset：你在终端里和它对话，它把活派给后台的 superagent，再把结果读回来。

两套东西**严格分开**：

|  | SPV（这里） | superagent（既有） |
|---|---|---|
| 是什么 | dsh agent preset（`dsh-tui` profile 里的一个会话组合） | 另一个 profile 里常驻的后台服务 |
| 谁对话 | 用户 | 无人 |
| 工具前缀 | `spv_*` | `orchestrator_*` |
| 通道 | 只有文件队列 `~/.dsh/state/superagent/spv/` | |

SPV 侧不 import superagent 的任何代码。两侧唯一的接口是队列里的 JSON 文件：SPV 写 `pending/`，superagent 的
`spv` Source 取走并写 `outbox/`，SPV 从 `outbox/` 读回。

## 装

```sh
bash tools/wheelchair-agent/install.sh          # 装 preset 与启动器
bash tools/wheelchair-agent/install.sh --check  # 只读自检，任一不满足 exit 2
```

装两样东西：

1. `~/.dsh/.agent-presets/spv/` —— `preset.yml`、`agent.cordis.yml`、`preset-default.patch.yml`、`spv-tools.js`、`src/`，
   以及 `prepare.sh` 与 `agentsmd-examples/`（面板的 prepare 命令用它们）
2. `~/.local/bin/spv` —— 启动器

装完会打印面板要用的 prepare 命令：

```sh
sh "$HOME/.dsh/.agent-presets/spv/prepare.sh"
```

把它填进面板的 Settings → Execution → Prepare command。它负责 clone 项目、按项目类型装受管
`AGENTS.md`、给 `tools/` 项目建私有 GitHub 远端并把工单的 `origin` 指过去；`research/` 永不配远端。
行为与约束见 `docs/delivery-target.md`，可跑证据是 `scripts/test-prepare.sh`。

前置：`dsh-tui` 在 `PATH` 上、`node` >= 22。缺了 `install.sh` 会 FAIL 并给获取方式。

## 起

```sh
spv              # 在 bioagentforge 根目录下运行（SPV 的 AGENTS.md 从 cwd 读）
```

`spv` 等价于：

```sh
DSH_TUI_PRESET=spv dsh-tui --patch ~/.dsh/.agent-presets/spv/preset-default.patch.yml
```

不想用启动器时，在任意 dsh-tui 会话里 `/preset spv` 也能切过去（需要那一次启动带上同一个 `--patch`）。

## 用

会话里让 agent 干活即它自己会调三个工具：

| 工具 | 参数 | 行为 |
|---|---|---|
| `spv_dispatch` | `project`（`tools/<name>` 或 `research/<name>`）、`task`、`thread?`（默认 `main`） | 写 `pending/`，立刻返回 `{id, thread, project}` |
| `spv_result` | `thread`、`timeout?`（秒，默认 300） | 阻塞到该 thread 出现 `reply`/`notice`，返回其 `text`；同一条消息只消费一次 |
| `spv_status` | `thread?` | 非阻塞：`pending/` 里没被取走的任务 + 已到未读的消息 |

任务文件里的 `actor` 固定是 `operator`，**不是** `spv_dispatch` 的参数 —— 见 `spv-tools.js` 里 `ACTOR` 的注释。

## 模块解析（改这个 preset 前必读）

`agent.cordis.yml` 里 `spv-tools` 行的 name 是 `@SPV_PLUGIN@`，安装时替换成
`file://<安装目录>/spv-tools.js`。**不能**换成 `wheelchair-agent/spv-tools`：

- preset 的声明来自 dsh profile 的 patch 层，那一层的模块解析基址是 profile 目录；
- `@deepseek-ai/*` 解析得到（它们在 dsh 的安装树里，有解析器兜住），但 `wheelchair-agent` 不在，
  会 `MODULE_NOT_FOUND`；
- 失败表现是 `spv-tools (...): never started`，只有这一行，没有根因。

同一个原因，`preset-default.patch.yml` 里的 `plugins:` 是从 `agent.cordis.yml` 直接内联生成的，而不是用
`@deepseek-ai/cordis-plugin-include` 指过去 —— 在本机测过的 dsh 0.2.1-rc.3 + dsh-tui 0.19.0 上，
preset 声明里的 include 行不挂载子行，也不报错。

改了 `dsh/` 或 `src/` 里的东西，**重跑 `install.sh`** 才会生效。
