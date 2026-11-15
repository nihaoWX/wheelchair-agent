#!/usr/bin/env node
/**
 * tests/test-work.mjs — offline evidence for `wheelchair-agent work gc` and `work restored`.
 *
 * Covers:
 *   - a clean, fully pushed ticket clone is reclaimed and its JSONL record holds HEAD / origin/main / branch / remote;
 *   - a clone with an unpushed commit, a dirty clone and a clone with no remote are kept with a readable reason;
 *   - the no-upstream fallback (`git rev-list origin/main..HEAD`) reclaims a clone whose HEAD is on origin/main and
 *     keeps one that is one local commit ahead;
 *   - a directory held by a live process cwd is kept and names that pid, and an unreadable /proc entry keeps everything;
 *   - a directory an open ticket still owns is kept by the mount-only skip list;
 *   - the tracked remote (not a hard-coded origin) is recorded, so `work restored` rebuilds a fork clone;
 *   - an unknown directory is reported and survives even when it is old;
 *   - `--dry-run` prints the plan and deletes nothing; a second run is a no-op;
 *   - the keep floor is a hard floor regardless of age, and `--keep-days` reclaims old clones while keeping fresh ones;
 *   - a failed delete retracts its record so `work restored` does not target a surviving directory;
 *   - `work restored` prints commands that actually rebuild the clone from the record;
 *   - the mount hook runs through `apply()` before setup, uses the same defaults, logs one summary line and only
 *     sweeps once; its fallback path uses the orchestrator service, not plugin-context members.
 *
 * Everything is offline: local bare repositories are exposed as `https://github.com/testowner/<name>` through
 * `url.<local-bare>.insteadOf` in a throwaway GIT_CONFIG_GLOBAL, so no credential or network is involved.
 *
 * Usage: node tests/test-work.mjs
 * Exit status: 0 when every assertion passes, 1 otherwise.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
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
import { apply, reclaimAtMount } from '../src/superagent/watch.js'

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

/** Run the CLI with the sandbox state dir; returns the completion result. */
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

/** A ticket-shaped clone of one branch of a fresh remote; `hex` is the ticket id suffix. */
async function cloneTicket(box, name, hex = '0123456789ab', branch = `agent/${name}`) {
  await makeRemote(box, name)
  const dir = join(box.work, `${name}-${hex}`)
  git(box, ['clone', '-q', '--branch', branch, `https://github.com/testowner/${name}.git`, dir])
  return dir
}

/** Backdate a directory, which the retention rules read from its mtime. */
async function setAge(dir, days) {
  const stamp = new Date(Date.now() - days * 86_400_000)
  await utimes(dir, stamp, stamp)
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

/** Plan/delete through the library entry point, with the retention cushions disabled for the case under test. */
function reclaim(box, overrides = {}) {
  return reclaimWork({ root: box.work, stateDir: box.state, keep: 0, keepDays: 0, ...overrides })
}

/** The plan entry for one directory, by name. */
function entryOf(summary, name) {
  const entry = summary.entries.find(item => item.name === name)
  assert.ok(entry, `the plan has an entry for ${name}`)
  return entry
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
  assert.equal(lines[0].remoteName, 'origin', 'the record holds the tracked remote name')
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
  const entry = entryOf(summary, 'beta-0123456789ab')
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
  const entry = entryOf(summary, 'gamma-0123456789ab')
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
  const entry = entryOf(summary, 'delta-0123456789ab')
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
    const entry = entryOf(summary, 'epsilon-0123456789ab')
    assert.equal(summary.reclaimed, 0)
    assert.equal(entry.action, 'keep')
    assert.equal(entry.reason, `cwd in use by pid ${child.pid}`)
    assert.ok((await gitIn(box, dir, 'rev-parse', 'HEAD')).length > 0, 'the held clone still exists')
  } finally {
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
  }
}

