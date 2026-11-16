# spv Source: 本机队列接入 superagent

`spv` 是 dsh-superagent 的一个 **Source 插件**，把本机文件队列里的任务送进 superagent，并把 Channel 写回落回同一队列。
它不依赖 GitHub/飞书，是"入口会话"派活与收结果的唯一通道。

- 插件包：`tools/wheelchair-agent/`（独立 git 仓库，纯 ESM JavaScript，无构建步骤）
- 上游：`~/opt/dsh-plugins/dsh-superagent/`（规范开发树；**只作为 peer 依赖，一个字节的源码都没改**）
- profile 加载点：`~/.dsh/profiles/superagent/cordis.patch.yml`

## 1. 为什么是 Source 而不是改核心

`SourceRegistry.register(kind)` 是 dsh-superagent 的官方扩展点。`kind` 描述"事件如何变成 Trigger、Channel 如何回写、
策略允许谁、环境变量是什么"，插件入口再用 `ctx.effect` 注册 kind 并跑自己的轮询循环。核心（`src/core`）不认识 `spv`，
它只看到一个普通 Source。

关键约束：**`~/opt/dsh-plugins/dsh-superagent/src/` 一个字节都不能改**。所以：

- 需要的 helper（`health`、`key`、`threadKey`）在 `src/superagent/spv.js` 里重写了等价的小函数。
- `SourceContext` 用 `ctx.orchestrator.context(kind)` 拿，不导入 `sourceContext`（`lib/` 没导出它）。
- schema 用自己写的 `src/shared/schema.js`（只实现 `parse`/`safeParse`），**故意不依赖 zod**。理由见 8.2。

## 2. 队列布局与"无 cursor"的消费标记

```
<stateDir>/spv/pending/      # 待处理，一个任务一个 .json（入口会话写）
<stateDir>/spv/done/         # 已消费；rename 到这里即"标记已读"
<stateDir>/spv/done/*.bad    # 解析失败的任务，移到这里不再重试
<stateDir>/spv/outbox/       # Channel 写回，一条消息一个 .json
<stateDir>/spv/outbox/read/  # 被注入器消费的消息移到这里；spv_status 只读，不移动
```

`stateDir` = `/home/nihao/.dsh/state/superagent`（`ctx.deployment.stateDir`，只在 setup 完成后可读）。
`kind.schema` 里的 `queueDir` 可覆盖，留空即默认；改它不需要重启。

**没有 cursor**。`rename(pending/x.json → done/x.json)` 是原子操作，就是消费标记：

- 崩溃后重放缓存的只是"飞来一半"的那个任务；
- Trigger id 由任务 id 派生（`spv:<uuid>`），所以即便重放，Engine 也返回 `duplicate` 而不是又开一张 Ticket。

这两条合起来使队列天然幂等，不需要任何持久状态。

## 3. 为什么任务不走 Assessment

按 `docs/002-authorization.md`，一个 Trigger 成为 **explicit**（直接接单）需要三个条件同时成立：

| 条件 | 我们的取值 | 含义 |
|---|---|---|
| `human` | `true` | 是人写的，不是 bot/CI |
| `addressed` | `'mention'` | 消息确实点名了智能体 |
| `actor.id ∈ policy.allowed` | `operator`（默认） | 在来源的允许名单里 |

三者齐备时，`settingsPolicy().gate()` 直接返回 `strength: 'explicit'`，`orchestrator_route` 可以 accept，
**不经过评估**。少任何一个就会掉进准入表，在 `observe` 模式下不会自动接单。

实测对照：把 `--actor stranger` 发一个任务（不在 allowed 列表里），Decision 是
`ignore / not_a_member / strength: inferred` —— 恰好证明 allowed 列表是生效的那一环。

## 4. 降噪是架构保证

Channel 只收到 `OutboundMessage.kind`，取值范围是 `acknowledgement | reply | notice`。
worker 的 `progress` 在 `app/notices.ts:reportRelay()` 里 `return undefined`，根本不进 outbox 队列；
即使绕过那一层，`ReplyRequest` 的 purpose 也只有 `acknowledgement / answer / result / attention`，**没有 progress**。

所以 `spv` 的 `channel.send` 里不需要任何过滤代码。实测（`smoke-progress` 任务）：

- worker 依次调了 `orchestrator_report{state:progress}` → `orchestrator_ack` → `orchestrator_report{state:ready}`
- `outbox/` 只有 2 个文件：`acknowledgement` 和 `reply`
- SQLite `outbox` 表 4 条 receipt，全部是 ack/reply

