# 面板：插口（hooks）段

面板第三段「插口」只读视图的说明。事件契约的唯一来源是 `src/shared/hook-events.js`，引擎契约见 `ARCHITECTURE/hooks/contract.md`
（内建行清单也在那一册的 §2），执行与 cursor 见 `hooks/execution.md` / `hooks/runtime.md`。

## Hooks

The third feature is **Hooks** (插口): a read-only view of the same `hooks` block the CLI owns. It is
not a second settings authority and adds no writer.

- **Snapshot, not a second route**: the host's `createSettingsHandler({ decorate })` adds
  `hookView` to the normal `GET /wheelchair-settings` response. `buildHookPanel()` (in the copied
  `lib/shared/hooks.js`) composes `readHooks()` with `records/hooks.jsonl`; no new HTTP route is
  registered.
- **What it renders**: every `EVENTS` entry in table order, with its id, localized title,
  explanation, `when`, `repeatNote`, payload fields and rows. Built-in rows come from
  `builtinRowsFor()` (effective label, default label, description, `template`/`pointer`, and the
  `cancellable: false` fact); custom rows come from `hooks.items` filtered by event and show name,
  enabled badge, collapsed script preview and last run. The last five runs per event are read from
  `<data root>/records/hooks.jsonl`, newest first, with `ok`/`failed`/`timeout`/`paused`, duration and
  a trimmed stderr tail on failure.
- **Rename, one writer**: the only writable control is a built-in row's display name. It sends the
  same `PUT /wheelchair-settings` as the Settings page with
  `{ revision, hooks: { labels: <complete map> } }`; `hooks.labels` is replace-whole, so the client
  merges every existing override instead of dropping the others. A stale revision is the normal 409,
  the draft is kept and Refresh re-reads. Built-in rows have no enable/delete control; custom rows
  are read-only.
- **Add is a prompt**: the "Add" disclosure shows the exact `buildHookPrompt()` text (the same bytes
  as `wheelchair-agent hook prompt <event>`) with a Copy button and the line "Have an agent make the
  change from this prompt". There is no script textarea and no execute button; the panel runs
  nothing.
- **Copied files**: `install.sh` already copies `src/shared/hooks.js` and `hook-events.js` into
  `lib/shared/`; the client stays a hand-written prebuilt bundle and receives the view through
  `hookView` rather than importing Node code.

The host-route and pure-helper checks live in `tests/test-settings.mjs`; the event/row/history/prompt
and rename checks live in `tests/test-hooks.mjs`.

## 面板「插口」段（中文说明，与上文是同一件事）

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
