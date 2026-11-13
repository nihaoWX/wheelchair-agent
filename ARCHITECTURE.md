# Definition

`wheelchair-agent` 是一个依赖superagent的轮椅流agent，用户取这个名字就是因为它的运行方式对用户很友好，用户只需要与spv一个agent对话，spv管多项目长期大目标，spv代替用户监督/跟进多个worker，近乎全自动运行，当然用户也可以具体下场到worker具体跟进。

用户期望：
- **`superagent` 的流程原封不动**：用户认为superagent的原生机制已经很适合上面提到的轮椅流理念，就只是差一个外层触发superagent流程的入口，这个入口就是spv。
- **用户自然语言对话spv**：用户在一个 dsh 会话（这个agent身份就是spv）（cwd = `/home/nihao/bioagentforge`）里打字，由它派活；不再由用户直接对 worker 说话，但是用户也可以具体下场跟进某个worker。
- **每个 worker 只管相应项目**：例如管某个工具，那么那个worker的cwd就是`tools/<a tool>`，推进某个研究任务，那这个worker的cwd就是`research/<a task>`。靠"目录内有无 `.git`"让 DSH 的 `ancestorChain` 停在项目根，从而只加载该项目的 `AGENTS.md`。

## 关键约束（讨论已定型，勿重复推导）

**压缩成本**：原规划是单会话worker持续长期推进，靠上下文压缩节省token，但是superagent是一次性worker。因此发出疑问新开一次性worker会不会省一次压缩的成本？

一次性worker可能会把 `ARCHITECTURE.md`、`PROGRESS.md`等等再读一遍。所以两种方案不一定谁成本更低，用户最终选择适配superagent的管理方式，superagent是一次性worker。
而且在实际测试里，一次性或者单会话，不干预的话一个任务上下文窗口占用都可以到90%以上，所以它们都避免不了压缩。
所以既然避免不了还不如直接顺着superagent来做一次性worker。

结论：新开一次性worker和单会话worker成本可能是相近的，但是它们都无法避免压缩问题。压缩时机是：上下文窗口已用 20% 左右 + 小阶段目标完成。但是这个判断需要模型介入，目前还没有解决这个问题。

**降噪靠架构，不靠规则**：用户的痛点是「spv 和 worker 间收发消息会淹没我的跟 spv 的交流」。根因不是消息太多，而是"消息承担了状态的职责"。信息过滤具体来自 superagent 的 worker 权限（使用的时候 worker 就是不会有任何信息外发）和它们自带的机会触发的 orchestrator（第二层过滤）。

因此不要在本项目里加任何"消息分级规则"——那是在架构之上叠规则，反而更脆。

**dsh 版本锁 `0.2.1-rc.3`**：superagent 的 `engines.dsh = ^0.2.1-alpha.2`，semver 对 `0.x` 预发布版的规则使 `0.2.2-rc.1` 不满足。`dsh-tui@0.19.0` 的 peer 列表含 `0.2.1-rc.3`，两个 profile 共用同一个全局 dsh。**`dsh-tui update` 会升回 `0.2.2-rc.1`**，届时须手动降回并带 `--allow-scripts`（否则 `node-pty` 不编译）。

**GOAT 套餐可驱动任意 harness**：`BYOK` 是"key 进 Command Code"（不耗额度），`Provider API` 是"key 出去"（耗额度）。我们要的是后者，官方原文 *"any client or agent can use them. No lock-in. Use it anywhere."*，已实测 `/provider/v1/{models,messages}` 均 200。**CLI 与 API 共用同一份额度**（5 小时 $20 / 每周 $50），所以 `maxWorkers=2`。

**派任务入口必须是 agent 工具，不能是 CLI 脚本**：`spv_send.py` 这类脚本可被任何有 bash 的 agent 调用，而它投递的任务默认以 `operator` 身份进入 superagent——worker 跑一下脚本就能伪造成用户派活，授权模型失效。所以入口必须是 SPV preset 里的工具（superagent 侧没有），且 `actor` 由代码写死为 `operator`、不接受参数。CLI 脚本保留但降级为过渡/调试。

