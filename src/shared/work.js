/**
 * Reclaiming work-ticket clones and recording how to rebuild them.
 *
 * dsh-superagent creates one directory per Ticket under its execution root
 * (`settings.executor.directory`, default `<stateDir>/work`). A directory is a *reproducible duplicate* only when three
 * runtime facts hold: nothing has its cwd inside it, the working tree is clean, and every commit is already on a
 * remote. This module owns that gate, the JSONL record written before a delete, and the `work restored` rendering.
 *
 * The module is shared by two programs on purpose (`ARCHITECTURE/layout.md` rule 1):
 *   - the CLI (`bin/wheelchair-agent.mjs` command `work`) is the operator's manual tool;
 *   - the `spv` Source plugin (`src/superagent/watch.js`) runs the same code once at mount, before workers start.
 * It lives in `src/shared/` because both programs may import that tree, and for no other reason.
 *
 * Nothing here reads or writes dsh-superagent's database. The record file is our own:
 *   `<stateDir>/work-reclaimed.jsonl`, one JSON object per reclaimed directory.
 */
import { spawnSync } from 'node:child_process'
import { appendFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/** Name of the append-only rebuild record inside the deployment's state directory. */
export const RECLAIMED_FILE = 'work-reclaimed.jsonl'

/** No age retention by default: the reconstructibility gate, not age, is what makes a delete safe. */
export const KEEP_DAYS_DEFAULT = 0

/**
 * Hard floor: the newest N directories that pass the gate are kept regardless of age. A recent ticket's worker
 * session still remembers its old commit, while re-preparing it clones the current `main`, so a few newest clones are
 * worth keeping for a while.
 */
export const KEEP_DEFAULT = 10

/** A Ticket directory is `<short name>-<hex>`; `state/` and other residue must not match. */
const TICKET_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*-[0-9a-f]{8,64}$/

/** Absolute milliseconds in one day, used by the `--keep-days` window. */
const DAY_MS = 86_400_000

/**
 * Work root of the deployment: the configured executor directory, else `$DSH_SUPERAGENT_WORK_DIR`, else
 * `<stateDir>/work`.
 *
 * The CLI cannot read dsh-superagent's panel settings, so the environment variable is the documented bridge for a
 * deployment that moved `executor.directory`; the mount hook passes the real setting directly.
 */
export function resolveWorkRoot({ stateDir, directory = '', env = process.env }) {
  const configured = String(directory ?? '').trim()
  if (configured) return configured
  const fromEnv = String(env.DSH_SUPERAGENT_WORK_DIR ?? '').trim()
  if (fromEnv) return fromEnv
  return join(stateDir, 'work')
}

/** Another program's terminal-friendly size: bytes under 1 KB stay exact, then one decimal place. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

/** A size in decimal megabytes with one decimal place, for the mount log line. */
export function megabytes(bytes) {
  return (Number(bytes || 0) / 1_000_000).toFixed(1)
}

/** Quote one value for a POSIX shell. The rebuild commands are meant to be pasted, so this matters. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// ------------------------------------------------------------------ the gate

/**
 * Processes whose cwd is `path` (or below it). `readlink /proc/<pid>/cwd` follows the kernel's symlink, which is
 * exactly the runtime fact the gate wants: a live process cannot be inferred from ticket state.
 *
 * A kernel without `/proc` returns `unavailable`; callers keep the directory, because "cannot prove unused" must not
 * be treated as unused.
 */
export async function cwdHolders(path, { procRoot = '/proc' } = {}) {
  const target = await realpath(path).catch(() => resolve(path))
  let names
  try {
    names = await readdir(procRoot)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { unavailable: true, pids: [] }
    throw error
  }
  const pids = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    let cwd
    try {
      cwd = await readlink(join(procRoot, name, 'cwd'))
    } catch {
      // A process that exited between readdir and readlink, or one we may not inspect: skip it.
      continue
    }
    const current = cwd.endsWith(' (deleted)') ? cwd.slice(0, -' (deleted)'.length) : cwd
    if (current === target || current.startsWith(`${target}${sep}`)) pids.push(Number(name))
  }
  return { unavailable: false, pids: pids.sort((a, b) => a - b) }
}

/** One process that holds a directory: the message the operator reads. */
function cwdReason(pids) {
  return `cwd in use by pid ${pids[0]}`
}

/** Run git in `path` with no terminal or optional locks; returns its status and output. */
function git(path, args) {
  const result = spawnSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
  return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' }
}

/** One porcelain line count, split into untracked and tracked changes for a readable reason. */
function dirtyReason(porcelain) {
  let untracked = 0
  let modified = 0
  for (const line of porcelain.split('\n')) {
    if (line.trim() === '') continue
    if (line.startsWith('?? ')) untracked += 1
    else modified += 1
  }
  const parts = []
  if (untracked > 0) parts.push(`${untracked} untracked path${untracked === 1 ? '' : 's'}`)
  if (modified > 0) parts.push(`${modified} modified path${modified === 1 ? '' : 's'}`)
  return parts.length > 0 ? parts.join(', ') : 'working tree not clean'
}