## 5. 命令行入口

队列的读写只有一份实现（`src/shared/queue.js` + `src/spv/{dispatch,outbox}.js`），`spv_dispatch` 工具与
`wheelchair-agent` 的 `dispatch` / `status` 子命令都 import 它。**曾经有两个 Python 脚本
（`scripts/spv_send.py` / `spv_read.py`）各写一份，已删除**：两份实现必须永远保持字节兼容，是个真隐患。

```bash
wheelchair-agent dispatch --project tools/foo --task "任务正文" [--thread main] [--preset cordis]
wheelchair-agent status [--thread main]
wheelchair-agent inbox add --title "决定" --body "正文 / @文件" [--thread main]   # 写一封 SPV 决策信
```

任务记录的顶层字段是 `id` / `thread` / `text` / `at` / `source` / `project` / `actor`，外加可选的 `preset`
（dsh agent preset id，例如 `cordis` / `ptc` / `standard`；省略时不写这个字段，superagent 用自己的默认
worker preset）。`triggerOf()` 把除 `text` / `thread` / `actor` 之外的字段整体 spread 进 `meta`，所以
`preset` 自动成为 `trigger.meta.preset`。

**结果不由 CLI 读**：`outbox/` 里的 `reply` / `notice` 由 SPV 会话里的注入器（`src/spv/injector.js`）在后台
消费，并作为一条新的 user 消息推进对话。所以 CLI 只有 `dispatch` / `status`（外加 `check`），没有、也不需要
`result` 子命令。

### 5.0 数据根与 superagent state 的边界

**队列是契约，其余是我们的。** `spv/` 文件队列（以及 superagent 的 `work/`、`orchestrator.sqlite*`、
`worker-bin/`、`worker-gitconfig`）由 superagent 管理，位置仍由 `$DSH_SUPERAGENT_STATE_DIR`
（缺省 `~/.dsh/state/superagent`）决定；两侧必须指向同一个队列，所以这个位置**不搬**。

我们自己的数据在另一个根 `<root>`（缺省 `~/.wheelchair-agent`，`$WHEELCHAIR_AGENT_HOME` 覆盖）：

```
<root>/settings.json                面板设置（旧位置 <stateDir>/panel-settings.json）
<root>/inbox/                       审查收件箱
<root>/records/work-reclaimed.jsonl 工单克隆重建记录
<root>/logs/restart-all.log         重启审计日志
<root>/logs/prepare.log             prepare 追溯日志
```

这样 `rm -rf ~/.dsh/state/superagent`（一次「重置 superagent」）不会带走操作者的审查历史、设置与
重建记录。旧文件由 `src/shared/home.js` 在第一次读取时一次性搬到新位置：新路径不存在且旧路径存在时
才搬，带跨进程锁、幂等、写 `<root>/logs/migration.log`；搬不动就继续读写旧路径。
`$SPV_INBOX_DIR`、`$SPV_PREPARE_LOG` 仍是显式覆盖，优先于 `<root>`。

`SPV_QUEUE_DIR` 覆盖队列根（与插件自身的 `queueDir` 设置同一优先级规则）。队列目录不存在时 `status` 不报错：
`unreadMessages` / `pendingTasks` 把 ENOENT 当成空队列，CLI 打印空列表。`dispatch` 只在 superagent 服务未运行
时失败（健康探针），队列目录本身不是它的前提——`submitTask` 会自己建 `pending/`。

### 5.1 回收工单克隆

`wheelchair-agent work gc` 删除"未使用、干净、提交全已发布"的 ticket 克隆，并把重建所需字段写进
`<root>/records/work-reclaimed.jsonl`（默认 `~/.wheelchair-agent`，`$WHEELCHAIR_AGENT_HOME` 可覆盖）；
`work restored <ticket>` 从这份记录打印可粘贴的重建命令。CLI 与挂载时
`src/superagent/watch.js` 都通过 `src/shared/work.js` 的同一个 `openTicketDirectories()` 保留 open ticket 的
目录（CLI 从服务的 `/orchestrator/api/tickets?state=open` 读取；服务没跑时跳过检查，其它失败则整次保留）。
挂载时还会删除 work root 内目录已消失的 dsh workspace 记录（只删注册行，会话与日志保留）。完整说明见
[work-gc.md](work-gc.md)。

## 6. 收件箱里的 SPV 决策信

操作者的审查收件箱（`src/spv/inbox.js`）不再只装 GitHub PR。每个 item 有 `kind`：

