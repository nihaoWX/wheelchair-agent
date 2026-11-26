# 面板：设置（`/wheelchair-settings`）

面板第二段「设置」的路由、设置文件、优先级、可调 knob、模板与预设。上级：`ARCHITECTURE/webui/index.md`。

## Settings

The second feature is **Settings** (设置): a page for the knobs that exist because wheelchair-agent
exists. It deliberately does **not** mirror or link superagent's own panel blocks — `executor`
(`model`, `maxWorkers`, `directory`, `prepare`, `blockedCommands`, `agentPreset`), `eval` (`mode`,
`timeoutSeconds`, `model`), `policy`, `source:github` and `source:spv` are owned there, not here. The
page says so in both locales.

### The route

`GET` / `PUT /wheelchair-settings` is one exact route, registered by the host half behind the same
`ctx.connection.requestRejection` fence as `/wheelchair-inbox/*`. There is no per-action route:

- `GET` returns the full snapshot (`revision`, `version`, `file`, `fileState`, `warning`, `values`,
  `effective`, `rows`, `templates`, and the Hooks section's read-only `hookView`), `cache-control:
  no-store`, re-read from disk on every request.
- `PUT` takes `{ revision, values?, templates?, reset? }` (JSON, body ≤ 64 KiB):
  - `values` is a merge of dotted key → value; an unknown key or invalid value refuses the whole
    write (`400`, `code: "SETTINGS_INVALID"`), naming the field.
  - `templates[id]` is `{ active, presets? }`. `presets` replaces that template's **custom** preset
    set; omit it to only switch `active` (the stored customs are kept). The built-in `default` preset
    is always preserved and its text cannot be changed. Deleting the active preset falls back to
    `default` in the same PUT.
  - `reset` is `{ values?: string[] | true, templates?: string[] | true }`: remove saved overrides so
    the lower layer applies again, or delete a template's custom presets and activate `default`.
  - The revision is required and must equal the current one. A stale write answers `409`
    `{ code: "conflict", revision, message }` and **writes nothing**.
- `405` (with `Allow: GET, PUT`), `413`, `415`, `404` and `500` are the remaining cases; they are
  covered by `node tests/test-settings.mjs`.

The page stages edits locally and sends **only the changed fields** in one PUT. On `200` it adopts the
returned snapshot and shows "Saved at revision N"; on `409` it keeps the drafts, disables Save and
offers Reload; on `400` it shows the server message inline on the row/template it names plus a
page-level alert. Unknown placeholders and missing required placeholders are also caught client-side
from the snapshot's own `placeholders`/`required`/`limit` metadata, so the server stays authoritative
without the page having to guess its rules.

### The store file

One JSON file at `<root>/settings.json`:

```json
{
  "version": 1,
  "revision": 3,
  "values": { "inbox.intervalSeconds": 30 },
  "templates": {
    "injection": {
      "active": "terse",
      "presets": { "terse": { "text": "[spv] {kind} {thread}: {body}", "builtin": false } }
    }
  }
}
```

Only **custom** presets are written. The built-in `default` text always comes from
`src/shared/settings.js`, so a template that is still on `default` (with no custom presets) is omitted
from the file, and a stored `default` entry from an older version is advisory and ignored: it never
changes the built-in text and never produces a warning.

`<root>` is `$WHEELCHAIR_AGENT_HOME`, else `~/.wheelchair-agent` (see `src/shared/home.js`); the
superagent state directory is only where the old `panel-settings.json` is read from once and moved to
`<root>/settings.json`. `values` holds only explicit overrides, so changing a built-in default is not
pinned by an old file. Settings writes are atomic (temp file + rename; the directory is created first).
Creating a missing file is the one exception: `ensureSettingsFile()` opens it with `wx` so concurrent
first runs cannot overwrite each other, and never replaces an existing file. A corrupt file or a failed
move keeps working through the old path and says so in the snapshot's `warning`.

A corrupt file, a missing one, an unsupported `version` or a bad field never throws: `resolveSettings()`
ignores it, falls back to the next precedence layer, and reports `fileState`
(`ok`/`missing`/`corrupt`) plus a `warning` that the page shows as a banner. A warning on an
otherwise valid file is shown too — the page never silently pretends fallback values were saved. A
consumer such as the poller or the injector keeps working. A normal install no longer has a missing
file: `install.sh` and the host mount both ship the empty-but-valid `{version, revision: 0, values: {},
templates: {}}` file, so the Settings page starts from the built-in defaults without a banner. A
missing file is still handled for hand-built deployments, but it is no longer the first-run state.

### Precedence

Highest to lowest:

1. `settings.json` (`values`);
2. the plugin config (`intervalSeconds`), then the environment (`SPV_INBOX_INTERVAL_SECONDS`,
   `SPV_INSTALL_REPO`) — the config is checked before the environment within this tier;
3. the built-in default.

Every row shows its effective value, its default, and the layer it came from (`Saved` / `Plugin config`
/ `Environment` / `Default`). When a lower layer is also set, the row names it and says the higher
layer wins; an environment variable that is present but invalid is called out separately. This is the
point of the display: a value that looks applied but is not is the failure mode to avoid.

The file (and the environment/config layers) are re-read **on use**: the inbox poller re-resolves
before every schedule (`0` pauses with no `gh` calls and re-checks every second), the injector
re-reads on every tick, `prIssueText()`/`noticeText()` render the active template per call, `work gc`
reads its defaults per run, and the mount sweep reads `work.sweepOnMount` when it starts. A save from
the page therefore applies without restarting the service or the SPV session. What still needs the
next normal service restart is the **host-half code** itself (`lib/index.js` and the copied core
files); `lib/client.js` hot-reloads through dsh's client-bundle watcher.

### Editable knobs

| Key | Default | What it changes |
|---|---|---|
| `webui.style` | `fluid` | Panel variant: `fluid` (tonal card wash, layered shadows and motion) or `minimal` (flat cards, no tint, shadow or motion). Read when the panel loads; a save applies without a reload. |
| `inbox.intervalSeconds` | `60` | Seconds between inbox polls. Every tick runs one `gh pr list` per repository. `0` pauses automatic refresh (the CLI still works). Env `SPV_INBOX_INTERVAL_SECONDS`; plugin config `intervalSeconds`. |
| `panel.port` | `3080` | 独立面板监听端口（整数，1–65535）。改完要重启面板才生效；`panel --port <n>` 只覆盖本次运行。schema 的唯一定义在 Rust core 的 `settings` 子命令里（`#52` 加键） |
| `panel.profileFrom` | `superagent` | 独立面板镜像哪个 profile 的插件（只接受 `a-z`、`0-9`、`-`）。`install.sh` 和 `wheelchair-agent panel sync` 按它重建 `~/.dsh/profiles/wheelchair-agent`（`#65` 前叫 `panel`）的 bundles 与 `cordis.patch.yml`（只去掉 `dsh-superagent`，跳过 `webserver`/`wheelchair-agent/*` insert 与字面秘密）；改完跑一次 `panel sync`（或 `panel start`，会自动 sync） |
| `merge.autoMerge` | `false` | When on, `ticket.delivered` tries to squash-merge the ticket PR after five gates (one open PR matching the clone's branch and repository, not a draft, `MERGEABLE`, non-empty all-SUCCESS `statusCheckRollup`, no HARNESS files). Any failing gate logs one line and does not merge. |
| `merge.installRepo` | `wheelchair-agent` | Merges of this repository queue the cold-install notice instead of a plain pull. `owner/name` or `name`. Env `SPV_INSTALL_REPO`. |
| `injection.intervalMs` | `1000` | How often the SPV-session result injector checks the outbox. |
| `injection.maxBodyChars` | `12000` | Maximum characters of a message body injected into the SPV session; longer bodies are truncated. |
| `work.keep` | `0` | Default `work gc --keep`: how many of the newest ticket clone directories to keep. |
| `work.keepDays` | `0` | Default `work gc --keep-days`: how many days of directories to keep. |
| `work.sweepOnMount` | `true` | Whether the mount-time reclaim runs at all. |

Explicit `work gc --keep` / `--keep-days` flags still win over the file. A numeric value may be
written as a number or as a numeric string (`"5"` is coerced to `5`); a non-numeric string is refused
on PUT and ignored with a warning when it comes from the file, config or environment. Booleans are
JSON booleans in the file/PUT (`"true"` is refused there) and `"true"`/`"false"` in config/environment.
The legacy fractional plugin config (for example `0.02`) is accepted for `inbox.intervalSeconds` only
in the config/environment layer, as before.

### Templates and presets

Three templates are editable. `injection` and `spvObjection` keep their previous default output
byte-for-byte; `prIssue` has the new SPV-notice wording:

| Template id | Used by | Allowed placeholders | Required |
|---|---|---|---|
| `injection` | `formatResult()` in the injector: the header + body injected into the SPV session | `{kind}` `{thread}` `{ticket}` `{body}` | `{thread}` `{body}` |
| `prIssue` | `prIssueText()` in `inbox.js`: the notice a PR "issue" comment becomes for SPV | `{repo}` `{pr}` `{title}` `{url}` `{comment}` | `{repo}` `{pr}` `{comment}` |
| `spvObjection` | `noticeText()` in `inbox.js`: the notice an objection to an `spv_message` becomes | `{title}` `{id}` `{thread}` `{comment}` | `{thread}` `{comment}` |

The required placeholders are the facts the receiving agent needs to act (the thread and the
operator's comment); a template that drops one is refused with a message naming the placeholder. Any
`{...}` that is not in the template's list is an unknown placeholder and is refused loudly — a typo
never silently produces a broken message. The ceiling is **20000 characters** per template (the
existing message-body limit); the PR review comment itself stays limited to 5000 in `inbox.js`.

Presets are per template:

- `default` is the immutable built-in preset; it is always present and its text cannot be changed.
- Any number of named presets (trimmed, 1–64 characters, no control characters, not `default`, and
  not a prototype key — `__proto__`, `prototype`, `constructor`) are stored with their text. The page
  refuses a reserved name before it stages a save, so the server never has to. Exactly one preset is
  active at a time.
- "New preset from this" copies the current text into a new named preset and activates it.
- "Delete preset" removes a custom preset; deleting the active one activates `default` rather than
  leaving a dangling reference. The button is disabled on the built-in default.
- "Revert to default" activates the built-in preset and **keeps** the custom presets stored, so a
  custom prompt can be tried and abandoned without retyping it later.
- The textarea is read-only while the built-in default is active; edit a named preset instead.

### What is deliberately not templated

Recovery-command text stays an exact string: the cold-install merge notice, `install.sh`'s refusal
text, and the `restart-all` plan text. A typo there would break recovery, so the page says this in
both locales and offers no template for them.

### Wiring, copy location and tests

`install.sh` copies `src/shared/settings.js` and `src/shared/home.js` to `lib/shared/` — **not**
`lib/core/`. The copied `lib/core/inbox.js` imports `../shared/settings.js` and `../shared/home.js`,
exactly like `queue.js` lives in `lib/shared/`; `lib/core/` is for files copied from `src/spv/`. The installed package stays
self-contained, and `install.sh --check` diffs the copy like the other generated files.

`tests/test-settings.mjs` is the offline proof (mkdtemp sandboxes, no network, no dsh): defaults,
merge + stale revision, corrupt files, unknown keys, template/preset rules, precedence, the HTTP
codes, consumer integration (injector, `appendReview`, poller, `work gc`, mount sweep), the pure
client helpers loaded through a fake `window.__ModuleLoader__`, and the host route behind the
connection fence. It runs in `npm test`, in CI, and on its own with `node tests/test-settings.mjs`.

## `PUT /wheelchair-settings` 的 `values` 是覆盖补丁（`#56`）

请求里的 `values` 只改**出现的键**，没出现的键保留文件里的现值与来源（用户设过的仍是用户设置，
`filled` 也不变）。面板自己总是发全量，所以这个差别只在 `curl`/脚本发一个键时才看得见——早先一次
部分写入会把别的键交给 `filled` 重新补成默认值，看起来像"被重置"。revision 校验、409、非法值与
只读键保护都不受影响。
