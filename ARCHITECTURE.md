# Definition

`wheelchair-agent` 是一个依赖 superagent 的轮椅流 agent。用户取这个名字就是因为它的运行方式对用户很友好：
用户只需要与 spv 一个 agent 对话，spv 管多项目长期大目标，spv 代替用户监督/跟进多个 worker，近乎全自动运行，
当然用户也可以具体下场到 worker 具体跟进。

用户期望：

- **`superagent` 的流程原封不动**：superagent 的原生机制已经很适合轮椅流理念，只差一个外层触发 superagent
  流程的入口，这个入口就是 spv。
- **用户自然语言对话 spv**：用户在一个 dsh 会话（这个 agent 身份就是 spv）（cwd = `/home/nihao/bioagentforge`）
  里打字，由它派活；不再由用户直接对 worker 说话，但用户也可以具体下场跟进某个 worker。
- **每个 worker 只管相应项目**：管某个工具则 worker 的 cwd 是 `tools/<a tool>`，推进某个研究任务则是
  `research/<a task>`。靠"目录内有无 `.git`"让 DSH 的 `ancestorChain` 停在项目根，从而只加载该项目的
  `AGENTS.md`。
- **一个命令入口**：`wheelchair-agent`。`install.sh` 只负责把它装进电脑，没有别的功能。

## 已定型的约束

讨论已经结束的结论全部移到 **`ARCHITECTURE/decisions.md`**，每条附证据或实测结果。**不要重新推导。**

| 结论 | 一句话 |
|---|---|
| 压缩成本 | 一次性 worker 与单会话 worker 成本相近，都避免不了压缩；压缩时机仍未解决 |
| 降噪 | 靠架构（worker 权限 + orchestrator 过滤），**不**在本项目加消息分级规则 |
| dsh 版本 | 锁 `0.2.1-rc.3`；`dsh-tui update` 会升回 `0.2.2-rc.1` |
| GOAT 额度 | CLI 与 API 共用 5 小时 $20 / 每周 $50，所以 `maxWorkers=2` |
| 派任务入口 | **CLI 可以**（2026-11-14 修订，旧结论作废）；`ACTOR` 仍写死 `operator`；**沙箱暂不做** |
| 长任务 | 交给 systemd（`jobctl`），触发器是作业自己的结束事件，不是轮询 |
| SPV 遇 API error | `wontfix`（账本 `R3-F1`），上游刻意设计，绕行＝代理或调高 `transportMaxRetries` |
| 交付目标 | 不与环境变量对抗，改为给 worker 一份受管 `AGENTS.md` |

# Structure

## 两个东西，严格分开，互不 import

这是本项目最容易混淆的地方：

| | 我们的 SPV | superagent |
|---|---|---|
| 是什么 | 我们自己定义的 dsh **agent preset** | 另一个 dsh profile 里的**常驻服务** |
| 谁对话 | **用户** | 无人（后台进程） |
| profile | `dsh-tui` | `superagent` |
| preset | `spv`（`~/.dsh/.agent-presets/spv/`） | `dsh-superagent-router` / `-worker`（它 bundle 自带） |
| cwd | `bioagentforge`（读根版 AGENTS.md） | 独立 stateDir |
| 工具前缀 | `spv_*` | `orchestrator_*` |
| 职责 | 听懂用户、派任务、报结果 | 准入判断、建 Ticket、路由、派工 |
| 唯一的接口 | **文件队列**（写 `pending/`、读 `outbox/`） | 同一个队列（反向） |

**不要把它们当成一个系统的两层。** 它们是两个独立程序，共享的只有队列文件格式。SPV 不读 superagent 的
代码，superagent 不知道 SPV 存在。

## 一个包，三个 dsh 插件入口

"新增工具必须注入"没有替代方案：模型可见的工具只能靠 `ctx.tools.register`，那只有插件能做。三个入口
**必须**分开，不能合成一个——前一个必须挂在 superagent profile，后两个必须挂在 dsh-tui，一个插件进不了
两个 profile。

| 入口（`package.json` exports 键） | 注册什么 | 挂在哪个 profile |
|---|---|---|
| `wheelchair-agent/spv-watch` | `spv` Source kind（Trigger/Channel/Policy） | `superagent` |
| `wheelchair-agent/spv-tools` | `spv_dispatch` / `spv_result` / `spv_status` | `dsh-tui` 的 SPV preset |
| `wheelchair-agent/spv-cron-plugin` | `/spv-cron` 斜杠命令 | `dsh-tui` 的 SPV preset |

**exports 的键是公开 API**：`~/.dsh/profiles/superagent/cordis.patch.yml` 用 bare specifier
`wheelchair-agent/spv-watch` 引用它，那是仓库外的操作者状态。只改键指向的文件，不改键名。

## 一个核心 + 两个适配器

```
        ┌──────────────┐
        │  src/ 核心库  │  ← 纯函数，不 import dsh，不 process.exit
        └──────┬───────┘
       ┌───────┴────────┐
   ┌───▼────┐      ┌───▼─────────┐
   │  CLI   │      │ dsh 插件 ×3 │
   └────────┘      └─────────────┘
```

