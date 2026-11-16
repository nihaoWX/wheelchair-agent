#!/usr/bin/env node
/**
 * tests/test-home.mjs — offline evidence for the wheelchair-agent data root.
 *
 * Covers the contract in `src/shared/home.js`:
 *   - the root resolves from `$WHEELCHAIR_AGENT_HOME` (absolute only) and otherwise from `$HOME`;
 *     a relative override fails loudly with `HOME_INVALID`;
 *   - a fresh install writes settings, inbox items, the reclaim record, the restart log and the prepare
 *     log under `<root>`, and creates nothing under the superagent state dir for them;
 *   - a machine with only the old layout migrates every artifact exactly once, logs `moved <old> -> <new>`
 *     in `<root>/logs/migration.log`, and a second resolve changes nothing;
 *   - a failed move leaves the old file reachable through the fallback and logs the failure;
 *   - a reader with only old data still reads it (and the old file is not deleted);
 *   - `$SPV_INBOX_DIR` and `$SPV_PREPARE_LOG` win outright, and `$DSH_SUPERAGENT_STATE_DIR` still owns
 *     the queue and the work root;
 *   - `wheelchair-agent where` prints every path and its `--json` shape is stable.
 *
 * Everything runs in `mkdtemp` sandboxes with a fake `HOME`; no network and no dsh service.
 *
 * Usage: node tests/test-home.mjs
 * Exit status: 0 when every assertion passes, 1 otherwise.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  INBOX_ENV,
  MIGRATION_LOG_FILE,
  PREPARE_LOG_ENV,
  SETTINGS_FILE,
  dataPaths,
  describeData,
  resolveData,
  resolveHome,
  resolveLegacyStateDir,
} from '../src/shared/home.js'
import { SETTINGS_VERSION, resolveSettings, saveSettings } from '../src/shared/settings.js'
import { createSpvMessage, readItem, resolveInboxRoot, writeItem } from '../src/spv/inbox.js'
import { appendLog, resolveRestartLog } from '../src/spv/restart.js'
import { resolveWorkRoot } from '../src/shared/work.js'
import { resolveRoot } from '../src/spv/paths.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(REPO, 'bin', 'wheelchair-agent.mjs')
const PREPARE = join(REPO, 'commands', 'prepare.sh')
const SANDBOXES = []

async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'wheelchair-agent-home-test-'))
  SANDBOXES.push(base)
  const box = {
    base,
    home: join(base, 'home'),
    root: join(base, 'data'),
    state: join(base, 'state'),
    work: join(base, 'workspaces'),
    remotes: join(base, 'remotes'),
  }
  for (const dir of [box.home, box.state, box.work, box.remotes]) await mkdir(dir, { recursive: true })
  box.env = {
    HOME: box.home,
    DSH_HOME: join(box.home, '.dsh'),
    WHEELCHAIR_AGENT_HOME: box.root,
    DSH_SUPERAGENT_STATE_DIR: box.state,
  }
  return box
}

/** Run the CLI with a fake HOME and no inherited wheelchair-agent state. */
function cli(box, args, extra = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: box.base,
    encoding: 'utf8',
    env: { ...process.env, ...box.env, ...extra },
  })
}

/** Write the old layout: every artifact at its pre-upgrade location under the superagent state dir. */
async function seedLegacy(box) {
  await mkdir(join(box.state, 'inbox'), { recursive: true })
  await writeFile(
    join(box.state, 'panel-settings.json'),
    `${JSON.stringify({ version: SETTINGS_VERSION, revision: 7, values: { 'inbox.intervalSeconds': 42 } })}\n`,
    'utf8',
  )
  await writeFile(join(box.state, 'work-reclaimed.jsonl'), '{"name":"old-0123456789ab"}\n', 'utf8')
  await writeFile(join(box.state, 'restart-all.log'), '[old] restart step\n', 'utf8')
  await writeFile(join(box.state, 'prepare.log'), 'old prepare line\n', 'utf8')
  await writeFile(join(box.state, 'inbox', 'old-1.json'), '{"id":"old-1","kind":"pr"}\n', 'utf8')
}

