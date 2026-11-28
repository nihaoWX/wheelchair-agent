# 面板：截图证据

每一次改动的前后截图与判读。上级：`ARCHITECTURE/webui/index.md`。

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

- `webui/docs/before-settings-en.png` / `webui/docs/before-settings-zh.png` — baseline installed panel at
  `main` @ `f2472a5`: the Inbox tab only, no Settings tab, English and Chinese.
- `webui/docs/after-settings-en.png` / `webui/docs/after-settings-zh.png` — the Settings tab at page top, both
  locales: Reload/Save toolbar, status, Inbox refresh / Merge handling / Message injection groups,
  with row labels, effective/default values, Reset buttons and source tags.
- `webui/docs/after-settings-templates-en.png` — the Dispatch text group scrolled into view: the three
  template rows with preset selector, textarea, "New preset from this", Delete preset, Revert to
  default, character count and placeholder list; the `prIssue` row uses the seeded `terse` preset.
- `webui/docs/after-settings-validation-en.png` — removing the required `{comment}` from that preset and
  pressing Save shows the inline error ("Missing required placeholder {comment}") and the client
  blocks the PUT, so the revision stays 1.
- `webui/docs/after-settings-saved-en.png` — optional live-save capture: changing
  `inbox.intervalSeconds` from 60 to 90 and pressing Save PUTs to the real handler and shows
  **Saved at revision 2**, the `Saved` source tag and effective 90 / default 60.
- `webui/docs/after-settings-dark.png` — optional dark capture of the same Settings page; the host tokens
  switch under `prefers-color-scheme: dark`.
- `webui/docs/before-status-pending.png` / `webui/docs/after-status-pending.png` — the review-status regression
  on the real inbox, **Pending review** tab, light, 1440×2300 (tall enough for all seven rows). Before, the installed panel shows only
  #6 as pending and counts 14 approved because merged-but-unreviewed PRs fall through to GitHub's
  `MERGED` state. After, the branch's `client.js` is hot-swapped into the running package (the documented
  client-bundle path; no preset/host install) and shows
  **7 pending**: #6 with a `Closed` chip and #11–#16 with a `Merged` chip, all still **Pending review**.
- `webui/docs/before-status-approved.png` / `webui/docs/after-status-approved.png` — the same comparison on the
  **Approved** tab: the wrong count drops from 14 to the **8** items that actually carry an
  `approve` record (`#2 #3 #4 #5 #7 #8 #9 #10`), each with its own `Merged` chip. #11–#16 no longer
  appear here.
- `webui/docs/before-letter-types.png` / `webui/docs/after-letter-types.png` — PR-only list vs the two-letter
  inbox with the filter bar (`letter type` / `repository` / `time`), the `PR` and `SPV decision`
  badges, and the two separate actions.
- `webui/docs/after-approve-form.png` — "Approve" opens the optional comment box; its hint says the text
  is recorded only and does not notify the agent.
- `webui/docs/before-issue-form-pr.png` / `webui/docs/after-issue-form-pr.png` — "Flag issue" on a PR in the
  same inbox: the old installed copy said submitting dispatches it to a worker; the branch's
  `client.js` (served to the same running app) says it notifies SPV. The after capture is 1440×900,
  light, like the before.
- `webui/docs/after-issue-form.png` — "Flag issue" on an `spv_message`: the comment is required and the
  hint says submitting notifies SPV.
- `webui/docs/after-letter-types-dark.png` — the same two-letter inbox in dark theme.
- `webui/docs/after-filter-pending.png`, `webui/docs/after-filter-issues.png`,
  `webui/docs/after-filter-approved.png`, `webui/docs/after-filter-all.png` — historical PR #13 captures of the
  four derived-status tabs (before the PR-state chip and the merged-status correction); kept as
  history.
- `webui/docs/after-pr-body.png` — a PR description expanded in the new chrome, rendering Markdown.
- `webui/docs/after-panel.png` / `webui/docs/after-panel-dark.png` — earlier feature-host captures in light and dark; the current status/chip UI is shown above.

### Panel plugin parity (this change)

The pair uses the **same throwaway temp `DSH_HOME`**, the same empty workspace, the same 1440×900
viewport and the same signed-out state, so only the panel's plugin set and mirrored config differ:

- `webui/docs/before-panel-plugins.png` — the panel profile as the previous `install.sh` left it:
  `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`, the `wheelchair-agent-webui` loader row and the
  managed `ui-settings-general` row only; light default theme.
- `webui/docs/after-panel-plugins-dark.png` —（历史截图：`#63` 时代「面板镜像来源 profile」的做法；`#74` 起面板跑的是
  `wca` + `deployments/panel.yml`，画面不变但机制已不是镜像）after `wheelchair-agent panel sync` against a source
  `superagent` profile with `dsh-context`, `billion-context` and `@mars-sea/dsh-commandcode-provider`:
  **Context Insights** appears from `dsh-context`, and the dark theme comes from the mirrored
  `ui-theme` row. The signed-out dialog is expected in both boxes: the temp `DSH_HOME` has no account.

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

- `webui/docs/panel-style-before-inbox-1440.png` — the baseline inbox on `main` @ `60661a8`, **Pending
  review**, 1440×900.
- `webui/docs/panel-style-after-inbox-1440.png` — the same view on the branch: letter cards, one spine per
  letter, PR / SPV decision dimensions, actions at the card bottom, no rules between groups.
- `webui/docs/panel-style-after-inbox-draft-1440.png` — a review comment typed on the first card, then
  Settings → Inbox: the text and the `Draft` tag are back.
- `webui/docs/panel-style-after-inbox-minimal-1440.png` — the same inbox with the `Panel style` select
  previewing `Minimal`: flat cards, no blur/shadow/motion, same layout.