/**
 * An unreadable same-user pid is dangerous only under `hidepid`; without it (systemd's dumpable=0 processes) the scan
 * still works. A missing /proc is always unprovable.
 */
async function testUnreadableProc() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return
  const box = await sandbox()
  const target = join(box.work, 'held-dir')
  await mkdir(target, { recursive: true })
  const fakeProc = join(box.base, 'proc')
  const pidDir = join(fakeProc, '4242')
  await mkdir(pidDir, { recursive: true })
  await symlink(target, join(pidDir, 'cwd'))
  await chmod(pidDir, 0o000)
  const mountsWithHidepid = join(box.base, 'mounts-hidepid')
  const mountsPlain = join(box.base, 'mounts-plain')
  await writeFile(mountsWithHidepid, 'proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=2 0 0\n', 'utf8')
  await writeFile(mountsPlain, 'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n', 'utf8')
  try {
    assert.deepEqual(
      await cwdHolders(target, { procRoot: fakeProc, procMounts: mountsWithHidepid }),
      { unavailable: true, pids: [] },
      'hidepid plus an unreadable same-user pid keeps everything',
    )
    assert.deepEqual(
      await cwdHolders(target, { procRoot: fakeProc, procMounts: mountsPlain }),
      { unavailable: false, pids: [] },
      'without hidepid a dumpable=0 process is skipped',
    )
  } finally {
    await chmod(pidDir, 0o755)
  }
  assert.deepEqual(
    await cwdHolders(target, { procRoot: join(box.base, 'missing'), procMounts: mountsPlain }),
    { unavailable: true, pids: [] },
    'a missing /proc is unavailable, not empty',
  )
}

/** Without an upstream, the recorded origin/main fallback decides: on main reclaims, one ahead keeps. */
async function testNoUpstreamFallback() {
  const box = await sandbox()
  const onMain = await cloneTicket(box, 'kappa', '000000000001', 'main')
  gitIn(box, onMain, 'branch', '--unset-upstream')
  const ahead = await cloneTicket(box, 'lambda', '000000000002')
  gitIn(box, ahead, 'branch', '--unset-upstream')

  const summary = await reclaim(box)
  assert.equal(summary.reclaimed, 1, 'the clone exactly on origin/main is reclaimed')
  assert.equal(entryOf(summary, 'kappa-000000000001').action, 'reclaim')
  const kept = entryOf(summary, 'lambda-000000000002')
  assert.equal(kept.action, 'keep')
  assert.equal(kept.reason, '1 commit not pushed')
  await assert.rejects(readFile(join(onMain, '.git', 'HEAD')), { code: 'ENOENT' })
  assert.ok((await gitIn(box, ahead, 'rev-parse', 'HEAD')).length > 0)
}

/** The record names the remote the branch actually tracks, so a non-origin upstream still rebuilds. */
async function testNonOriginRemote() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'mu')
  const head = gitIn(box, dir, 'rev-parse', 'HEAD').trim()
  gitIn(box, dir, 'remote', 'rename', 'origin', 'fork')
  const empty = join(box.remotes, 'empty.git')
  git(box, ['init', '-q', '--bare', '-b', 'main', empty])
  gitIn(box, dir, 'remote', 'add', 'origin', 'https://github.com/testowner/empty.git')

  await reclaim(box)
  const lines = await records(box)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].remoteName, 'fork', 'the tracked remote name is recorded')
  assert.equal(lines[0].remote, 'https://github.com/testowner/mu.git', 'the tracked remote URL is recorded')

  const result = cli(box, ['work', 'restored', 'mu-0123456789ab'])
  assert.match(result.stdout, new RegExp(`git fetch origin 'agent/mu'`))
  execFileSync('sh', ['-c', result.stdout], {
    cwd: box.base,
    encoding: 'utf8',
    env: box.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.equal(gitIn(box, dir, 'rev-parse', 'HEAD').trim(), head, 'the fork clone is rebuilt at the recorded commit')
}

/** An unknown directory is reported, not reclaimed, even when it is old. */
async function testUnknownSurvives() {
  const box = await sandbox()
  const stray = join(box.work, 'state')
  await mkdir(stray, { recursive: true })
  await writeFile(join(stray, 'residue.txt'), 'not a ticket\n', 'utf8')
  await utimes(stray, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))

  const summary = await reclaim(box)
  const entry = entryOf(summary, 'state')
  assert.equal(summary.reclaimed, 0)
  assert.equal(summary.unknown, 1)
  assert.equal(entry.action, 'unknown')
  assert.match(entry.reason, /not a ticket clone: no \.git/)
  assert.ok((await readFile(join(stray, 'residue.txt'), 'utf8')).includes('not a ticket'))
}

