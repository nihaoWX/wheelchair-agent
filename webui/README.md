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
  Host/Origin and login fence guards them. The Host no longer serves a page: the panel is a
  Client React component.
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

The inbox feature derives each PR's review status from the **latest `review` entry**, with no
stored status field (`statusOf(item)` in `lib/client.js`):

| latest review | status | UI |
|---|---|---|
| none | `pending` (待审) | tertiary badge |
| `approve` | `approved` (已通过) | success badge; row de-emphasized |
| `issue` | `issue` (有问题) | error badge |

`approve` takes no text and dispatches nothing; `issue` requires text and dispatches the usual
`inbox-<pr>` task. Legacy `question` / `fix` records are normalized to `issue` on read, and the old
disk records are never rewritten. The toolbar filters by derived status (All / Pending / Issues /
Approved, default Pending), with counts.

## Markdown

PR descriptions are rendered by a small dependency-free Markdown → React renderer inside
`lib/client.js`. It supports ATX headings, unordered/ordered nested lists, fenced code blocks,
inline code, bold/italic/strikethrough, links, blockquotes, horizontal rules, GFM pipe tables and
paragraphs. Raw HTML is not passed through (text becomes React children, so nothing is injected);
images render as their alt text linked to the image, and footnotes and math are intentionally
unsupported. The body is collapsed by default; expanding "PR description" renders the Markdown.
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
profile itself, run `bash install.sh` afterwards.

## Screenshots

All captures use the same dsh web composition (`dsh-web-app`, 1440×900). The "before" column is
the previous iframe page (commit `7e8bfff`); the "after" column is the native feature host. Light
and dark are included; the superagent service was not restarted, so the browser loaded the updated
package through dsh's client-bundle watcher.

- `docs/before-panel.png` / `docs/after-panel.png` — the panel before (iframe list) and after
  (feature host, default Pending filter, light).
- `docs/after-panel-dark.png` — the feature host in dark theme.
- `docs/after-filter-pending.png`, `docs/after-filter-issues.png`,
  `docs/after-filter-approved.png`, `docs/after-filter-all.png` — the four filter states,
  including the real PR #1 whose legacy `question` review displays as **Issue**.
- `docs/after-issue-form.png` — "Flag issue" expanded with a comment.
- `docs/before-pr-body.png` / `docs/after-pr-body.png` — the **same PR #4 body** expanded:
  plain text + monospace before, rendered Markdown after (light).
- `docs/before-pr-body-dark.png` / `docs/after-pr-body-dark.png` — the same comparison in dark.
- `docs/after-pr-table.png` — a GFM pipe table rendered with token-colored borders.
- `docs/after-pr-code-dark.png` — a fenced code block in dark theme (monospace + code surface).
- `docs/before-sidebar.png` / `docs/after-sidebar.png` — the sidebar before/after this package.

The approved-state capture uses a temporary fixture item because the real inbox had no approved
PR; it was removed after the capture. Every other capture uses the real inbox.
