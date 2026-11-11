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

---

# 已定型的决定（勿重复推导）

这一节是用户在多轮讨论中明确拍定的判断。**后来者不要因为"看起来可以更简单/更省成本"就推翻它们**；每条都附了理由，理由不成立才能重开。

## D1 压缩成本不能靠"多开新会话"规避

曾经的推论是「既然状态都在 HARNESS 里，就少用压缩、多开新会话」。**这条已被证伪**：

- 压缩是上下文填满时的 **O(1) 固定开销**，不随会话数增减。
- 换新会话没有消掉它，只是换成了**重新获取上下文**——agent 不知道读过什么，会把 `ARCHITECTURE.md`、`PROGRESS.md`、源码再读一遍。本仓 HARNESS 20–32 KB，加上按需源码，**通常比一次压缩更贵**。
- 而且**新会话同样会跑到 90%**（用户实测多个新会话仍触发 tier-3 自动总结）。「新会话 = 不压缩」这个前提本身不成立。

**结论**：会话生命周期不因省成本而改变。压缩时机由 operator 判定（规则：剩余约 20% + 小阶段目标完成），机器只兜底。

## D2 cmd 的自动压缩三档（实测，dsh/cmd 1.88.5）

| 已用 | 行为 |
|---|---|
| 50% | 修剪旧工具调用（保留最近 20 次） |
| 80% | 再修剪（保留最近 10 次） |
| 90% | 完整总结（tier 3） |

operator 的「**剩余** 20%」（= 已用 80%）正好落在「自动修剪已发生、自动总结尚未发生」的区间，所以主动 `/compact` 的价值是**接管选择权**（决定保留什么），不是省一次操作。

## D3 只抄 superagent 的 Ticket / Mandate，不抄它的全部

用户明确：*"其实 superagent 在我们这里比较有价值的就是 Ticket / Mandate 这两个，它们决定一个任务进来后处理不乱。"*

但**落地方式不是移植代码，而是直接用它**——因为 Web 面板（`src/client/`，4037 行）是体验的一部分，砍掉它整个方案就残了；而"agent 改多错多"，重写 2500 行 core 是风险最高的选项。

评估过的三条路：

| 路线 | 依赖 | 判定 |
|---|---|---|
| A. 装 DSH 全栈 + 加 Source | DSH | **采用** |
| B. 用 DSH worker + 自写 CaoExecutor | 两边绑 | 否决：要改 `Sessions`，是改核心 |
| C. 移植 `src/core` + 写适配器 | 无 | 否决：丢面板体验，且重写风险高 |

`src/core` 本身是干净的（2088 行、零 DSH 依赖、零 I/O），所以 C 在技术上可行——**否决它是因为体验和工作量，不是因为耦合重**。

## D4 CAO 只保留"硬件"，编排全部让给 superagent

用户的原话式判断：*"CAO 更像是一个可用的调度壳（因为它只含硬件，但是不附带一个好用的软件）"*。

CAO 给了：进程管理（tmux）、消息投递（inbox）、工具授权、持久化、崩溃恢复。
CAO 没给：消息分级、发言权分离、任务状态机、授权凭证、降噪规则、scope 边界。

**所以对 CAO 做减法，但只做"不授权"，不做"删代码"**——`.build/cao-src` 是从上游 tag 克隆的工作副本，任何源码改动都会被 `revert.sh`/`install.sh` 抹掉。自定义只能留在 `tools/cao/` 这一层。

## D5 降噪靠架构，不靠规则

用户的痛点：*"spv 和 worker 间收发消息会淹没我的跟 spv 的交流。"*

**根因不是消息太多，而是"消息承担了状态的职责"。**

superagent 的解法是两层独立过滤：

| 层 | 机制 | 效果 |
|---|---|---|
| 策略层 | `reportRelay()` 里 `if (state === 'progress') return undefined` | 进度**不进 relay 队列** |
| 类型层 | `ReplyRequest` 的 purpose 只有 `acknowledgement / answer / result / attention` | **根本没有 progress 这个 purpose** |

即使有人改了第一层，第二层还挡着。**这就是"架构保证"的含义**——所以不要在本项目里加任何"消息分级规则"，那是在架构之上叠规则，反而更脆。

## D6 信息流：入口会话在 superagent 外层

用户拍定的形状：

```
用户自然语言 → 入口会话（cwd=bioagentforge）→ [spv Source] → superagent 的 Eval → Ticket → worker
```

**"入口会话"不是 superagent 的主会话。** 它们是两个不同的东西：

- superagent 的主会话是**后台进程**，用户的界面是 GitHub/飞书，人不会"进去打字"。
- 我们的入口会话是一个 **cmd 终端**，专门给用户打字，通过 `spv` Source 把任务灌进去。

这样用户只面对一个窗口，而 superagent 的全部内部噪音（worker 汇报、Eval 过程）都到不了这里。

**不要试图把入口会话做成 superagent 的主会话**——那需要人机对话界面，而 superagent 的主会话设计上不是干这个的。

## D7 worker 的 cwd 按项目分隔，靠 `.git` 实现

目标：SPV（cwd = 仓库根）和 worker（cwd = `tools/<项目>` 或 `research/<任务>`）读到**不同的 `AGENTS.md`**。

机制（实测确认）：

```js
findProjectRoot(cwd, markers=[".git"])   // 从 cwd 向上找第一个含 .git 的目录
ancestorChain(projectRoot, cwd)          // 只在这条链上加载 AGENTS.md
```