- `webui/docs/panel-style-before-settings-1440.png` — the baseline Settings page on `main` @ `60661a8`,
  1440×900: one column, rule dividers, explanation inline.
- `webui/docs/panel-style-after-settings-1440.png` — the same Settings page on the branch at 1440×900: the
  Appearance card with the `Panel style` select and two-column rows.
- `webui/docs/panel-style-after-settings-full-1440.png` — the whole after Settings page at 1440px wide
  (1440×3140), showing every group card and the three template editors.
- `webui/docs/panel-style-after-settings-1000.png` — the same page at 1000×3852: the responsive single-column
  fallback below 1100px.
- `webui/docs/panel-style-after-settings-dark-1440.png` — the after Settings page in the host's dark theme.

### Panel width, inbox timestamp and fluid material (this change)

The before/after pair uses the **same seeded inbox, the same throwaway profile copy and the same
1600×1000 viewport and light theme**; the baseline is `main` @ `1fcde56`, and the after is this
branch. 1600 was chosen so the 960 → 1200 frame is visible at full width (`1440` is narrower than
1200 + the sidebar and page padding). The sandbox used `DSH_HOME`, `WHEELCHAIR_AGENT_HOME`,
`DSH_SUPERAGENT_STATE_DIR`, `SPV_QUEUE_DIR` and `SPV_INBOX_DIR` under `/tmp`,
`SPV_INBOX_INTERVAL_SECONDS=0`, and seeded fixture letters only; no submission was sent and no live
state was touched.

- `webui/docs/panel-layout-before-inbox-1600.png` — baseline inbox on `main` @ `1fcde56`: the 960px frame,
  the 104px date rail on the left and the cards pushed right.
- `webui/docs/panel-layout-after-inbox-1600.png` — the same inbox on this branch: a 1200px frame, no rail,
  the cards starting at the settings groups' left edge, each letter's own `Nov 16, 09:40` timestamp
  in its meta row, and the fluid tonal wash, tinted border and layered shadow.
- `webui/docs/panel-layout-after-inbox-minimal-1600.png` — the same view with the Settings select
  previewing `Minimal`: flat cards, no tint, shadow or motion, identical layout and timestamps.
- `webui/docs/panel-layout-after-inbox-hover-1600.png` — the first letter hovered: a 2px lift and a visibly
  deeper ambient shadow than the `after-inbox` capture.
- `docs/panel-layout-after-inbox-motion.gif` — an 1120×540 crop recorded while the panel mounts (the
  staggered arrival: the first letter leads the second) and then the first card is hovered (the 2px
  lift and deeper shadow settle in): the motion the operator could not see before this change.
- `webui/docs/panel-layout-before-settings-1600.png` — baseline Settings page on `main` @ `1fcde56`: the
  960px frame.
- `webui/docs/panel-layout-after-settings-1600.png` — the same Settings page on this branch: the 1200px
  frame and the fluid group cards (tonal wash, border and shadow).
- `webui/docs/panel-layout-after-inbox-dark-1600.png` — optional dark capture of the same after inbox, to
  confirm the tokens and shadow layers still read in the host's dark theme.

Earlier captures (`before-panel.png`, `before-sidebar.png` / `after-sidebar.png`,
`after-pr-table.png`, `after-pr-code-dark.png`, `before-pr-body-dark.png` /
`after-pr-body-dark.png`) document the earlier iframe → feature-host change at commit `7e8bfff`;
they predate the letter types and are kept as history.

### Hooks section (this change)

The before/after pair uses the **same seeded data root, the same throwaway `web` profile copy, the
same 1440×1000 viewport and light theme**. The baseline is `main` @ `2788bbc`; the after is this
branch. Both runs used a copy of the profile under `mkdtemp`, `DSH_HOME` / `WHEELCHAIR_AGENT_HOME` /
`DSH_SUPERAGENT_STATE_DIR` / `SPV_QUEUE_DIR` / `SPV_INBOX_DIR` inside it,
`SPV_INBOX_INTERVAL_SECONDS=0`, and a seeded `settings.json` plus six `ticket.delivered` rows in
`records/hooks.jsonl`; no live state was read or written and no hook ran. The section was captured in
the real dsh host (Chromium against the profile's own page), not a mock.

- `webui/docs/hooks-panel-before-1440.png` — `main` @ `2788bbc`: the feature nav has only 收件箱 / 设置;
  there is no 插口 tab.
- `webui/docs/hooks-panel-after-1440.png` — the same page and viewport on this branch, 插口 selected:
  收件箱 / 设置 / 插口, the eight-event summary, and the first event with its built-in row, the
  "cannot cancel or delete" line, the rename input and the empty last-five-runs area.
- `webui/docs/hooks-panel-after-history-1440.png` — the `ticket.delivered` card scrolled to its history:
  five rows newest-first (成功 / 已暂停 / 超时 / 失败 with the trimmed stderr / 成功), the custom
  row's collapsed script preview and its last run.
- `webui/docs/hooks-panel-after-prompt-1440.png` — `ticket.acknowledged` expanded: 收起, the copy button,
  the sentence "让 agent 照这段提示词去改" and the generated prompt text (no script box, no run
  button).
- `webui/docs/hooks-panel-after-rename-1440.png` — `builtin:injection` renamed from the panel; the PUT
  moved the file from revision 7 to 8 and the row shows 已改名 plus the default-name hint.
- `webui/docs/hooks-panel-after-minimal-1440.png` — the same Hooks section with `webui.style=minimal`
  (flat cards, no tint/shadow/motion); layout, widths and every control stay identical.

The captures confirm the visual side only; the revision/stale-409 behavior is asserted in
`tests/test-hooks.mjs` and `tests/test-settings.mjs`.
