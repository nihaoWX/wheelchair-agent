# 插口契约：事件表、内建行、PR 身份

> 分册：`ARCHITECTURE/hooks.md` 是插口总览；本文的小节编号在本文件内重新编号。

## 0. 三条硬边界

核心事件（`ticket.started|acknowledged|delivered|attention`、`inbox.approved|issue|merged`、`spv.dispatch`）上可以
挂**用户脚本**，手感对齐 superagent 的 `executor.prepare`。事件表的唯一实现在 `src/shared/hook-events.js`，
本文件与 `execution.md`/`runtime.md`/`surfaces.md` 是完整契约；先把三条硬边界放在最前面：

1. **core path 不可配置、不可取消**：review 落盘、notice 进队列、合并后的 `git pull --ff-only`、队列的 rename 消费
   永远发生。hook 失败、超时、输出洪水只记账，**不 gate、不包裹、不重试** core path。
2. **写设置只有一条路**：`wheelchair-agent hook …`（revision 校验，过期即 409 且不落盘）；没有手改
   `settings.json` 的路径，也没有"取消内建行"的开关——内建行只描述、不执行。
3. **脚本环境是白名单**：payload 走 stdin 的 JSON + 几个 `WCA_*` 变量；`*TOKEN*` / `*SECRET*` / `GH_*` / `DSH_*`
   一律不传。


## 1. 事件表

表在 `src/shared/hook-events.js`（唯一实现）。`wheelchair-agent hook events` 打印它，`hook prompt <event>`
从它生成中文提示词。

| 事件 id | 什么时候触发 | 能重复吗 | 内建行 | 内建行可取消 |
|---|---|---|---|---|
| `ticket.started` | prepare 成功结束之后（脚本可能在 worker 启动后才跑） | 能（工单复活后会重新启动） | `builtin:prepare` | 否 |
| `ticket.acknowledged` | 队列里出现 `kind: "acknowledgement"` | 能 | — | —（没有内建行） |
| `ticket.delivered` | 队列里出现 `kind: "reply"` | 能 | `builtin:injection`、`builtin:archiveSession`、`builtin:autoMerge` | 否 |
| `ticket.attention` | 队列里出现 `kind: "notice"` | 能 | `builtin:injection` | 否 |
| `inbox.approved` | 操作者在收件箱点「通过」 | 能（同一 item 可再次审查） | `builtin:reviewRecord` | 否 |
| `inbox.issue` | 操作者标「有问题」并写评论 | 能 | `builtin:prIssue`、`builtin:spvObjection` | 否 |
| `inbox.merged` | PR 被观察为 MERGED 且 `--ff-only` pull 完成 | 不能（item 上记 `mergeHandledAt`） | `builtin:mergePull`、`builtin:coldInstallNotice` | 否 |
| `spv.dispatch` | SPV 把任务写进 `pending/` | 能 | — | — |

「内建行可取消」一列：带 core-path 内建行的事件是**否**；只有自定义脚本的事件（`ticket.acknowledged` /
`spv.dispatch`）没有 core path 可保护，所以是**是**。自定义行在任何事件上都能删。

`builtin:injection` 同时属于 `ticket.delivered` 与 `ticket.attention`：注入器把 reply 与 notice 一视同仁地用
`injection` 模板推进 SPV 会话，所以这是**一行两个事件**，不是两行同 id 的复制。
`wheelchair-agent hook events` 打印的就是这个布尔值。

每个事件的完整含义、触发时机、重复说明与负载字段都在 `EVENTS` 的 `explanation` / `when` /
`repeatNote` / `payload` 里；本文件不重复那段散文。

### 没有 `ticket.ended`

队列只能看到 acknowledgement / reply / notice，**看不到工单的终态结果**。一个叫 `ticket.ended` 的事件会在
以后被当成「结束了」来用，而它其实只是「worker 又说了一句话」。要终态，先解决下一节的 PR 身份问题，再
另开事件；现在**不要**编一个。

### `ticket.delivered` 不是终态

