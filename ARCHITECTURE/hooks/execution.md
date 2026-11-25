# 插口：设置形状与执行契约

> 分册：`ARCHITECTURE/hooks.md` 是插口总览；本文的小节编号在本文件内重新编号。

## 1. 设置形状

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


## 2. 执行契约

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
