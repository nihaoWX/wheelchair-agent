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

The page is a **feature host**, not a PR list: the nav lists features (review inbox and Settings
today, shaped so adding another is one array entry) and the active feature renders in its own bordered
panel with its own title, description and toolbar. `SECTIONS` is the single declaration:

```js
const SECTIONS = [
  { id: 'inbox', labelKey: 'section.inbox', titleKey: 'feature.inbox.title',
    descriptionKey: 'feature.inbox.description', Component: InboxSection },
  { id: 'settings', labelKey: 'section.settings', titleKey: 'feature.settings.title',
    descriptionKey: 'feature.settings.description', Component: SettingsSection },
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
  `effective`, `rows`, `templates`), `cache-control: no-store`, re-read from disk on every request.
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

## Screenshots

All captures use the same dsh web composition (`dsh-web-app`, 1440×900 unless a file name says
otherwise), light unless the file name says dark. The letter-types comparison uses the same scenario —
the real inbox with its PR rows —
and the same viewport/theme: `before-letter-types.png` is commit `f301111` (the PR-only list), and
`after-letter-types.png` is PR #13 (`c5ab828`). That after capture also shows one temporary `spv_message`
fixture, written with the new `inbox add`; it was removed after the capture. No submission was sent
from either form, so no worker task or SPV notice was produced.

The Settings comparison uses the same app at 1440×900 in light, in fresh English and Chinese pages:
`before-settings-*.png` is the installed package at `main` @ `f2472a5` (Inbox only) and
`after-settings-*.png` is `agent/webui-settings` @ `5bcecb7` (Inbox and Settings). Because the running
service predates the new host route and cannot be restarted (it runs workers), the branch's
`lib/client.js` was hot-swapped into the installed package only for these captures, and
`/wheelchair-settings` was served in the page by request interception forwarding GET/PUT to a
temporary local Node process running the real `createSettingsHandler({ stateDir, env: {} })` from
`src/shared/settings.js`, seeded with one custom `prIssue` preset; no hand-written JSON fixtures were
used. The installed client was restored afterwards (sha256 equals `main` @ `f2472a5`), and the host
route registration itself is covered by the test suite.

- `docs/before-settings-en.png` / `docs/before-settings-zh.png` — baseline installed panel at
  `main` @ `f2472a5`: the Inbox tab only, no Settings tab, English and Chinese.
- `docs/after-settings-en.png` / `docs/after-settings-zh.png` — the Settings tab at page top, both
  locales: Reload/Save toolbar, status, Inbox refresh / Merge handling / Message injection groups,
  with row labels, effective/default values, Reset buttons and source tags.
- `docs/after-settings-templates-en.png` — the Dispatch text group scrolled into view: the three
  template rows with preset selector, textarea, "New preset from this", Delete preset, Revert to
  default, character count and placeholder list; the `prIssue` row uses the seeded `terse` preset.
- `docs/after-settings-validation-en.png` — removing the required `{comment}` from that preset and
  pressing Save shows the inline error ("Missing required placeholder {comment}") and the client
  blocks the PUT, so the revision stays 1.
- `docs/after-settings-saved-en.png` — optional live-save capture: changing
  `inbox.intervalSeconds` from 60 to 90 and pressing Save PUTs to the real handler and shows
  **Saved at revision 2**, the `Saved` source tag and effective 90 / default 60.
- `docs/after-settings-dark.png` — optional dark capture of the same Settings page; the host tokens
  switch under `prefers-color-scheme: dark`.
- `docs/before-status-pending.png` / `docs/after-status-pending.png` — the review-status regression
  on the real inbox, **Pending review** tab, light, 1440×2300 (tall enough for all seven rows). Before, the installed panel shows only
  #6 as pending and counts 14 approved because merged-but-unreviewed PRs fall through to GitHub's
  `MERGED` state. After, the branch's `client.js` is hot-swapped into the running package (the documented
  client-bundle path; no preset/host install) and shows
  **7 pending**: #6 with a `Closed` chip and #11–#16 with a `Merged` chip, all still **Pending review**.
- `docs/before-status-approved.png` / `docs/after-status-approved.png` — the same comparison on the
  **Approved** tab: the wrong count drops from 14 to the **8** items that actually carry an
  `approve` record (`#2 #3 #4 #5 #7 #8 #9 #10`), each with its own `Merged` chip. #11–#16 no longer
  appear here.
- `docs/before-letter-types.png` / `docs/after-letter-types.png` — PR-only list vs the two-letter
  inbox with the filter bar (`letter type` / `repository` / `time`), the `PR` and `SPV decision`
  badges, and the two separate actions.
- `docs/after-approve-form.png` — "Approve" opens the optional comment box; its hint says the text
  is recorded only and does not notify the agent.
- `docs/before-issue-form-pr.png` / `docs/after-issue-form-pr.png` — "Flag issue" on a PR in the
  same inbox: the old installed copy said submitting dispatches it to a worker; the branch's
  `client.js` (served to the same running app) says it notifies SPV. The after capture is 1440×900,
  light, like the before.
- `docs/after-issue-form.png` — "Flag issue" on an `spv_message`: the comment is required and the
  hint says submitting notifies SPV.
- `docs/after-letter-types-dark.png` — the same two-letter inbox in dark theme.
- `docs/after-filter-pending.png`, `docs/after-filter-issues.png`,
  `docs/after-filter-approved.png`, `docs/after-filter-all.png` — historical PR #13 captures of the
  four derived-status tabs (before the PR-state chip and the merged-status correction); kept as
  history.
