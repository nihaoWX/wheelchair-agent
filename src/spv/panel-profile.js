/**
 * Plugin parity for the standalone panel profile.
 *
 * The panel is a separate dsh instance on port 3080. Its profile used to be a fixed
 * `dsh-base` + `dsh-web-app` pair, while the deployment webui instances run the plugin set of
 * their superagent profile (`dsh-context`, `billion-context`, a model provider, ...). The panel
 * must show the same plugins; the only intended difference is that it has no superagent process
 * (so no orchestrator and no Sources).
 *
 * This module plans and applies that mirror:
 *
 * - `bundles` mirror the source profile's `dsh.profile.bundles` verbatim, except the blacklisted
 *   `dsh-superagent` bundle (loading it would start a second orchestrator and a second set of
 *   Sources inside the panel).
 * - Packages the panel cannot resolve from the dsh installation are symlinked from the source
 *   profile's `node_modules`. Packages dsh already resolves (`@deepseek-ai/dsh-base`,
 *   `@deepseek-ai/dsh-web-app`, plus anything dsh's own dependency tree carries) are deliberately
 *   not linked, so the panel loads the same module instances as every other dsh webui instead of
 *   shadowing them with a second copy.
 * - The previous link list is recorded in `panel-bundles.json`, so a later sync can prune only
 *   the links this module created. Anything else in the profile directory is never deleted.
 *
 * The planner is pure: filesystem probes are passed in (`resolves`, `linkState`,
 * `targetExists`), which keeps it unit-testable and keeps `install.sh --check` read-only. The
 * module is also the small CLI `install.sh` calls (`sync` and `check`).
 *
 * Run `node src/spv/panel-profile.js sync --dsh-home ~/.dsh` to mirror the source profile.
 */
import { createRequire } from 'node:module'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PANEL_PROFILE_ID } from './panel-instance.js'

export { PANEL_PROFILE_ID }

/** Settings key holding the profile whose plugins the panel mirrors. */
export const PANEL_SOURCE_PROFILE_KEY = 'panel.profileFrom'

/** Used when the settings file does not name a source profile (or names an empty one). */
export const DEFAULT_PANEL_SOURCE_PROFILE = 'superagent'

/**
 * Bundles never mirrored into the panel. `dsh-superagent` would start a second orchestrator and a
 * second set of Sources in the panel process; the panel is meant to be a webui without any
 * superagent process. Everything else in the source profile is mirrored.
 */
export const PANEL_EXCLUDED_BUNDLES = ['dsh-superagent']

/** Bundles the panel keeps when no source profile exists yet (fresh install, test homes). */
export const PANEL_FALLBACK_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** Written next to `package.json` so the next sync only prunes links this module created. */
export const PANEL_BUNDLES_FILE = 'panel-bundles.json'

/** The profile's dsh patch. The panel's copy is generated from this file, never edited by hand. */
export const PANEL_PATCH_FILE = 'cordis.patch.yml'

/**
 * Rows the panel never mirrors.
 *
 * - `dsh-superagent` would start a second orchestrator and a second set of Sources in the panel.
 * - `webserver` owns the listen address; the panel chooses its own host/port, so copying it would
 *   collide with the deployment's 3082 webserver.
 */
export const PANEL_PATCH_DENY_IDS = ['dsh-superagent', 'webserver']

/** Insert items that belong to the superagent process, not to a plain webui. */
export const PANEL_INSERT_DENY_PREFIX = 'wheelchair-agent/'

/** Rows the panel owns; a source row with one of these ids is never copied. */
export const PANEL_MANAGED_IDS = ['wheelchair-webui', 'ui-settings-general']

/** Literal secrets are skipped; credential *references* (`apiKeyEnv: ...`) are copied normally. */
export const PANEL_LITERAL_SECRET_KEYS = ['apiKey', 'token', 'password']

const PROFILE_NAME = /^[a-z0-9-]+$/
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/

/** True when `name` is a plain dsh profile id (no path separators, no `..`). */
export function validProfileName(name) {
  return typeof name === 'string' && PROFILE_NAME.test(name)
}

/** Refuse a source profile that is the panel itself: it would mirror the manifest it writes. */
function assertSourceProfile(sourceProfile) {
  if (!validProfileName(sourceProfile)) throw new Error(`invalid source profile ${JSON.stringify(sourceProfile)}`)
  if (sourceProfile === PANEL_PROFILE_ID) {
    throw new Error(`the panel profile cannot mirror itself; choose another ${PANEL_SOURCE_PROFILE_KEY}`)
  }
}

