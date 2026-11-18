# 面板：插口（hooks）段

面板第三段「插口」只读视图的说明。事件契约的唯一来源是 `src/shared/hook-events.js`，引擎契约见 `ARCHITECTURE/hooks.md`。

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
