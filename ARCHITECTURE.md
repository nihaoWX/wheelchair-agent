# Definition

`wheelchair-agent` 是一个依赖 superagent 的轮椅流 agent。用户取这个名字就是因为它的运行方式对用户很友好：
用户只需要与 spv 一个 agent 对话，spv 管多项目长期大目标，spv 代替用户监督/跟进多个 worker，近乎全自动运行，
当然用户也可以具体下场到 worker 具体跟进。

用户期望：

- **`superagent` 的流程原封不动**：superagent 的原生机制已经很适合轮椅流理念，只差一个外层触发 superagent
  流程的入口，这个入口就是 spv。
- **用户自然语言对话 spv**：用户在一个 dsh 会话（这个 agent 身份就是 spv）（cwd = 管理所有仓库的顶层目录，
  默认 `~/bioagentforge`，可用 `SPV_PROJECTS_ROOT` 换）里打字，由它派活；不再由用户直接对 worker 说话，但用户也可以具体下场跟进某个 worker。
- **每个 worker 只管相应项目**：管某个工具则 worker 的 cwd 是 `tools/<a tool>`，推进某个研究任务则是
  `research/<a task>`。靠"目录内有无 `.git`"让 DSH 的 `ancestorChain` 停在项目根，从而只加载该项目的
  `AGENTS.md`。
- **一个命令入口**：`wheelchair-agent`。`install.sh` 只负责把它装进电脑，没有别的功能。

## 已定型的约束

讨论已经结束的结论（压缩时机、maxWorkers、派单入口、交付目标、长任务……）全部落定在
**`ARCHITECTURE/decisions.md`**，每条附证据或实测结果。**不要重新推导，也不要在本文件复述。**

# Structure

本文件只留「读一次就够」的东西：定义、分册索引、角色与信息流。**任何一节的细节都在分册里，不在本文件重复**
——同一条规则写两处，下一个人就会改一处忘一处。

## 分册索引

| 想知道 | 读 |
|---|---|
| SPV 与 superagent 是两个程序、三个 dsh 插件入口为何不能合并 | `ARCHITECTURE/boundaries.md` |
| 一个核心 + 两个适配器、子命令表、面板值为什么是命令名 | `ARCHITECTURE/cli.md` |
| 目录布局全树、三条机械可查的规则、`install.sh` 的冷安装契约 | `ARCHITECTURE/layout.md` |
| 面板：功能宿主、加载方式、审查模型、布局与样式、设置页、插口段、截图 | `ARCHITECTURE/webui/index.md`（+ `settings.md` / `hooks.md` / `screenshots.md`） |
| 插口（hooks）：事件表、内建行、设置与执行契约、cursor/队列原语、CLI 与实现位置 | `ARCHITECTURE/hooks.md`（+ `hooks/{contract,execution,runtime,surfaces}.md`） |
| `/restart-wheelchair-agent` 重启链与冷安装顺序 | `ARCHITECTURE/restart.md`（+ `restart/{order,narrator,lease,operations}.md`） |
| spv Source（本机队列接入 superagent）与数据根边界 | `ARCHITECTURE/spv-source.md` |
| 票目录回收（`work gc`）与挂载时的自动回收 | `ARCHITECTURE/work-gc.md` |
| SPV preset 怎么装/起/用、标准工具从哪来、模块解析、superagent profile 配置现状 | `ARCHITECTURE/preset.md` |
| 交付目标：仓库随项目走、受管 `AGENTS.md` 的六条约束 | `ARCHITECTURE/preset.md` |
| 一仓一部署：注册表、派单路由、安装/服务/收件箱的分阶段改造 | `ARCHITECTURE/deployments.md` |
| spv 项目（spv 根 → worker 项目的绑定）、四条校验、面板「项目」段 | `ARCHITECTURE/spv-projects.md` |
| Rust 核心：边界、JSON 契约、为什么不是 `.node`、分发待办 | `ARCHITECTURE/core.md` |
| 已定型的结论（每条附证据，**勿重新推导**） | `ARCHITECTURE/decisions.md` |
| 已踩过的坑（一条一个问题） | `docs/PITFALLS/` |
| superagent 设计文档（9 篇） | `docs/repositories/dsh-superagent-prototype/docs/` |
| DSH 安装与 GOAT 接入 | `docs/setup/dsh-commandcode.md` |
| AGENTS.md 模板（项目开发 / 研究任务） | `docs/agentsmd-examples/` |
| 会话归档：dsh 原生归档是什么、为什么移动目录不行、`ticket.delivered`→`ticket.ended` 的缺口 | `docs/dsh/session-archive.md` |
| superagent 源码 | `~/opt/dsh-plugins/dsh-superagent/`（独立仓库，在 bioagentforge 工作区之外） |

## 目录布局（压缩版）

```
wheelchair-agent/
├── bin/wheelchair-agent.mjs       # 唯一入口：argv 解析 + process.exit
├── src/shared/ src/superagent/ src/spv/   # 核心库 / superagent 插件 / SPV preset 与 CLI
├── preset/                        # 装到 ~/.dsh/.agent-presets/spv/
├── commands/                      # prepare.sh / jobctl.py / superagent-service.py（装成独立命令）
├── webui/                         # 独立 dsh web client 包 wheelchair-agent-webui（截图在 webui/docs/）
├── crates/wca-core/                # Rust 核心：wheelchair-agent-core（独立进程，见 ARCHITECTURE/core.md）
├── build/ tests/                  # 构建步骤 / 离线证据（CI 逐个跑）
├── install.sh                     # 只负责安装（冷安装）
├── ARCHITECTURE.md ARCHITECTURE/  # 本文件（定义 + 索引）与分册
├── PROGRESS.md INSTRUCTIONS.md AGENTS.md
└── docs/                          # 只剩 PITFALLS/、setup/、agentsmd-examples/
```

完整树、三条机械可查的规则与 `install.sh` 的冷安装契约：`ARCHITECTURE/layout.md`。

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
