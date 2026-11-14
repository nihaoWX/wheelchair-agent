# 交付目标：仓库随项目走

**这份文档记录这个方向的结论与实现。** 后续接手的 agent 读这一份就能明白现状，不必重新推导。

**状态（2026-11-14）**：**已实现**。三部分：`install.sh` 把两份模板与 `prepare.sh` 装到
`~/.dsh/.agent-presets/spv/`；面板的 prepare 命令改为
`sh /home/nihao/.dsh/.agent-presets/spv/prepare.sh`（绝对路径）；
该脚本负责 clone、受管 `AGENTS.md`、以及 `tools/` 项目的私有 GitHub 远端。账本 `R2-F1` 的
`deferred` 到此关闭。

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

## 实现（2026-11-14）

| 部分 | 位置 | 做什么 |
|---|---|---|
| 模板与脚本的安装 | `install.sh` 的 `render_into` | 把 `dsh/prepare.sh` 与 `docs/agentsmd-examples/*.md` 拷进 `~/.dsh/.agent-presets/spv/`（`prepare.sh` 与 `agentsmd-examples/`）；白名单与 `--check` 同步更新 |
| 面板的 prepare 命令 | 面板 Settings → Execution | `sh <preset 目录>/prepare.sh` 的绝对路径（`install.sh` 结束时打印；已通过管理 API 保存）。**不能写 `$DSH_HOME`**：prepare 命令跑在子进程里，`DSH_*` 名字会被剥掉，引用会静默退回 |
| 脚本本体 | `dsh/prepare.sh` | clone → 受管 `AGENTS.md` → `tools/` 的私有远端与工单 origin |
| 可跑证据 | `scripts/test-prepare.sh` | 77 条断言，用假 `gh` + 本地裸仓库，不碰 github.com |

`prepare.sh` 的行为，按顺序：

1. **项目来源**：`$DSH_SUPERAGENT_SPV_PROJECT`；为空时退回 `$SPV_PROJECTS_ROOT/.superagent-project`
   （默认根 `$HOME/bioagentforge`），与旧 prepare 命令的兜底一致。两者都没有 ⇒ 失败并点名。
2. **`tools/` 且没有 `.git`** ⇒ `git init -b main` 并把现有文件提交为初始 commit（作者是 gh 账号，
   邮箱用 `<id>+<login>@users.noreply.github.com`）。`research/` 永不 init。
3. **clone**：有 `.git` 用 `git clone --no-hardlinks`，没有就 `rsync -a --exclude .git`（没有 rsync
   时退回 `cp -a`）。
   目录已存在且非空 ⇒ 不重复 clone（与 superagent「已存在即视为已准备」一致）。
4. **`AGENTS.md`**：`tools/*` → `proj-dev-agentsmd.md`，`research/*` → `research-task-agentsmd.md`。
   缺失就装，内容不同就覆盖（模板是唯一真源）。受管文件不进入 `git status`：未跟踪的写进
   `.git/info/exclude`，已跟踪的用 `skip-worktree`（代价：上游改了 `AGENTS.md` 时 rebase/merge
   会以 "local changes would be overwritten" 停下——响亮且可恢复，好过它悄悄进 PR）。
5. **`tools/` 的远端**：项目已有 GitHub remote ⇒ 直接用（若它是 PUBLIC，打一行 WARNING——约束 1
   禁止**创建**公开仓库，不禁止使用项目本来就有的）；没有 ⇒ 用 `gh repo create <owner>/<name>
   --private` 建私有仓库、加 remote、推当前分支。名字已被占用时：私有且仍为空 ⇒ 接管（上次跑到一半
   失败可恢复）；公开或已有分支 ⇒ 拒绝并让人处理。`research/` 完全不进这一段。
6. **工单 origin**：`git remote set-url origin <github url>`（没有就 `add`），并回读
   `remote.origin.url` 校验。读配置值而不是 `remote get-url`，因为后者会应用
   `url.<base>.insteadOf` 改写。

可追溯性：每次创建/接管/推送/改 origin 都写一行到
`<DSH_HOME>/state/superagent/prepare.log`（UTC 时间 + 仓库名 + 归属 + 可见性；路径由脚本自身位置推出，
不读 `$DSH_HOME`——子进程环境里 `DSH_*` 会被剥掉），同时往 stderr 打
`prepare: ...`；失败打 `prepare: FAILED at <step>: <原因>` 并以 1 退出，superagent 会把这段输出
附在失败的工单上。

测试开关（只给测试用，面板命令不带）：`SPV_PREPARE_DRY_RUN=1` 不写项目、不碰 GitHub，只打印
将要做什么；`SPV_PROJECTS_ROOT`、`SPV_PREPARE_TEMPLATES`、`SPV_PREPARE_LOG` 可改路径。

## 与已有约束的关系

这份文档不推翻 `ARCHITECTURE.md` 里任何一条已定型的决定。它补的是：

- 长任务那套（`jobctl`）解决"作业活不过 worker 回合"；
- `/spv-cron` 解决"漏挂的作业一小时内被发现"；
- **这份文档解决"worker 把结果交付到错误的仓库"**。

三者互不依赖。

## 参考资料

| 资料 | 位置 |
|---|---|
| 完整调查（现象、7 组复现步骤、全部实测数字） | 报告已按流程消费后删除，原文取回：`git show 7dae586:docs/PITFALLS/wheelchair-agent-建议-仓库随项目走.md`（账本条目 `R2-F1` / `R3-F2`） |
| 项目开发类 AGENTS.md 模板 | `docs/agentsmd-examples/proj-dev-agentsmd.md` |
| 研究任务类 AGENTS.md 模板 | `docs/agentsmd-examples/research-task-agentsmd.md` |
| prepare 命令本体 | `dsh/prepare.sh` |
| prepare 命令的可跑证据 | `scripts/test-prepare.sh`（`sh scripts/test-prepare.sh`，77 条断言） |
| superagent 的交付契约与合并规则 | `tools/dsh-superagent/prompts/work.md`、`prompts/team/delivery.md` |