- `docs/after-pr-body.png` — a PR description expanded in the new chrome, rendering Markdown.
- `docs/after-panel.png` / `docs/after-panel-dark.png` — earlier feature-host captures in light and dark; the current status/chip UI is shown above.

### Panel style, cards and drafts (this change)

The before/after pair uses the **same throwaway `superagent` profile, the same seeded inbox, the same
1440×900 viewport and light theme**, so only the panel changes:

- **before** — `main` @ `60661a8`: one boxed surface, one-column settings rows, rule dividers between
  groups and rows, no style setting.
- **after** — `agent/webui-style-salvage` @ `04a5e82`: group cards, two-column settings rows, a status
  spine per letter, actions at the card foot, no divider rules, the `Panel style` select, and the
  review/form drafts.

The captures were taken in a copy of the profile under a `mkdtemp` root, not against the live service:
`DSH_HOME`, `WHEELCHAIR_AGENT_HOME`, `DSH_SUPERAGENT_STATE_DIR`, `SPV_QUEUE_DIR` and `SPV_INBOX_DIR`
pointed inside the sandbox, `SPV_INBOX_INTERVAL_SECONDS=0`, and the superagent orchestrator row was
disabled so no Source or model was mounted. The inbox items were seeded fixtures; no submission was
sent, so no SPV notice or worker task was produced.

- `docs/panel-style-before-inbox-1440.png` — the baseline inbox on `main` @ `60661a8`, **Pending
  review**, 1440×900.
- `docs/panel-style-after-inbox-1440.png` — the same view on the branch: letter cards, one spine per
  letter, PR / SPV decision dimensions, actions at the card bottom, no rules between groups.
- `docs/panel-style-after-inbox-draft-1440.png` — a review comment typed on the first card, then
  Settings → Inbox: the text and the `Draft` tag are back.
- `docs/panel-style-after-inbox-minimal-1440.png` — the same inbox with the `Panel style` select
  previewing `Minimal`: flat cards, no blur/shadow/motion, same layout.
- `docs/panel-style-before-settings-1440.png` — the baseline Settings page on `main` @ `60661a8`,
  1440×900: one column, rule dividers, explanation inline.
- `docs/panel-style-after-settings-1440.png` — the same Settings page on the branch at 1440×900: the
  Appearance card with the `Panel style` select and two-column rows.
- `docs/panel-style-after-settings-full-1440.png` — the whole after Settings page at 1440px wide
  (1440×3140), showing every group card and the three template editors.
- `docs/panel-style-after-settings-1000.png` — the same page at 1000×3852: the responsive single-column
  fallback below 1100px.
- `docs/panel-style-after-settings-dark-1440.png` — the after Settings page in the host's dark theme.

### Panel width, inbox timestamp and fluid material (this change)

The before/after pair uses the **same seeded inbox, the same throwaway profile copy and the same
1600×1000 viewport and light theme**; the baseline is `main` @ `1fcde56`, and the after is this
branch. 1600 was chosen so the 960 → 1200 frame is visible at full width (`1440` is narrower than
1200 + the sidebar and page padding). The sandbox used `DSH_HOME`, `WHEELCHAIR_AGENT_HOME`,
`DSH_SUPERAGENT_STATE_DIR`, `SPV_QUEUE_DIR` and `SPV_INBOX_DIR` under `/tmp`,
`SPV_INBOX_INTERVAL_SECONDS=0`, and seeded fixture letters only; no submission was sent and no live
state was touched.

- `docs/panel-layout-before-inbox-1600.png` — baseline inbox on `main` @ `1fcde56`: the 960px frame,
  the 104px date rail on the left and the cards pushed right.
- `docs/panel-layout-after-inbox-1600.png` — the same inbox on this branch: a 1200px frame, no rail,
  the cards starting at the settings groups' left edge, each letter's own `Nov 16, 09:40` timestamp
  in its meta row, and the fluid tonal wash, tinted border and layered shadow.
- `docs/panel-layout-after-inbox-minimal-1600.png` — the same view with the Settings select
  previewing `Minimal`: flat cards, no tint, shadow or motion, identical layout and timestamps.
- `docs/panel-layout-after-inbox-hover-1600.png` — the first letter hovered: a 2px lift and a visibly
  deeper ambient shadow than the `after-inbox` capture.
- `docs/panel-layout-after-inbox-motion.gif` — an 1120×540 crop recorded while the panel mounts (the
  staggered arrival: the first letter leads the second) and then the first card is hovered (the 2px
  lift and deeper shadow settle in): the motion the operator could not see before this change.
- `docs/panel-layout-before-settings-1600.png` — baseline Settings page on `main` @ `1fcde56`: the
  960px frame.
- `docs/panel-layout-after-settings-1600.png` — the same Settings page on this branch: the 1200px
  frame and the fluid group cards (tonal wash, border and shadow).
- `docs/panel-layout-after-inbox-dark-1600.png` — optional dark capture of the same after inbox, to
  confirm the tokens and shadow layers still read in the host's dark theme.

Earlier captures (`before-panel.png`, `before-sidebar.png` / `after-sidebar.png`,
`after-pr-table.png`, `after-pr-code-dark.png`, `before-pr-body-dark.png` /
`after-pr-body-dark.png`) document the earlier iframe → feature-host change at commit `7e8bfff`;
they predate the letter types and are kept as history.
