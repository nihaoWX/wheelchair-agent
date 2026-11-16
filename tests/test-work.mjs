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
 *   - the shared open-ticket resolver keeps the clone of an open ticket (both `directory` and `execution.directory`)
 *     from the CLI and the mount hook; a directory-less queued ticket is skipped, an unusable one fails closed;
 *   - the tracked remote (not a hard-coded origin) is recorded, so `work restored` rebuilds a fork clone;
 *   - an unknown directory is reported and survives even when it is old;
 *   - `--dry-run` prints the plan and deletes nothing; a second run is a no-op;
 *   - the keep floor is opt-in (default 0), and `--keep-days` reclaims old clones while keeping fresh ones;
 *   - a failed delete retracts its record so `work restored` does not target a surviving directory;
 *   - `work restored` prints commands that actually rebuild the clone from the record;
 *   - the mount hook runs through `apply()` before setup, uses the same defaults, logs one summary line and only
 *     sweeps once; its fallback path uses the orchestrator service, not plugin-context members;
 *   - the mount pass prunes stale workspace rows with strict path/inside/exists guards, fails soft on a bad registry,
 *     and logs the summary plus one line per pruned path.
 *
 * Everything is offline: local bare repositories are exposed as `https://github.com/testowner/<name>` through
 * `url.<local-bare>.insteadOf` in a throwaway GIT_CONFIG_GLOBAL, so no credential or network is involved.
 *
 * Usage: node tests/test-work.mjs
 * Exit status: 0 when every assertion passes, 1 otherwise.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
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
  openTicketDirectories,
  planWork,
  pruneStaleWorkspaces,
  readReclaimed,
  reclaimWork,
  resolveWorkRoot,
  restoreCommands,
  shellQuote,
} from '../src/shared/work.js'
import { fetchOpenTickets } from '../src/spv/health.js'
import {
  apply,
  openTicketDirectories as watchOpenTicketDirectories,
  reclaimAtMount,
} from '../src/superagent/watch.js'

const CLI = fileURLToPath(new URL('../bin/wheelchair-agent.mjs', import.meta.url))
const SANDBOXES = []
const SERVERS = []

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
    root: join(base, 'data'),
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
    WHEELCHAIR_AGENT_HOME: box.root,
    GIT_CONFIG_GLOBAL: box.config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Deterministic default for CLI cases: an unreachable management API means "nothing can be working".
    SPV_SUPERAGENT_URL: 'http://127.0.0.1:1',
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

/** Run the CLI synchronously; used when no in-process server must answer during the run. */
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

/**
 * Run the CLI without blocking the test's event loop, so a fake HTTP server in this process can answer it.
 * Mirrors `cli()`'s environment and failure check.
 */
