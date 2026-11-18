# `wheelchair-agent-webui` — the wheelchair-agent UI home panel

An **independent dsh web client plugin package**. It adds the `wheelchair-agent` **feature host** to
the `superagent` profile: one sidebar row, one full-size page that lists features and hosts the
active feature panel (the review inbox, 收件箱, is the first one; Settings, 设置, is the second), and the
`/wheelchair-inbox/*` + `/wheelchair-settings` JSON routes those features talk to.

## Why a separate package

`@deepseek-ai/dsh-client-modules` discovers a browser bundle by scanning the **bare package
specifiers** of the host Loader's rows for a `dsh.client` declaration. A package inside another
package (`wheelchair-agent/webui`) is not a row of its own and is never scanned, so the panel
would simply not appear. Hence a real package, installed into the profile's `node_modules` with
its own loader row in `~/.dsh/profiles/superagent/cordis.patch.yml` (written by `install.sh`).

## How it loads

- Host half (`lib/index.js`): `name = 'wheelchair-agent-webui'`, `inject = ['webServer',
  'connection']`. It registers three exact JSON routes — `/wheelchair-inbox/items`,
  `/wheelchair-inbox/review` and `/wheelchair-settings` — each behind
  `ctx.connection.requestRejection` so dsh's Host/Origin and login fence guards them, and starts the
  inbox poller through `ctx.effect`. The Host no longer serves a page: the panel is a Client React
  component. The settings handler itself is `lib/shared/settings.js`'s `createSettingsHandler`; the
  route only wraps it in the same fence as the inbox routes.
- Browser half (`lib/client.js`): a hand-written prebuilt bundle in the fixed
  `window.__ModuleLoader__.load({ id, factory })` format. It registers the sidebar row
  (`sidebar.panellist`) and the page (`main`) under the same id `wheelchair-agent`, with the
  label `wheelchair-agent` in both `zh` and `en`. The `main` entry renders a React component, so
  the page inherits the host's theme tokens, light/dark switching and `ctx.locale`.
- The bundle uses no JSX and no Harness Client package: it calls `require('react')` and
  `require('react/jsx-runtime')` / `jsx(...)` / `jsxs(...)` directly, and implements its own
  controls, Markdown renderer and styles. In particular it does **not** require
  `@deepseek-ai/dsh-client-ui-primitives` (the dsh plugin guide forbids loading Harness Client
  packages as modules). This repository has no TypeScript and no build chain.

## Features and the review model

The page is a **feature host**, not a PR list: the nav lists features (review inbox, Settings and
Hooks, shaped so adding another is one array entry) and the active feature renders in its own bordered
panel with its own title, description and toolbar. `SECTIONS` is the single declaration:

```js
const SECTIONS = [
  { id: 'inbox', labelKey: 'section.inbox', titleKey: 'feature.inbox.title',
    descriptionKey: 'feature.inbox.description', Component: InboxSection },
  { id: 'settings', labelKey: 'section.settings', titleKey: 'feature.settings.title',
    descriptionKey: 'feature.settings.description', Component: SettingsSection },
  { id: 'hooks', labelKey: 'section.hooks', titleKey: 'feature.hooks.title',
    descriptionKey: 'feature.hooks.description', Component: HooksSection },
]
```

Adding a feature is exactly one array entry plus its React component:

1. add `{ id, labelKey, titleKey, descriptionKey, Component }` to `SECTIONS` (and the locale keys
   to both dictionaries);
2. implement the component; it owns its heading controls and data. The feature panel itself owns
   the bordered surface, title/description row and toolbar.

### Two letter types

Every item carries a `kind`:

| `kind` | What it is | Fields |
|---|---|---|
| `pr` | a GitHub pull request, written by `wheelchair-agent inbox watch` | `repo`, `pr`, `state`, diff counts, `url`, `body`, `createdAt`, `updatedAt`, `at` |
| `spv_message` | one decision the SPV agent made on its own while running unattended | `title`, Markdown `body`, `thread`, `at`; **no** `repo` and **no** `pr` |

An `spv_message` letter exists so the operator can later accept the call or object to it. Its writer
is `wheelchair-agent inbox add --title <text> --body <markdown|@file> [--thread <name>]`, or the
`spv_notify({title, body, thread?})` tool the SPV preset registers. Both call the same
`createSpvMessage()`; ids are `spv-<thread>-<UTC timestamp>-<4 random chars>`, so two letters in the
same second cannot collide. The panel shows a `PR` / localized `SPV decision` badge on every row;
PR rows keep repo + number, decision rows show their thread.

