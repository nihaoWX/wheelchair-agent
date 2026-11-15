# spv Source: 本机队列接入 superagent

`spv` 是 dsh-superagent 的一个 **Source 插件**，把本机文件队列里的任务送进 superagent，并把 Channel 写回落回同一队列。
它不依赖 GitHub/飞书，是"入口会话"派活与收结果的唯一通道。

- 插件包：`tools/wheelchair-agent/`（独立 git 仓库，纯 ESM JavaScript，无构建步骤）
- 上游：`tools/dsh-superagent/`（**只作为 peer 依赖，未改一行源码**）
- profile 加载点：`~/.dsh/profiles/superagent/cordis.patch.yml`

## 1. 为什么是 Source 而不是改核心

`SourceRegistry.register(kind)` 是 dsh-superagent 的官方扩展点。`kind` 描述"事件如何变成 Trigger、Channel 如何回写、
策略允许谁、环境变量是什么"，插件入口再用 `ctx.effect` 注册 kind 并跑自己的轮询循环。核心（`src/core`）不认识 `spv`，
它只看到一个普通 Source。

关键约束：**`tools/dsh-superagent/src/` 一个字节都不能改**。所以：

- 需要的 helper（`health`、`key`、`threadKey`）在 `src/superagent/spv.js` 里重写了等价的小函数。
- `SourceContext` 用 `ctx.orchestrator.context(kind)` 拿，不导入 `sourceContext`（`lib/` 没导出它）。
- schema 用自己写的 `src/shared/schema.js`（只实现 `parse`/`safeParse`），**故意不依赖 zod**。理由见第 6 节。

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
```

任务记录的顶层字段是 `id` / `thread` / `text` / `at` / `source` / `project` / `actor`，外加可选的 `preset`
（dsh agent preset id，例如 `cordis` / `ptc` / `standard`；省略时不写这个字段，superagent 用自己的默认
worker preset）。`triggerOf()` 把除 `text` / `thread` / `actor` 之外的字段整体 spread 进 `meta`，所以
`preset` 自动成为 `trigger.meta.preset`。

**结果不由 CLI 读**：`outbox/` 里的 `reply` / `notice` 由 SPV 会话里的注入器（`src/spv/injector.js`）在后台
消费，并作为一条新的 user 消息推进对话。所以 CLI 只有 `dispatch` / `status`（外加 `check`），没有、也不需要
`result` 子命令。

`SPV_QUEUE_DIR` 覆盖队列根（与插件自身的 `queueDir` 设置同一优先级规则）。队列目录不存在时 `status` 不报错：
`unreadMessages` / `pendingTasks` 把 ENOENT 当成空队列，CLI 打印空列表。`dispatch` 只在 superagent 服务未运行
时失败（健康探针），队列目录本身不是它的前提——`submitTask` 会自己建 `pending/`。

## 6. 踩过的坑

### 6.1 插件入口的相对路径

插件入口是 `src/superagent/watch.js`，Source kind 在 `src/superagent/spv.js`，队列在 `src/shared/`。
第一版把入口放在包根、源码放在 `src/`，写成 `from './spv.js'`，服务日志里 `ERR_MODULE_NOT_FOUND` 直接让
entry 不激活（`dsh: warning: 1 entry did not activate`）——但进程照样起来，health 里只是**没有** `spv` 条目。
排查方式：`health` 列表缺条目就去 `tools/dsh-superagent/.artifacts/*.log` 找。

`package.json` 的 exports 键（`./spv-watch` 等）是公开 API，`~/.dsh/profiles/superagent/cordis.patch.yml`
用 bare specifier 引用它们；键名不能改，只能改它指向的文件。

### 6.2 不要导入 zod

dsh-superagent 自带一份 zod。插件如果 import 另一个副本的 zod，抛出的 `ZodError` 在它的
`failure()`（`app/http.ts:82`）里 `instanceof` 判定失败，一个"设置值非法"的 400 会变成 500。
`src/shared/schema.js` 用自定义 `SchemaError` 绕开这个问题，同时省掉一个依赖。

### 6.3 `pids: []` 但服务在跑

`scripts/dsh-superagent status|stop` 用 `ps` 的 `ucomm` 判断进程名，在 WSL2 下 node 进程的 comm 是
`MainThread`，于是脚本认为"没有服务"。表现：`restart` 打印 "An existing orchestrator answers at this URL;
refusing duplicate startup"，实际没重启。可靠做法是直接按端口找 PID：

```bash
kill -INT $(ss -ltnp 2>/dev/null | grep 3082 | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
```

### 6.4 主会话的模型凭据是既有缺口

`~/.dsh/profiles/superagent` 原来**没有挂 provider**，`agent-default-model` 落到 `deepseek-official`，
而本机没有 `DEEPSEEK_API_KEY`。后果：任何 Eval 都 `MISSING_CREDENTIAL`，两分钟超时后记 `unavailable`。
通过 API 看不到这个错误，只能读 session 记录：

```bash
zstd -dc ~/.dsh/sessions/--home-nihao-.dsh-state-superagent--/orchestrator-*/session.v4.jsonl.zstd | grep MISSING
```

修法是在 profile 的 `cordis.patch.yml` 挂 commandcode provider 并把 `agent-default-model` 指过去（见第 7 节）。

### 6.5 主会话会固化第一次的 request header

主会话的 `model/selection` 一旦写入 session 记录，`initializeRoleModel()` 就不再覆盖
（`if (agent.session.requestHeader() || snapshotEvents().some(e => e.type === 'model/selection')) return`）。
所以在"没有 provider"状态下跑过一次的主会话，即使补上 provider 也会继续用旧路由。
处理：删掉 `~/.dsh/sessions/--home-nihao-.dsh-state-superagent--/orchestrator-*` 与对应的
`~/.dsh/storages/session_projcache/sessions/orchestrator-*.json`，让它重建。Ticket/Thread 全在 SQLite 里，不丢。

### 6.6 消费标记只有一个：rename

`outbox/` 的消息靠 `rename(outbox/x.json → outbox/read/x.json)` 标记已读。注入器（`src/spv/injector.js`）
先 `consumeMessage` 再注入；`consumeMessage` 只在真正搬走文件时返回 id，被别的读者抢先时返回 `undefined`，
调用方据此跳过，所以同一条结果只会注入一次。`spv_status` 只读，不移动任何文件。`--consume` / `--watch`
这类旧开关已经不存在了。