/**
 * The source profile named by `panel.profileFrom`, defaulting to "superagent".
 *
 * Throws for a value that could escape `profiles/` (a slash, `..`, an absolute path, ...). An
 * explicit empty value is treated as unset so clearing the settings field restores the default.
 */
export function panelSourceProfile({ settings = null, fallback = DEFAULT_PANEL_SOURCE_PROFILE } = {}) {
  const configured = settings?.effective?.[PANEL_SOURCE_PROFILE_KEY] ?? settings?.values?.[PANEL_SOURCE_PROFILE_KEY]
  const name = configured === undefined || configured === null ? fallback : String(configured).trim()
  if (name === '') return fallback
  if (!validProfileName(name)) {
    throw new Error(
      `${PANEL_SOURCE_PROFILE_KEY} must be a profile id such as "${DEFAULT_PANEL_SOURCE_PROFILE}" (only a-z, 0-9 and "-"), got ${JSON.stringify(name)}`,
    )
  }
  assertSourceProfile(name)
  return name
}

/**
 * Read `panel.profileFrom` without opening the settings *reader*.
 *
 * `resolveSettings()` fills missing keys and completes the one-shot data migration as a side effect.
 * That is right for the interactive CLI, but install and `--check` must not rewrite a hand-edited
 * settings file or move a legacy one, so this only parses the file the reader would use (new layout
 * first, legacy layout only when the new file does not exist).
 */
export function readPanelSourceProfileSetting({ env = process.env } = {}) {
  const dataHome = String(env.WHEELCHAIR_AGENT_HOME ?? '').trim() || join(homedir(), '.wheelchair-agent')
  const dshHome = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const stateDir =
    String(env.DSH_SUPERAGENT_STATE_DIR ?? '').trim() || join(dshHome, 'state', 'superagent')
  for (const file of [join(dataHome, 'settings.json'), join(stateDir, 'panel-settings.json')]) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      return undefined
    }
    const values = parsed?.values
    return values && Object.hasOwn(values, PANEL_SOURCE_PROFILE_KEY)
      ? values[PANEL_SOURCE_PROFILE_KEY]
      : undefined
  }
  return undefined
}

/** Absolute dsh home, refusing relative paths that would make link targets ambiguous. */
function dshHomePath(dshHome) {
  const home = String(dshHome ?? '').trim()
  if (home === '') throw new Error('a dsh home is required')
  if (!isAbsolute(home)) throw new Error(`the dsh home must be an absolute path, got ${JSON.stringify(home)}`)
  return resolve(home)
}

function panelProfileDir({ dshHome }) {
  return join(dshHomePath(dshHome), 'profiles', PANEL_PROFILE_ID)
}

/** Same string? Link targets are stored as absolute paths; `resolve` normalises trailing slashes. */
function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string' && resolve(left) === resolve(right)
}

function sameBundles(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((name, index) => name === right[index])
}

/**
 * The source profile's bundle list.
 *
 * A missing profile directory/package.json is `{ missing: true }`: install and start must keep
 * working on a machine where the superagent profile has not been created yet. A profile that
 * exists but has no `dsh.profile.bundles` array is a broken source and throws with the file path.
 */