Both types keep `review: [{at, kind: "approve"|"issue", text}]` as the log, and both use the same
per-item cross-process lock and atomic writes.

### Review semantics

The review status is derived from the **latest `review` entry**, with no stored status field
(`statusOf(item)` in `lib/client.js`):

| latest review | status | UI |
|---|---|---|
| none | `pending` (待审查) | tertiary badge |
| `approve` | `approved` (已通过) | success badge; row de-emphasized |
| `issue` | `issue` (有问题) | error badge |

`approve` takes an **optional** comment; it is recorded only and never notifies the agent. `issue`
requires a comment and writes **exactly one** `notice` into the spv outbox for **both** letter
types: a `pr` uses thread `inbox-<pr>` and the `prIssue` template; an `spv_message` uses the
letter's own thread and the `spvObjection` template. Nothing is dispatched to a worker: the notice
reaches the SPV entry session, which decides whether to discuss or dispatch. A repeated identical
submission reuses the last review index and overwrites the same notice file instead of stacking a
second one. Legacy `question` / `fix` records are normalized to `issue` on read, and the old disk
records are never rewritten.

### Filters

Three filters compose with AND: **letter type** (`pr` / `spv_message` / all), **repository**
(derived from the items; a specific repo excludes `spv_message`), and **time** (all / last 24 hours /
last 7 days / custom range). They are implemented server-side in
`GET /wheelchair-inbox/items?kind=&repo=&since=&until=`; no query parameters is exactly the old
response and the body stays `{items: [...]}`. The panel only URL-encodes the parameters and
re-fetches when they change, so the filter logic stays out of the bundle. Time uses the PR's own
`createdAt` (its age, not the moment the watcher noticed it) and an `spv_message`'s `at`.

The toolbar also keeps the derived-status filter (All / Pending review / Issues / Approved,
default Pending review), with counts over the currently fetched letters. Review status is independent
of GitHub state: merging is not reviewing, so a `MERGED` PR with no review is **pending**. Any
existing review still wins (an issue is not pending, but it stays an issue).

The GitHub state is a **separate chip** next to the repo + number (`Open` / `Merged` / `Closed`,
localized), derived by `stateOf()` from the item's existing `state`. It is context only and never
feeds `statusOf()`.

### Automatic refresh

The host half starts the inbox poller on mount, inside `ctx.effect`, so it stops with the plugin.
It calls `startInboxWatcher()` from `lib/core/inbox.js` — the same implementation behind
`wheelchair-agent inbox watch`; there is no second loop. The first round runs immediately and the
next ones follow a timer, so the inbox data is current while SPV runs unattended and nobody has to
type the CLI command.

The interval is **60 seconds by default**, matching the CLI. Configure it in any of these places, in
increasing precedence:

- `SPV_INBOX_INTERVAL_SECONDS=<seconds>` in the service's environment;
- the webui plugin's config: `intervalSeconds: <seconds>`;
- `inbox.intervalSeconds` in the panel settings file (`<root>/settings.json`, editable from the
  Settings section), which wins over both.

`0` disables the automatic poller (the CLI still works). The poller re-reads the settings file before every
schedule, so changing the interval applies without a restart; a paused poller re-checks every second and
resumes by itself. A non-numeric or negative value is logged and falls back to 60s rather than failing the
panel. One failing repository or one `gh` error is logged as a warning and the next round still runs.

### Merged PRs, pulls and the cold-install notice

`gh pr list` now also returns `mergedAt` and `mergeCommit`. When a `pr` item becomes `MERGED`, the
first poll that observes it records the merge on the item and then acts exactly once:

- it runs `git -C <projectsRoot>/tools/<name> pull --ff-only` and records `pulledSha` (the local
  HEAD after the pull), `pullAt`, and `mergeHandledAt`. It never force-pulls, resets or stashes.
  A dirty tree, a diverged branch, a missing remote or no network makes git fail; the failure is
  recorded as `pullError`, the local tree is left alone, and the poll loop continues. The item keeps
  `mergeObservedAt` and is retried on a later poll, so cleaning the tree lets the same transition
  finish instead of being lost.