/** Run `sh commands/prepare.sh` just far enough to run the log migration; it then fails on missing args. */
function prepareOnce(box, extra = {}) {
  return spawnSync('sh', [PREPARE], {
    cwd: box.base,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: box.home,
      WHEELCHAIR_AGENT_HOME: box.root,
      DSH_SUPERAGENT_STATE_DIR: box.state,
      ...extra,
    },
  })
}

/** A minimal research project: it has its own git repo, so prepare only clones and installs AGENTS.md. */
async function makeResearchProject(box) {
  const project = join(box.base, 'projects', 'research', 'demo')
  await mkdir(project, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', project], { encoding: 'utf8' })
  await writeFile(join(project, 'file.txt'), 'x\n', 'utf8')
  execFileSync('git', ['-C', project, 'add', '-A'], { encoding: 'utf8' })
  execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], {
    encoding: 'utf8',
  })
}

/** Run prepare to completion against that project; extra env wins over the sandbox defaults. */
function prepareOk(box, extra = {}) {
  return spawnSync('sh', [PREPARE], {
    cwd: box.base,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: box.home,
      WHEELCHAIR_AGENT_HOME: box.root,
      DSH_SUPERAGENT_STATE_DIR: box.state,
      SPV_PROJECTS_ROOT: join(box.base, 'projects'),
      SPV_PREPARE_TEMPLATES: join(REPO, 'docs', 'agentsmd-examples'),
      DSH_SUPERAGENT_SPV_PROJECT: 'research/demo',
      DSH_SUPERAGENT_DIR: join(box.base, 'ticket'),
      ...extra,
    },
  })
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return error.code === 'EISDIR'
    throw error
  }
}

// ------------------------------------------------------------------- cases

async function testRootResolution() {
  // The explicit env override wins over $HOME.
  assert.equal(resolveHome({ env: { HOME: '/tmp/fake-home', WHEELCHAIR_AGENT_HOME: '/tmp/custom-root' } }), '/tmp/custom-root')
  // The built-in default is $HOME/.wheelchair-agent; an injected env map is honoured too.
  assert.equal(resolveHome({ env: { HOME: '/tmp/fake-default-home' } }), '/tmp/fake-default-home/.wheelchair-agent')
  assert.equal(resolveLegacyStateDir({ env: { HOME: '/tmp/fake-default-home' } }), '/tmp/fake-default-home/.dsh/state/superagent')
  // A relative override must fail loudly, not resolve against the cwd.
  assert.throws(
    () => resolveHome({ env: { HOME: '/tmp/h', WHEELCHAIR_AGENT_HOME: 'relative/root' } }),
    error => error.code === 'HOME_INVALID' && /absolute path/.test(error.message),
  )
  assert.throws(
    () => resolveData({ env: { WHEELCHAIR_AGENT_HOME: 'relative' } }),
    error => error.code === 'HOME_INVALID',
  )
  // DSH_SUPERAGENT_STATE_DIR still decides the legacy state dir; DSH_HOME is the fallback rule.
  assert.equal(resolveLegacyStateDir({ env: { DSH_SUPERAGENT_STATE_DIR: '/tmp/state' } }), '/tmp/state')
  assert.equal(resolveLegacyStateDir({ env: { DSH_HOME: '/tmp/dsh' } }), '/tmp/dsh/state/superagent')
}

