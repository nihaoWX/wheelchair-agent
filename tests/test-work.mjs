#!/usr/bin/env node
/**
 * tests/test-work.mjs — offline evidence for `wheelchair-agent work gc` and `work restored`.
 *
 * Covers:
 *   - a clean, fully pushed ticket clone is reclaimed and its JSONL record holds HEAD / origin/main / branch / remote;
 *   - a clone with an unpushed commit, a dirty clone and a clone with no remote are kept with a readable reason;
 *   - a directory held by a live process cwd is kept and names that pid;
 *   - an unknown directory is reported and survives even when it is old;
 *   - `--dry-run` prints the plan and deletes nothing; a second run is a no-op;
 *   - `work restored` prints commands that actually rebuild the clone from the record;
 *   - the mount hook runs the same implementation and logs one summary line;
 *   - the work root defaults to `<stateDir>/work` and follows the documented overrides.
 *
 * Everything is offline: local bare repositories are exposed as `https://github.com/testowner/<name>` through
 * `url.<local-bare>.insteadOf` in a throwaway GIT_CONFIG_GLOBAL, so no credential or network is involved.
 *
 * Usage: node tests/test-work.mjs
 * Exit status: 0 when every assertion passes, 1 otherwise.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KEEP_DAYS_DEFAULT,
  KEEP_DEFAULT,
  RECLAIMED_FILE,
  cwdHolders,
  formatBytes,
  megabytes,
  planWork,
  readReclaimed,
  reclaimWork,
  resolveWorkRoot,
  restoreCommands,
  shellQuote,
} from '../src/shared/work.js'
import { reclaimAtMount } from '../src/superagent/watch.js'

const CLI = fileURLToPath(new URL('../bin/wheelchair-agent.mjs', import.meta.url))
const SANDBOXES = []

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(10)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** One throwaway sandbox: state dir, work root, remotes, and an isolated git configuration. */
async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'spv-work-test.'))
  SANDBOXES.push(base)
  const box = {
    base,
    home: join(base, 'home'),
    remotes: join(base, 'remotes'),
    state: join(base, 'state'),
    work: join(base, 'state', 'work'),
    config: join(base, 'gitconfig'),
  }
  await mkdir(box.home, { recursive: true })
  await mkdir(box.remotes, { recursive: true })
  await mkdir(box.work, { recursive: true })
  await writeFile(
    box.config,
    [
      '[user]',
      '\tname = Test Runner',
      '\temail = test@example.invalid',
      '[init]',
      '\tdefaultBranch = main',
      '[url "file://' + box.remotes + '/"]',
      '\tinsteadOf = https://github.com/testowner/',
      '',
    ].join('\n'),
    'utf8',
  )
  box.env = {
    ...process.env,
    HOME: box.home,
    GIT_CONFIG_GLOBAL: box.config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
  return box
}

/** Run real git inside the sandbox. */
function git(box, args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: box.env,
    ...options,
  })
}

function gitIn(box, dir, ...args) {
  return git(box, ['-C', dir, ...args])
}