- if the updated clone is this repository (local directory or repo basename `wheelchair-agent`;
  override with `SPV_INSTALL_REPO`, either `wheelchair-agent` or `owner/wheelchair-agent`), the service
  cannot install itself. It writes exactly one
  `notice` through `writeMessage()` into the spv outbox, with id `inbox-merge-<item id>`. The text
  names the PR, repo and pulled sha, says a cold install is pending, and gives the stop → install →
  start commands (`wheelchair-agent service stop`, exit the SPV session, `cd <clone> && bash
  install.sh`, `wheelchair-agent service start`, `wheelchair-agent spv`). `noticeAt` records that
  the notice was written; if the notice itself fails, the pull result is kept and only the notice is
  retried on later polls. `mergeHandledAt` is set only once the pull (and, for this repository, the
  notice) succeeds, so a later poll or a service restart neither pulls nor notifies again.

Only an observed transition counts: an item the watcher already saw as `MERGED` (for example the
historical merged PRs already in an upgraded inbox) is left alone, so the first poll after an
upgrade neither pulls every old PR nor queues a notice for each.

Only `tools/` directories with a GitHub origin are candidates. `research/` is local-only and is
never polled, pulled or pushed. The cold install is always performed by the operator (or the SPV
session after the notice), never by the running service.

### Layout

The inbox and the Settings page share one width: `.wca-page` defines `--wca-content-max: 1200px`
(the old common frame was 960) and every direct child uses it, so the two frames cannot drift apart.
The inbox no longer reserves a 104px date rail on the left: a day is a structural `<section>` with
an accessible name and 24px spacing (12px between cards), so the card column starts at the same left
edge as the settings groups. Each letter shows its own timestamp (the day plus `HH:MM`, taken from
`at` / `createdAt` / `updatedAt`, with the full value in `title`) right-aligned in its meta row, clear
of the chips.

### Panel style

`webui.style` selects the visual variant and defaults to **fluid**. Both variants share the same
layout, so switching never moves a control:

- **fluid** — material and motion. The page below a card is an opaque token surface, so a backdrop
  blur would render as nothing; instead each card carries a visible tonal wash (an 18% token tint
  over the layer background, fading into it), a tinted hairline border and two shadow layers that read
  as elevation. Motion is always on: a 30ms staggered arrival on every mount/refresh (not only for
  newly polled letters), a 2px hover lift with a visibly deeper ambient shadow, a press on the card
  and on controls (`scale(.985)`), an enter curve with a little spring, a 240ms disclosure whose
  content follows 40ms behind, a `clip-path` wipe on the status pill, and an approve settle of 1px.
  Separation comes from cards and spacing; there are no divider rules between groups or inside cards,
  and no stamp, flag, paper texture, rotated card or console/HUD chrome. The entry marker is cleared
  when its animation ends (with a 900ms fallback for minimal/reduced-motion, where no animation event
  fires), so a later status re-render does not replay it.
- **minimal** — the escape hatch: the same cards on a flat token background, with no tint, shadow or
  animation. It stays fully usable and keeps the status spine and all controls.

The panel reads the saved style on load. The Settings select previews a change immediately; Save
makes it stick. Every animation and transition is disabled under `prefers-reduced-motion: reduce`.

### Drafts

An inbox review comment is keyed by item id, persisted to `localStorage`, restored when the operator
returns to the section, and cleared only after a successful submit; a visible `Draft` tag marks the
card while it differs. The Settings form uses the same pattern (revision-scoped): a section switch
keeps the staged edits and their `Draft` tags, a successful save clears them, and a 409 keeps them
while the operator reloads the newer snapshot. When `localStorage` is denied, both fall back to an
in-memory copy for the life of the page.

## Markdown

PR descriptions and `spv_message` bodies are rendered by a small dependency-free Markdown → React renderer inside
`lib/client.js`. It supports ATX headings, unordered/ordered nested lists, fenced code blocks,
inline code, bold/italic/strikethrough, links, blockquotes, horizontal rules, GFM pipe tables and
paragraphs. Raw HTML is not passed through (text becomes React children, so nothing is injected);
images render as their alt text linked to the image, and footnotes and math are intentionally
unsupported. The body is collapsed by default; expanding "PR description" / "Decision note" renders the Markdown.
Block nesting is capped so a hostile body cannot exhaust the stack.

## Self-contained installed package

`install.sh` copies this package into the profile's `node_modules` **and** copies the core
files it imports from the checkout:

```
src/spv/inbox.js          -> lib/core/inbox.js
src/spv/dispatch.js       -> lib/core/dispatch.js
src/spv/hook-runner.js    -> lib/core/hook-runner.js
src/spv/paths.js          -> lib/core/paths.js
src/shared/home.js        -> lib/shared/home.js
src/shared/hook-events.js -> lib/shared/hook-events.js
src/shared/hooks.js       -> lib/shared/hooks.js
src/shared/queue.js       -> lib/shared/queue.js
src/shared/settings.js    -> lib/shared/settings.js
```

