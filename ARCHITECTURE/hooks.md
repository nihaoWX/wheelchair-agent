# 插口（hook）引擎

插口（hook）是**额外副作用**：在项目的某个事件发生时，自动跑一段操作者自己的 shell 脚本，把结果记下来。
它和 core path 严格分开：

| | core path | hook |
|---|---|---|
| 例子 | review 落盘、notice 进 SPV 队列、合并后的 `git pull --ff-only`、队列的 rename 式消费 | 发一条通知、跑一个检查脚本、写一份报告 |
| 能否关掉 | 不能 | 随时 `enable` / `disable` / `rm` |
| 失败会怎样 | 会阻塞流程，必须处理 | 记录后继续，**永远不影响** core path |
| 谁拥有 | `src/spv/inbox.js`、`src/spv/injector.js`、`src/superagent/spv.js`、superagent 的 `executor.prepare` | 操作者（设置文件里的 `hooks.items`） |

一条规则贯穿全文：**hook 从不包裹、不 gate、不重试 core path。** 一个坏脚本最多让自己那一条记录变成失败。

stage 1 交付引擎、设置面、CLI、队列原语与文档；stage 2 把八个事件接到各自 core path 完成之后，并由
service 侧 runner 统一执行；stage 3 交付面板「插口」一节（§10）。事件表、内建行与提示词文本已经在这里
定型，面板直接渲染，不再抄一份。

---

## 0. 三条硬边界（摘自 `ARCHITECTURE.md`）

核心事件（`ticket.started|acknowledged|delivered|attention`、`inbox.approved|issue|merged`、`spv.dispatch`）上可以
挂**用户脚本**，手感对齐 superagent 的 `executor.prepare`。事件表的唯一实现在 `src/shared/hook-events.js`，
完整契约在 `ARCHITECTURE/hooks.md`；这里只记三条硬边界：

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
| `ticket.delivered` | 队列里出现 `kind: "reply"` | 能 | `builtin:injection` | 否 |
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

「文本可改」的三行走**已有模板 id**（`src/shared/settings.js` 的 `TEMPLATE_SPECS`），不新增文本；改模板就
是改面板「设置」里的那几个模板。`rename` 只改显示标签，不改行为。

---

## 3. 设置形状

`hooks` 是 `settings.json` 的顶层字段，与 `version` / `revision` / `values` / `templates` 并列：

```json
{
  "version": 1,
  "revision": 7,
  "values": {},
  "templates": {},
  "hooks": {
    "enabled": true,
    "scriptTimeoutMs": 10000,
    "items": [
      {
        "id": "hook-ticket-delivered-1a2b3c",
        "event": "ticket.delivered",
        "name": "把结果发到我的手机",
        "enabled": true,
        "script": "curl -fsS -d \"$WCA_EVENT_ID\" https://example.invalid/hook",
        "timeoutMs": 2000
      }
    ],
    "labels": { "builtin:injection": "推进会话" }
  }
}
```

| 字段 | 默认 | 语义 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时**一个脚本都不跑**，每次 occurrence 只写一条 `paused` 记录 |
| `scriptTimeoutMs` | `10000` | 默认超时；行内 `timeoutMs` 覆盖它；硬上限 `300000` |
| `intervalSeconds` | `15` | service runner 的轮询间隔（秒）；`0` 暂停（每秒回看设置）；读盘超限夹到 `86400` 并 warning，写入直接拒绝 |
| `items` | `[]` | 自定义行，**顺序就是每个事件内的执行顺序** |
| `items[].id` | — | `hook-` 前缀、全局唯一；`builtin:` 前缀留给内建行，自定义行不能占用 |
| `items[].event` | — | 必须是事件表里的 id |
| `items[].name` | — | 1..120 字符、无控制字符，给人看 |
| `items[].enabled` | `true` | 单行开关 |
| `items[].script` | — | `sh -c` 的脚本正文，非空、≤ 20000 字符 |
| `items[].timeoutMs` | 省略 | 1..300000；写入超限直接拒绝（`SETTINGS_INVALID`，什么都不写）；磁盘上超限的手改值读取时夹到上限并给一条 warning |
| `labels` | `{}` | 内建行的显示标签覆盖；空串 = 恢复默认，不落盘 |