/** Run the CLI with the sandbox state dir; returns stdout, and optionally the status. */
function cli(box, args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? box.base,
    encoding: 'utf8',
    env: { ...box.env, DSH_SUPERAGENT_STATE_DIR: box.state, ...(options.env ?? {}) },
  })
  if (options.expectFailure !== true) {
    assert.equal(
      result.status,
      0,
      `wheelchair-agent ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    )
  }
  return result
}

/** A local bare repository plus a seed history on `main` and `agent/<name>`, reachable as the https URL. */
async function makeRemote(box, name) {
  const seed = join(box.base, 'seed', name)
  await mkdir(seed, { recursive: true })
  git(box, ['init', '-q', '-b', 'main', seed])
  await writeFile(join(seed, 'README.md'), `${name}\n`, 'utf8')
  git(box, ['-C', seed, 'add', '-A'])
  git(box, ['-C', seed, 'commit', '-qm', 'init'])
  git(box, ['-C', seed, 'checkout', '-qb', `agent/${name}`])
  await writeFile(join(seed, 'work.txt'), 'pushed\n', 'utf8')
  git(box, ['-C', seed, 'add', '-A'])
  git(box, ['-C', seed, 'commit', '-qm', 'work'])
  const bare = join(box.remotes, `${name}.git`)
  await mkdir(dirname(bare), { recursive: true })
  git(box, ['init', '-q', '--bare', '-b', 'main', bare])
  git(box, ['-C', seed, 'remote', 'add', 'origin', `https://github.com/testowner/${name}.git`])
  git(box, ['-C', seed, 'push', '-q', 'origin', 'main', `agent/${name}`])
  return bare
}

/** A ticket-shaped clone of one attribute branch; `hex` is the ticket id suffix. */
async function cloneTicket(box, name, hex = '0123456789ab', branch = `agent/${name}`) {
  await makeRemote(box, name)
  const dir = join(box.work, `${name}-${hex}`)
  git(box, ['clone', '-q', '--branch', branch, `https://github.com/testowner/${name}.git`, dir])
  return dir
}

/** Parse the record file into objects; a missing file reads as empty. */
async function records(box) {
  try {
    const text = await readFile(join(box.state, RECLAIMED_FILE), 'utf8')
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** Plan/delete through the library entry point, with the retention window disabled for the case under test. */
function reclaim(box, overrides = {}) {
  return reclaimWork({ root: box.work, stateDir: box.state, keep: 0, keepDays: 0, ...overrides })
}

/** A clean, fully pushed clone is reclaimed, and the record has the shas and remote. */
async function testCleanCloneReclaimed() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'alpha')
  const head = gitIn(box, dir, 'rev-parse', 'HEAD').trim()
  const originMain = gitIn(box, dir, 'rev-parse', 'origin/main').trim()
  const branch = gitIn(box, dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  // The *configured* URL, not the insteadOf-resolved local path: that is what a later rebuild must paste.
  const remote = gitIn(box, dir, 'config', '--get', 'remote.origin.url').trim()

  const summary = await reclaim(box)
  assert.equal(summary.reclaimed, 1, 'the clean pushed clone is reclaimed')
  assert.equal(summary.kept, 0)
  assert.equal(summary.unknown, 0)
  assert.ok(summary.freedBytes > 0, 'the freed size is positive')
  await assert.rejects(readFile(join(dir, '.git', 'HEAD')), { code: 'ENOENT' }, 'the directory is gone')

  const lines = await records(box)
  assert.equal(lines.length, 1, 'one JSONL line is written')
  assert.equal(lines[0].name, 'alpha-0123456789ab')
  assert.equal(lines[0].head, head, 'the record holds HEAD')
  assert.equal(lines[0].originMain, originMain, 'the record holds origin/main')
  assert.equal(lines[0].branch, branch, 'the record holds the branch')
  assert.equal(lines[0].remote, remote, 'the record holds the remote URL')
  assert.ok(lines[0].bytes > 0, 'the record holds the absolute size')
  assert.ok(Number.isFinite(Date.parse(lines[0].when)), 'the record holds an ISO timestamp')

  const again = await reclaim(box)
  assert.equal(again.reclaimed, 0, 'a second run is a no-op')
  assert.equal((await records(box)).length, 1, 'a second run appends no record')
}

/** One local commit that was never pushed keeps the clone and is counted in the reason. */
async function testUnpushedKept() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'beta')
  await writeFile(join(dir, 'local.txt'), 'unpublished\n', 'utf8')
  gitIn(box, dir, 'add', '-A')
  gitIn(box, dir, 'commit', '-qm', 'local only')

  const summary = await reclaim(box)
  assert.equal(summary.reclaimed, 0)
  const entry = summary.entries.find(item => item.name === 'beta-0123456789ab')
  assert.equal(entry.action, 'keep')
  assert.equal(entry.reason, '1 commit not pushed')
  assert.deepEqual(await records(box), [], 'no record is written for a kept directory')
  assert.equal(gitIn(box, dir, 'rev-list', '--count', 'HEAD').trim(), '3', 'the clone still exists')
}

