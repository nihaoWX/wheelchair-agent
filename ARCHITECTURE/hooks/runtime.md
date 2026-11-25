# 插口运行时：cursor、队列读取、spool、接线

> 分册：`ARCHITECTURE/hooks.md` 是插口总览；本文的小节编号在本文件内重新编号。

## 1. cursor 与队列读取原语

### cursor

`<数据根>/records/events-cursor.json`：

```json
{ "version": 1, "updatedAt": "2026-11-16T10:00:00.000Z", "ids": { "msg-reply-0001": "2026-11-16T09:59:59.000Z" } }
```

- 认领在**跑脚本之前**落盘（tmp + rename 原子写，跨进程文件锁 `<records>/.events-cursor.lock`）；
  一次崩溃最多丢掉那一次运行，绝不会在重启后补跑；
- 同一个 id 第二次调用是 no-op（`skipped: "cursor"`）。跨进程成立：新进程读同一个文件；
- **永不裁剪**已处理的 id：`outbox/read/` 是 append-only 的归档，裁掉一条旧 id 就等于同意它在之后的读取里
  重放一次；cursor 只增不减（文件大小由实际事件量决定）；
- 派生不出稳定 id 的 occurrence **不写 cursor**（例如 `ticket.started` 缺 `at`）：宁可重放，不可静默丢失。
  脚本应当用 `WCA_EVENT_ID` 做幂等；
- 锁拿不到时**照常跑**（stderr 一句），同样选择了"宁可多跑一次"。

### 队列读取

`readQueueEvents()` 是 `src/shared/hooks.js` 的队列读取原语（stage 2 的 service runner 用它）：

- 同时读 `outbox/*.json`（未消费）与 `outbox/read/*.json`（append-only 归档），所以 injector 先一步
  rename 走的消息仍然会被看到；
- 映射只有三种：`acknowledgement → ticket.acknowledged`、`reply → ticket.delivered`、
  `notice → ticket.attention`；
- 按消息 id 去重（同一条消息在两个目录各有一份只算一次）。排序：`at` 可解析就用它，缺失或写坏时用文件
  mtime 派生的 ISO，再按 mtime、id 决出同刻顺序——一条没有 `at` 的消息不会排到所有日期之前；
- 用 cursor 过滤；
- **只读**：不 rename、不 unlink、不调用 `consumeMessage`，所以它和 injector 不会抢同一条消息，也不会
  打断"rename 即已读"的原子消费。runner 可以在 injector 之前/之后任意时刻读。
- 负载里的 `text` 超过 12000 个 Unicode code point 时截断并带 `textTruncated: true`；`file` 是这条消息在
  `outbox/` 或 `outbox/read/` 的绝对路径，脚本可以自己读全文。`at` 缺失/写坏时给 mtime 派生的 ISO，
  不会给一个空串。

### 服务侧 runner（唯一读者）

`src/spv/hook-runner.js` 的 `startHookRunner()` 挂在 **service 侧的 webui host**，紧挨着
`startInboxWatcher()`（`webui/lib/index.js`），由 `ctx.effect` 停止。理由：

- 注入器（`src/spv/tools.js` 里的 `startResultInjector`）只在**活着的 SPV 会话**里跑；在会话里再开一个
  队列读取器会**双触发**（两个读者各跑一遍 hook），而且会话关掉 hook 就停了；
- 一个进程内的 `ctx.effect` 轮询器（和 inbox watcher 同一层）是唯一"服务活着就一直在"的位置；
- **只有一个读者**：不要在 `src/spv/tools.js`、`inbox watch`、CLI 或 superagent 侧再起一个。

runner 的行为：

- 启动时**先 drain 一次**（服务停着期间累积的 spool/队列事件不会等一个完整间隔），之后按
  `hooks.intervalSeconds` 的 setTimeout 链调度；默认 15 秒，`0` 暂停（每秒回来看设置，改回正数不用重启），
  非法值 warning 后回退 15 秒；每轮重新读设置，所以面板改间隔不需要重启；