`ticket.delivered` 的定义是「worker 报告了这次的结果」，也就是本项目里「worker 完成了」的意思。但一张工单
可以被后续消息**复活**，然后再次报告；因此它不是终态，也不该拿来触发「合并 PR 之后」的动作。合并那一侧
有自己的事件（`inbox.merged`），冷安装挂在那里——挂在 worker 的报告上会在 PR 存在之前就触发。

---


## 2. 内建行（core path，不可取消）

内建行是**数据，不是脚本**。面板只展示；执行仍在各自实现里。它们全部 `cancellable: false`，因为它们就是
core path 本身。

| 行 id | 事件 | 说明 | 文本可改 | 指向 |
|---|---|---|---|---|
| `builtin:prepare` | `ticket.started` | superagent 的 prepare 命令 | 否 | `pointer: executor.prepare`（住在 superagent 设置里，**不复制、不遮蔽**） |
| `builtin:injection` | `ticket.delivered`、`ticket.attention` | reply/notice 注入 SPV 会话 | 是 | `template: injection` |
| `builtin:prIssue` | `inbox.issue` | PR 质疑转成 SPV notice | 是 | `template: prIssue` |
| `builtin:spvObjection` | `inbox.issue` | 对 SPV 决策信的质疑 | 是 | `template: spvObjection` |
| `builtin:reviewRecord` | `inbox.approved` | 把「通过」追加到 item | 否 | — |
| `builtin:mergePull` | `inbox.merged` | 合并后 `git pull --ff-only` | 否 | — |
| `builtin:coldInstallNotice` | `inbox.merged` | 安装目标仓库合并后的冷安装提醒 | 否 | — |
| `builtin:archiveSession` | `ticket.delivered` | 交付后归档 worker 会话（`worker-<ticketId>`） | 否 | — |
| `builtin:autoMerge` | `ticket.delivered` | `merge.autoMerge` 打开时把工单 PR squash 合并（五道闸门） | 否 | — |

「文本可改」的三行走**已有模板 id**（`src/shared/settings.js` 的 `TEMPLATE_SPECS`），不新增文本；改模板就
是改面板「设置」里的那几个模板。`rename` 只改显示标签，不改行为。

### `builtin:archiveSession` 跑在 runner 里，不在 items 循环里

内容（dsh 归档是什么、日志留在原地、可取消、下次唤醒前 superagent 会 `revive()`、为什么"移走会话目录"
不是归档）见 `docs/dsh/session-archive.md`。这里是**执行位置**的契约：

- `src/shared/hooks.js` 的 `runHooksFor()` 在 `items.length === 0` 时认领 occurrence 后**提前返回**。delivered
  通常没有自定义行，所以效果不能挂在那个循环里，否则会被跳过。runner（`src/spv/hook-runner.js`）在每次
  `runHooksFor()` 之后按 `builtinRowsFor(event)` 调用 `effects[rowId]`，**只在 occurrence 真的被认领时**
  （`skipped === 'paused' | 'cursor'` 跳过，`skipped === 'empty'` 照跑）。
- 效果是**服务侧实现**，由 `webui/lib/index.js` 用 `ctx.get('workspaceRegistry')` / `ctx.get('jobs')`
  注入（懒取 + 最多 5s 等待，且只有第一次 delivered 花这个等待）；没有这两个服务时降级成一行 warning，
  不归档、不失败。纯 Node 的 `src/spv/archive-effect.js` 不 import dsh，测试用假实现。
- `stopActivity: false`：归档从不杀 turn / subagent / job。会话还有 `running` / `stopping` 的 job 时**整个跳过**
  ——job 结束后的唤醒不走 `revive()`，归档落下会把那次唤醒拒成 `blocked`；这种会话留给 `ticket.ended` 的
  归档（那条路径先杀 job）。