/** The unpushed commit count, or an error reason when the comparison itself cannot run. */
function unpublishedReason(path) {
  const upstream = git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (upstream.ok && upstream.out.trim() !== '') {
    const count = git(path, ['rev-list', '--count', `${upstream.out.trim()}..HEAD`])
    if (!count.ok) return { reason: `cannot compare HEAD with ${upstream.out.trim()}` }
    const commits = Number(count.out.trim())
    if (commits > 0) return { reason: `${commits} commit${commits === 1 ? '' : 's'} not pushed` }
    return { upstream: upstream.out.trim() }
  }
  const originMain = git(path, ['rev-parse', 'origin/main'])
  if (!originMain.ok) return { reason: 'no upstream and no origin/main to compare' }
  const count = git(path, ['rev-list', '--count', 'origin/main..HEAD'])
  if (!count.ok) return { reason: 'cannot compare HEAD with origin/main' }
  const commits = Number(count.out.trim())
  if (commits > 0) return { reason: `${commits} commit${commits === 1 ? '' : 's'} not pushed` }
  return { upstream: null }
}

/**
 * Inspect one ticket-shaped directory. `{ ok: true, record }` means the reconstructibility gate passed and the record
 * fields were captured; `{ ok: false, reason }` means it must be kept.
 */
async function inspectClone(path) {
  const holders = await cwdHolders(path)
  if (holders.unavailable) return { ok: false, reason: 'cannot scan /proc to prove nothing is using it' }
  if (holders.pids.length > 0) return { ok: false, reason: cwdReason(holders.pids) }

  const status = git(path, ['status', '--porcelain'])
  if (!status.ok) return { ok: false, reason: `git status failed: ${firstLine(status.err) || 'unknown error'}` }
  if (status.out.trim() !== '') return { ok: false, reason: dirtyReason(status.out) }

  const remotes = git(path, ['remote'])
  if (!remotes.ok) return { ok: false, reason: `git remote failed: ${firstLine(remotes.err) || 'unknown error'}` }
  const names = remotes.out.split('\n').map(name => name.trim()).filter(Boolean)
  if (names.length === 0) return { ok: false, reason: 'no remote (the clone is the only copy)' }

  const pushed = unpublishedReason(path)
  if (pushed.reason) return { ok: false, reason: pushed.reason }

  const head = git(path, ['rev-parse', 'HEAD'])
  const branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const originMain = git(path, ['rev-parse', 'origin/main'])
  const remoteName = names.includes('origin') ? 'origin' : names[0]
  const remoteUrl = git(path, ['remote', 'get-url', remoteName])
  if (!head.ok || !remoteUrl.ok) {
    return { ok: false, reason: `cannot read HEAD or the ${remoteName} remote URL` }
  }
  const branchName = branch.ok ? branch.out.trim() : ''
  return {
    ok: true,
    record: {
      name: path.slice(path.lastIndexOf(sep) + 1),
      path,
      head: head.out.trim(),
      originMain: originMain.ok ? originMain.out.trim() : null,
      branch: branchName === '' || branchName === 'HEAD' ? null : branchName,
      upstream: pushed.upstream,
      remote: remoteUrl.out.trim(),
    },
  }
}

/** First non-empty line of git stderr, for a one-line reason. */
function firstLine(text) {
  return String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? ''
}

// ------------------------------------------------------------------ planning