超限的 `scriptTimeoutMs` / `items[].timeoutMs`：**写入直接拒绝**（`SETTINGS_INVALID`，什么都不写）；磁盘上的
手改值**读取时夹到上限并给一条 warning**（文件仍是 `fileState: "ok"`）。

**写语义**（`src/shared/settings.js` 的 `saveSettings` 与 HTTP `PUT /wheelchair-settings`）：

- 每次写入都带 `revision`。**过期的 revision 是 409，磁盘一个字节都不写**（库层抛 `SETTINGS_CONFLICT`）。
- `hooks` 的每个**提供的字段整体替换**；省略的字段保留现有值（与 `values` / `templates` 的部分保存一致）。
- 校验失败的 `hooks` 整体拒绝（400 / `SETTINGS_INVALID`），同样不写。
- 磁盘上的 `hooks` 子块坏了（字段类型错、未知事件、重复 id、未知内建行……）只跳过那一条并给 `warning`，
  文件仍然 `fileState: "ok"`；整个 JSON / version / revision 坏了才是 `corrupt` + 全默认。
- 一次只改 `values` / `templates` 的保存会保留磁盘上**形状合法（JSON 对象）**的 `hooks` 块原样：不会把
  超限的 timeout 夹成 `300000`，也不会丢掉它看不懂的字段。若 `hooks` 不是对象（字符串 / 数组 / `null`），
  读取时已经给过 warning，保存时这个字段被丢弃（文件其余部分照常写）。要修 hooks 就显式写 `hooks`。
- 默认值不落盘：`enabled: true` / `10000` / 空表 / 空标签都不会写出来，所以新装机器上那份
  「empty-but-valid」文件保持不变，未来的默认值也能到达旧文件。
- 旧文件没有 `hooks` 字段仍然有效（读出来就是默认值）。
- **没有任何一条路径手改 `settings.json`**；CLI 与面板都走这个存储。

`node tests/test-settings.mjs` 覆盖以上全部不变量；`npm run check` 只是 `node --check`（语法），不跑断言。

---

## 4. 执行契约

`sh -c <script>`，逐行串行、按 `items` 顺序、每个事件独立。一个失败不停止下一个，任何失败都不传播给调用方
（`runHooksFor` 永不 reject）。

### cwd

| 事件 | cwd |
|---|---|
| `ticket.started` | `payload.workspace`（`prepare.sh` 写的工单目录，绝对路径） |
| 其它 `ticket.*`（队列事件） | 负载没有 workspace；service runner 用 service 进程的 cwd（`opts.cwd`），CLI 用当前目录 |
| 其它事件 | CLI 用当前目录；service runner 用 service 进程的 cwd |

目录不存在时不提前报错：子进程以 ENOENT 失败，那一条记进记录，下一个照常跑。

### stdin

**一行 JSON**，就是事件负载本身（字段见 `EVENTS[].payload` / `hook prompt`）。队列事件里的 `at` 在消息
缺失或写坏时用文件 mtime 派生的 ISO 代替，所以脚本总能拿到一个可用的时间。示例：

```json
{"messageId":"msg-reply-0001","ticketId":"agent-demo-0123abcd","thread":"demo-0123abcd","kind":"reply","text":"已完成：…","at":"2026-01-01T00:00:00.000Z"}
```

### 环境变量

只有白名单 + 事件事实，**不是** `process.env`：

