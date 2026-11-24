#!/usr/bin/env node
/**
 * tests/test-clone-guard.mjs — offline evidence for the ticket-clone data-root guard.
 *
 * Covers the rule in `src/shared/home.js`:
 *   - a copy of this code that lives inside `<stateDir>/work/<ticket>/` may not resolve the *default*
 *     settings / inbox / queue / records / log roots: each refusal names what was attempted, says the
 *     copy is a ticket clone, lists WHEELCHAIR_AGENT_HOME / SPV_INBOX_DIR / SPV_QUEUE_DIR /
 *     DSH_SUPERAGENT_STATE_DIR and shows a mkdtemp-based sandbox;
 *   - explicit overrides are honoured: an inbox-only override still resolves its inbox, and a full
 *     sandbox (all four variables) resolves and writes only inside the sandbox;
 *   - the data-root migration refuses from a clone even when the data root is explicit, and leaves every
 *     legacy file exactly where it was;
 *   - the installed preset (`<dshHome>/.agent-presets/spv/…`) and a normal checkout resolve their
 *     defaults exactly as before, so the deployment and the operator's workflow keep working;
 *   - the guard follows realpath, so a symlinked module or a symlinked state directory cannot slip past.
 *
 * The three layouts are simulated by copying `src/` into throwaway trees under `mkdtemp`; the copied
 * modules are imported by URL, so `import.meta.url` really points at the simulated location. Everything
 * is offline: no network, no dsh, and no write to the real `~/.wheelchair-agent` or superagent state dir.
 *
 * Usage: node tests/test-clone-guard.mjs
 * Exit status: 0 when every assertion passes, 1 otherwise.
 */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')
const SANDBOXES = []

async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'wheelchair-agent-clone-guard-'))
  SANDBOXES.push(base)
  const box = {
    base,
    home: join(base, 'home'),
    state: join(base, 'state'),
    sandboxState: join(base, 'sandbox-state'),
  }
  for (const dir of [box.home, box.state, box.sandboxState]) await mkdir(dir, { recursive: true })
  return box
}

/** Copy this checkout's `src/` into `dest`; returns `dest`. */
async function copySource(dest) {
  await mkdir(dirname(dest), { recursive: true })
  await cp(SRC, dest, { recursive: true })
  return dest
}

/** Import a module from a copied tree (each location is a distinct module instance). */
async function load(tree, ...parts) {
  return import(pathToFileURL(join(tree, ...parts)).href)
}

/** The clone layout: `<stateDir>/work/<ticket>/src/…`. */
async function cloneLayout(box, name = 'ticket-0123456789ab') {
  const tree = join(box.state, 'work', name)
  await copySource(join(tree, 'src'))
  const env = { HOME: box.home, DSH_SUPERAGENT_STATE_DIR: box.state }
  return { tree, env }
}