/** A dirty working tree keeps the clone and says what is dirty. */
async function testDirtyKept() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'gamma')
  await writeFile(join(dir, 'untracked.txt'), 'dirty\n', 'utf8')

  const summary = await reclaim(box)
  const entry = summary.entries.find(item => item.name === 'gamma-0123456789ab')
  assert.equal(summary.reclaimed, 0)
  assert.equal(entry.action, 'keep')
  assert.equal(entry.reason, '1 untracked path')
  assert.ok((await readFile(join(dir, 'untracked.txt'), 'utf8')).includes('dirty'))
}

/** A clone with no remote at all is the only copy and is never reclaimed. */
async function testNoRemoteKept() {
  const box = await sandbox()
  const dir = join(box.work, 'delta-0123456789ab')
  await mkdir(dir, { recursive: true })
  git(box, ['init', '-q', '-b', 'main', dir])
  await writeFile(join(dir, 'file.txt'), 'only copy\n', 'utf8')
  gitIn(box, dir, 'add', '-A')
  gitIn(box, dir, 'commit', '-qm', 'init')

  const summary = await reclaim(box)
  const entry = summary.entries.find(item => item.name === 'delta-0123456789ab')
  assert.equal(summary.reclaimed, 0)
  assert.equal(entry.action, 'keep')
  assert.equal(entry.reason, 'no remote (the clone is the only copy)')
}

/** A live process whose cwd is the directory is the runtime fact that keeps it. */
async function testCwdHeldKept() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'epsilon')
  const child = spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' })
  try {
    await waitFor(async () => {
      const holders = await cwdHolders(dir)
      return holders.pids.includes(child.pid)
    }, 'the sleep process to enter the directory')

    const summary = await reclaim(box)
    const entry = summary.entries.find(item => item.name === 'epsilon-0123456789ab')
    assert.equal(summary.reclaimed, 0)
    assert.equal(entry.action, 'keep')
    assert.equal(entry.reason, `cwd in use by pid ${child.pid}`)
    assert.ok((await gitIn(box, dir, 'rev-parse', 'HEAD')).length > 0, 'the held clone still exists')
  } finally {
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
  }
}

/** An unknown directory is reported, not reclaimed, even when it is old. */
async function testUnknownSurvives() {
  const box = await sandbox()
  const stray = join(box.work, 'state')
  await mkdir(stray, { recursive: true })
  await writeFile(join(stray, 'residue.txt'), 'not a ticket\n', 'utf8')
  const old = new Date('2020-01-01T00:00:00Z')
  await utimes(stray, old, old)

  const summary = await reclaim(box)
  const entry = summary.entries.find(item => item.name === 'state')
  assert.equal(summary.reclaimed, 0)
  assert.equal(summary.unknown, 1)
  assert.equal(entry.action, 'unknown')
  assert.match(entry.reason, /not a ticket clone: no \.git/)
  assert.ok((await readFile(join(stray, 'residue.txt'), 'utf8')).includes('not a ticket'))
}