async function testFreshInstallWritesUnderRoot() {
  const box = await sandbox()
  const env = { ...box.env }

  // settings.json
  const saved = saveSettings({ env, revision: 0, values: { 'inbox.intervalSeconds': 12 } })
  assert.equal(saved.file, join(box.root, SETTINGS_FILE))
  assert.equal(saved.effective['inbox.intervalSeconds'], 12)
  assert.equal(JSON.parse(await readFile(join(box.root, SETTINGS_FILE), 'utf8')).revision, 1)
  assert.equal(await exists(join(box.state, 'panel-settings.json')), false)

  // inbox item
  const item = await createSpvMessage(resolveInboxRoot({ env }), { title: 'Fresh', body: 'body', thread: 'main' })
  assert.equal(resolveInboxRoot({ env }), join(box.root, 'inbox'))
  assert.equal((await readItem(join(box.root, 'inbox'), item.id)).title, 'Fresh')

  // restart log
  appendLog(resolveRestartLog({ env }), 'fresh restart line')
  assert.match(await readFile(join(box.root, 'logs', 'restart-all.log'), 'utf8'), /fresh restart line/)

  // prepare log: a real prepare writes its traceability line under the root.
  await makeResearchProject(box)
  const prepared = prepareOk(box)
  assert.equal(prepared.status, 0, prepared.stderr)
  assert.match(await readFile(join(box.root, 'logs', 'prepare.log'), 'utf8'), /installed .*AGENTS\.md/)

  // The reclaim record lands under records/ (a clean, fully pushed clone is the easy passing case).
  const remote = join(box.remotes, 'ticket.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { encoding: 'utf8' })
  const clone = join(box.work, 'ticket-0123456789ab')
  execFileSync('git', ['init', '-b', 'main', clone], { encoding: 'utf8' })
  await writeFile(join(clone, 'file.txt'), 'x\n', 'utf8')
  execFileSync('git', ['-C', clone, 'add', '-A'], { encoding: 'utf8' })
  execFileSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { encoding: 'utf8' })
  execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', remote], { encoding: 'utf8' })
  execFileSync('git', ['-C', clone, 'push', '-qu', 'origin', 'main'], { encoding: 'utf8' })
  const { reclaimWork } = await import('../src/shared/work.js')
  const summary = await reclaimWork({ root: box.work, env, keep: 0, keepDays: 0 })
  assert.equal(summary.reclaimed, 1)
  assert.match(await readFile(join(box.root, 'records', 'work-reclaimed.jsonl'), 'utf8'), /ticket-0123456789ab/)
  assert.equal(await exists(join(box.state, 'work-reclaimed.jsonl')), false, 'the record is not written under the state dir')
}

async function testOldOnlyMigratesOnce() {
  const box = await sandbox()
  await seedLegacy(box)
  // install.sh creates an empty destination inbox up front; that must count as absent so the old items move.
  await mkdir(join(box.root, 'inbox'), { recursive: true })
  const env = { ...box.env }

  const before = describeData({ env })
  assert.equal(before.layout, 'old', 'only the old layout is on disk before the first reader')
  assert.equal(before.migrationPending, true)

  const first = resolveData({ env })
  assert.equal(first.settings, join(box.root, SETTINGS_FILE))
  assert.equal(first.inbox, join(box.root, 'inbox'))
  assert.equal(first.reclaimed, join(box.root, 'records', 'work-reclaimed.jsonl'))
  assert.equal(first.restartLog, join(box.root, 'logs', 'restart-all.log'))
  assert.equal(first.prepareLog, join(box.root, 'logs', 'prepare.log'))

  assert.equal(await exists(join(box.state, 'panel-settings.json')), false, 'the old settings file moved')
  assert.equal(JSON.parse(await readFile(join(box.root, SETTINGS_FILE), 'utf8')).revision, 7)
  assert.equal(await exists(join(box.root, 'inbox', 'old-1.json')), true)
  assert.equal(await exists(join(box.state, 'inbox')), false)
  assert.match(await readFile(join(box.root, 'records', 'work-reclaimed.jsonl'), 'utf8'), /old-0123456789ab/)
  assert.match(await readFile(join(box.root, 'logs', 'restart-all.log'), 'utf8'), /restart step/)
  assert.match(await readFile(join(box.root, 'logs', 'prepare.log'), 'utf8'), /old prepare line/)

  const log = await readFile(join(box.root, 'logs', MIGRATION_LOG_FILE), 'utf8')
  for (const [oldPath, newPath] of [
    [join(box.state, 'panel-settings.json'), join(box.root, SETTINGS_FILE)],
    [join(box.state, 'inbox'), join(box.root, 'inbox')],
    [join(box.state, 'work-reclaimed.jsonl'), join(box.root, 'records', 'work-reclaimed.jsonl')],
    [join(box.state, 'restart-all.log'), join(box.root, 'logs', 'restart-all.log')],
    [join(box.state, 'prepare.log'), join(box.root, 'logs', 'prepare.log')],
  ]) {
    assert.ok(log.includes(`moved ${oldPath} -> ${newPath}`), `the migration log names ${oldPath}`)
  }

  // The second run is a no-op: the log does not grow and the data does not move again.
  const second = resolveData({ env })
  assert.equal(second.settings, first.settings)
  assert.equal(await readFile(join(box.root, 'logs', MIGRATION_LOG_FILE), 'utf8'), log, 'no second migration line')
  assert.equal(describeData({ env }).layout, 'new')
  assert.equal(describeData({ env }).migrationPending, false)
}