The relative imports line up (`inbox.js` imports `./dispatch.js`, `./paths.js`,
`../shared/queue.js`, `../shared/hooks.js`, `../shared/settings.js`, `../shared/home.js`;
`hook-runner.js` imports `./paths.js`, `../shared/hooks.js`, `../shared/queue.js`;
`hooks.js` imports `./home.js`, `./queue.js`, `./settings.js`, `./hook-events.js`), so the
installed package is self-contained: replacing
`~/.dsh/.agent-presets/spv/` (for example, another worktree running its own `install.sh`) can no
longer break the plugin's import, and the next service restart keeps working.

The copies are **generated by `install.sh` and never edited by hand**. The single source of truth
is the checkout, and `install.sh --check` proves the installed copies match it with `diff -r` — one
implementation, copied at install time.

## Install and upgrade notes

The package is a directory inside the profile's `node_modules`, not a dependency in the profile's
`package.json` (that file is operator/dsh state and is deliberately not modified). A `pnpm install`
run against the profile may prune anything it does not know about, removing this package;
`install.sh --check` reports that, and rerunning `install.sh` restores it. If you reinstall the
profile itself, run `bash install.sh` afterwards; `install.sh` is cold-only, so stop the service and
exit the SPV session first or it refuses with exit 3.

**Restart the superagent service after installing a host-half code change.** `lib/client.js`
hot-reloads through dsh's client-bundle watcher, but `lib/index.js` and the core copies are imported
once when the service starts. The server-side `kind` / `repo` / `since` / `until` filters, the
`/wheelchair-settings` route and the inbox poller code live in that host half, so an already-running
older service keeps the old behaviour even though the new client bundle is visible. Saved settings
are different: the file is re-read on use, so a save from the page needs no restart.

`install.sh` is cold-install only: while the service or a live SPV session holds the targets it
refuses with exit 3, and `install.sh --check` is read-only. Between a merge and the next cold
install, `--check` therefore reports the installed tree as different (exit 2); that is the expected
cold-install state, not a panel regression. A cold install into a throwaway `DSH_HOME` followed by
`--check` is the offline proof of the checkout.

The settings-file step is also a first reader. On a machine upgrading from the pre-#21 layout it can
therefore complete the one-shot move of `panel-settings.json` and the old inbox into the data root,
exactly as the service's first mount or the CLI would; the move is logged in `<root>/logs/migration.log`.
It never rewrites an existing `settings.json` (the helper opens with `wx`), so a hand-edited file
survives a re-install unchanged.


## 与 `ARCHITECTURE.md` 的边界：面板是功能宿主（摘自 ARCHITECTURE.md）

面板是 **`wheelchair-agent` 的功能宿主**（不是 iframe）：左侧栏一项 `wheelchair-agent`，页面是原生 React 组件，
渲染在 host 的 `main` slot，继承 host 的 theme token 与 `ctx.locale`。当前两个功能：**收件箱**（PR 与 SPV 决策信；
`approve` 只记录、`issue` 发一条 notice 回 SPV，**不派 worker**）与**设置**（只存本项目自己的键，superagent 的
设置块不在这里重复）。功能由 `SECTIONS` 数组驱动，加一个功能 = 加一个数组项 + 一个组件。

面板是**独立包** `wheelchair-agent-webui`（`dsh-client-modules` 只认裸包名，子路径成不了 loader 行），
`install.sh` 把它拷进 superagent profile 的 `node_modules` 并 append 一行 loader。`webui/lib/client.js` 是手写的
预构建 bundle（无 JSX、无构建链、只用 `--dsw-alias-*` token、`wca-` 前缀）；host 半身 `webui/lib/index.js` 注册
`/wheelchair-inbox/{items,review}` 与 `/wheelchair-settings` 三条 JSON 路由。

**面板的布局、样式变体（`webui.style` = `fluid` 默认 / `minimal` 逃生口）、宽度节奏、审查记录的渲染细节，全部
在本文件与 `settings.md` / `hooks.md` / `screenshots.md` 里。**

## See also

- 设置页（路由、设置文件、优先级、模板与预设）：`ARCHITECTURE/webui/settings.md`
- 面板第三段「插口」：`ARCHITECTURE/webui/hooks.md`
- 各次改动的截图证据：`ARCHITECTURE/webui/screenshots.md`