/** `--dry-run` prints the plan, keeps the reasons, and writes/deletes nothing. */
async function testDryRun() {
  const box = await sandbox()
  const clean = await cloneTicket(box, 'alpha')
  const dirty = await cloneTicket(box, 'zeta')
  await writeFile(join(dirty, 'untracked.txt'), 'dirty\n', 'utf8')
  await mkdir(join(box.work, 'state'), { recursive: true })

  const result = cli(box, ['work', 'gc', '--dry-run', '--keep', '0'])
  assert.match(result.stdout, /\(dry run; nothing is deleted\)/)
  assert.match(result.stdout, /reclaim\s+[\d.]+ [KMG]?B\s+alpha-0123456789ab/)
  assert.match(result.stdout, /keep\s+[\d.]+ [KMG]?B\s+zeta-0123456789ab \(1 untracked path\)/)
  assert.match(result.stdout, /unknown\s+[\d.]+ [KMG]?B\s+state \(not a ticket clone: no \.git\)/)
  assert.match(result.stdout, /would reclaim 1, kept 2 \(1 unknown\), free /)
  assert.ok((await gitIn(box, clean, 'rev-parse', 'HEAD')).length > 0, 'dry-run deleted nothing')
  assert.deepEqual(await records(box), [], 'dry-run wrote no record')

  const live = cli(box, ['work', 'gc', '--keep', '0'])
  assert.match(live.stdout, /^reclaimed 1, kept 2 \(1 unknown\), freed /m)
  await assert.rejects(readFile(join(clean, '.git', 'HEAD')), { code: 'ENOENT' })
  const second = cli(box, ['work', 'gc', '--keep', '0'])
  assert.match(second.stdout, /^reclaimed 0, kept 2 \(1 unknown\), freed 0 B/m)
  assert.equal((await records(box)).length, 1, 'the second run appended nothing')
}