function cliAsync(box, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd ?? box.base,
      env: { ...box.env, DSH_SUPERAGENT_STATE_DIR: box.state, ...(options.env ?? {}) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => {
      if (options.expectFailure !== true) {
        assert.equal(status, 0, `wheelchair-agent ${args.join(' ')} failed: ${stderr || stdout}`)
      }
      resolve({ status, stdout, stderr })
    })
  })
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
    const text = await readFile(join(box.root, 'records', RECLAIMED_FILE), 'utf8')
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** Fake management API for open tickets; returns its base URL. The caller closes it via SERVERS. */
async function serveTickets({ body, status = 200, onRequest } = {}) {
  const server = createServer((req, res) => {
    if (onRequest?.(req, res) === true) return
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(body)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  SERVERS.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

/** Plan/delete through the library entry point, with the retention cushions disabled for the case under test. */
function reclaim(box, overrides = {}) {
  return reclaimWork({ root: box.work, home: box.root, stateDir: box.state, keep: 0, keepDays: 0, ...overrides })
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

/** The shared open-ticket resolver is the same export in the mount hook, and reads both ticket shapes. */
async function testSharedOpenTickets() {
  assert.equal(watchOpenTicketDirectories, openTicketDirectories, 'the mount hook re-exports the shared resolver')
  const directories = await openTicketDirectories(async () => ({
    tickets: [
      { id: 'ticket-api', directory: '/work/api-0123456789ab' },
      { id: 'ticket-domain', execution: { directory: '/work/domain-0123456789ab' } },
    ],
  }))
  assert.equal(directories.ok, true)
  assert.deepEqual([...directories.directories], [
    ['/work/api-0123456789ab', 'ticket-api'],
    ['/work/domain-0123456789ab', 'ticket-domain'],
  ])
  assert.deepEqual(await openTicketDirectories(async () => ({ down: true, reason: 'nothing is listening' })), {
    ok: false,
    down: true,
    reason: 'nothing is listening',
  })
  const queued = await openTicketDirectories(async () => ({
    tickets: [{ id: 'queued' }, { id: 'ticket-api', directory: '/work/api-0123456789ab' }],
  }))
  assert.equal(queued.ok, true, 'a queued ticket without an execution owns no clone')
  assert.deepEqual([...queued.directories], [['/work/api-0123456789ab', 'ticket-api']])
  const invalid = await openTicketDirectories(async () => ({ tickets: [{ id: 'bad', directory: 42 }] }))
  assert.equal(invalid.ok, false)
  assert.match(invalid.reason, /unusable execution\.directory/)
  const notObject = await openTicketDirectories(async () => ({ tickets: [null] }))
  assert.equal(notObject.ok, false)
  const thrown = await openTicketDirectories(async () => { throw new Error('boom') })
  assert.equal(thrown.ok, false)
  assert.match(thrown.reason, /boom/)
}

/** A directory an open ticket owns is kept, with a reason naming that ticket, even when it is newest. */
async function testOpenTicketSkipped() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'nu')
  const skipDirectories = new Map([[dir, 'ticket-open-1']])
  const plan = await planWork({ root: box.work, keep: 0, keepDays: 0, skipDirectories })
  const entry = entryOf(plan, 'nu-0123456789ab')
  assert.equal(entry.action, 'keep')
  assert.equal(entry.reason, 'open ticket ticket-open-1 is using this directory')
  const summary = await reclaimWork({
    root: box.work,
    stateDir: box.state,
    keep: 0,
    keepDays: 0,
    skipDirectories,
  })
  assert.equal(summary.reclaimed, 0)
  assert.ok((await gitIn(box, dir, 'rev-parse', 'HEAD')).length > 0)
}

/** The CLI reads the tickets endpoint; a directory it lists is kept and the response shape is validated. */
async function testCliOpenTicketSkip() {
  const box = await sandbox()
  await cloneTicket(box, 'free')
  // Created second, so the open ticket's clone is the newest directory and still must be kept.
  const open = await cloneTicket(box, 'open')
  let seen
  const url = await serveTickets({
    body: JSON.stringify({ items: [{ id: 'ticket-open-1', title: 'active work', directory: open }] }),
    onRequest: req => { seen = req },
  })
  const result = await cliAsync(box, ['work', 'gc', '--dry-run'], { env: { SPV_SUPERAGENT_URL: url } })
  assert.equal(seen.url, '/orchestrator/api/tickets?state=open')
  assert.equal(seen.headers['x-orchestrator-request'], '1')
  assert.match(result.stdout, /open tickets: 1 directory\(s\) in use/)
  assert.match(result.stdout, /keep\s+[\d.]+ [KMG]?B\s+open-0123456789ab \(open ticket ticket-open-1 is using this directory\)/)
  assert.match(result.stdout, /would reclaim 1, kept 1/)
  assert.ok((await stat(open)).mtimeMs >= (await stat(box.work + '/free-0123456789ab')).mtimeMs, 'the open clone is newest')
  assert.ok((await gitIn(box, open, 'rev-parse', 'HEAD')).length > 0, 'the open ticket clone survives')
}

/** Service down is not a malformed answer: nothing can be working, so the newest clone is reclaimed by default. */
async function testCliServiceDownAndDefault() {
  const box = await sandbox()
  const newest = await cloneTicket(box, 'newest')
  await setAge(newest, 0)
  const dry = cli(box, ['work', 'gc', '--dry-run'])
  assert.match(dry.stdout, /open-ticket check skipped: nothing is listening on http:\/\/127\.0\.0\.1:1/)
  assert.match(dry.stdout, /would reclaim 1, kept 0/)
  const live = cli(box, ['work', 'gc'])
  assert.match(live.stdout, /^reclaimed 1, kept 0/m, '--keep defaults to 0, so the newest passing clone goes')
  await assert.rejects(readFile(join(newest, '.git', 'HEAD')), { code: 'ENOENT' })
}

/** A response that aborts mid-body settles as an error instead of leaving the CLI hung or silent. */
async function testCliAbortedTickets() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'abort')
  const url = await serveTickets({
    body: '',
    onRequest: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"items":[')
      res.socket?.destroy()
      return true
    },
  })
  // serveTickets ends the response too; the raw fetch must already have settled with an error.
  const direct = await fetchOpenTickets(url, 500)
  assert.equal(direct.tickets, undefined)
  assert.match(String(direct.error), /aborted|closed|failed|items/)
  const result = await cliAsync(box, ['work', 'gc', '--dry-run'], {
    env: { SPV_SUPERAGENT_URL: url },
    expectFailure: true,
  })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /cannot read open tickets/)
  assert.match(result.stdout, /would reclaim 0, kept 1/)
  assert.ok((await gitIn(box, dir, 'rev-parse', 'HEAD')).length > 0)
}