export function readSourceProfile({ dshHome, sourceProfile = DEFAULT_PANEL_SOURCE_PROFILE } = {}) {
  assertSourceProfile(sourceProfile)
  const dir = join(dshHomePath(dshHome), 'profiles', sourceProfile)
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return { file, missing: true, bundles: null, patch: null, patchFile: join(dir, PANEL_PATCH_FILE), patchError: null }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read the source profile ${file}: ${error.message}`)
  }
  const bundles = parsed?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    throw new Error(`the source profile ${file} has no dsh.profile.bundles array`)
  }
  const patchFile = join(dir, PANEL_PATCH_FILE)
  let patch = null
  let patchError = null
  try {
    patch = readFileSync(patchFile, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') patchError = `${patchFile}: ${error.message}`
  }
  return { file, missing: false, bundles: bundles.map(name => String(name)), patch, patchFile, patchError }
}

/**
 * The panel's current manifest and recorded links.
 *
 * `bundles` is `null` when the panel has no manifest yet (or the manifest is unreadable), which
 * the planner treats as drift, so a sync repairs it. `recorded` is the link list written by the
 * previous sync; unreadable records fall back to an empty list and are simply rewritten.
 */
export function readPanelProfile({ dshHome, panelProfile = PANEL_PROFILE_ID } = {}) {
  const dir = join(dshHomePath(dshHome), 'profiles', panelProfile)
  let bundles = null
  let manifestError = null
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (Array.isArray(parsed?.dsh?.profile?.bundles)) bundles = parsed.dsh.profile.bundles.map(name => String(name))
  } catch (error) {
    if (error?.code !== 'ENOENT') manifestError = `${join(dir, 'package.json')}: ${error.message}`
  }
  let recorded = []
  let recordError = null
  try {
    const parsed = JSON.parse(readFileSync(join(dir, PANEL_BUNDLES_FILE), 'utf8'))
    recorded = normalizeRecorded(parsed?.linked)
  } catch (error) {
    if (error?.code !== 'ENOENT') recordError = `${join(dir, PANEL_BUNDLES_FILE)}: ${error.message}`
  }
  let patch = null
  let patchError = null
  try {
    patch = readFileSync(join(dir, PANEL_PATCH_FILE), 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') patchError = `${join(dir, PANEL_PATCH_FILE)}: ${error.message}`
  }
  return {
    dir,
    file: join(dir, 'package.json'),
    recordFile: join(dir, PANEL_BUNDLES_FILE),
    patchFile: join(dir, PANEL_PATCH_FILE),
    bundles,
    recorded,
    patch,
    manifestError,
    recordError,
    patchError,
  }
}

function normalizeRecorded(linked) {
  if (!Array.isArray(linked)) return []
  const seen = new Set()
  const out = []
  for (const item of linked) {
    const name = typeof item === 'string' ? item : item?.name
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name) || seen.has(name)) continue
    const target = typeof item === 'object' && typeof item?.target === 'string' ? item.target : null
    seen.add(name)
    out.push({ name, target })
  }
  return out
}

function linkState(file) {
  try {
    const stat = lstatSync(file)
    if (!stat.isSymbolicLink()) return { state: 'other', target: null }
    return { state: 'symlink', target: resolve(dirname(file), readlinkSync(file)) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', target: null }
    throw error
  }
}

function linkStateAt(nodeModules, name) {
  return linkState(join(nodeModules, name))
}

/*
 * Patch mirroring.
 *
 * A dsh patch is a YAML list of plugin rows (`- id: ...`) plus `- insert:` rows that mount extra
 * packages. Parsing arbitrary YAML would mean a dependency, so the mirror works on the list blocks
 * themselves: split at a column-0 `- `, keep each block's raw lines, and only filter the few things
 * the panel must not load (an id, an insert item, a literal secret). Key order and values are kept
 * verbatim; comments and blank lines are dropped so the generated file stays deterministic.
 */

function splitPatchLines(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()
  return lines
}

function splitPatchBlocks(text) {
  const blocks = []
  let current = null
  for (const line of splitPatchLines(text)) {
    if (/^-\s/.test(line) || line === '-') {
      current = [line]
      blocks.push(current)
    } else if (current !== null) {
      current.push(line)
    }
    // Lines before the first row are the file preamble (comments); the generated header replaces it.
  }
  return blocks.map(block => {
    while (block.length > 0 && block.at(-1).trim() === '') block.pop()
    return block
  }).filter(block => block.length > 0)
}

function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
    return text.slice(1, -1)
  }
  return text
}

function patchField(lines, key) {
  for (const line of lines) {
    const match = line.match(new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.*)$`))
    if (match) return unquote(match[1])
  }
  return null
}

function patchBlockId(lines) {
  for (const line of lines) {
    const match = line.match(/^(?:-\s+|\s+)id:\s*(.*)$/)
    if (match) return unquote(match[1])
  }
  return null
}

/** Items of a top-level `- insert:` block, or `null` when the block is not an insert. */
function patchInsertItems(lines) {
  const insertIndex = lines.findIndex(line => /^(?:-\s+|\s+)insert:\s*$/.test(line))
  if (insertIndex === -1) return null
  let itemIndent = null
  for (let index = insertIndex + 1; index < lines.length; index += 1) {
    const indent = lines[index].match(/^(\s+)-\s+/)
    if (indent) {
      itemIndent = indent[1].length
      break
    }
  }
  if (itemIndent === null) return []
  const items = []
  let current = null
  for (let index = insertIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') {
      if (current !== null) current.push(line)
      continue
    }
    const indent = line.match(/^(\s*)/)[1].length
    if (indent === itemIndent && /^-\s+/.test(line.slice(indent))) {
      current = [line]
      items.push(current)
      continue
    }
    if (indent < itemIndent) break
    if (current !== null) current.push(line)
  }
  return items.map(item => {
    while (item.length > 0 && item.at(-1).trim() === '') item.pop()
    return item
  }).filter(item => item.length > 0)
}

/**
 * Drop a literal secret key and its (possibly nested) value. Credential references such as
 * `apiKeyEnv: COMMANDCODE_API_KEY` do not match and are copied normally.
 */