/** `work restored` prints commands that really rebuild the clone at the recorded commit. */
async function testRestored() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'eta')
  const head = gitIn(box, dir, 'rev-parse', 'HEAD').trim()
  await reclaim(box)

  const result = cli(box, ['work', 'restored', 'eta-0123456789ab'])
  assert.match(result.stdout, /^mkdir -p '.*\/state\/work'$/m)
  assert.match(result.stdout, new RegExp(`git clone 'https://github\\.com/testowner/eta\\.git' '${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
  assert.match(result.stdout, /^git fetch origin 'agent\/eta'$/m)
  assert.match(result.stdout, new RegExp(`git checkout --detach '${head}'`))

  // Paste the printed commands into a shell and prove the checkout lands on the recorded commit.
  const output = execFileSync('sh', ['-c', result.stdout], {
    cwd: box.base,
    encoding: 'utf8',
    env: box.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.equal(output.trim(), '', 'the rebuild commands are quiet')
  assert.equal(gitIn(box, dir, 'rev-parse', 'HEAD').trim(), head, 'the rebuilt clone is at the recorded commit')
  const restored = await readReclaimed({ stateDir: box.state, ticket: 'eta-0123456789ab' })
  assert.equal(restored.record.head, head)
  assert.equal(restoreCommands(restored.record, { root: box.work }).includes(head), true)
}

/** The keep floor is a hard floor over passing clones, independent of age. */
async function testKeepFloor() {
  const box = await sandbox()
  const dirs = []
  for (const [index, name] of ['one', 'two', 'three'].entries()) {
    const dir = await cloneTicket(box, name, `00000000000${index + 1}`)
    const stamp = Date.now() - 1000 * (3 - index)
    await utimes(dir, new Date(stamp), new Date(stamp))
    dirs.push(dir)
  }
  const summary = await reclaimWork({ root: box.work, stateDir: box.state, keep: 2 })
  assert.equal(summary.reclaimed, 1, 'only the clone below the floor is reclaimed')
  assert.equal(summary.kept, 2)
  const kept = summary.entries.filter(entry => entry.action === 'keep')
  assert.deepEqual(kept.map(entry => entry.reason), [
    'among the newest 2 directories (--keep)',
    'among the newest 2 directories (--keep)',
  ])
  assert.deepEqual((await records(box)).map(record => record.name), ['one-000000000001'])
  assert.ok(dirs[1].length > 0)
}

/** Age retention is opt-in: a fresh clean clone is kept only when the caller asks for a window. */
async function testAgeRetention() {
  const box = await sandbox()
  await cloneTicket(box, 'iota')
  const summary = await reclaimWork({ root: box.work, stateDir: box.state, keep: 0, keepDays: 7 })
  assert.equal(summary.reclaimed, 0)
  const entry = summary.entries.find(item => item.name === 'iota-0123456789ab')
  assert.equal(entry.reason, 'modified less than 7 days ago (--keep-days)')
  assert.deepEqual(await records(box), [])
}

/** The mount hook uses the same defaults as the CLI: the newest 10 passing clones stay. */
async function testMountHook() {
  const box = await sandbox()
  await makeRemote(box, 'theta')
  const dirs = []
  for (let index = 1; index <= 11; index += 1) {
    const dir = join(box.work, `theta-${String(index).padStart(12, '0')}`)
    git(box, ['clone', '-q', '--branch', 'agent/theta', 'https://github.com/testowner/theta.git', dir])
    await utimes(dir, new Date(Date.now() - 1000 * (12 - index)), new Date(Date.now() - 1000 * (12 - index)))
    dirs.push(dir)
  }
  const lines = []
  // The early path must not wait for setup: a rejecting `ready` proves the mount pass ran before it. The catch keeps
  // Node from treating the unawaited rejection as a crash while still failing the test if the fallback is taken.
  const ready = Promise.reject(new Error('reclaimAtMount waited for setup instead of running at mount'))
  ready.catch(() => {})
  const ctx = {
    ready,
    orchestrator: {
      machine: { stateDir: box.state },
      settings: { current: () => ({ executor: { directory: box.work } }) },
    },
    logger: { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) },
  }
  await reclaimAtMount(ctx)
  assert.equal(lines.length, 1, 'the mount logs one summary line')
  assert.match(lines[0], /wheelchair-agent work gc: reclaimed 1, kept 10, freed [\d.]+ MB/)
  await assert.rejects(readFile(join(dirs[0], '.git', 'HEAD')), { code: 'ENOENT' }, 'the oldest clone is gone')
  assert.ok((await readFile(join(dirs[10], '.git', 'HEAD'), 'utf8')).length > 0, 'the newest 10 are kept')
}

/** Root resolution and formatting helpers: documented defaults and overrides. */
function testHelpers() {
  const saved = process.env.DSH_SUPERAGENT_WORK_DIR
  try {
    delete process.env.DSH_SUPERAGENT_WORK_DIR
    assert.equal(resolveWorkRoot({ stateDir: '/s' }), '/s/work')
    assert.equal(resolveWorkRoot({ stateDir: '/s', directory: '/custom' }), '/custom')
    process.env.DSH_SUPERAGENT_WORK_DIR = '/from-env'
    assert.equal(resolveWorkRoot({ stateDir: '/s' }), '/from-env')
    assert.equal(resolveWorkRoot({ stateDir: '/s', directory: '/custom' }), '/custom', 'the setting wins')
    delete process.env.DSH_SUPERAGENT_WORK_DIR
    assert.equal(KEEP_DAYS_DEFAULT, 0, 'no age retention by default')
    assert.equal(KEEP_DEFAULT, 10, 'the newest ten passing clones are a hard floor')
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(12 * 1024), '12.0 KB')
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
    assert.equal(megabytes(2_500_000), '2.5')
    assert.equal(shellQuote(`a'b`), `'a'\\''b'`)
    const plan = planWork
    assert.equal(typeof plan, 'function')
  } finally {
    if (saved === undefined) delete process.env.DSH_SUPERAGENT_WORK_DIR
    else process.env.DSH_SUPERAGENT_WORK_DIR = saved
  }
}

// ------------------------------------------------------------------- main

try {
  await testCleanCloneReclaimed()
  await testUnpushedKept()
  await testDirtyKept()
  await testNoRemoteKept()
  await testCwdHeldKept()
  await testUnknownSurvives()
  await testDryRun()
  await testRestored()
  await testKeepFloor()
  await testAgeRetention()
  await testMountHook()
  testHelpers()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true })
}