/** A 2xx answer without the expected shape keeps everything and says so (nonzero exit). */
async function testCliMalformedTickets() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'guard')
  const url = await serveTickets({ body: JSON.stringify({ items: 'not-a-list' }) })
  const result = await cliAsync(box, ['work', 'gc', '--dry-run'], {
    env: { SPV_SUPERAGENT_URL: url },
    expectFailure: true,
  })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /cannot read open tickets: the response has no items list; keeping everything/)
  assert.match(result.stdout, /would reclaim 0, kept 1/)
  assert.ok((await gitIn(box, dir, 'rev-parse', 'HEAD')).length > 0, 'nothing is reclaimed on an invalid answer')
  assert.deepEqual(await records(box), [])

  // The real delete path, not only the dry run, must keep everything when the answer is unusable.
  const live = await cliAsync(box, ['work', 'gc'], { env: { SPV_SUPERAGENT_URL: url }, expectFailure: true })
  assert.equal(live.status, 1)
  assert.match(live.stdout, /reclaimed 0, kept 1/)
  assert.ok((await gitIn(box, dir, 'rev-parse', 'HEAD')).length > 0, 'the live run kept the clone')
  assert.deepEqual(await records(box), [])

  // A direct blocked run is the same guard without the CLI.
  const blocked = await reclaimWork({
    root: box.work,
    stateDir: box.state,
    keep: 0,
    keepDays: 0,
    blockedReason: 'cannot read open tickets: test',
  })
  assert.equal(blocked.reclaimed, 0)
  assert.equal(blocked.entries.find(entry => entry.name === 'guard-0123456789ab').reason, 'cannot read open tickets: test')
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
  const restored = await readReclaimed({ home: box.root, stateDir: box.state, ticket: 'eta-0123456789ab' })
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
  const dry = cli(box, ['work', 'gc', '--dry-run', '--keep', '2'])
  assert.match(dry.stdout, /would reclaim 1, kept 2/, '--keep 2 still protects the newest two when asked')
  const summary = await reclaimWork({ root: box.work, home: box.root, stateDir: box.state, keep: 2 })
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
  const summary = await reclaimWork({ root: box.work, home: box.root, stateDir: box.state, keep: 0, keepDays: 7 })
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
    readReclaimed({ home: box.root, stateDir: box.state, ticket: 'xi-0123456789ab' }),
    /no reclaim record/,
  )
}