| item | 来源 | 字段 |
|---|---|---|
| `pr` | `wheelchair-agent inbox watch` 轮询 `gh pr list` | `repo` / `pr` / diff / `url` / `body` / `createdAt` / `updatedAt` / `at` |
| `spv_message` | `wheelchair-agent inbox add` 或 SPV 的 `spv_notify` 工具 | `title` / Markdown `body` / `thread` / `at`；没有 `repo`、没有 `pr` |

`spv_message` 的语义是：SPV 在无人看管时碰到需要操作者的事，它自己先做决定，然后写一封信记录**决定了
什么、为什么**。操作者之后在面板里接受（`approve`）或质疑（`issue`）。两条写入入口共用
`createSpvMessage()`，id 形如 `spv-<thread>-<UTC 时间戳>-<4 个随机字符>`，同一秒写两封也不会撞名。

审查语义：

- `approve` 的评论是**可选**的，只追加到 `review`，不派任务、不发 outbox —— 它是操作者接受的理由。
- `issue` on `pr` 与以前一样：写 `review`，然后派 `inbox-<pr>` worker 任务，不发 outbox。
- `issue` on `spv_message`：写 `review`，然后通过 `writeMessage()` 往 spv outbox 写**恰好一条**
  `kind: "notice"` 的消息。id 由信件 id 与 review index 派生（`inbox-<item id>-review-<index>`），
  `thread` 是信件自己的 thread；正文带信件标题、id 与操作者评论原文，所以 SPV 知道被质疑的是哪个决定。
  **不派 worker 任务**，也完全不经过 `checkProject()` 的 repo/pr 预检。

这条 `notice` 由 `src/spv/injector.js` 在 SPV 会话里消费，作为一条新消息出现；它和 worker 停下来的
`notice` 走同一个 outbox 通道，因此队列格式没有第二种。与 worker 的答复一样，注入器只投递**会话挂载之后**
到达的消息：SPV 会话关闭期间写下的质疑会留在 `outbox/`，`spv_status` 能看到，但不会在下次启动时补投。

## 7. 合并 PR 与冷安装通知

收件箱的快照不再是“有人运行 `wheelchair-agent inbox watch` 才更新”的。webui 的 host 半身在
`ctx.effect` 里启动 `startInboxWatcher()`（`src/spv/inbox.js`，与 CLI 的 `inbox watch` 共用同一个
循环），默认每 60 秒轮询一次；插件配置的 `intervalSeconds` 或环境变量 `SPV_INBOX_INTERVAL_SECONDS`
可覆盖，`0` 表示关闭自动轮询。单个仓库或 `gh` 失败只记一行 warning，下一轮继续。

`gh pr list` 额外取 `mergedAt` / `mergeCommit`，item 也记录合并处理的状态：

| 字段 | 含义 |
|---|---|
| `mergedAt` / `mergeCommit` | GitHub 给出的合并时间与合并提交 |
| `mergeObservedAt` | watcher 亲眼看到这次 OPEN → MERGED 的时刻；失败后靠它重试 |
| `mergeHandledAt` | 拉取（以及本仓库需要的 notice）都成功后才置位；重复轮询与服务重启都看它 |
| `pullAt` / `pulledSha` | 本地 clone 执行 `git pull --ff-only` 的时刻与拉到的 HEAD |
| `pullError` | 拉取失败的原因（脏工作区、分叉、无远端、无网络……），失败不抛出、不阻断循环 |
| `noticeAt` / `noticeError` | 冷安装 notice 是否已写入 spv outbox |

处理规则：

- 只处理 watcher **亲眼看到**的 `OPEN → MERGED` 变化。升级前就已经是 `MERGED` 的 item 不重放，
  否则第一次轮询会把历史 PR 全部拉一遍、并为每个都排一条 notice。
- 只处理 `<projectsRoot>/tools/` 下有 GitHub origin 的仓库；`research/` 永不被轮询、拉取或推送。
- 拉取永远是 `git -C <local clone> pull --ff-only`，从不 force、reset 或 stash。失败时本地树保持原样，
  原因写进 `pullError`，收件箱与其他仓库照常更新；item 保留 `mergeObservedAt` 且不置 `mergeHandledAt`，
  下一次轮询会重试，所以把脏树清理掉之后同一次合并仍能完成。