- 白名单：`PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`LC_*`、`TZ`、`TERM`、`TMPDIR`；
- 凭证过滤：名字里带 `TOKEN` / `SECRET` / `PASSWORD` / `PASSWD` / `CREDENTIAL` / `KEY`，或 `GH_*` /
  `GITHUB_*` / `DSH_*` 的，一律不传；
- 我们的：`WCA_EVENT`（事件 id）、`WCA_EVENT_ID`（本次 occurrence 的稳定 id，**用它做幂等**）、
  `WCA_EVENT_AT`、`WCA_HOME`（数据根）、`WCA_TICKET`（负载有 `ticketId` 时）、`WCA_CWD`。

没有任何凭证会进脚本环境；脚本如果需要网络凭证，自己从操作者的密钥管理里取，不要指望这里。

### 超时

行内 `timeoutMs` → `hooks.scriptTimeoutMs` → `10000`，最后夹到 `300000`（写入超限会被设置存储直接拒绝，
所以运行期这一夹只防手改文件）。超时先 **SIGTERM**，宽限 `500 ms` 再 **SIGKILL**；记录里 `timedOut: true`，
`signal` 说明最后用的是哪个信号（一个忽略 SIGTERM 的脚本会以 `SIGKILL` 结束）。

### 输出与记录

stdout / stderr **各只保留最后 8 KiB**（内存里也只保留这么多：一个输出洪水不会把内存或记录撑大）。
`truncated.stdout` / `truncated.stderr` 说明是否发生过截断。

一次运行一条 JSON 行，追加到 `<数据根>/records/hooks.jsonl`（默认 `~/.wheelchair-agent/records/hooks.jsonl`）：

```json
{"ts":"2026-11-16T10:00:00.000Z","event":"ticket.delivered","eventId":"msg-reply-0001","hookId":"hook-ticket-delivered-1a2b3c","name":"把结果发到我的手机","exit":0,"signal":null,"durationMs":42,"timedOut":false,"stdout":"ok\n","stderr":"","truncated":{"stdout":false,"stderr":false}}
```

失败时还有 `exit`（非 0 / `null`）、`signal`、可选的 `error`；暂停时是
`{"ts":…,"event":…,"eventId":…,"skipped":"paused"}`。

记录写入失败**绝不**抛：只写一句 stderr。脚本失败也**绝不**影响 core path。

### 总开关与空表

- `hooks.enabled: false`：一个脚本都不跑；**每次 occurrence 恰写一条** `skipped: "paused"`（不是每行一条）。
  这次 occurrence 同时被 cursor 认领，所以重新打开后**不会**把暂停期间的旧消息补跑一遍。
- `items` 为空（或该事件没有启用的行）：不跑脚本、不写记录；但**当这次 occurrence 有可派生的稳定 id
  且 `opts.cursor !== false`** 时，该 id 会被静默认领，所以以后加上第一个 hook 时不会把 `outbox/read/`
  里的历史消息全部补跑一遍。没有稳定 id（例如 `ticket.started` 缺 `at`）或显式 `cursor: false` 时不写
  cursor：调用方自己负责去重与幂等（脚本仍可用 `WCA_EVENT_ID`）。

---

## 5. cursor 与队列读取原语

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
- 同一轮先 spool、再队列，串行执行；单条失败只记 `warning:`，不影响下一条、不影响下一轮；
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

## 6. CLI

```bash
wheelchair-agent hook events                 # 事件表：id、标题、何时触发、是否可取消、行数
wheelchair-agent hook list                   # 每个事件的内建行与自定义行（顺序、超时、脚本预览）
wheelchair-agent hook add --event <id> --name "<名字>" --script '<sh>' [--timeout <ms>]
                                             # 打印新 id（hook-<slug>-<hex>）