/** `apply()` sweeps before setup, uses the CLI defaults, logs once, and only once per process. */
async function testMountApply() {
  const box = await sandbox()
  // `apply()` is the real plugin entry and resolves the data root from the environment; pin it to the
  // sandbox so this in-process sweep cannot write into the operator's ~/.wheelchair-agent.
  const savedHome = process.env.HOME
  const savedDataHome = process.env.WHEELCHAIR_AGENT_HOME
  const savedStateDir = process.env.DSH_SUPERAGENT_STATE_DIR
  process.env.HOME = box.home
  process.env.WHEELCHAIR_AGENT_HOME = box.root
  process.env.DSH_SUPERAGENT_STATE_DIR = box.state
  try {
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
    const openTicket = { id: 'ticket-open-1', title: 'active', execution: { directory: dirs[10] } }
    const registryCalls = []
    const ctx = {
      effect: (fn, label) => effects.push({ fn, label }),
      workspaceRegistry: {
        list: () => [{ id: 'w-apply', path: dirs[0] }],
        delete: async id => { registryCalls.push(id); return true },
      },
      // No `ready`, `configured()` or `deployment` on the plugin context: the early path must be used.
      orchestrator: {
        sources: { register: () => {} },
        context: () => ({ tickets: { open: () => [openTicket] } }),
        machine: { stateDir: box.state },
        settings: { current: () => ({ executor: { directory: box.work } }) },
      },
      logger: { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) },
    }
    apply(ctx)
    await waitFor(() => lines.some(line => line.includes('reclaimed')), 'the mount summary line')
    const summaryLine = lines.find(line => line.includes('reclaimed'))
    assert.match(summaryLine, /wheelchair-agent work gc: reclaimed 10 clones, pruned 1 workspaces, freed [\d.]+ MB/)
    assert.deepEqual(registryCalls, ['w-apply'], 'apply() reads ctx.workspaceRegistry and prunes the reclaimed row')
    assert.ok(lines.some(line => line.includes(`pruned workspace ${dirs[0]}`)))
    for (const dir of dirs.slice(0, 10)) {
      await assert.rejects(readFile(join(dir, '.git', 'HEAD')), { code: 'ENOENT' }, `${dir} is reclaimed`)
    }
    assert.ok((await readFile(join(dirs[10], '.git', 'HEAD'), 'utf8')).length > 0, 'the open ticket clone is kept')

    const firstCount = lines.length
    apply(ctx)
    await sleep(150)
    assert.equal(lines.length, firstCount, 'a hot remount does not sweep again')
    assert.ok(effects.length >= 2, 'the Source still registers its effects')
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedDataHome === undefined) delete process.env.WHEELCHAIR_AGENT_HOME
    else process.env.WHEELCHAIR_AGENT_HOME = savedDataHome
    if (savedStateDir === undefined) delete process.env.DSH_SUPERAGENT_STATE_DIR
    else process.env.DSH_SUPERAGENT_STATE_DIR = savedStateDir
  }
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
  await reclaimAtMount(ctx, { home: box.root,
    openTickets: async () => ({ tickets: [] }),
    workspaceRegistry: registryOf([]).registry,
  })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /reclaimed 1 clones, pruned 0 workspaces, freed [\d.]+ MB/, 'with no floor the only passing clone goes')
}

/** A fake workspace registry: a record list plus a delete spy. */
function registryOf(records, { listThrows, nonArray } = {}) {
  const calls = []
  return {
    calls,
    registry: {
      list: () => {
        if (listThrows !== undefined) throw new Error(listThrows)
        return nonArray === true ? {} : records
      },
      delete: async id => {
        calls.push(id)
        return true
      },
    },
  }
}

/** Only a missing child of the work root is pruned; an existing dir, the root itself and outside paths are not. */
async function testPruneWorkspaces() {
  const box = await sandbox()
  const gone = join(box.work, 'gone-0123456789ab')
  const kept = join(box.work, 'kept-0123456789ab')
  await mkdir(kept, { recursive: true })
  const filePath = join(box.work, 'file-0123456789ab')
  await writeFile(filePath, 'not a directory\n', 'utf8')
  const { registry, calls } = registryOf([
    { id: 'w-gone', path: gone },
    { id: 'w-kept', path: kept },
    { id: 'w-file', path: filePath },
    { id: 'w-outside', path: join(box.base, 'outside-home') },
    { id: 'w-root', path: box.work },
    { id: 'w-relative', path: 'relative-0123456789ab' },
    { id: 'w-empty', path: '' },
    { id: 'w-shape', title: 'no path or id' },
  ])
  const result = await pruneStaleWorkspaces({ registry, root: box.work })
  assert.deepEqual(result.pruned.map(item => item.id), ['w-gone', 'w-file'])
  assert.equal(result.pruned[0].path, gone)
  assert.deepEqual(
    calls,
    ['w-gone', 'w-file'],
    'the registry is never asked to delete an outside, existing, relative or empty path',
  )
}