/** Run `fn` with these process.env keys set (undefined deletes), restoring them afterwards. */
async function withProcessEnv(patch, fn) {
  const saved = new Map()
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Assert `fn` throws the shared ticket-clone error and its message contains every needle. */
function assertCloneError(fn, ...needles) {
  assert.throws(fn, error => {
    assert.equal(error.code, 'TICKET_CLONE', `expected TICKET_CLONE, got ${error.code}: ${error.message}`)
    for (const needle of needles) {
      assert.ok(error.message.includes(needle), `error should mention ${JSON.stringify(needle)}: ${error.message}`)
    }
    return true
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

/** Seed every artifact at its pre-migration (legacy) location under the state dir. */
async function seedLegacy(box) {
  await mkdir(join(box.state, 'inbox'), { recursive: true })
  await writeFile(join(box.state, 'panel-settings.json'), '{"version":1,"revision":4,"values":{}}\n', 'utf8')
  await writeFile(join(box.state, 'work-reclaimed.jsonl'), '{"name":"old-0123456789ab"}\n', 'utf8')
  await writeFile(join(box.state, 'restart-all.log'), '[old] restart\n', 'utf8')
  await writeFile(join(box.state, 'prepare.log'), 'old prepare\n', 'utf8')
  await writeFile(join(box.state, 'inbox', 'old-1.json'), '{"id":"old-1","kind":"pr"}\n', 'utf8')
}

/** Every legacy artifact still exists with its original content. */
async function assertLegacyUntouched(box) {
  const expected = {
    'panel-settings.json': '{"version":1,"revision":4,"values":{}}\n',
    'work-reclaimed.jsonl': '{"name":"old-0123456789ab"}\n',
    'restart-all.log': '[old] restart\n',
    'prepare.log': 'old prepare\n',
    'inbox/old-1.json': '{"id":"old-1","kind":"pr"}\n',
  }
  for (const [relative, content] of Object.entries(expected)) {
    assert.equal(await readFile(join(box.state, relative), 'utf8'), content, `${relative} is still in place`)
  }
}

// ------------------------------------------------------------------- cases

async function testCloneDefaultsRefuse() {
  const box = await sandbox()
  const { tree, env } = await cloneLayout(box)
  const home = await load(tree, 'src', 'shared', 'home.js')
  const paths = await load(tree, 'src', 'spv', 'paths.js')
  const inbox = await load(tree, 'src', 'spv', 'inbox.js')
  const settings = await load(tree, 'src', 'shared', 'settings.js')

  // The module's own location is what is checked, and it resolves to the clone under <stateDir>/work/.
  assert.equal(home.ticketCloneRoot({ env }), join(box.state, 'work'))
  // With the state dir overridden and a fake HOME, the default data root is itself a sandbox, so the
  // deployment scope has nothing live to protect; testStateDirOverrideCannotHideTheDefaultRoot covers a
  // realistic <home>/.dsh layout where overriding only the state dir must still be refused.
  assert.equal(
    home.ticketCloneRoot({
      env: { ...env, DSH_SUPERAGENT_STATE_DIR: box.sandboxState },
      scope: 'deployment',
    }),
    undefined,
  )

  // Data root: settings / inbox / records / logs all derive from it, so the one refusal covers them and
  // tells the worker exactly which variables to set (and that reads are refused too).
  for (const attempt of [
    () => home.resolveHome({ env }),
    () => home.resolveData({ env }),
    () => home.describeData({ env }),
    () => home.resolveData({ env, migrate: false }),
    () => settings.resolveSettings({ env }),
  ]) {
    assertCloneError(
      attempt,
      'default data root',
      'settings',
      'inbox',
      'records',
      'log',
      'ticket clone',
      join(box.home, '.wheelchair-agent'),
      join(box.state, 'work'),
      'WHEELCHAIR_AGENT_HOME',
      'SPV_INBOX_DIR',
      'SPV_QUEUE_DIR',
      'DSH_SUPERAGENT_STATE_DIR',
      'mkdtemp',
    )
  }

  // Inbox root (default location, no override): the refusal names the default data root it derives from.
  assertCloneError(
    () => inbox.resolveInboxRoot({ env }),
    'settings',
    'inbox',
    'ticket clone',
    join(box.home, '.wheelchair-agent'),
  )
  // A direct write attempt fails the same way instead of creating files under the real inbox.
  assert.throws(
    () => home.resolveData({ env }).inbox,
    error => error.code === 'TICKET_CLONE',
  )

  // Queue root: the registry is now the only source, so a bare resolveRoot() has no deployment context and
  // refuses instead of deriving <stateDir>/spv. Nothing may be derived (and therefore nothing written) from a
  // clone's default state dir anymore.
  await withProcessEnv({ DSH_SUPERAGENT_STATE_DIR: box.state, SPV_QUEUE_DIR: undefined }, () => {
    assert.throws(() => paths.resolveRoot(), /cannot tell which deployment this process belongs to/)
    assert.throws(() => paths.resolveRoot({ queueDir: '' }), /cannot tell which deployment this process belongs to/)
  })

  // Nothing was created or moved by any of those refusals.
  assert.equal(await exists(join(box.home, '.wheelchair-agent')), false, 'the default data root was not created')
  assert.deepEqual(await readdir(box.state), ['work'])
}

async function testMigrationRefusesFromClone() {
  const box = await sandbox()
  const { tree, env } = await cloneLayout(box)
  await seedLegacy(box)
  const home = await load(tree, 'src', 'shared', 'home.js')
  const sandboxData = join(box.base, 'sandbox-data')
  await mkdir(sandboxData, { recursive: true })

  // With defaults, the data-root guard fires first; the migration must not have read or moved anything.
  assertCloneError(() => home.migrateData({ env }), 'default data root', 'ticket clone')
  assertLegacyUntouched(box)

  // Even an explicit data root may not run the migration from a clone: that is the operation that moved
  // the operator's live inbox. It names the only two places it may be run from.
  assertCloneError(
    () => home.migrateData({ env, home: sandboxData }),
    'data-root migration',
    'ticket clone',
    'fix: run it from the installed preset or a normal checkout',
  )
  assertLegacyUntouched(box)
  assert.deepEqual(await readdir(sandboxData), [], 'no data was moved into the sandbox')
  assert.equal(await exists(join(box.home, '.wheelchair-agent', 'settings.json')), false)

  // `resolveData` (the implicit migration) refuses before describeData stats the live legacy directory.
  assertCloneError(() => home.resolveData({ env, home: sandboxData }), 'data-root migration')
  assertLegacyUntouched(box)
}

async function testExplicitOverridesWin() {
  const box = await sandbox()
  const { tree, env } = await cloneLayout(box)
  const home = await load(tree, 'src', 'shared', 'home.js')
  const paths = await load(tree, 'src', 'spv', 'paths.js')
  const inbox = await load(tree, 'src', 'spv', 'inbox.js')
  const settings = await load(tree, 'src', 'shared', 'settings.js')

  const sandboxData = join(box.base, 'sandbox-data')
  const sandboxInbox = join(box.base, 'sandbox-inbox')
  const sandboxQueue = join(box.base, 'sandbox-queue')

  // (a) Root-specific overrides are honoured even while the clone is still detected (real state dir):
  // the inbox and the queue resolve to their explicit paths.
  const partial = {
    ...env,
    WHEELCHAIR_AGENT_HOME: sandboxData,
    SPV_INBOX_DIR: sandboxInbox,
  }
  assert.equal(inbox.resolveInboxRoot({ env: partial }), sandboxInbox)
  await withProcessEnv({ DSH_SUPERAGENT_STATE_DIR: box.state, SPV_QUEUE_DIR: sandboxQueue }, () => {
    assert.equal(paths.resolveRoot(), sandboxQueue)
    assert.equal(paths.resolveRoot({ queueDir: join(box.base, 'config-queue') }), join(box.base, 'config-queue'))
  })
  // Describing the data layout inspects the live legacy state root (the migration fallback), so with the
  // state dir still live it refuses even though the data root is explicit; the migration refuses too.
  assertCloneError(
    () => home.resolveData({ env: partial, migrate: false }),
    'legacy state root',
    'DSH_SUPERAGENT_STATE_DIR',
  )
  assertCloneError(() => home.resolveData({ env: partial }), 'data-root migration')
  assertCloneError(() => home.migrateData({ env: partial, home: sandboxData }), 'data-root migration')
  assert.equal(await exists(join(box.state, 'inbox')), false)

  // (b) A full sandbox (including DSH_SUPERAGENT_STATE_DIR) is the supported way to run from a clone:
  // defaults resolve against the sandbox and writes stay there. The guard treats a copy outside the
  // overridden state dir as not being a ticket clone.
  const full = {
    HOME: box.home,
    DSH_SUPERAGENT_STATE_DIR: box.sandboxState,
    WHEELCHAIR_AGENT_HOME: sandboxData,
    SPV_INBOX_DIR: sandboxInbox,
    SPV_QUEUE_DIR: sandboxQueue,
  }
  const fullResolved = home.resolveData({ env: full })
  assert.equal(fullResolved.settings, join(sandboxData, 'settings.json'))
  assert.equal(fullResolved.inbox, sandboxInbox)
  assert.deepEqual(home.migrateData({ env: full }), [])

  const saved = settings.saveSettings({ env: full, revision: 0, values: { 'inbox.intervalSeconds': 7 } })
  assert.equal(saved.file, join(sandboxData, 'settings.json'))
  assert.equal(JSON.parse(await readFile(join(sandboxData, 'settings.json'), 'utf8')).values['inbox.intervalSeconds'], 7)
  assert.equal(await exists(join(box.home, '.wheelchair-agent')), false, 'nothing was written under the default root')
  assert.equal((await readdir(box.state)).sort().join(','), 'work', 'nothing was written under the real state dir')

  // (c) The explicit `home` option is honoured by resolveHome(), but describing or writing the layout
  // still needs the legacy state root sandboxed, because that fallback lives in the live state dir.
  const explicitHome = join(box.base, 'explicit-home')
  assert.equal(home.resolveHome({ env, home: explicitHome }), explicitHome)
  assertCloneError(() => home.resolveData({ env, home: explicitHome, migrate: false }), 'legacy state root')
}

async function testStateDirOverrideCannotHideTheDefaultRoot() {
  const box = await sandbox()
  // The realistic deployment layout: the clone lives under <home>/.dsh/state/superagent/work/<ticket>.
  const homeState = join(box.home, '.dsh', 'state', 'superagent')
  const tree = join(homeState, 'work', 'ticket-0123456789ab')
  await copySource(join(tree, 'src'))
  const home = await load(tree, 'src', 'shared', 'home.js')
  const paths = await load(tree, 'src', 'spv', 'paths.js')
  const inbox = await load(tree, 'src', 'spv', 'inbox.js')
  const settings = await load(tree, 'src', 'shared', 'settings.js')
  const sandboxState = join(box.base, 'other-state')

  // Only the state dir is overridden. The default data root did not move with it, so the deployment-scoped
  // check still sees the physical clone and refuses the live ~/.wheelchair-agent.
  const stateOnly = { HOME: box.home, DSH_SUPERAGENT_STATE_DIR: sandboxState }
  assertCloneError(
    () => home.resolveHome({ env: stateOnly }),
    'default data root',
    join(box.home, '.wheelchair-agent'),
  )
  assertCloneError(
    () => inbox.resolveInboxRoot({ env: stateOnly }),
    'default data root',
    join(box.home, '.wheelchair-agent'),
  )
  assertCloneError(() => settings.saveSettings({ env: stateOnly, revision: 0 }), 'default data root')

  // The queue has no default to follow anymore: without a registry entry (or an explicit override) it
  // refuses instead of deriving <sandboxState>/spv.
  await withProcessEnv({ HOME: box.home, DSH_SUPERAGENT_STATE_DIR: sandboxState, SPV_QUEUE_DIR: undefined }, () => {
    assert.throws(() => paths.resolveRoot(), /cannot tell which deployment this process belongs to/)
  })

  // Only DSH_HOME is overridden: the un-overridden $HOME/.dsh default still catches the clone.
  const dshOnly = { HOME: box.home, DSH_HOME: join(box.base, 'other-dsh') }
  assertCloneError(() => home.resolveHome({ env: dshOnly }), 'default data root', join(box.home, '.wheelchair-agent'))

  // A relocated state dir that neither candidate knows is caught by the structural work/<ticket> shape.
  const relocatedWork = join(box.base, 'opt', 'state', 'superagent', 'work')
  const relocated = join(relocatedWork, 'ticket-0123456789ab')
  await copySource(join(relocated, 'src'))
  const relocatedHome = await load(relocated, 'src', 'shared', 'home.js')
  // The structural fallback is for a *live* default data root; use the real HOME so it applies. Nothing is
  // written: the assertion only resolves the path and catches the refusal.
  assertCloneError(
    () =>
      relocatedHome.resolveHome({ env: { HOME: homedir(), DSH_SUPERAGENT_STATE_DIR: sandboxState } }),
    'default data root',
    relocatedWork,
    join(homedir(), '.wheelchair-agent'),
  )

  // The Source's own fallback queue resolver goes through the same shared check.
  const spv = await load(tree, 'src', 'superagent', 'spv.js')
  await withProcessEnv(
    { HOME: box.home, DSH_SUPERAGENT_STATE_DIR: undefined, SPV_QUEUE_DIR: undefined, DSH_SUPERAGENT_WORK_DIR: undefined },
    () => {
      assertCloneError(
        () => new spv.Queue(),
        'default spv queue root',
        join(homeState, 'spv'),
      )
    },
  )
}

async function testNonCloneLayoutsKeepWorking() {
  // The installed preset: `<dshHome>/.agent-presets/spv/src/…`, with state under `<dshHome>/state/superagent`.
  const presetBox = await sandbox()
  const dshHome = join(presetBox.home, '.dsh')
  const presetState = join(dshHome, 'state', 'superagent')
  await mkdir(presetState, { recursive: true })
  const presetTree = join(dshHome, '.agent-presets', 'spv')
  await copySource(join(presetTree, 'src'))
  const presetEnv = { HOME: presetBox.home, DSH_HOME: dshHome, DSH_SUPERAGENT_STATE_DIR: presetState }
  const presetHome = await load(presetTree, 'src', 'shared', 'home.js')
  const presetPaths = await load(presetTree, 'src', 'spv', 'paths.js')
  assert.equal(presetHome.ticketCloneRoot({ env: presetEnv }), undefined)
  const presetData = presetHome.resolveData({ env: presetEnv })
  assert.equal(presetData.root, join(presetBox.home, '.wheelchair-agent'))
  assert.equal(presetData.settings, join(presetBox.home, '.wheelchair-agent', 'settings.json'))
  assert.equal(presetData.inbox, join(presetBox.home, '.wheelchair-agent', 'inbox'))
  assert.equal(presetData.reclaimed, join(presetBox.home, '.wheelchair-agent', 'records', 'work-reclaimed.jsonl'))
  assert.equal(presetData.restartLog, join(presetBox.home, '.wheelchair-agent', 'logs', 'restart-all.log'))
  assert.equal(presetData.prepareLog, join(presetBox.home, '.wheelchair-agent', 'logs', 'prepare.log'))
  // No registry entry: the installed preset refuses instead of guessing <presetState>/spv.
  await withProcessEnv({ DSH_SUPERAGENT_STATE_DIR: presetState, SPV_QUEUE_DIR: undefined }, () => {
    assert.throws(() => presetPaths.resolveRoot(), /cannot tell which deployment this process belongs to/)
  })

  // A normal checkout: `~/bioagentforge/tools/wheelchair-agent/src/…`, same default state dir.
  const checkoutBox = await sandbox()
  const checkoutState = join(checkoutBox.home, '.dsh', 'state', 'superagent')
  await mkdir(checkoutState, { recursive: true })
  const checkoutTree = join(checkoutBox.home, 'bioagentforge', 'tools', 'wheelchair-agent')
  await copySource(join(checkoutTree, 'src'))
  const checkoutEnv = { HOME: checkoutBox.home, DSH_SUPERAGENT_STATE_DIR: checkoutState }
  const checkoutHome = await load(checkoutTree, 'src', 'shared', 'home.js')
  const checkoutPaths = await load(checkoutTree, 'src', 'spv', 'paths.js')
  assert.equal(checkoutHome.ticketCloneRoot({ env: checkoutEnv }), undefined)
  const checkoutData = checkoutHome.resolveData({ env: checkoutEnv })
  assert.equal(checkoutData.root, join(checkoutBox.home, '.wheelchair-agent'))
  assert.equal(checkoutData.settings, join(checkoutBox.home, '.wheelchair-agent', 'settings.json'))
  assert.equal(checkoutData.inbox, join(checkoutBox.home, '.wheelchair-agent', 'inbox'))
  await withProcessEnv({ DSH_SUPERAGENT_STATE_DIR: checkoutState, SPV_QUEUE_DIR: undefined }, () => {
    assert.throws(() => checkoutPaths.resolveRoot(), /cannot tell which deployment this process belongs to/)
  })
}

async function testSymlinksCannotSlipThrough() {
  const box = await sandbox()
  const { tree, env } = await cloneLayout(box)

  // A symlinked module URL still points at the real clone: Node and the guard both realpath it.
  const moduleLink = join(box.base, 'linked-home.js')
  await symlink(join(tree, 'src', 'shared', 'home.js'), moduleLink)
  const linked = await load(box.base, 'linked-home.js')
  assert.equal(await realpath(moduleLink), join(tree, 'src', 'shared', 'home.js'))
  assertCloneError(() => linked.resolveData({ env }), 'ticket clone', join(box.state, 'work'))

  // A symlinked state directory must not hide the clone either: the state dir is realpath'd too.
  const stateLink = join(box.base, 'state-link')
  await symlink(box.state, stateLink)
  const home = await load(tree, 'src', 'shared', 'home.js')
  assert.equal(home.ticketCloneRoot({ env: { ...env, DSH_SUPERAGENT_STATE_DIR: stateLink } }), join(box.state, 'work'))
  assertCloneError(
    () => home.resolveData({ env: { ...env, DSH_SUPERAGENT_STATE_DIR: stateLink } }),
    'ticket clone',
    'default data root',
  )

  // A symlinked access path into the real work root still resolves to the real clone.
  const workLink = join(box.base, 'work-link')
  await symlink(join(box.state, 'work'), workLink)
  const relinked = await load(box.base, 'work-link', 'ticket-0123456789ab', 'src', 'shared', 'home.js')
  assertCloneError(() => relinked.resolveHome({ env }), 'ticket clone', join(box.state, 'work'))

  // The work root itself may be a symlink to the real ticket tree: the work root is realpath'd too, so the
  // module's real location is still recognised as a ticket clone.
  const box2 = await sandbox()
  const realWork = join(box2.base, 'real-work')
  const hiddenTree = join(realWork, 'ticket-0123456789ab')
  await copySource(join(hiddenTree, 'src'))
  await symlink(realWork, join(box2.state, 'work'), 'dir')
  const hiddenHome = await load(hiddenTree, 'src', 'shared', 'home.js')
  assertCloneError(
    () => hiddenHome.resolveHome({ env: { HOME: box2.home, DSH_SUPERAGENT_STATE_DIR: box2.state } }),
    'ticket clone',
    realWork,
  )
}

// ------------------------------------------------------------------- main

try {
  await testCloneDefaultsRefuse()
  await testMigrationRefusesFromClone()
  await testExplicitOverridesWin()
  await testStateDirOverrideCannotHideTheDefaultRoot()
  await testNonCloneLayoutsKeepWorking()
  await testSymlinksCannotSlipThrough()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true }).catch(() => {})
}