async function testFailedMoveKeepsFallback() {
  const box = await sandbox()
  await seedLegacy(box)
  // A file where the root must be makes every move and every lock fail deterministically, without relying
  // on permission bits (CI may run as root).
  await writeFile(box.root, 'not a directory\n', 'utf8')
  const messages = []
  const resolved = resolveData({ env: box.env, log: message => messages.push(message) })
  assert.equal(resolved.settings, join(box.state, 'panel-settings.json'), 'the reader falls back to the old file')
  assert.equal(resolved.inbox, join(box.state, 'inbox'))
  assert.equal(resolved.reclaimed, join(box.state, 'work-reclaimed.jsonl'))
  assert.ok(messages.some(message => /failed|skipped/.test(message)), 'the failed migration is logged')
  assert.equal(await exists(join(box.state, 'panel-settings.json')), true, 'the old file is untouched')
  assert.equal(await exists(join(box.state, 'inbox', 'old-1.json')), true)

  // Reading through the fallback still returns the old content.
  const settings = resolveSettings({ ...box.env, env: { ...box.env } })
  assert.equal(settings.revision, 7)
  assert.equal(settings.effective['inbox.intervalSeconds'], 42)
  assert.equal(settings.file, join(box.state, 'panel-settings.json'))

  // Once the obstruction is gone, the same process retries immediately (the failure fingerprint changed).
  await rm(box.root, { force: true })
  const recovered = resolveData({ env: box.env })
  assert.equal(recovered.settings, join(box.root, SETTINGS_FILE), 'the retry moves the old file')
  assert.equal(await exists(join(box.state, 'panel-settings.json')), false)
}

async function testOverridesWin() {
  const box = await sandbox()
  await seedLegacy(box)
  const explicitInbox = join(box.base, 'explicit-inbox')
  const explicitPrepare = join(box.base, 'explicit-prepare.log')
  const env = { ...box.env, [INBOX_ENV]: explicitInbox, [PREPARE_LOG_ENV]: explicitPrepare }

  // The explicit inbox is used as-is and the legacy inbox is not migrated.
  assert.equal(resolveInboxRoot({ env }), explicitInbox)
  await createSpvMessage(resolveInboxRoot({ env }), { title: 'Explicit', body: 'x' })
  assert.equal((await readdir(explicitInbox)).filter(name => name.endsWith('.json')).length, 1)
  assert.equal(await exists(join(box.state, 'inbox')), true, 'the legacy inbox is untouched under an override')

  // The explicit prepare log wins and the shell writer appends there, not to the root log.
  await makeResearchProject(box)
  const prepared = prepareOk(box, { [PREPARE_LOG_ENV]: explicitPrepare })
  assert.equal(prepared.status, 0, prepared.stderr)
  assert.match(await readFile(explicitPrepare, 'utf8'), /installed .*AGENTS\.md/)
  assert.equal(await exists(join(box.root, 'logs', 'prepare.log')), false, 'the override suppresses the root log')

  // DSH_SUPERAGENT_STATE_DIR still decides the queue and the work root (the superagent contract).
  const stateEnv = { DSH_SUPERAGENT_STATE_DIR: box.state }
  const savedQueue = process.env.SPV_QUEUE_DIR
  const savedState = process.env.DSH_SUPERAGENT_STATE_DIR
  try {
    delete process.env.SPV_QUEUE_DIR
    process.env.DSH_SUPERAGENT_STATE_DIR = box.state
    assert.equal(resolveRoot(), join(box.state, 'spv'))
  } finally {
    if (savedQueue === undefined) delete process.env.SPV_QUEUE_DIR
    else process.env.SPV_QUEUE_DIR = savedQueue
    if (savedState === undefined) delete process.env.DSH_SUPERAGENT_STATE_DIR
    else process.env.DSH_SUPERAGENT_STATE_DIR = savedState
  }
  assert.equal(resolveWorkRoot({ stateDir: box.state, directory: '', env: stateEnv }), join(box.state, 'work'))
  assert.equal(dataPaths({ env: stateEnv }).legacyStateDir, box.state)
}