/** The mount-only skip list keeps a clone an open ticket still owns. */
async function testOpenTicketSkipped() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'nu')
  const plan = await planWork({
    root: box.work,
    keep: 0,
    keepDays: 0,
    skipDirectories: new Set([dir]),
  })
  const entry = entryOf(plan, 'nu-0123456789ab')
  assert.equal(entry.action, 'keep')
  assert.equal(entry.reason, 'an open ticket still uses this directory')
  const summary = await reclaimWork({
    root: box.work,
    stateDir: box.state,
    keep: 0,
    keepDays: 0,
    skipDirectories: new Set([dir]),
  })
  assert.equal(summary.reclaimed, 0)
  assert.ok((await gitIn(box, dir, 'rev-parse', 'HEAD')).length > 0)
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
  assert.match(second.stdout, /^reclaimed 0, kept 2 \(1 unknown\)/m)
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
  assert.match(
    result.stdout,
    new RegExp(`git clone 'https://github\\.com/testowner/eta\\.git' '${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
  )
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
    await setAge(dir, 30 - index * 10)
    dirs.push(dir)
  }
  const summary = await reclaimWork({ root: box.work, stateDir: box.state, keep: 2 })
  assert.equal(summary.reclaimed, 1, 'only the clone below the floor is reclaimed')
  assert.equal(summary.kept, 2)
  assert.deepEqual(
    summary.entries.filter(entry => entry.action === 'keep').map(entry => entry.reason),
    ['among the newest 2 directories (--keep)', 'among the newest 2 directories (--keep)'],
  )
  assert.deepEqual((await records(box)).map(record => record.name), ['one-000000000001'])
  for (const dir of dirs.slice(1)) {
    assert.ok((await readFile(join(dir, '.git', 'HEAD'), 'utf8')).length > 0, `${dir} survives the floor`)
  }
}

/** Age retention is opt-in and two-sided: an old clone is reclaimed, a fresh one is kept. */
async function testAgeRetention() {
  const box = await sandbox()
  const fresh = await cloneTicket(box, 'iota')
  const old = await cloneTicket(box, 'kappa')
  await setAge(old, 30)
  const summary = await reclaimWork({ root: box.work, stateDir: box.state, keep: 0, keepDays: 7 })
  assert.equal(summary.reclaimed, 1, 'the old clone is reclaimed')
  const kept = entryOf(summary, 'iota-0123456789ab')
  assert.equal(kept.action, 'keep')
  assert.equal(kept.reason, 'modified less than 7 days ago (--keep-days)')
  await assert.rejects(readFile(join(old, '.git', 'HEAD')), { code: 'ENOENT' })
  assert.ok((await gitIn(box, fresh, 'rev-parse', 'HEAD')).length > 0)
}

/** A failed delete retracts the record written before it. */
async function testDeleteFailureRetracts() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return
  const box = await sandbox()
  await cloneTicket(box, 'xi')
  await chmod(box.work, 0o555)
  try {
    const summary = await reclaim(box)
    assert.equal(summary.reclaimed, 0)
    assert.match(entryOf(summary, 'xi-0123456789ab').reason, /^delete failed:/)
  } finally {
    await chmod(box.work, 0o755)
  }
  const lines = await records(box)
  assert.equal(lines.length, 2, 'the record and its retraction are both append-only')
  assert.equal(lines[1].retracted, true)
  await assert.rejects(
    readReclaimed({ stateDir: box.state, ticket: 'xi-0123456789ab' }),
    /no reclaim record/,
  )
}

/** `apply()` sweeps before setup, uses the CLI defaults, logs once, and only once per process. */
async function testMountApply() {
  const box = await sandbox()
  await makeRemote(box, 'theta')
  const dirs = []
  for (let index = 1; index <= 11; index += 1) {
    const dir = join(box.work, `theta-${String(index).padStart(12, '0')}`)
    git(box, ['clone', '-q', '--branch', 'agent/theta', 'https://github.com/testowner/theta.git', dir])
    await setAge(dir, 40 - index)
    dirs.push(dir)
  }
  const lines = []
  const effects = []
  const ctx = {
    effect: (fn, label) => effects.push({ fn, label }),
    // No `ready`, `configured()` or `deployment` on the plugin context: the early path must be used.
    orchestrator: {
      sources: { register: () => {} },
      context: () => ({ tickets: { open: () => [] } }),
      machine: { stateDir: box.state },
      settings: { current: () => ({ executor: { directory: box.work } }) },
    },
    logger: { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) },
  }
  apply(ctx)
  await waitFor(() => lines.length === 1, 'the mount summary line')
  assert.match(lines[0], /wheelchair-agent work gc: reclaimed 1, kept 10, freed [\d.]+ MB/)
  await assert.rejects(readFile(join(dirs[0], '.git', 'HEAD')), { code: 'ENOENT' }, 'the oldest clone is gone')
  assert.ok((await readFile(join(dirs[10], '.git', 'HEAD'), 'utf8')).length > 0, 'the newest 10 are kept')

  apply(ctx)
  await sleep(150)
  assert.equal(lines.length, 1, 'a hot remount does not sweep again')
  assert.ok(effects.length >= 2, 'the Source still registers its effects')
}

/** The fallback path waits on the orchestrator service, not on plugin-context members. */
async function testMountFallback() {
  const box = await sandbox()
  await cloneTicket(box, 'omicron')
  const lines = []
  const ctx = {
    // No `machine` and a settings store that is not ready: the fallback must use the orchestrator service.
    orchestrator: {
      ready: Promise.resolve(),
      configured: () => true,
      deployment: { stateDir: box.state },
      settings: { current: () => { throw new Error('store not ready') } },
    },
    logger: { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) },
  }
  await reclaimAtMount(ctx)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /reclaimed 0, kept 1/, 'the default floor keeps the only clone')
}

/** Root resolution and formatting helpers: documented defaults and overrides, and unsafe roots refused. */
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
    assert.throws(() => resolveWorkRoot({ stateDir: '/s', directory: 'relative' }), /absolute/)
    assert.throws(() => resolveWorkRoot({ stateDir: '/s', directory: '/' }), /refusing/)
    assert.throws(() => resolveWorkRoot({ stateDir: '/s', directory: homedir() }), /refusing/)
    assert.equal(KEEP_DAYS_DEFAULT, 0, 'no age retention by default')
    assert.equal(KEEP_DEFAULT, 10, 'the newest ten passing clones are a hard floor')
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(12 * 1024), '12.0 KB')
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
    assert.equal(megabytes(10 * 1024 * 1024), '10.0')
    assert.equal(shellQuote(`a'b`), `'a'\\''b'`)
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
  await testUnreadableProc()
  await testNoUpstreamFallback()
  await testNonOriginRemote()
  await testUnknownSurvives()
  await testOpenTicketSkipped()
  await testDryRun()
  await testRestored()
  await testKeepFloor()
  await testAgeRetention()
  await testDeleteFailureRetracts()
  await testMountFallback()
  await testMountApply()
  testHelpers()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true })
}