/** A missing, throwing or malformed registry keeps everything and never throws; one failed delete does not stop the rest. */
async function testPruneFailSoft() {
  const box = await sandbox()
  assert.deepEqual(await pruneStaleWorkspaces({ registry: undefined, root: box.work }), {
    pruned: [],
    skipped: 'no workspace registry',
  })
  const throwing = registryOf([], { listThrows: 'boom' })
  const failed = await pruneStaleWorkspaces({ registry: throwing.registry, root: box.work })
  assert.deepEqual(failed.pruned, [])
  assert.match(failed.error, /boom/)
  const malformed = registryOf([], { nonArray: true })
  const wrong = await pruneStaleWorkspaces({ registry: malformed.registry, root: box.work })
  assert.deepEqual(wrong.pruned, [])
  assert.match(wrong.error, /not an array/)

  const calls = []
  const registry = {
    list: () => [
      { id: 'w-throws', path: join(box.work, 'throws-0123456789ab') },
      { id: 'w-ok', path: join(box.work, 'ok-0123456789ab') },
    ],
    delete: async id => {
      calls.push(id)
      if (id === 'w-throws') throw new Error('delete failed')
      return true
    },
  }
  const partial = await pruneStaleWorkspaces({ registry, root: box.work })
  assert.deepEqual(partial.pruned.map(item => item.id), ['w-ok'])
  assert.deepEqual(calls, ['w-throws', 'w-ok'], 'a failed delete does not stop the other records')

  const refusedCalls = []
  const refused = {
    list: () => [{ id: 'w-refused', path: join(box.work, 'refused-0123456789ab') }],
    delete: async id => {
      refusedCalls.push(id)
      return false
    },
  }
  const notPruned = await pruneStaleWorkspaces({ registry: refused, root: box.work })
  assert.deepEqual(notPruned.pruned, [], 'a false delete result is not counted as pruned')
  assert.deepEqual(refusedCalls, ['w-refused'])

  const getterThrows = {}
  Object.defineProperty(getterThrows, 'list', { get() { throw new Error('getter') } })
  Object.defineProperty(getterThrows, 'delete', { value: async () => true })
  const getterResult = await pruneStaleWorkspaces({ registry: getterThrows, root: box.work })
  assert.deepEqual(getterResult.pruned, [])
  assert.match(getterResult.error, /could not be read/)
}

/** A symlinked work root is skipped rather than widening the canonical child guard. */
async function testPruneSymlinkRoot() {
  const box = await sandbox()
  const real = join(box.base, 'real-root')
  await mkdir(real, { recursive: true })
  const link = join(box.base, 'link-root')
  await symlink(real, link)
  const { registry, calls } = registryOf([{ id: 'w-link', path: join(real, 'gone-0123456789ab') }])
  const result = await pruneStaleWorkspaces({ registry, root: link })
  assert.deepEqual(result.pruned, [])
  assert.match(result.skipped, /symlink/)
  assert.deepEqual(calls, [])
}

/** The mount pass waits for the asynchronously-initialized registry instead of reading it once in apply(). */
async function testPruneRegistryAcquiredLate() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'late')
  const calls = []
  const registry = {
    list: () => [{ id: 'w-late', path: dir }],
    delete: async id => {
      calls.push(id)
      return true
    },
  }
  let looks = 0
  const lines = []
  const ctx = {
    get: name => {
      if (name !== 'workspaceRegistry') return undefined
      looks += 1
      return looks > 2 ? registry : undefined
    },
    orchestrator: {
      machine: { stateDir: box.state },
      settings: { current: () => ({ executor: { directory: box.work } }) },
    },
    logger: { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) },
  }
  await reclaimAtMount(ctx, { home: box.root, openTickets: async () => ({ tickets: [] }) })
  assert.ok(looks >= 3, 'the pass retried the lazy lookup instead of taking the first undefined')
  assert.deepEqual(calls, ['w-late'])
  assert.ok(lines.some(line => line.includes(`pruned workspace ${dir}`)))
  assert.ok(lines.some(line => /reclaimed 1 clones, pruned 1 workspaces/.test(line)))
}

