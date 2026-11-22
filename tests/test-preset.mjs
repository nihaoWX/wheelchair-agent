#!/usr/bin/env node
/**
 * tests/test-preset.mjs — offline evidence that the SPV preset is composed the way the operator decided.
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
 *   - asserts the rendered `compaction` group keeps its isolate realm and `command-compact` /
 *     `tool-result-pruner`, but mounts `compaction-basic` with `auto: false`: billion-context owns automatic
 *     compression, and the row stays as the fallback for deployments without it;
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

/** Parse the YAML scalars this test compares: booleans, integers, and single-quoted strings. */
function yamlScalar(text) {
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) return Number(text)
  const quoted = /^'(.*)'$/.exec(text)
  return quoted ? quoted[1] : text
}

/**
 * Read the rendered preset's top-level `compaction` group by walking its block structure.
 *
 * A text search cannot tell a live entry from a comment or a nested key, so this follows the group's
 * indentation instead: `isolate` and the `id` / `config` of each entry under `config`. That is the whole
 * YAML subset this file uses, and the assertions below only need those two levels.
 */
function readCompactionGroup(rendered) {
  const lines = rendered.split('\n')
  const start = lines.findIndex(line => line === '- id: compaction')
  assert.notEqual(start, -1, 'rendered preset has no top-level `compaction` group')
  const group = []
  for (let i = start + 1; i < lines.length && !/^- /.test(lines[i]); i++) group.push(lines[i])

  const isolate = {}
  const entries = []
  let current = null
  let section = ''
  for (const line of group) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 2 && text === 'isolate:') { section = 'isolate'; continue }
    if (indent === 2 && text === 'config:') { section = 'config'; continue }
    if (indent === 2) continue
    if (section === 'isolate') {
      const match = /^([A-Za-z][\w-]*):\s*(true|false)$/.exec(text)
      assert.ok(match !== null && indent === 4, `unexpected isolate line in the compaction group: ${text}`)
      isolate[match[1]] = yamlScalar(match[2])
      continue
    }
    if (section !== 'config') continue
    if (indent === 4 && text.startsWith('- ')) {
      const match = /^- id:\s*(\S+)$/.exec(text)
      assert.ok(match !== null, `unexpected compaction entry: ${text}`)
      current = { id: match[1], config: {} }
      entries.push(current)
      continue
    }
    assert.notEqual(current, null, `compaction config line before any entry: ${text}`)
    if (indent === 6 && text.startsWith('name:')) { current.name = yamlScalar(text.slice(5).trim()); continue }
    if (indent === 6 && text === 'config:') continue
    if (indent === 8) {
      const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(text)
      assert.ok(match !== null, `unexpected compaction entry config line: ${text}`)
      current.config[match[1]] = yamlScalar(match[2])
      continue
    }
    assert.fail(`unexpected line in the compaction group: ${line}`)
  }
  return { isolate, entries }
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

  // billion-context owns automatic compression; this preset must not also compact on its own watermark.
  // `command-compact` (manual `/compact`) and the tool-result pruner are unrelated and must stay mounted.
  const compaction = readCompactionGroup(rendered)
  assert.deepEqual(
    compaction.isolate,
    { compaction: true, toolResultPruner: true },
    'the compaction isolate realm changed',
  )
  const compactEntries = new Map(compaction.entries.map(entry => [entry.id, entry]))
  assert.deepEqual(
    compactEntries.get('compaction-basic')?.config,
    { auto: false },
    'compaction-basic must stay mounted with auto: false',
  )
  assert.ok(compactEntries.has('command-compact'), 'command-compact (/compact) is missing from the compaction group')
  assert.ok(compactEntries.has('tool-result-pruner'), 'tool-result-pruner is missing from the compaction group')

  // The dispatch contract moved to the tool description and must keep both rules.
  const dispatch = defineSpvTools(join(out, 'queue'), {}).find(tool => tool.name === 'spv_dispatch')
  assert.ok(dispatch, 'spv_dispatch is not registered')
  assert.match(dispatch.description, /do implementation work yourself/i, 'delivery rule (who does the work) is missing')
  assert.match(dispatch.description, /PR delivery/i, 'delivery rule (a PR is the deliverable) is missing')
  assert.match(dispatch.description, /worker owns that path/i, 'delivery rule (the worker owns delivery) is missing')
  assert.match(dispatch.description, /do not wait/i, '"do not wait" rule is missing')
  assert.match(dispatch.description, /do not poll/i, '"do not poll" rule is missing')

  process.stdout.write('PASS  the compaction group keeps /compact and the pruner, with auto compaction off\n')
  process.stdout.write('ok: preset has no persona; spv_dispatch carries the dispatch rules\n')
} finally {
  await rm(out, { recursive: true, force: true }).catch(() => {})
}