**长任务不留在 worker 会话里**：worker 回合结束后其 shell job 最多再跑 30 分钟即被杀（`src/executor/dsh.ts` 的 `BACKGROUND_LIMIT_MS`）。长时间分析交给 systemd user manager 持有（`jobctl`），下一阶段的触发器是**作业自己的结束事件**（`ExecStopPost` 写队列），不依赖 worker 自觉、全局 goal 状态或定时轮询。`/spv-cron` 每小时机械检查一次，漏挂的作业顶多一小时内被发现。

**SPV 的重试能力取决于错误 code，不是"有没有重试"**：`dsh-llm-retry` 已挂载，commandcode provider 也实现了 `providerRetryPolicy`（`maxRetries: 1000`，白名单 `EMPTY_RESPONSE / RATE_LIMIT / THROTTLED / SERVER / TIMEOUT / TRANSPORT`）。所以遇到上游报错直接停下，大概率是**该错误的 code 不在白名单**，或**错误发生在 agent 轮次之外**（`ctx.llm.stream()` 的直接消费方没有重试边界）。排查时先确认实际 code，再决定是补白名单、还是在 SPV profile 层把 `retryPolicy` 调成 `always`——后者会让永久性失败（无效 key、配额耗尽）也一直重试，需明确取舍。worker 侧不受影响是因为 superagent 自带独立重试（`TRANSIENT_TRIES = 3`、15s 退避、认 408/429/5xx 与 ECONNRESET 等）。

# Structure

**两个东西，严格分开，互不 import**——这是本项目最容易混淆的地方：

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

**不要把它们当成一个系统的两层。** 它们是两个独立程序，共享的只有队列文件格式。SPV 不读 superagent 的代码，superagent 不知道 SPV 存在。

```
tools/wheelchair-agent/          # 本项目（独立 git 仓库）
├── AGENTS.md                    # 项目版 agent 规则（DSH 靠它做隔离）
├── ARCHITECTURE.md              # 本文档
├── PROGRESS.md                  # 当前状态
├── package.json                 # 两个入口：superagent Source 插件 + SPV 插件
├── index.js                     # 包默认入口，转出 spv-watch.js
├── spv-watch.js                 # 【superagent 侧】插件入口：注册 kind + 轮询循环
├── spv-tools.js                 # 【SPV 侧】spv_dispatch / spv_result / spv_status
├── spv-cron-plugin.js           # 【SPV 侧】`/spv-cron` 插件入口（薄壳，逻辑在 src/spv-cron.js）
├── src/spv.js                   # 【superagent 侧】spv Source kind（Trigger/Channel/Policy）
├── src/queue.js                 # 共用：文件队列布局与读写（pending/done/outbox）
├── src/schema.js                # 共用：极简 schema 校验
├── src/paths.js                 # 【SPV 侧】队列根解析（config > env > stateDir）
├── src/dispatch.js              # 【SPV 侧】写 pending/，actor 写死 operator
├── src/outbox.js                # 【SPV 侧】读 outbox/，等 reply/notice
├── src/health.js                # 【SPV 侧】探健康端点，服务没跑就拒绝派活
├── src/spv-cron.js              # 【SPV 侧】`/spv-cron` 逻辑（纯逻辑，注入依赖）
├── dsh/                         # 【SPV 侧】agent preset 定义（装到 ~/.dsh/.agent-presets/spv/）
│   ├── preset.yml
│   ├── agent.cordis.yml         # 工具面 + compaction 组
│   └── spv-launcher.sh          # 启动器模板（先拉起服务，再开 TUI）
├── install.sh                   # 装 preset + spv 启动器 + superagent-service + jobctl；带 --check
├── scripts/
│   ├── superagent-service.py    # 服务启停（不依赖进程名）+ open 面板
│   ├── jobctl.py                # 长任务交给 systemd 持有（submit/status/log/verify/cancel）
│   ├── render-preset.mjs        # 渲染 preset 与 patch
│   ├── spv_send.py              # 过渡用 CLI（正路是 SPV 工具）
│   └── spv_read.py              # 过渡用 CLI
└── docs/
    ├── spv-source.md            # spv Source 设计与踩坑
    ├── delivery-target.md       # 交付目标随项目走（未实现的方向与约束）
    ├── agentsmd-examples/       # worker 用的两份 AGENTS.md 模板
    └── PITFALLS/                # 报告（消费完即删，原文在 git）

/home/nihao/bioagentforge/
├── AGENTS.md                    # 根版规则：SPV 会话（cwd=仓库根）加载它
├── .dsh/state/superagent/       # superagent 的 stateDir（DB、锁、worker 目录）
│   ├── work/<name>-<ticket>/    # 每个 Ticket 一个 worker 目录（项目 clone）
│   └── spv/                     # 两边唯一的接口
│       ├── pending/             # SPV 写，superagent 读（rename 到 done/ 即消费）
│       ├── done/                # 已消费
│       └── outbox/              # superagent 写，SPV 读
└── tools/dsh-superagent/        # superagent 源码（独立仓库，本地构建）

~/.dsh/profiles/superagent/      # DSH profile：dsh-superagent bundle + wheelchair-agent 插件 + 模型 provider
~/.dsh/.agent-presets/spv/       # DSH 用户级 preset：定义 SPV 是什么（install.sh 装）
~/.local/bin/spv                 # SPV 启动器（install.sh 装）
~/.local/bin/superagent-service   # 服务管理（install.sh 装）
~/.local/bin/jobctl              # 长任务管理（install.sh 装）
~/.local/state/jobctl/ledger.jsonl # jobctl 的账本（--collect 会删掉结束的 unit，账本跨越它）
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
| Policy allowed | github=`nihaoWX`；spv=`operator`（写死在 `spv_dispatch`，不接受参数） |
| accept mode | `observe`（只影响 inferred 候选；explicit 请求始终直接接单） |
| 模型路由 | `commandcode` / `deepseek/deepseek-v4-pro`（profile 的 `agent-default-model`） |
| executor.directory | `/home/nihao/.dsh/state/superagent/work` |
| executor.maxWorkers | 2 |
| executor.prepare | 读任务自带的 `DSH_SUPERAGENT_SPV_PROJECT`，`git clone --no-hardlinks <项目>` 到 worker 目录 |
| 面板 | `http://127.0.0.1:3082/?token=<日志里的 token>` |

