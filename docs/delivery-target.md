# 交付目标：仓库随项目走

**这份文档记录一个还没实现的方向，以及为什么它不能靠配置解决。** 后续在 dsh 那边接手的 agent
读这一份就能明白现状，不必重新推导。

## 问题

`spv` 派发的任务自带项目路径（`project`，如 `tools/pitfalls-manager`），但 worker 环境里的
`DSH_SUPERAGENT_GITHUB_REPOSITORY` 始终是面板配置的那一个（`nihaoWX/bioagentforge`）。
两者可以指向完全不同的项目，而环境里**没有任何标记**说明后者是兜底值。

已发生的后果：一个 `project: tools/pitfalls-manager` 的任务要求开 PR，worker 把分支推到
`nihaoWX/bioagentforge` 并在那里开了 PR #1。改动后来在正确的仓库落地（`79908d7`），但错仓 PR
已经发生且全程无警告。

## 为什么这就是全部可查事实

三条绕行路都已实测堵死（证据在 `docs/PITFALLS/` 报告的复现步骤 D）：

| 想法 | 为什么不行 |
|---|---|
| 关掉 github Source | 注入会停，但 setup 仍无条件要求仓库非空（`deployment.ts:91` 抛 `repositoryUnset`），服务停在 `setupPending`，连 `spv` 一起不工作 |
| 让 `spv` 声明同名变量 | 不会覆盖，只会并排渲染成两行，worker 无从判断哪行算数 |
| 让编排器去盯第二个仓库 | `commands.ts:96` 抛 `GitHub calls are restricted to the configured repository` |

**结论：冲突不能靠配置消除，只能靠"另给一个可分辨的值 + 明确说明谁覆盖谁"。**

## 项目分布（2026-11-13 实测，交接时复核）

```
tools/    19 个目录，全部有 .git
          ├─ 3 个有 GitHub remote：manuscripts_skills / pitfalls-manager / svg_grid
          ├─ 15 个完全没有 remote
          └─ 1 个（dsh-superagent）remote 是本机路径
          → 16/19 推不出 GitHub 仓库

research/ 11 个目录
          ├─ 6 个连 .git 都没有
          └─ 全部 11 个都没有 AGENTS.md
          → 且根 AGENTS.md 规定：research/ 是 local-only，永不推送
```

**关键区分**：真正缺 remote 的是 `tools/` 里那 15 个"有版本库、没有远端"的项目，
而不是"没有 `.git`"的项目。这两种情况不能合并处理。

## 工单工作副本的默认推送目标是本机路径

```
$ git -C ~/.dsh/state/superagent/work/<ticket>/ remote -v
origin  /home/nihao/bioagentforge/tools/wheelchair-agent (fetch)
origin  /home/nihao/bioagentforge/tools/wheelchair-agent (push)
```

**原因是 prepare 命令用 `git clone <本地路径>`**——新 clone 的 `origin` 指向那个本地路径，
而不是原来的 GitHub remote。所以 worker 在那个目录里 `gh pr create` 找不到 GitHub remote，
退回环境变量里的面板值。

**这一点很重要**：即使给所有项目都建好了 GitHub 仓库，只要 prepare 仍用本地路径 clone，
worker 依然拿不到正确 remote。

## 交付契约的默认值

`prompts/work.md:35`：

> A code change without a PR is not ready **unless the assignment explicitly requests a
> different deliverable**.

所以对没有远端、也不该有远端的项目（如 `research/`），任务写明"交付物是本地 commit"即可，
worker 不会去开 PR。**但默认值仍是 PR**：任务没写清时，worker 要么报 blocked，要么拿环境里
那个仓库去推——后者正是 PR #1 的成因。

## 已定的解决方向（用户 2026-11-13 确定）

**不与环境变量里的单值对抗，而是给 worker 一份它读得到的 AGENTS.md，说明这个项目该不该推送。**

理由是 worker 只读自己 cwd 下的 `AGENTS.md`（见 `ARCHITECTURE.md` 的「AGENTS.md 的隔离靠
`.git`」），而"这个项目该不该有远端"这条信息目前**既不在 worker 能读到的地方，也没有统一来源**。

两份模板已写好，放在 `docs/agentsmd-examples/`：

| 模板 | 给谁 | 关键约定 |
|---|---|---|
| `proj-dev-agentsmd.md` | `tools/<a tool>`（项目开发） | 项目有自己的 git 仓库；worker 是 Arranger，派 Executor |
| `research-task-agentsmd.md` | `research/<a task>`（研究任务） | **`GIT` 一节明写 local-only、永不推送、只提交本地 commit** |

模板与根 `AGENTS.md` 的差异是刻意的：项目版上限 20 KB（根版 10 KB）、删掉根目录专属章节
（`Key folders`、`research/`、`docs/repositories/`），并把 `# AGENT ROLE` 从 SUPERVISOR 改为
**WORKER**。

## 实现时要遵守的约束（来自报告的「建议」一节）

这些是用户明确提出的要求，不是可选优化：

1. **补齐远端只能建私有仓库**，不得创建任何公开可见的远端。
2. **补齐会创建外部状态**（真实存在的远端仓库），因此必须可追溯：仓库名、可见性、归属都要有确定
   来源，失败时要说清哪一步没成。
3. **必须尊重项目自身的性质**：`research/` 被规定 local-only，这类项目**不应该**被自动配上远端。
   系统需要能区分"该有远端"和"不该有远端"，不能对所有缺 remote 的项目一视同仁。
4. **每个工单的工作副本都应当自带一份与项目类型匹配的 AGENTS.md**，因为 worker 读不到工作区
   根目录的约定。
5. **这份 AGENTS.md 应当是受管的**：缺失时自动补、内容过期时自动更新，而不是"有就不管"。
   否则旧副本会长期压过新规则。
6. **权威来源必须随工具安装到用户级位置**，让派发侧能稳定找到它，而不是把某个开发树路径写死
   在派发逻辑里。

## 与已有约束的关系

这份文档不推翻 `ARCHITECTURE.md` 里任何一条已定型的决定。它补的是：

- 长任务那套（`jobctl`）解决"作业活不过 worker 回合"；
- `/spv-cron` 解决"漏挂的作业一小时内被发现"；
- **这份文档解决"worker 把结果交付到错误的仓库"**。

三者互不依赖。

## 参考资料

| 资料 | 位置 |
|---|---|
| 完整调查（现象、6 组复现步骤、全部实测数字） | `docs/PITFALLS/wheelchair-agent-建议-仓库随项目走.md` |
| 项目开发类 AGENTS.md 模板 | `docs/agentsmd-examples/proj-dev-agentsmd.md` |
| 研究任务类 AGENTS.md 模板 | `docs/agentsmd-examples/research-task-agentsmd.md` |
| superagent 的交付契约与合并规则 | `tools/dsh-superagent/prompts/work.md`、`prompts/team/delivery.md` |