- 如果更新的就是本仓库（目录名或 repo basename 为 `wheelchair-agent`，可用 `SPV_INSTALL_REPO` 覆盖），
  **运行中的 service 不安装自己**：它通过 `writeMessage()` 往 spv outbox 写**恰好一条** `notice`
  （id `inbox-merge-<item id>`），正文给出 PR/仓库/拉到的 sha、冷安装待办，以及
  `service stop` → 退出 SPV 会话 → `cd <clone> && bash install.sh` → `service start` 的确切命令。
  去重靠 item 上的 `mergeHandledAt` / `noticeAt`，所以成功处理后轮询不会每 60 秒重复，重启也不会再来一次；失败则按上面的 `mergeObservedAt` 重试。
- 冷安装永远由操作者（或收到 notice 后的 SPV 会话）执行；service 只负责发现合并、拉取本地 clone 和通知。

这条 notice 与收件箱的审查质疑共用 outbox 的 `notice` 通道；注入器的头部现在只报 kind 与 thread，
不再说“worker 停了”，因为同一 kind 现在也承载合并通知和操作者质疑。

## 8. 踩过的坑

### 8.1 插件入口的相对路径

插件入口是 `src/superagent/watch.js`，Source kind 在 `src/superagent/spv.js`，队列在 `src/shared/`。
第一版把入口放在包根、源码放在 `src/`，写成 `from './spv.js'`，服务日志里 `ERR_MODULE_NOT_FOUND` 直接让
entry 不激活（`dsh: warning: 1 entry did not activate`）——但进程照样起来，health 里只是**没有** `spv` 条目。
排查方式：`health` 列表缺条目就去 `~/opt/dsh-plugins/dsh-superagent/.artifacts/*.log` 找。

`package.json` 的 exports 键（`./spv-watch` 等）是公开 API，`~/.dsh/profiles/superagent/cordis.patch.yml`
用 bare specifier 引用它们；键名不能改，只能改它指向的文件。

### 8.2 不要导入 zod

dsh-superagent 自带一份 zod。插件如果 import 另一个副本的 zod，抛出的 `ZodError` 在它的
`failure()`（`app/http.ts:82`）里 `instanceof` 判定失败，一个"设置值非法"的 400 会变成 500。
`src/shared/schema.js` 用自定义 `SchemaError` 绕开这个问题，同时省掉一个依赖。

### 8.3 `pids: []` 但服务在跑

`scripts/dsh-superagent status|stop` 用 `ps` 的 `ucomm` 判断进程名，在 WSL2 下 node 进程的 comm 是
`MainThread`，于是脚本认为"没有服务"。表现：`restart` 打印 "An existing orchestrator answers at this URL;
refusing duplicate startup"，实际没重启。可靠做法是直接按端口找 PID：

```bash
kill -INT $(ss -ltnp 2>/dev/null | grep 3082 | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
```

### 8.4 主会话的模型凭据是既有缺口

`~/.dsh/profiles/superagent` 原来**没有挂 provider**，`agent-default-model` 落到 `deepseek-official`，
而本机没有 `DEEPSEEK_API_KEY`。后果：任何 Eval 都 `MISSING_CREDENTIAL`，两分钟超时后记 `unavailable`。
通过 API 看不到这个错误，只能读 session 记录：

```bash
zstd -dc ~/.dsh/sessions/--home-nihao-.dsh-state-superagent--/orchestrator-*/session.v4.jsonl.zstd | grep MISSING
```

修法是在 profile 的 `cordis.patch.yml` 挂 commandcode provider 并把 `agent-default-model` 指过去。

### 8.5 主会话会固化第一次的 request header

主会话的 `model/selection` 一旦写入 session 记录，`initializeRoleModel()` 就不再覆盖
（`if (agent.session.requestHeader() || snapshotEvents().some(e => e.type === 'model/selection')) return`）。
所以在"没有 provider"状态下跑过一次的主会话，即使补上 provider 也会继续用旧路由。
处理：删掉 `~/.dsh/sessions/--home-nihao-.dsh-state-superagent--/orchestrator-*` 与对应的
`~/.dsh/storages/session_projcache/sessions/orchestrator-*.json`，让它重建。Ticket/Thread 全在 SQLite 里，不丢。

### 8.6 消费标记只有一个：rename

`outbox/` 的消息靠 `rename(outbox/x.json → outbox/read/x.json)` 标记已读。注入器（`src/spv/injector.js`）
先 `consumeMessage` 再注入；`consumeMessage` 只在真正搬走文件时返回 id，被别的读者抢先时返回 `undefined`，
调用方据此跳过，所以同一条结果只会注入一次。`spv_status` 只读，不移动任何文件。`--consume` / `--watch`
这类旧开关已经不存在了。