function stripPatchComments(lines) {
  return lines.filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'))
}

function stripLiteralSecrets(lines) {
  const out = []
  const secrets = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/)
    if (match && PANEL_LITERAL_SECRET_KEYS.includes(match[2])) {
      secrets.push(match[2])
      const indent = match[1].length
      index += 1
      while (index < lines.length) {
        const next = lines[index]
        if (next.trim() === '') {
          index += 1
          continue
        }
        const nextIndent = next.match(/^(\s*)/)[1].length
        if (nextIndent > indent) {
          index += 1
          continue
        }
        index -= 1
        break
      }
      continue
    }
    out.push(line)
  }
  return { lines: out, secrets }
}

function panelPatchHeader(sourceProfile) {
  return [
    `# Generated by \`wheelchair-agent panel sync\` from profile "${sourceProfile}"; edit the source profile instead.`,
    '# The panel profile is a webui without a superagent process, so this file is not hand-edited.',
  ].join('\n')
}

const PANEL_MANAGED_INSERT = [
  '- insert:',
  '    - id: wheelchair-webui',
  "      name: 'wheelchair-agent-webui'",
].join('\n')

const PANEL_MANAGED_SETTINGS = [
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '  config:',
  '    welcomeNoticeVersion: 2026-09-28.1',
].join('\n')

/**
 * Build the panel's patch from the source profile's patch. Pure, so plan/check can compare without
 * writing.
 *
 * A missing or unreadable source patch is not an error: the panel keeps only the two rows it owns
 * and the caller prints the returned note.
 */
export function buildPanelPatch({ sourceProfile, patchText = null, patchError = null } = {}) {
  const rows = []
  const skipped = []
  const secrets = []
  const notes = []
  let managedSettings = false
  if (patchError !== null) {
    notes.push(`cannot read profile "${sourceProfile}" ${PANEL_PATCH_FILE} (${patchError}); the panel keeps only its managed rows`)
  } else if (patchText === null) {
    notes.push(`profile "${sourceProfile}" has no ${PANEL_PATCH_FILE}; the panel keeps only its managed rows`)
  }
  if (typeof patchText === 'string') {
    for (const block of splitPatchBlocks(patchText)) {
      const items = patchInsertItems(block)
      if (items !== null) {
        const kept = []
        const denied = []
        for (const item of items) {
          const itemId = patchField(item, 'id')
          const itemName = patchField(item, 'name')
          if (itemId === 'wheelchair-webui') continue
          if (itemName !== null && itemName.startsWith(PANEL_INSERT_DENY_PREFIX)) {
            denied.push(itemName)
            continue
          }
          const cleaned = stripLiteralSecrets(stripPatchComments(item))
          if (cleaned.secrets.length > 0) {
            secrets.push({ id: itemName ?? itemId ?? 'insert', keys: [...new Set(cleaned.secrets)] })
          }
          kept.push(cleaned.lines)
        }
        if (denied.length > 0) skipped.push({ kind: 'insert', names: [...new Set(denied)] })
        if (kept.length === 0) continue
        rows.push({ kind: 'insert', id: 'insert', raw: ['- insert:', ...kept.flat()].join('\n') })
        continue
      }
      const id = patchBlockId(block)
      if (id !== null && PANEL_PATCH_DENY_IDS.includes(id)) {
        skipped.push({ kind: 'id', id })
        continue
      }
      if (id !== null && PANEL_MANAGED_IDS.includes(id)) {
        if (id === 'ui-settings-general') managedSettings = true
        continue
      }
      const cleaned = stripLiteralSecrets(stripPatchComments(block))
      if (cleaned.secrets.length > 0) {
        secrets.push({ id: id ?? 'patch row', keys: [...new Set(cleaned.secrets)] })
      }
      rows.push({ kind: 'row', id, raw: cleaned.lines.join('\n') })
    }
  }
  for (const item of secrets) {
    notes.push(`the source profile pins a literal secret in ${item.id}; the panel keeps the default`)
  }
  const content = [panelPatchHeader(sourceProfile), PANEL_MANAGED_INSERT, ...rows.map(row => row.raw), PANEL_MANAGED_SETTINGS].join('\n\n') + '\n'
  return {
    content,
    rows,
    copied: rows.map(row => row.id),
    // What the panel actually mirrors: copied rows plus its own ui-settings row when the source
    // configured that plugin (the panel owns the row's content, but it is still mirrored config).
    mirroredCount: rows.length + (managedSettings ? 1 : 0),
    skipped,
    secrets,
    notes,
    sourceMissing: patchText === null,
    changed: false,
    differences: [],
  }
}