async function testHeldLockLogsAndFallsBack() {
  const box = await sandbox()
  await seedLegacy(box)
  // Hold the migration lock: a fresh lock is not stale, so the reader waits, gives up, logs, and reads
  // through the fallback without moving anything.
  await mkdir(box.root, { recursive: true })
  await writeFile(join(box.root, '.migrate.lock'), 'held by the test\n', 'utf8')
  const resolved = resolveData({ env: box.env })
  assert.equal(resolved.settings, join(box.state, 'panel-settings.json'), 'the fallback path is used')
  assert.equal(await exists(join(box.state, 'panel-settings.json')), true, 'the old file was not moved')
  assert.equal(await exists(join(box.root, SETTINGS_FILE)), false)
  const log = await readFile(join(box.root, 'logs', MIGRATION_LOG_FILE), 'utf8')
  assert.match(log, /migration skipped/)
  assert.match(log, /migration lock/)
}

async function testWhere() {
  const box = await sandbox()
  const json = cli(box, ['where', '--json'])
  assert.equal(json.status, 0, json.stderr)
  const payload = JSON.parse(json.stdout)
  const paths = dataPaths({ env: box.env })
  assert.equal(payload.root, paths.root)
  assert.equal(payload.rootExists, false)
  assert.equal(payload.layout, 'none')
  assert.equal(payload.migrationPending, false)
  assert.equal(payload.presetDir, join(box.home, '.dsh', '.agent-presets', 'spv'))
  assert.equal(payload.webuiPackage, join(box.home, '.dsh', 'profiles', 'superagent', 'node_modules', 'wheelchair-agent-webui'))
  assert.equal(payload.queue.path, join(box.state, 'spv'))
  assert.equal(payload.workRoot.path, join(box.state, 'work'))
  assert.equal(payload.data.settings, join(box.root, SETTINGS_FILE))
  assert.equal(payload.data.inbox, join(box.root, 'inbox'))
  assert.equal(payload.data.reclaimed, join(box.root, 'records', 'work-reclaimed.jsonl'))
  assert.equal(payload.data.restartLog, join(box.root, 'logs', 'restart-all.log'))
  assert.equal(payload.data.prepareLog, join(box.root, 'logs', 'prepare.log'))
  assert.equal(payload.panelUrl, 'http://127.0.0.1:3082')
  assert.deepEqual(
    payload.wrappers.map(wrapper => wrapper.name),
    ['wheelchair-agent', 'spv', 'superagent-service', 'jobctl'],
  )
  for (const wrapper of payload.wrappers) assert.equal(wrapper.path, join(box.home, '.local', 'bin', wrapper.name))

  const human = cli(box, ['where'])
  assert.equal(human.status, 0, human.stderr)
  for (const path of [
    payload.root,
    payload.presetDir,
    payload.data.settings,
    payload.data.inbox,
    payload.data.reclaimed,
    payload.data.restartLog,
    payload.data.prepareLog,
    payload.queue.path,
    payload.workRoot.path,
    payload.panelUrl,
  ]) {
    assert.ok(human.stdout.includes(path), `where prints ${path}`)
  }
  for (const wrapper of payload.wrappers) assert.ok(human.stdout.includes(wrapper.path))

  // A relative override is refused by `where` as well.
  const bad = cli(box, ['where', '--json'], { WHEELCHAIR_AGENT_HOME: 'relative' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /absolute path/)

  // `where` is read-only: it does not create the root or migrate anything.
  await seedLegacy(box)
  const readOnly = cli(box, ['where', '--json'])
  assert.equal(readOnly.status, 0, readOnly.stderr)
  assert.equal((JSON.parse(readOnly.stdout)).layout, 'old')
  assert.equal(await exists(join(box.state, 'panel-settings.json')), true, 'where did not move the old file')
  assert.equal(await exists(join(box.root, 'settings.json')), false)
}

// ------------------------------------------------------------------- main

try {
  await testRootResolution()
  await testFreshInstallWritesUnderRoot()
  await testOldOnlyMigratesOnce()
  await testFailedMoveKeepsFallback()
  await testHeldLockLogsAndFallsBack()
  await testOverridesWin()
  await testWhere()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const base of SANDBOXES) {
    await rm(base, { recursive: true, force: true }).catch(() => {})
    await chmod(base, 0o700).catch(() => {})
  }
}
