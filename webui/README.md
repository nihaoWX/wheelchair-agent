# `wheelchair-agent-webui` — the wheelchair-agent UI home panel

An **independent dsh web client plugin package**. It adds the `wheelchair-agent` **feature host** to
the `superagent` profile: one sidebar row, one full-size page that lists features and hosts the
active feature panel (the review inbox, 收件箱, is the first one), and the `/wheelchair-inbox/*`
JSON routes the inbox talks to.

## Why a separate package

`@deepseek-ai/dsh-client-modules` discovers a browser bundle by scanning the **bare package
specifiers** of the host Loader's rows for a `dsh.client` declaration. A package inside another
package (`wheelchair-agent/webui`) is not a row of its own and is never scanned, so the panel
would simply not appear. Hence a real package, installed into the profile's `node_modules` with
its own loader row in `~/.dsh/profiles/superagent/cordis.patch.yml` (written by `install.sh`).

## How it loads

- Host half (`lib/index.js`): `name = 'wheelchair-agent-webui'`, `inject = ['webServer',
  'connection']`. It registers two exact JSON routes — `/wheelchair-inbox/items` and
  `/wheelchair-inbox/review` — each behind `ctx.connection.requestRejection` so dsh's
  Host/Origin and login fence guards them, and starts the inbox poller through `ctx.effect`.
  The Host no longer serves a page: the panel is a Client React component.
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

The page is a **feature host**, not a PR list: the nav lists features (one today, shaped so adding
another is one array entry) and the active feature renders in its own bordered panel with its own
title, description and toolbar. `SECTIONS` is the single declaration:

```js
const SECTIONS = [{
  id: 'inbox',
  labelKey: 'section.inbox',
  titleKey: 'feature.inbox.title',
  descriptionKey: 'feature.inbox.description',
  Component: InboxSection,
}]
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
requires a comment and branches by letter type: a `pr` dispatches the usual `inbox-<pr>` worker
task; an `spv_message` writes **exactly one** `notice` into the spv outbox on the letter's thread,
so the SPV session sees which decision is being questioned. Neither path sends an outbox message for
a PR issue. Legacy `question` / `fix` records are normalized to `issue` on read, and the old disk
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

The interval is **60 seconds by default**, matching the CLI. Configure it in either place:

- the webui plugin's config: `intervalSeconds: <seconds>`; or
- `SPV_INBOX_INTERVAL_SECONDS=<seconds>` in the service's environment.

`0` disables the automatic poller (the CLI still works). A non-numeric or negative value is logged
and falls back to 60s rather than failing the panel. One failing repository or one `gh` error is
logged as a warning and the next round still runs.

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

## Markdown

PR descriptions and `spv_message` bodies are rendered by a small dependency-free Markdown → React renderer inside
`lib/client.js`. It supports ATX headings, unordered/ordered nested lists, fenced code blocks,
inline code, bold/italic/strikethrough, links, blockquotes, horizontal rules, GFM pipe tables and
paragraphs. Raw HTML is not passed through (text becomes React children, so nothing is injected);
images render as their alt text linked to the image, and footnotes and math are intentionally
unsupported. The body is collapsed by default; expanding "PR description" / "Decision note" renders the Markdown.
Block nesting is capped so a hostile body cannot exhaust the stack.

## Self-contained installed package

`install.sh` copies this package into the profile's `node_modules` **and** copies the four core
files it imports from the checkout:

```
src/spv/inbox.js     -> lib/core/inbox.js
src/spv/dispatch.js  -> lib/core/dispatch.js
src/spv/paths.js     -> lib/core/paths.js
src/shared/queue.js  -> lib/shared/queue.js
```

The relative imports line up (`inbox.js` imports `./dispatch.js`, `./paths.js`,
`../shared/queue.js`), so the installed package is self-contained: replacing
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

**Restart the superagent service after installing a host-half change.** `lib/client.js` hot-reloads
through dsh's client-bundle watcher, but `lib/index.js` and the core copies are imported once when
the service starts. The server-side `kind` / `repo` / `since` / `until` filters and the inbox poller
live in that host half, so an already-running older service keeps the old behaviour even though the
new client bundle is visible.

`install.sh` is cold-install only: while the service or a live SPV session holds the targets it
refuses with exit 3, and `install.sh --check` is read-only. Between a merge and the next cold
install, `--check` therefore reports the installed tree as different (exit 2); that is the expected
cold-install state, not a panel regression. A cold install into a throwaway `DSH_HOME` followed by
`--check` is the offline proof of the checkout.

## Screenshots

All captures use the same dsh web composition (`dsh-web-app`, 1440×900), light unless the file name
says dark. The letter-types comparison uses the same scenario — the real inbox with its PR rows —
and the same viewport/theme: `before-letter-types.png` is commit `f301111` (the PR-only list), and
`after-letter-types.png` is PR #13 (`c5ab828`). That after capture also shows one temporary `spv_message`
fixture, written with the new `inbox add`; it was removed after the capture. No submission was sent
from either form, so no worker task or SPV notice was produced.

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
- `docs/after-issue-form.png` — "Flag issue" on an `spv_message`: the comment is required and the
  hint says submitting notifies SPV (on a PR the same action says it dispatches a worker).
- `docs/after-letter-types-dark.png` — the same two-letter inbox in dark theme.
- `docs/after-filter-pending.png`, `docs/after-filter-issues.png`,
  `docs/after-filter-approved.png`, `docs/after-filter-all.png` — historical PR #13 captures of the
  four derived-status tabs (before the PR-state chip and the merged-status correction); kept as
  history.
- `docs/after-pr-body.png` — a PR description expanded in the new chrome, rendering Markdown.
- `docs/after-panel.png` / `docs/after-panel-dark.png` — earlier feature-host captures in light and dark; the current status/chip UI is shown above.

Earlier captures (`before-panel.png`, `before-sidebar.png` / `after-sidebar.png`,
`after-pr-table.png`, `after-pr-code-dark.png`, `before-pr-body-dark.png` /
`after-pr-body-dark.png`) document the earlier iframe → feature-host change at commit `7e8bfff`;
they predate the letter types and are kept as history.
