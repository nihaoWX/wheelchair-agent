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
bash tools/wheelchair-agent/install.sh          # 装 preset、CLI 与兼容命令
bash tools/wheelchair-agent/install.sh --check  # 只读自检，任一不满足 exit 2
```

装这些东西：

1. `~/.dsh/.agent-presets/spv/` —— 渲染出的 `preset.yml`、`agent.cordis.yml`、`preset-default.patch.yml`、
   `cli.js`、`src/{shared,spv}/`、`commands/`、`prepare.sh`、`spv-launcher.sh` 与 `agentsmd-examples/`。
   这个目录就是「SPV 侧的已安装包」；superagent 侧的 `src/superagent/` **不在**里面（那个 profile 用
   自己的 `node_modules` 软链加载它）。
2. `~/.local/bin/wheelchair-agent` —— 唯一入口（薄壳，把 preset 目录烧进去后 `exec node <preset>/cli.js`）
3. `~/.local/bin/{spv,superagent-service,jobctl}` —— 兼容名，每个都是 `exec wheelchair-agent <子命令> "$@"`

装完会打印面板要用的 prepare 命令：

```sh
wheelchair-agent prepare
```

把它填进面板的 Settings → Execution → Prepare command。**是命令名，不是绝对路径**：面板值存在
superagent 的 sqlite 里，`install.sh` 管不到它，绝对路径会在换 `DSH_HOME` / 换用户名后静默失效。
`install.sh --check` 会读服务进程的 `/proc/<pid>/environ`，确认 `~/.local/bin` 在那个 PATH 里。

`prepare` 负责 clone 项目、按项目类型装受管 `AGENTS.md`、给 `tools/` 项目建私有 GitHub 远端并把工单的
`origin` 指过去；`research/` 永不配远端。行为与约束见 `docs/delivery-target.md`，可跑证据是
`tests/test-prepare.sh`。

前置：`dsh-tui` 在 `PATH` 上、`node` >= 22。缺了 `install.sh` 会 FAIL 并给获取方式。

## 起

```sh
wheelchair-agent spv    # 在 bioagentforge 根目录下运行（SPV 的 AGENTS.md 从 cwd 读）
spv                     # 同一个东西的兼容名
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

任务文件里的 `actor` 固定是 `operator`，**不是** `spv_dispatch` 的参数 —— 见 `src/spv/dispatch.js` 里
`ACTOR` 的注释。

同样的三件事在命令行上也有，供手动调试与脚本使用（`dispatch` / `result` / `status` 直接 import
`src/spv/*.js`，不 spawn 子进程，所以队列格式只有一份实现）：

```sh
wheelchair-agent dispatch --project tools/foo --task "..." --thread t1
wheelchair-agent result --thread t1 --timeout 300
wheelchair-agent status [--thread t1]
wheelchair-agent check          # 运行时健康：服务 / preset / 面板 prepare 值 / prepare dry run
```

## 模块解析（改这个 preset 前必读）

`agent.cordis.yml` 里 `spv-tools` 行的 name 是 `@SPV_PLUGIN@`，安装时替换成
`file://<安装目录>/src/spv/tools.js`。**不能**换成 `wheelchair-agent/spv-tools`：

- preset 的声明来自 dsh profile 的 patch 层，那一层的模块解析基址是 profile 目录；
- `@deepseek-ai/*` 解析得到（它们在 dsh 的安装树里，有解析器兜住），但 `wheelchair-agent` 不在，
  会 `MODULE_NOT_FOUND`；
- 失败表现是 `spv-tools (...): never started`，只有这一行，没有根因。

同一个原因，`preset-default.patch.yml` 里的 `plugins:` 是从 `agent.cordis.yml` 直接内联生成的，而不是用
`@deepseek-ai/cordis-plugin-include` 指过去 —— 在本机测过的 dsh 0.2.1-rc.3 + dsh-tui 0.19.0 上，
preset 声明里的 include 行不挂载子行，也不报错。

改了 `preset/`、`src/`、`commands/` 或 `bin/` 里的东西，**重跑 `install.sh`** 才会生效。