- 同一轮先重试上一轮没做完的内建效果，再 spool、再队列，串行执行；单条失败只记 `warning:`，不影响下一条、
  不影响下一轮；
- `stop()` 清定时器；`unref` 让 host 的定时器不阻止进程退出。

### spool 契约（`ticket.started` / `spv.dispatch`）

这两个事件发生在任何服务 tick 之外（`prepare.sh`、`dispatch` 写 `pending/`），所以写一个**文件**而不是
内联跑脚本：微秒级、不需要 node/python、慢脚本不可能拖住 ticket 启动。

- 目录：`<数据根>/records/hook-events/`（`dataPaths().records` 下），一个 occurrence 一个 `.json`；
- 文件内容：`{ "version": 1, "event": "<id>", "eventId": "<stable id>", "at": "<ISO>", "payload": { … } }`；
- 写入：同目录点号临时文件 + `rename`（读者永远看不到半写 JSON）；**best effort**，写失败只记一行 warning，
  绝不让 prepare / dispatch 失败；
- `prepare.sh` 只在**成功且非 `SPV_PREPARE_DRY_RUN`** 时、在最后写一次，纯 POSIX sh，eventId 为
  `<ticket>:<at>:<pid>`（同一秒的两次启动也区分得开）；它自己不跑任何 hook，所以工单启动不会被脚本拖慢；
- `src/spv/dispatch.js` 在任务文件 `rename` 进 `pending/` 之后写 `spv.dispatch`，eventId 为
  `dispatch:<taskId>`；
- runner 认领 cursor 后**删除** spool 文件（即使 cursor 跳过也删，避免崩溃/重启后无限重试同一个
  occurrence）；坏 JSON/未知事件/坏版本进 `<file>.bad` 并记 warning，不再重试。

### 接线表（八个事件）

| 事件 | 在哪里触发（core path 之后） | 负载 |
|---|---|---|
| `ticket.started` | `commands/prepare.sh` 成功结束时写 spool；service runner drain | `ticketId, name?, project, workspace, at` |
| `ticket.acknowledged` | service runner 读队列 `kind: acknowledgement` | `messageId, kind, thread, ticketId?, text, file, at` (+ `textTruncated`) |
| `ticket.delivered` | service runner 读队列 `kind: reply` | 同上，kind=reply |
| `ticket.attention` | service runner 读队列 `kind: notice` | 同上，kind=notice |
| `inbox.approved` | `src/spv/inbox.js:appendReview` 写完 review 之后 | `itemId, kind, pr?, repo?, reviewIndex, comment, at`；eventId `inbox.approved:<itemId>:<index>` |
| `inbox.issue` | `appendReview` 把 notice 写进 SPV 队列之后（PR 与决策信都触发） | `itemId, kind, pr?, repo?, reviewIndex, comment, messageId, thread, at`；eventId `inbox.issue:<itemId>:<index>`（**不是** notice 的 message id：队列读取器用后者派生 `ticket.attention`，共用会吞掉那次 occurrence） |
| `inbox.merged` | `pollOnce` 把成功 merge 的 item 写盘之后（pull 成功且冷安装提醒已排队） | `itemId, pr, repo, url, mergeCommit, pulledSha, localPath, at`；eventId `merge:<itemId>:<pulledSha>` |
| `spv.dispatch` | `src/spv/dispatch.js` 任务文件落进 `pending/` 之后写 spool；service runner drain | `taskId, thread, project, text, preset?, at` |

所有触发点都在 core action **完成之后**，并且是 fire-and-forget：hook 不 await、不阻塞 HTTP 响应或
append/pull；失败/超时/输出洪水只进 `records/hooks.jsonl`。`inbox.merged` 只在最终成功时触发——pull 失败
或冷安装 notice 失败都不触发，下一次轮询补上。

---