/**
 * Plan the panel profile against the source profile. Pure: no writes, no hidden filesystem reads.
 *
 * Inputs:
 * - `bundles`: the source profile's bundle list, or `null`/undefined when it is missing.
 * - `resolves(name)`: whether the panel's dsh installation already resolves the package.
 * - `linkState(name)`: `{ state: 'missing'|'symlink'|'other', target }` for the current
 *   `node_modules/<name>` entry.
 * - `targetExists(name)`: whether the source profile has `node_modules/<name>` installed.
 * - `bundlesNow`: the panel manifest's current bundle list (`null` when absent/damaged).
 * - `recorded`: `[{ name, target }]` from the previous sync.
 *
 * Returns `sourceMissing: true` with empty bundles/links for a missing source, so callers can
 * decide whether to keep the current panel profile (the normal case) or use a fallback.
 */
export function planPanelProfile({
  dshHome,
  sourceProfile = DEFAULT_PANEL_SOURCE_PROFILE,
  bundles = null,
  resolves = () => false,
  recorded = [],
  bundlesNow = null,
  linkState: readLink = () => ({ state: 'missing', target: null }),
  targetExists = () => true,
  patchText,
  patchNow,
  patchError = null,
} = {}) {
  const home = dshHomePath(dshHome)
  assertSourceProfile(sourceProfile)

  if (!Array.isArray(bundles)) {
    return {
      sourceProfile,
      sourceMissing: true,
      bundles: [],
      links: {},
      stale: [],
      missingTargets: [],
      excluded: [],
      preexisting: [],
      patch: null,
      changed: false,
    }
  }

  for (const name of bundles) {
    if (!PACKAGE_NAME.test(name)) {
      throw new Error(`the source profile declares an invalid package name ${JSON.stringify(name)}`)
    }
  }

  const excluded = PANEL_EXCLUDED_BUNDLES.filter(name => bundles.includes(name))
  const desired = bundles.filter(name => !PANEL_EXCLUDED_BUNDLES.includes(name))
  const links = Object.create(null)
  const missingTargets = []
  for (const name of desired) {
    if (resolves(name)) continue
    const target = join(home, 'profiles', sourceProfile, 'node_modules', name)
    links[name] = target
    if (!targetExists(name)) missingTargets.push(name)
  }

  const recordedList = normalizeRecorded(recorded)
  const stale = recordedList.filter(item => !Object.hasOwn(links, item.name))

  const preexisting = []
  if (!sameBundles(bundlesNow, desired)) {
    preexisting.push({
      code: 'bundles',
      message: `the panel profile bundles differ from profile "${sourceProfile}": expected ${JSON.stringify(desired)}, found ${JSON.stringify(bundlesNow)}`,
    })
  }
  for (const [name, target] of Object.entries(links)) {
    const state = readLink(name)
    if (state.state === 'missing') {
      preexisting.push({
        code: 'link-missing',
        name,
        message: `node_modules/${name} is missing: profile "${sourceProfile}" declares it and the dsh installation does not resolve it`,
      })
    } else if (state.state !== 'symlink') {
      preexisting.push({
        code: 'link-other',
        name,
        message: `node_modules/${name} exists but is not a symlink; the panel profile expects a link to ${target}`,
      })
    } else if (!samePath(state.target, target)) {
      preexisting.push({
        code: 'link-wrong',
        name,
        message: `node_modules/${name} points at ${state.target}, not ${target}`,
      })
    }
  }
  for (const item of stale) {
    preexisting.push({
      code: 'link-stale',
      name: item.name,
      message: `node_modules/${item.name} is a leftover link from an earlier sync`,
    })
  }
  for (const name of missingTargets) {
    const target = links[name]
    preexisting.push({
      code: 'target-missing',
      name,
      message: `profile "${sourceProfile}" declares "${name}" but its package is not installed at ${target}`,
    })
  }

  let patch = null
  if (patchText !== undefined || patchNow !== undefined || patchError !== null) {
    patch = buildPanelPatch({ sourceProfile, patchText: patchText ?? null, patchError })
    if (typeof patchNow !== 'string' || patchNow !== patch.content) {
      patch.changed = true
      const expected = patch.rows.map(row => row.id).filter(Boolean)
      const present = typeof patchNow === 'string' ? patchNow : ''
      const differences = expected.filter(label => {
        const row = patch.rows.find(item => item.id === label)
        return row !== undefined && !present.includes(row.raw)
      })
      patch.differences = differences.length > 0 ? differences : ['generated header or managed rows']
      preexisting.push({
        code: 'patch',
        name: PANEL_PATCH_FILE,
        message: `the panel ${PANEL_PATCH_FILE} differs from profile "${sourceProfile}" at ${patch.differences.join(', ')}`,
      })
    }
  }

  return {
    sourceProfile,
    sourceMissing: false,
    bundles: desired,
    links,
    stale,
    missingTargets,
    excluded,
    patch,
    preexisting,
    changed: preexisting.length > 0,
  }
}