/** The prune runs after the clone pass, so a clone reclaimed now has its row removed in the same pass. */
async function testPruneAfterReclaim() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'prune')
  const { registry, calls } = registryOf([{ id: 'w-prune', path: dir }])
  const lines = []
  const ctx = {
    orchestrator: {
      machine: { stateDir: box.state },
      settings: { current: () => ({ executor: { directory: box.work } }) },
    },
    logger: { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) },
  }
  await reclaimAtMount(ctx, { home: box.root, openTickets: async () => ({ tickets: [] }), workspaceRegistry: registry })
  await assert.rejects(readFile(join(dir, '.git', 'HEAD')), { code: 'ENOENT' }, 'the clone is reclaimed')
  assert.deepEqual(calls, ['w-prune'], 'the row of the clone reclaimed in this pass is pruned')
  assert.ok(lines.some(line => line.includes(`pruned workspace ${dir}`)), 'one line per pruned path')
  const summary = lines.find(line => line.includes('reclaimed'))
  assert.match(summary, /reclaimed 1 clones, pruned 1 workspaces, freed [\d.]+ MB/)
}

/** A bad registry does not disturb the mount path, and the clone pass still completes. */
async function testPruneDoesNotBreakMount() {
  const cases = [
    ['missing', null],
    ['throwing', { list: () => { throw new Error('boom') }, delete: async () => true }],
    ['non-array', { list: () => ({}), delete: async () => true }],
  ]
  for (const [label, registry] of cases) {
    const box = await sandbox()
    const dir = await cloneTicket(box, 'soft')
    const lines = []
    const ctx = {
      orchestrator: {
        machine: { stateDir: box.state },
        settings: { current: () => ({ executor: { directory: box.work } }) },
      },
      logger: { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) },
    }
    await reclaimAtMount(ctx, { home: box.root, openTickets: async () => ({ tickets: [] }), workspaceRegistry: registry })
    await assert.rejects(readFile(join(dir, '.git', 'HEAD')), { code: 'ENOENT' }, `${label}: the clone pass completes`)
    assert.ok(
      lines.some(line => /reclaimed 1 clones, pruned 0 workspaces/.test(line)),
      `${label}: the summary still reports zero prunes`,
    )
    assert.ok(lines.some(line => line.includes('workspace prune skipped')), `${label}: the skip is logged`)
  }
}

/** At mount, a provider that throws is fail-closed and does not escape the mount path. */
async function testMountProviderThrows() {
  const box = await sandbox()
  const dir = await cloneTicket(box, 'guard')
  const lines = []
  const ctx = {
    orchestrator: {
      machine: { stateDir: box.state },
      settings: { current: () => ({ executor: { directory: box.work } }) },
    },
    logger: { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) },
  }
  await reclaimAtMount(ctx, { home: box.root,
    openTickets: async () => { throw new Error('boom') },
    workspaceRegistry: registryOf([]).registry,
  })
  assert.ok((await gitIn(box, dir, 'rev-parse', 'HEAD')).length > 0, 'the clone is kept')
  assert.ok(lines.some(line => line.includes('cannot read open tickets: boom; keeping everything')))
  assert.ok(lines.some(line => /reclaimed 0 clones, pruned 0 workspaces/.test(line)))
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
    assert.equal(KEEP_DEFAULT, 0, 'no count floor by default')
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
  await testSharedOpenTickets()
  await testOpenTicketSkipped()
  await testCliOpenTicketSkip()
  await testCliServiceDownAndDefault()
  await testCliAbortedTickets()
  await testCliMalformedTickets()
  await testDryRun()
  await testRestored()
  await testKeepFloor()
  await testAgeRetention()
  await testDeleteFailureRetracts()
  await testMountFallback()
  await testMountProviderThrows()
  await testPruneWorkspaces()
  await testPruneFailSoft()
  await testPruneSymlinkRoot()
  await testPruneRegistryAcquiredLate()
  await testPruneAfterReclaim()
  await testPruneDoesNotBreakMount()
  await testMountApply()
  testHelpers()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const server of SERVERS) {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true })
}