| cwd | 加载 |
|---|---|
| `bioagentforge/` | 只有根版 |
| `.../tools/proj/`（自带 `.git`） | **只有 proj 版，根版不加载** |

**所以 2026-11-11 把 `tools/` 下 20 个目录全部拆成独立 git 仓库**。这不是整理癖，而是这个隔离机制的**唯一实现方式**，不能靠提示词约定替代。

注意：`~/.dsh/AGENTS.md` 这类用户全局文件**总是加载**，是唯一会突破隔离的位置。目前不存在。

## D8 dsh 版本必须锁 `0.2.1-rc.3`

superagent 的 `engines.dsh = ^0.2.1-alpha.2`。semver 对 `0.x` 预发布版的规则使得 `0.2.2-rc.1` **不满足**（实测）：

```
0.2.1-alpha.2  SATISFIES
0.2.1-rc.3     SATISFIES   ← 用这个
0.2.2-rc.1     NOT satisfied
```

`dsh-tui@0.19.0` 的 peer 列表**包含 `0.2.1-rc.3`**，所以两个 profile 能共用同一个全局 dsh。

**`dsh-tui update` 会把 dsh 升回 `0.2.2-rc.1`**，届时 superagent 加载失败。升级后须手动降回，并带 `--allow-scripts`（否则 `node-pty` 不编译）。

## D9 GOAT 套餐可以驱动任意 harness（已实测）

曾误以为 "BYOK" 就是"key 出去"。**方向正相反**：

| | 方向 | 说明 |
|---|---|---|
| **BYOK** | key **进** Command Code | 你带 OpenAI/Anthropic 的 key 给 cmd 用，**不消耗套餐额度** |
| **Provider API** | key **出去** | Command Code 给 endpoint，**任何客户端可调**，**消耗套餐额度** |

我们要的是后者。官方原文（`/docs/provider`）：*"any client or agent can use them. No lock-in. Use it anywhere."*

实测（本机 key 来自 `~/.commandcode/auth.json` 的 `apiKey`）：

```
GET  /provider/v1/models      → 200，97 个模型
GET  + Bearer                 → 200
POST /provider/v1/messages    → 200，返回 "OK"，usage 正常
```

**风险**：CLI 与 API **共用同一份额度**，窗口是 5 小时 $20 / 每周 $50。superagent 的 Eval + worker 都会吃额度，所以 `maxWorkers=2`，并先用 `observe` 模式观察。

## D10 不为了"可移植"而自建 Ticket 层

曾建议用 cmd 的 `task_create/task_update` 当任务表（它支持 `COMMAND_CODE_TASK_LIST_ID` 环境变量，能跨终端共享）。**已被否决**：

1. 换 harness 就废了——与"工具要能独立活"冲突。
2. 更根本的原因：它是**一堆独立 JSON 文件，没有事务**。而 superagent 的核心要求是「accept 时 Ticket + Mandate + Assignment + Subscription + 回执**原子创建**」，靠独立文件永远做不到。

**所以任务状态必须落在 superagent 自己的 SQLite 里，不另建表。**

## D11 `scope` / `blocked` 防不住范围蔓延，只让它可追溯

stack 上只有 `guard` 是机械约束（代码判断 `!liveTicket(ticket)` 就拒绝所有工具调用）。`scope` 和 `blocked` 都是**模型判断**，靠提示词。

superagent 让它们相对可靠的手段是「把模型判断变成可校验的结构」——`assessmentOutcome` 有 4 道代码校验：

1. 每条启用的规则都必须有判断（少一条就抛错）
2. `direction` 必须明确
3. 至少匹配一条规则
4. 必须有 `intent_evidence`（缺了直接抛错）

**它防的不是"模型判断出错"，而是"模型跳过判断"。**

对我们自己写的 `spv` Source：**不要指望 scope 能拦住范围蔓延**，要接受"记录完整、事后可追溯"就是上限。

## D12 `guard`（工单结束收回所有工具）在本场景用不上

superagent 的 `guard` 目的**不是省资源，也不是防越权**，而是让授权无法绕过：

> 工单结束后人发一条消息就能 resume（不走 Eval），如果工具一直留着，等于"一次授权、永久干活"，Mandate 形同虚设。
> **Tools follow authorization, not the process.**

本场景碰不到：Source 只有用户本人（或用户转述），不存在"冒充授权"。**保留这个机制但不用它**，也不去模拟它（CAO 的 `allowedTools` 是启动时写死的，本来也模拟不了）。

## D13 不要依赖 cmd 的专有特性做架构基础

cmd 的 `task_*`、`taste 学习`、`COMMAND_CODE_TASK_LIST_ID` 等都很好用，但**把它们当架构基础就等于绑死 harness**。能够依赖的只有标准化的东西（文件、SQLite、HTTP、git）。

`tools/cao` 里给 cmd 打的 taste 补丁是例外——它是**运维便利**，不是架构依赖，丢了不影响系统运行（`status.sh` 会报 FAIL 提醒重打）。

## 参考索引

| 资料 | 位置 |
|---|---|
| superagent 设计文档（9 篇） | `docs/repositories/dsh-superagent-prototype/docs/` |
| DSH 安装与 GOAT 接入 | `docs/setup/dsh-commandcode.md` |
| superagent 源码 | `tools/dsh-superagent/`（独立仓库） |
| CAO 旧方案（归档） | `tools/cao/ARCHITECTURE.md` |