wheelchair-agent hook enable <id>
wheelchair-agent hook disable <id>
wheelchair-agent hook rm <id>
wheelchair-agent hook rename <builtin id> "<标签>"      # 空标签 = 恢复默认；只接受 builtin:*
wheelchair-agent hook test <id> [--event <id>] [--payload <json>]
wheelchair-agent hook log [--tail <n>] [--event <id>]   # 默认 20 行
wheelchair-agent hook prompt <event>         # 可复制给 agent 的中文提示词
```

- 退出码：`0` 成功；`1` 运行期错误（找不到 hook、内建行不可改、设置写入冲突/非法、`hook test` 的脚本
  失败）；`2` argv / 用法错误（缺参数、未知事件、`--payload` 不是 JSON、`--timeout` 超限）。
- 所有写入都走设置存储的 revision 检查（过期 = 409，什么都不写）；没有手改文件的路。
- `hook add` 生成 id、校验事件/名字/脚本/超时，**立刻启用**并打印 id。
- `enable` / `disable` / `rm` 作用在内建行上会明确失败：*the core path owns it*。
- `rename` 只接受 `builtin:*`；自定义行的名字在 `add` 时定，改名 = rm + add。
- `hook test`：用事件的文档示例负载（或 `--payload`），`--event` 可覆盖；打印 exit / signal / duration /
  stdout / stderr；**不写 `hooks.jsonl`、不认领 cursor**（它不是一次真实 occurrence）。显式测试**总是会跑**：
  行被 `disable` 或总开关 `hooks.enabled: false` 时也照跑，只在输出里各加一条 `note:`。
- `hook rename` 的标签形状（≤120 字符、无控制字符）在命令行就校验，非法是用法错误（退出码 2）。
- `hook prompt`：中文、可整段复制。它只从 `EVENTS` 生成，包含事件 id、含义、触发时机、重复性、负载字段、
  `WCA_*`、cwd、超时，以及要写出来的
  `wheelchair-agent hook add --event <id> --name "<名字>" --script '<sh>' [--timeout <ms>]`。
  这正是 stage 3 面板「新增」按钮要显示的文字；面板与 CLI 用同一个生成函数，输出逐字节相同（CLI 不再
  附加 checkout 行）。

### 「新增」是提示词，不是 shell 输入框

操作者的话：*"用户可以新增脚本（点开新增是一段可复制的提示词，其实意思就是让用户叫 agent 改就行）"*。
所以 `hook add` 是给 agent 用的；操作者拿 `hook prompt` 的文本去让 agent 加。stage 2 **不**提供从面板直接写
shell 的路径；stage 3 的面板也只显示这段提示词。

---

## 7. 已知缺口：PR 身份（stage 2 仍未解决）

`ticket.delivered` 的负载来自队列消息，只有 `ticketId` 与 `thread`——**没有 PR 号、仓库或 url**。想在
worker 报告时自动合并 PR 的 hook，现在拿不到要合并哪一个。stage 2 按 assignment 只搬运消息里真实存在的
字段，**不发明** outcome/PR 字段，所以这个缺口仍然存在：要解决它，需要让 reply 消息携带 PR 身份，或由
一个能查到工单→PR 映射的调用点补全负载。

相关但不相同：`inbox.merged` 有完整 PR 字段（`pr` / `repo` / `url` / `mergeCommit` / `pulledSha`），
所以合并后的动作应该挂在那里。

---

## 8. 边界与安全

- **不 import `dsh-superagent`**，不碰 `~/opt/dsh-plugins/dsh-superagent`；唯一跨项目接口是既有的文件队列。
- `src/shared/hooks.js`、`src/shared/hook-events.js` 与 `src/spv/hook-runner.js` 只用 Node builtins，被
  `install.sh` 复制进 preset / webui 包，必须能单独存在（`tests/test-layout.sh` 规则 3）。
- 脚本以**操作者**的权限运行：它和操作者自己的 shell 一样强。所以入口只有设置文件，而设置文件只能通过
  CLI / 面板（revision 检查）写；stage 2 没有"面板直接执行 shell"的通道，stage 3 的面板也只显示提示词。
- 队列读取器只读，不消费；注入器仍然是唯一的消费者，"rename 即已读"的原子性没有被破坏。
- 所有测试都在 `mkdtemp` 沙箱里，`WHEELCHAIR_AGENT_HOME` / `SPV_QUEUE_DIR` / `DSH_SUPERAGENT_STATE_DIR`
  全部指向沙箱；没有网络。

## 9. 实现位置

| 文件 | 职责 |
|---|---|
| `src/shared/hook-events.js` | 事件表 + 内建行（唯一契约；settings 与 hooks 都从它读） |
| `src/shared/hooks.js` | 模型、执行、记录、cursor、队列原语、spool 原语、提示词生成 |
| `src/shared/settings.js` | `hooks` 子块的校验、合并、落盘、HTTP 面（含 `intervalSeconds`） |
| `src/spv/hook.js` | `wheelchair-agent hook ...` 的命令逻辑 |
| `src/spv/hook-runner.js` | service 侧唯一 runner：drain spool + 队列，按 `hooks.intervalSeconds` 调度 |
| `webui/lib/index.js` | 在 host 里挂 runner（与 `startInboxWatcher` 同一层，`ctx.effect` 停止）；给 settings 快照挂只读的 `hookView` |
| `webui/lib/client.js` | 第三个功能段「插口」：事件/行/最近 5 次执行的只读视图；内建行改名走同一个 revision PUT |
| `src/spv/inbox.js` | review / notice / merge 的 core path，之后 fire `inbox.*` |
| `src/spv/dispatch.js` | 任务落进 `pending/` 后写 `spv.dispatch` spool |
| `commands/prepare.sh` | 成功结束时写 `ticket.started` spool（纯 sh、best effort、dry-run 不写） |
| `bin/wheelchair-agent.mjs` | argv → 命令、退出码、`--help` |
| `tests/test-hooks.mjs` / `tests/test-settings.mjs` / `tests/test-inbox*.mjs` / `tests/test-prepare.sh` | 离线证据（含 stage 3 视图、提示词逐字节相等、改名与陈旧 revision） |

## 10. stage 3：面板「插口」

面板是**第三个功能段**，与「收件箱」「设置」共用 `SECTIONS`、`webui.style`（`fluid` 默认 / `minimal`）
和唯一的内容宽度 `--wca-content-max`。它是一份**只读视图**，不是第二个设置权威：

- **数据从哪来**：`GET /wheelchair-settings` 的同一份快照多一个 `hookView` 字段，由
  `src/shared/hooks.js` 的 `buildHookPanel()` 生成。它复用 `readHooks()` 的模型，事件含义 / `when` /
  `repeatNote` / `payload` 仍来自 `src/shared/hook-events.js`；提示词仍由 `buildHookPrompt()` 生成，
  与 `wheelchair-agent hook prompt <event>` 的输出逐字节相同（CLI 不再附加 checkout 行）。
- **事件**：按 `EVENTS` 顺序显示 id、中文名、说明、触发时机、重复说明、负载字段；内建行按
  `builtinRowsFor(eventId)` 显示，自定义行来自 `hooks.items` 按事件过滤。
- **内建行**：显示有效标签、默认标签、`description`、`cancellable: false` 的事实与文本位置
  （`pointer: executor.prepare`，或 `template: injection` 等指向「设置 → 派单文本」）。`cancellable:
  false` 的行**不能停用、不能删除**；面板不提供这两个动作。内建行可以改名，写的是 `hooks.labels`。
- **自定义行**：只显示名称、启用状态、折叠的脚本预览和最近一次运行；面板没有执行、停用、删除入口。
- **最近 5 次执行**：每个事件从 `<数据根>/records/hooks.jsonl` 取最近 5 条，最新在前；显示 `at`、事件 id、
  行名、`ok` / `failed` / `timeout` / `paused`、耗时，失败时附上 trim 后的 stderr 尾部（最多 600 字符；
  完整记录仍在 jsonl 里）。
- **改名写路径**：与设置页完全相同的一次 `PUT /wheelchair-settings`，body 是
  `{ revision, hooks: { labels: <完整 labels 映射> } }`；`labels` 在存储层是整体替换，所以面板发送合并后的
  完整映射，不是单条覆盖。过期 revision 仍然是 **409**，磁盘一个字节都不写；面板保留草稿并提示刷新。
  没有手改 `settings.json`、没有新增写路由。
- **新增插口**：不是面板动作。「新增」只展开该事件的 `hook prompt` 原文，可选中 / 复制，并写明
  「让 agent 照这段提示词去改」。面板没有 shell 输入框、没有执行按钮，也不跑任何脚本。
- **边界**：HTTP 面仍然只有 `/wheelchair-settings` 的 GET/PUT 与收件箱两条路由；hook 的读盘/执行仍在
  service runner 与 CLI，面板不 import `dsh-superagent`、不接触脚本执行器。

证据：`tests/test-hooks.mjs` 的 `testPanelView()`（8 个事件全渲染、内建行不可停用、提示词与 CLI 逐字节相同、
最近 5 条顺序与 stderr trim、改名 round-trip 与陈旧 revision 不写盘）和 `tests/test-settings.mjs` 的
`testClientHookHelpers()` / host route 断言（快照带 `hookView`，改名映射不丢其它标签）。
