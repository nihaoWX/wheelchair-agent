#!/usr/bin/env node
/**
 * tests/test-preset.mjs — offline evidence that the SPV preset carries no custom persona.
 *
 * The operator's decision (INSTRUCTIONS.md): the SPV system prompt is a plain dsh system prompt; nothing about
 * wheelchair-agent or spv is injected through a persona. The dispatch contract lives in the `spv_dispatch`
 * tool description instead.
 *
 * This test:
 *   - renders the preset through `build/render-preset.mjs` (the same entry `install.sh` calls) into `mkdtemp`;
 *   - asserts the rendered `agent.cordis.yml` and `preset-default.patch.yml` contain no persona row and no
 *     `dsh-persona` reference — not even in a comment;
 *   - asserts the old persona prose ("You are SPV" / "You do not do implementation work yourself") is gone;
 *   - imports the registered `spv_dispatch` description and asserts it carries the delivery rule and the
 *     "no waiting / no polling" rule, so a future edit cannot silently drop them.
 *
 * Everything runs in `mkdtemp`; no network, no `install.sh`, no dsh service.
 *
 * Usage: node tests/test-preset.mjs
 * Exit status: 0 when every assertion passes, 1 otherwise.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineSpvTools } from '../src/spv/tools.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const RENDER = join(REPO, 'build', 'render-preset.mjs')
// A neutral install location rather than this checkout's path: the rendered plugin URLs become part of the
// file, and a checkout or TMPDIR whose name contains "persona" would make the assertions below lie.
const INSTALLED = 'file:///opt/wheelchair-agent'

/** Render the checked-out preset the way install.sh does, into a temp dir; return that dir. */
async function renderPreset() {
  const out = await mkdtemp(join(tmpdir(), 'wheelchair-agent-preset-test-'))
  const result = spawnSync(process.execPath, [
    RENDER,
    join(REPO, 'preset'),
    `${INSTALLED}/src/spv/tools.js`,
    `${INSTALLED}/src/spv/cron-plugin.js`,
    out,
    `${INSTALLED}/src/spv/restart-command.js`,
  ], { cwd: REPO, encoding: 'utf8' })
  assert.equal(result.status, 0, `render-preset failed:\n${result.stderr}`)
  return out
}

const out = await renderPreset()
try {
  const rendered = await readFile(join(out, 'agent.cordis.yml'), 'utf8')
  const patch = await readFile(join(out, 'preset-default.patch.yml'), 'utf8')

  // No persona row, no dsh-persona reference. The broad `persona` check also covers a stale comment, which
  // would make a `grep -c persona` verification lie.
  assert.doesNotMatch(rendered, /^\s*-\s*id:\s*persona\s*$/m, 'rendered preset still declares a persona row')
  assert.ok(!rendered.includes('dsh-persona'), 'rendered preset still references @deepseek-ai/dsh-persona')
  assert.ok(!/persona/i.test(rendered), 'rendered preset still mentions persona anywhere')
  assert.ok(!/persona/i.test(patch), 'rendered preset patch still mentions persona anywhere')
  // The removed row also owned the session's prompt overrides; they must not come back through another row.
  assert.doesNotMatch(rendered, /^\s*complete:\s*true\s*$/m, 'rendered preset still sets complete: true')
  assert.doesNotMatch(rendered, /^\s*includeRuntimeContext:/m, 'rendered preset still sets includeRuntimeContext')

  // The old persona prose must not survive in the rendered preset.
  assert.ok(!rendered.includes('You are SPV'), 'rendered preset still contains the old "You are SPV" persona prose')
  assert.ok(
    !rendered.includes('You do not do implementation work yourself'),
    'rendered preset still contains the old "You do not do implementation work yourself" persona prose',
  )

  // The dispatch contract moved to the tool description and must keep both rules.
  const dispatch = defineSpvTools(join(out, 'queue'), {}).find(tool => tool.name === 'spv_dispatch')
  assert.ok(dispatch, 'spv_dispatch is not registered')
  assert.match(dispatch.description, /do implementation work yourself/i, 'delivery rule (who does the work) is missing')
  assert.match(dispatch.description, /PR delivery/i, 'delivery rule (a PR is the deliverable) is missing')
  assert.match(dispatch.description, /worker owns that path/i, 'delivery rule (the worker owns delivery) is missing')
  assert.match(dispatch.description, /do not wait/i, '"do not wait" rule is missing')
  assert.match(dispatch.description, /do not poll/i, '"do not poll" rule is missing')

  process.stdout.write('ok: preset has no persona; spv_dispatch carries the dispatch rules\n')
} finally {
  await rm(out, { recursive: true, force: true }).catch(() => {})
}