/**
 * Human-readable problems for `--check` and `panel status`. Every entry names the problem and the
 * command that fixes it. A missing source profile yields no problems: install must stay green on a
 * machine that has no superagent profile yet.
 */
export function verifyPanelProfile(plan, { syncCommand = 'wheelchair-agent panel sync' } = {}) {
  if (!plan || plan.sourceMissing) return []
  return plan.preexisting.map(item => {
    const fix =
      item.code === 'target-missing'
        ? `install "${item.name}" in the source profile, then run "${syncCommand}"`
        : `run "${syncCommand}"`
    return { code: item.code, name: item.name ?? null, problem: item.message, fix }
  })
}

function writeIfChanged(file, content) {
  try {
    if (readFileSync(file, 'utf8') === content) return false
  } catch {
    // A missing or unreadable file is simply rewritten.
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, file)
  return true
}

function recordContent(plan) {
  return `${JSON.stringify(
    {
      sourceProfile: plan.sourceProfile,
      linked: Object.entries(plan.links)
        .map(([name, target]) => ({ name, target }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      writtenAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`
}

function recordMatches(file, plan) {
  try {
    const current = JSON.parse(readFileSync(file, 'utf8'))
    if (current?.sourceProfile !== plan.sourceProfile) return false
    const linked = normalizeRecorded(current?.linked)
    const desired = Object.entries(plan.links).map(([name, target]) => ({ name, target }))
    if (linked.length !== desired.length) return false
    return desired.every(item => linked.some(other => other.name === item.name && samePath(other.target, item.target)))
  } catch {
    return false
  }
}

/**
 * Apply a plan to `~/.dsh/profiles/panel` only.
 *
 * Writes the manifest and the link record, creates/updates the planned symlinks, and prunes only
 * symlinks recorded by the previous sync (`plan.stale`) whose target still matches the record. A
 * desired link name that currently holds a regular file or directory is never replaced: it throws
 * with the path, because that content belongs to someone else. Missing source packages throw too,
 * so a sync never leaves a bundle in the manifest that cannot load.
 */
export function applyPanelProfile(plan, { dshHome } = {}) {
  const home = dshHomePath(dshHome)
  if (!plan || plan.sourceMissing) {
    return { changed: false, packageJson: false, linked: [], pruned: [], kept: [] }
  }
  const dir = join(home, 'profiles', PANEL_PROFILE_ID)
  const nodeModules = join(dir, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })

  if (plan.missingTargets.length > 0) {
    const missing = plan.missingTargets.join(', ')
    throw new Error(
      `cannot link ${missing}: the source profile "${plan.sourceProfile}" does not have ${plan.missingTargets.length === 1 ? 'that package' : 'those packages'} installed in node_modules; install the profile's dependencies first`,
    )
  }

  const linked = []
  for (const [name, target] of Object.entries(plan.links)) {
    if (!existsSync(target)) {
      throw new Error(`cannot link ${name}: ${target} does not exist; install the source profile's dependencies first`)
    }
    const destination = join(nodeModules, name)
    const state = linkState(destination)
    if (state.state === 'symlink') {
      if (samePath(state.target, target)) continue
      unlinkSync(destination)
    } else if (state.state !== 'missing') {
      throw new Error(`cannot link ${name}: ${destination} exists and is not a symlink; remove it and rerun the sync`)
    }
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(target, destination, 'dir')
    linked.push(name)
  }

  const pruned = []
  const kept = []
  for (const item of plan.stale) {
    const destination = join(nodeModules, item.name)
    const state = linkState(destination)
    if (state.state === 'symlink' && (item.target === null || samePath(state.target, item.target))) {
      unlinkSync(destination)
      pruned.push(item.name)
    } else if (state.state !== 'missing') {
      kept.push(item.name)
    }
  }

  const manifest = {
    name: 'dsh-profile-panel',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: plan.bundles } },
  }
  const packageJson = writeIfChanged(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const patch = plan.patch === null || plan.patch === undefined
    ? false
    : writeIfChanged(join(dir, PANEL_PATCH_FILE), plan.patch.content)
  const recordChanged = recordMatches(join(dir, PANEL_BUNDLES_FILE), plan) ? false : writeIfChanged(join(dir, PANEL_BUNDLES_FILE), recordContent(plan))
  return {
    changed: packageJson || patch || linked.length > 0 || pruned.length > 0 || recordChanged,
    packageJson,
    patch,
    linked,
    pruned,
    kept,
  }
}