- turn 尚未结束时 `archiveSession` 抛 `WorkspaceActiveSessionError` → 效果返回 `{ retry: true }`，runner 在后续
  drain 里最多重试 `EFFECT_MAX_RETRIES = 3` 次；单次效果有 `EFFECT_TIMEOUT_MS = 15_000` 上限（超时不重试、
  只记 warning），因为效果跑在串行 drain 里，一个永不 settle 的调用会让所有 hook 脚本停摆。
  会话从未创建（`WorkspaceUnknownSessionError`）→ 静默，不 warning。
- 效果**永不抛**：任何失败只走 `wheelchair-hooks: warning: …` 日志，绝不影响用户脚本与下一条事件。

### `builtin:autoMerge`：PR 身份从工单 clone 反推，五道闸门全绿才合并

负载里仍然没有 PR（见本文件 §3），所以效果自己找：`work-plan` 给出该工单的执行目录（目录名以 `ticketId` 前 12
位结尾，**必须唯一匹配**，0 或 2 个都当作读不到）→ 目录里 `git rev-parse --abbrev-ref HEAD` 取分支、
`git config --get remote.origin.url` 取仓库（只认 github.com 的 https/ssh/scp 形状）→
`gh pr list --repo <owner/name> --head <branch> --state open --json number,url,isDraft,mergeable,mergeStateStatus,statusCheckRollup,files,headRefName,headRepository`。

五道闸门（任一条不成立只记一行日志，**不合并**）：恰好一个 open PR 且 `headRefName`/`headRepository`
都与 clone 一致（fork 的同名分支不算）；`isDraft === false`；`mergeable === 'MERGEABLE'`；
`statusCheckRollup` **非空且全部 SUCCESS**（`CheckRun` 看 `conclusion`、`StatusContext` 看 `state`；空列表等于
"没有 CI"，记 `no CI checks`，不合并——`dsh-superagent` 就是这种仓库，只能由人合）；`files` 不含
`ARCHITECTURE.md`、`ARCHITECTURE/**`、`PROGRESS.md`、`INSTRUCTIONS.md`（HARNESS 归操作者）。

合并命令固定 `gh pr merge <n> --repo <owner/name> --squash --delete-branch`；之后**不 pull、不发冷安装通知**，
那是 `inbox.merged` 那条 core path 的事（watcher 会自己观察到 MERGED）。开关 `merge.autoMerge` 默认 `false`，
因为它等于跳过人工审查。gh 二进制取法与收件箱一致（参数 → `$SPV_GH` → `gh`）。

超时：这个效果由 host 以 `{ run, timeoutMs: 120_000 }` 注册，`src/spv/hook-runner.js` 允许逐项覆盖默认的
`EFFECT_TIMEOUT_MS = 15_000`。代价要写清：效果跑在**串行** drain 里，120s 的上限意味着最坏情况下后续 hook
脚本推迟两分钟；`archiveSession` 仍用 15s。超时不重试（卡住的 gh 再等一轮也一样），只记 warning。
"已合并过"的 PR 与已成功合并的工单各有一份内存集合，进程重启后靠"没有 open PR"自然幂等。


---


## 3. PR 身份：负载里没有，只能事后反推

`ticket.delivered` 的负载来自队列消息，只有 `ticketId` 与 `thread`——**没有 PR 号、仓库或 url**。stage 2 按
assignment 只搬运消息里真实存在的字段，**不发明** outcome/PR 字段；这条约束仍然有效。

所以"合并 PR"这类需要 PR 身份的动作不在负载里找答案，而是从工单自己的 clone 反推（`builtin:autoMerge`，
见 §2）。这条路径的代价写在明处：**clone 被回收之后就读不到**（`work-plan` 找不到唯一目录、或目录里的
`origin` 不是 github.com），此时效果只记一行日志、不合并。要更早的身份，只能改 reply 负载——那属于
superagent 侧的改动，本项目的禁令下不做。

`inbox.merged` 仍然有完整 PR 字段（`pr` / `repo` / `url` / `mergeCommit` / `pulledSha`），所以**合并之后**的动作
（pull、冷安装提醒）继续挂在那里；两个事件的职责不重叠。

---