/** Total size of one entry without following symlinks; an unreadable subtree is reported, not fatal. */
async function sizeOf(path) {
  let info
  try {
    info = await lstat(path)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size
  let total = 0
  let names
  try {
    names = await readdir(path)
  } catch {
    return 0
  }
  for (const name of names) total += await sizeOf(join(path, name))
  return total
}

/**
 * Build the plan: every direct child of `root`, its size, and either `reclaim` or the reason it is kept.
 *
 * Unknown entries (no `.git`, or a name that is not `<name>-<hex>`, or a plain file) are never reclaimed. `--keep`
 * and `--keep-days` only delay an otherwise passing entry; they never override a failed gate.
 */
export async function planWork({ root, keep = KEEP_DEFAULT, keepDays = KEEP_DAYS_DEFAULT, now = Date.now() }) {
  const entries = []
  let children = []
  try {
    children = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  children.sort((a, b) => a.name.localeCompare(b.name))

  for (const child of children) {
    const path = join(root, child.name)
    const bytes = await sizeOf(path)
    const base = { name: child.name, path, bytes }
    if (!child.isDirectory()) {
      entries.push({ ...base, action: 'unknown', reason: 'not a directory' })
      continue
    }
    let hasGit
    try {
      await lstat(join(path, '.git'))
      hasGit = true
    } catch {
      hasGit = false
    }
    if (!hasGit) {
      entries.push({ ...base, action: 'unknown', reason: 'not a ticket clone: no .git' })
      continue
    }
    if (!TICKET_DIR.test(child.name)) {
      entries.push({ ...base, action: 'unknown', reason: 'not a ticket clone: name is not <name>-<hex>' })
      continue
    }
    const inspected = await inspectClone(path)
    if (!inspected.ok) {
      entries.push({ ...base, action: 'keep', reason: inspected.reason })
      continue
    }
    entries.push({
      ...base,
      action: 'reclaim',
      mtimeMs: (await stat(path)).mtimeMs,
      record: {
        version: 1,
        ...inspected.record,
        bytes,
        when: new Date(now).toISOString(),
      },
    })
  }

  // The recency cushions only decide *when* a passing entry is eligible. Sort the passing entries newest first so
  // `--keep N` is stable regardless of readdir order.
  const passing = entries.filter(entry => entry.action === 'reclaim')
  passing.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
  for (let index = 0; index < passing.length; index += 1) {
    if (index < keep) passing[index].reason = `among the newest ${keep} directories (--keep)`
    else if (keepDays > 0 && now - passing[index].mtimeMs < keepDays * DAY_MS) {
      passing[index].reason = `modified less than ${keepDays} days ago (--keep-days)`
    }
    if (passing[index].reason !== undefined) passing[index].action = 'keep'
  }
  const reclaimable = entries.filter(entry => entry.action === 'reclaim')
  return {
    root,
    entries,
    reclaimable: reclaimable.length,
    reclaimableBytes: reclaimable.reduce((total, entry) => total + entry.bytes, 0),
    kept: entries.length - reclaimable.length,
    unknown: entries.filter(entry => entry.action === 'unknown').length,
  }
}

// ------------------------------------------------------------------ reclaim

/**
 * Plan and (unless `dryRun`) reclaim. The record line is appended **before** the delete: if the write fails, the
 * directory stays, so no reclaimed directory can be missing from the record. A cwd recheck happens immediately before
 * each delete as well, closing the window between planning and removal.
 */
export async function reclaimWork({
  root,
  stateDir,
  keep = KEEP_DEFAULT,
  keepDays = KEEP_DAYS_DEFAULT,
  dryRun = false,
  now = Date.now(),
}) {
  const plan = await planWork({ root, keep, keepDays, now })
  if (dryRun) {
    return {
      root,
      dryRun: true,
      entries: plan.entries,
      reclaimed: plan.reclaimable,
      kept: plan.kept,
      unknown: plan.unknown,
      freedBytes: plan.reclaimableBytes,
    }
  }

  const file = join(stateDir, RECLAIMED_FILE)
  let reclaimed = 0
  let freedBytes = 0
  for (const entry of plan.entries) {
    if (entry.action !== 'reclaim') continue
    // The plan is a snapshot; a worker could have started since. Re-check the runtime fact, not the ticket state.
    const holders = await cwdHolders(entry.path)
    if (holders.unavailable || holders.pids.length > 0) {
      entry.action = 'keep'
      entry.reason = holders.unavailable ? 'cannot scan /proc to prove nothing is using it' : cwdReason(holders.pids)
      continue
    }
    try {
      await mkdir(stateDir, { recursive: true })
      await appendFile(file, `${JSON.stringify(entry.record)}\n`, 'utf8')
    } catch (error) {
      entry.action = 'keep'
      entry.reason = `cannot write the reclaim record: ${error.code ?? error.message}`
      continue
    }
    try {
      await rm(entry.path, { recursive: true, force: false })
    } catch (error) {
      entry.action = 'keep'
      entry.reason = `delete failed: ${error.code ?? error.message}`
      continue
    }
    reclaimed += 1
    freedBytes += entry.bytes
  }
  return {
    root,
    dryRun: false,
    entries: plan.entries,
    reclaimed,
    kept: plan.entries.length - reclaimed,
    unknown: plan.unknown,
    freedBytes,
  }
}

// ------------------------------------------------------------------ restore

/** The last record for `ticket`, or an error that names the exact file that was searched. */
export async function readReclaimed({ stateDir, ticket }) {
  const file = join(stateDir, RECLAIMED_FILE)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`no reclaim record at ${file}`)
    throw error
  }
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A truncated final line from a crash is skipped rather than hiding earlier records.
    }
  }
  const matches = records.filter(record => record?.name === ticket)
  if (matches.length === 0) throw new Error(`no reclaim record for ${ticket} in ${file}`)
  return { file, record: matches[matches.length - 1] }
}

/** Copy-paste commands that clone the source repository at the recorded commit. */
export function restoreCommands(record, { root = process.cwd() } = {}) {
  if (typeof record?.remote !== 'string' || record.remote === '') {
    throw new Error(`the record for ${record?.name ?? 'this ticket'} has no remote URL`)
  }
  if (typeof record.head !== 'string' || record.head === '') {
    throw new Error(`the record for ${record.name} has no HEAD commit`)
  }
  const target = typeof record.path === 'string' && record.path !== '' ? record.path : join(root, record.name)
  const lines = [
    `mkdir -p ${shellQuote(dirname(target))}`,
    `git clone ${shellQuote(record.remote)} ${shellQuote(target)}`,
    `cd ${shellQuote(target)}`,
  ]
  lines.push(record.branch ? `git fetch origin ${shellQuote(record.branch)}` : 'git fetch origin')
  lines.push(`git checkout --detach ${shellQuote(record.head)}`)
  return lines.join('\n')
}