/**
 * Probe whether the panel's dsh installation resolves `name`.
 *
 * Two roots are consulted: the dsh home (where `~/.dsh/node_modules` holds globally installed
 * plugins such as `billion-context`) and the installed dsh package (which owns `dsh-base` and
 * `dsh-web-app`). Deliberately not the source profile's `node_modules`: a package found only there
 * must be linked for the panel, otherwise the panel would see no instance at all.
 */
export function dshBundleResolver({ dshHome, env = process.env } = {}) {
  const home = dshHomePath(dshHome)
  const roots = new Set([home])
  const dshRoot = dshPackageRoot({ env })
  if (dshRoot !== null) roots.add(dshRoot)
  // The executable may be a shell wrapper, and the nearest package.json above it is not
  // necessarily the dsh package. The dsh home resolves a global install, which also owns
  // dsh-base/dsh-web-app, so always consult it as well instead of only as a fallback.
  const fallback = resolveDshPackage(home)
  if (fallback !== null) roots.add(fallback)
  const requires = [...roots].map(root => createRequire(join(root, 'package.json')))
  return name => requires.some(require => {
    try {
      require.resolve(name)
      return true
    } catch {
      return false
    }
  })
}

function resolveDshPackage(root) {
  try {
    return dirname(createRequire(join(root, 'package.json')).resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    return null
  }
}

/** Directory of the installed dsh package, found by walking up from the real `dsh` executable. */
export function dshPackageRoot({ env = process.env } = {}) {
  const executable = resolveExecutable(String(env.DSH_BIN ?? '').trim() || 'dsh', env)
  if (executable === null) return null
  let dir = dirname(executable)
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function resolveExecutable(command, env) {
  const isFile = candidate => {
    try {
      accessSync(candidate, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const candidates = command.includes('/') ? [resolve(command)] : String(env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, command))
  for (const candidate of candidates) {
    if (!isFile(candidate)) continue
    try {
      return realpathSync(candidate)
    } catch {
      return resolve(candidate)
    }
  }
  return null
}

/**
 * Ensure --dsh-home/--source-profile helpers for the tiny CLI. Kept separate from the pure API.
 */
function cliOption(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return null
  const value = argv[index + 1]
  return typeof value === 'string' && !value.startsWith('--') ? value : ''
}

function cliUsage() {
  return [
    'usage: node src/spv/panel-profile.js <sync|check> [--dsh-home <dir>] [--source-profile <name>]',
    '',
    '  sync   mirror the source profile plugins into the panel profile',
    '  check  report drift without writing (exit 1 when the panel is out of date)',
  ].join('\n')
}

async function configuredSourceProfile({ env, explicit }) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const name = explicit.trim()
    if (!validProfileName(name)) throw new Error(`invalid source profile ${JSON.stringify(name)}`)
    return name
  }
  const configured = readPanelSourceProfileSetting({ env })
  return panelSourceProfile({
    settings: configured === undefined ? null : { effective: { [PANEL_SOURCE_PROFILE_KEY]: configured } },
  })
}

function summary(report, { changed = false } = {}) {
  if (report.sourceMissing) {
    if (report.kept) {
      return `kept the current panel profile because source profile "${report.sourceProfile}" is missing (${report.bundles.length} bundle(s), ${report.linkCount} link(s))`
    }
    return `source profile "${report.sourceProfile}" is missing; installed the fallback bundles (${report.bundles.length} bundle(s))`
  }
  const links = Object.keys(report.links).length
  const suffix = changed ? '; updated' : '; up to date'
  const excluded = report.excluded.length > 0 ? `; ${report.excluded.join(', ')} excluded` : ''
  return `mirrors profile "${report.sourceProfile}" (${report.bundles.length} bundle(s), ${links} link(s)${excluded})${suffix}`
}

/**
 * Plan, optionally apply, and return a status report. This is the one function install, `panel
 * sync` and `panel status` share.
 *
 * `write: false` is the read-only check path. The report includes:
 * - `sourceMissing` / `kept` / `fallback` so callers can keep the current panel profile or say so.
 * - `problems` (verifyPanelProfile output) for red `--check` output and status.
 * - `changed`, `bundles`, `links`, `excluded`, `linked`, `pruned` for notes and summaries.
 */
export function syncPanelProfile({
  dshHome,
  sourceProfile = DEFAULT_PANEL_SOURCE_PROFILE,
  env = process.env,
  write = true,
  resolves = null,
  fallbackBundles = PANEL_FALLBACK_BUNDLES,
} = {}) {
  const home = dshHomePath(dshHome)
  const panel = readPanelProfile({ dshHome: home })
  if (!existsSync(panel.dir)) {
    throw new Error(
      `the panel profile is not installed at ${panel.dir}: run "bash install.sh --project <project>" first, then rerun the sync`,
    )
  }
  const source = readSourceProfile({ dshHome: home, sourceProfile })
  const probe = resolves ?? dshBundleResolver({ dshHome: home, env })
  const readLink = name => linkStateAt(join(panel.dir, 'node_modules'), name)
  const targetExists = name => existsSync(join(home, 'profiles', sourceProfile, 'node_modules', name))

  if (source.missing && panel.bundles !== null) {
    return {
      sourceProfile,
      sourceMissing: true,
      kept: true,
      fallback: false,
      changed: false,
      bundles: panel.bundles,
      links: {},
      linkCount: panel.recorded.length,
      stale: [],
      missingTargets: [],
      excluded: [],
      preexisting: [],
      patch: null,
      notes: [],
      problems: [],
      linked: [],
      pruned: [],
    }
  }

  const bundles = source.missing ? fallbackBundles : source.bundles
  const plan = planPanelProfile({
    dshHome: home,
    sourceProfile,
    bundles,
    resolves: probe,
    recorded: panel.recorded,
    bundlesNow: panel.bundles,
    linkState: readLink,
    targetExists,
    patchText: source.patch,
    patchNow: panel.patch,
    patchError: source.patchError,
  })
  const problems = verifyPanelProfile(plan)
  if (source.missing) {
    problems.unshift({
      code: 'source-missing',
      name: null,
      problem: `source profile "${sourceProfile}" is missing; the panel keeps the fallback bundles because it has no manifest yet`,
      fix: `create the source profile or set "${PANEL_SOURCE_PROFILE_KEY}" in the settings`,
    })
  }

  if (write && plan.missingTargets.length > 0) {
    throw new Error(`${plan.missingTargets.length === 1 ? 'a bundle is' : 'bundles are'} missing: ${problems.map(item => `${item.problem} (fix: ${item.fix})`).join('; ')}`)
  }

  const applied = write
    ? applyPanelProfile(plan, { dshHome: home })
    : { changed: false, packageJson: false, patch: false, linked: [], pruned: [], kept: [] }
  return {
    sourceProfile,
    sourceMissing: source.missing,
    kept: false,
    fallback: source.missing,
    changed: plan.changed,
    bundles: plan.bundles,
    links: plan.links,
    linkCount: Object.keys(plan.links).length,
    stale: plan.stale,
    missingTargets: plan.missingTargets,
    excluded: plan.excluded,
    patch: plan.patch,
    notes: plan.patch?.notes ?? [],
    preexisting: plan.preexisting,
    problems,
    linked: applied.linked,
    pruned: applied.pruned,
    packageJson: applied.packageJson,
    patchWritten: applied.patch,
  }
}

/** Format a report for install output, `panel sync`, and `panel status`. */
export function describePanelProfile(report) {
  return summary(report, { changed: report.changed })
}

async function main(argv) {
  const command = argv[0]
  if (command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(`${cliUsage()}\n`)
    return 0
  }
  if (command !== 'sync' && command !== 'check') {
    process.stderr.write(`${cliUsage()}\n`)
    return 2
  }
  const dshHome = cliOption(argv, '--dsh-home') || process.env.DSH_HOME || join(homedir(), '.dsh')
  const sourceProfile = await configuredSourceProfile({ env: process.env, explicit: cliOption(argv, '--source-profile') })
  const report = syncPanelProfile({ dshHome, sourceProfile, env: process.env, write: command === 'sync' })
  if (command === 'check') {
    if (report.problems.length > 0) {
      for (const item of report.problems) process.stdout.write(`${item.problem} (fix: ${item.fix})\n`)
      return 1
    }
    process.stdout.write(`${describePanelProfile(report)}\n`)
    for (const note of report.notes ?? []) process.stdout.write(`note: ${note}\n`)
    return 0
  }
  if (report.sourceMissing) process.stdout.write(`note: ${describePanelProfile(report)}\n`)
  else process.stdout.write(`${describePanelProfile(report)}\n`)
  for (const note of report.notes ?? []) process.stdout.write(`note: ${note}\n`)
  return 0
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invoked !== '' && invoked === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  main(process.argv.slice(2)).then(
    code => {
      process.exitCode = code
    },
    error => {
      process.stderr.write(`panel-profile: ${error.message}\n`)
      process.exitCode = 1
    },
  )
}