插件和 CLI **不能互相调用，只能共享代码**。逻辑若在 CLI 里，插件想用就得 `spawn` 子进程——多一个进程、
多一个 PATH 依赖、结构化返回值变成 stderr 文本、错误没法带类型。`process.exit` 只出现在 `bin/`，
JSON Schema 与 render 只出现在插件入口。

## 目录布局

**布局与三条机械可查的规则见 `ARCHITECTURE/layout.md`（`tests/test-layout.sh` 逐条断言）。**
`src/` 已按 `shared/` `superagent/` `spv/` 三分，边界在布局上一眼可见。

```
wheelchair-agent/
├── bin/wheelchair-agent.mjs      # CLI 入口：argv 解析 + process.exit，仅此
├── src/shared/                   # 两侧共用，唯一的契约（queue.js, schema.js）
├── src/superagent/               # 只被 superagent profile 加载（spv.js, watch.js）
├── src/spv/                      # 只被 SPV preset 与 CLI 加载（paths, dispatch, outbox, health, cron, tools, cron-plugin）
├── preset/                       # 装到 ~/.dsh/.agent-presets/spv/（preset.yml, agent.cordis.yml, spv-launcher.sh, wheelchair-agent.sh, README.md）
├── commands/                     # 会被装成独立命令的实现（prepare.sh, jobctl.py, superagent-service.py）
├── build/render-preset.mjs       # 构建步骤，不是命令
├── tests/                        # test-prepare.sh, test-layout.sh
├── install.sh                    # 只负责安装
└── docs/
```

安装布局：preset 目录是「SPV 侧的已安装包」（含 `cli.js`、`src/{shared,spv}/`、`commands/`、`prepare.sh`），
`~/.local/bin/wheelchair-agent` 是薄壳，`spv` / `superagent-service` / `jobctl` 是它的兼容名。
superagent 侧的 `src/superagent/` **从不进 preset 目录**：那个 profile 用自己的 `node_modules` 软链加载它。

## CLI

**契约见 `ARCHITECTURE/cli.md`。** 子命令：`spv` / `prepare` / `service` / `jobctl` / `dispatch` / `result` /
`status` / `check`。`install.sh --check` 查"装进去的东西 == checkout"，`wheelchair-agent check` 查运行时
健康，两个不重叠。

`spv`、`superagent-service`、`jobctl` 继续作为独立命令存在（薄 wrapper），因为 worker 的 prompt 与
`docs/` 里都是按名字引用它们的。

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

所以 2026-11-11 把 `tools/` 下 20 个目录全部拆成独立 git 仓库，正是为了让"项目 worker 只读自己项目的规则"
成立，而不是靠提示词约定。

## 角色与信息流

```
用户
  ↓ 打字（cwd = bioagentforge，读根版 AGENTS.md）
入口会话（cmd，长期存活）
  ↓ 派任务（spv_dispatch 写文件队列）
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
| spv Source | `<stateDir>/spv/` 文件队列，2s 轮询，健康条目 `spv` |
| Policy allowed | github=`nihaoWX`；spv=`operator`（写死在 `src/spv/dispatch.js`，不接受参数） |
| accept mode | `observe`（只影响 inferred 候选；explicit 请求始终直接接单） |
| 模型路由 | `commandcode` / `deepseek/deepseek-v4-pro`（profile 的 `agent-default-model`） |
| executor.directory | `/home/nihao/.dsh/state/superagent/work` |
| executor.maxWorkers | 2 |
| executor.prepare | `wheelchair-agent prepare`（**命令名，不是绝对路径**；见 `ARCHITECTURE/cli.md`） |
| 面板 | `http://127.0.0.1:3082/?token=<日志里的 token>` |

`prepare` 项目选择：项目名随任务走（`spv_dispatch` 的 `project` 参数 → Trigger 的 `project` →
`DSH_SUPERAGENT_SPV_PROJECT`）。`/home/nihao/bioagentforge/.superagent-project` 只作非 spv 任务的兜底；
两者都没有时 Ticket 会在 prepare 阶段失败（设计如此）。

## 参考索引

| 资料 | 位置 |
|---|---|
| **已定型的约束（勿重复推导）** | **`ARCHITECTURE/decisions.md`** |
| **目标目录布局与三条规则** | **`ARCHITECTURE/layout.md`** |
| **CLI 契约** | **`ARCHITECTURE/cli.md`** |
| superagent 设计文档（9 篇） | `docs/repositories/dsh-superagent-prototype/docs/` |
| DSH 安装与 GOAT 接入 | `docs/setup/dsh-commandcode.md` |
| superagent 源码 | `tools/dsh-superagent/`（独立仓库） |
| **spv Source 设计与踩坑** | **`docs/spv-source.md`** |
| **交付目标：仓库随项目走** | **`docs/delivery-target.md`** |
| AGENTS.md 模板（项目开发 / 研究任务） | `docs/agentsmd-examples/` |