`prepare` 项目选择：项目名随任务走（`spv_dispatch` 的 `project` 参数 → Trigger 的 `project` → `DSH_SUPERAGENT_SPV_PROJECT`）。`/home/nihao/bioagentforge/.superagent-project` 只作非 spv 任务的兜底；两者都没有时 Ticket 会在 prepare 阶段失败（设计如此）。

## 参考索引

| 资料 | 位置 |
|---|---|
| superagent 设计文档（9 篇） | `docs/repositories/dsh-superagent-prototype/docs/` |
| DSH 安装与 GOAT 接入 | `docs/setup/dsh-commandcode.md` |
| superagent 源码 | `tools/dsh-superagent/`（独立仓库） |
| **spv Source 设计与踩坑** | **`docs/spv-source.md`** |
| **交付目标：仓库随项目走（未实现）** | **`docs/delivery-target.md`** |
| AGENTS.md 模板（项目开发 / 研究任务） | `docs/agentsmd-examples/` |

## 未实现：交付目标随项目走

worker 环境里的 `DSH_SUPERAGENT_GITHUB_REPOSITORY` 永远是面板那一个单值，而任务自带 `project`，
两者可以指向不同项目且无任何标记。**曾因此把一个 `tools/pitfalls-manager` 的 PR 开到了
`nihaoWX/bioagentforge`。**

三条配置绕行路已实测堵死（关 github Source 会停在 `setupPending`；`spv` 声明同名变量只是并排渲染
两行；编排器 API 锁死在配置仓库）。**已定方向：不与环境变量对抗，改为给 worker 一份它读得到的
`AGENTS.md`，说明这个项目该不该推送。** 详见 `docs/delivery-target.md`，模板在
`docs/agentsmd-examples/`。

**尚未实现**——本节只是把结论和约束固定下来，避免下一个 agent 重新推导。
