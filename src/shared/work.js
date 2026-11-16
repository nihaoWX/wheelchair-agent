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
 *   `<root>/records/work-reclaimed.jsonl` (default `~/.wheelchair-agent`, `$WHEELCHAIR_AGENT_HOME`
 *   overrides), one JSON object per reclaimed directory. The old `<stateDir>/work-reclaimed.jsonl` is
 *   migrated by `src/shared/home.js` and stays readable through its fallback.
 *
 * Every git call is asynchronous (`execFile`, with a timeout) because the mount hook runs this inside the service
 * process: a synchronous spawn would stall the Source's own event loop.
 */
import { execFile } from 'node:child_process'
import { appendFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { resolveData } from './home.js'

const execFileAsync = promisify(execFile)

export { RECLAIMED_FILE } from './home.js'

/** No age retention by default: the reconstructibility gate, not age, is what makes a delete safe. */
export const KEEP_DAYS_DEFAULT = 0

/**
 * Opt-in count floor: `--keep N` protects the newest N passing directories when someone asks for it. The default is
 * 0 because `work restored` rebuilds a clone from the record in a moment; recency alone buys nothing.
 */
export const KEEP_DEFAULT = 0

/** A Ticket directory is `<short name>-<hex>`; `state/` and other residue must not match. */
const TICKET_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*-[0-9a-f]{8,64}$/

/** Absolute milliseconds in one day, used by the `--keep-days` window. */
const DAY_MS = 86_400_000

/** Git variables that would make `git -C <clone>` operate on the caller's repository instead of the clone. */
const GIT_CALLER_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

/**
 * Work root of the deployment: the configured executor directory, else `$DSH_SUPERAGENT_WORK_DIR`, else
 * `<stateDir>/work`.
 *
 * The CLI cannot read dsh-superagent's panel settings, so the environment variable is the documented bridge for a
 * deployment that moved `executor.directory`; the mount hook passes the real setting directly. A relative override
 * and the filesystem roots are refused: this path is handed to `rm`.
 */
export function resolveWorkRoot({ stateDir, directory = '', env = process.env }) {
  const configured = String(directory ?? '').trim()
  const fromEnv = String(env.DSH_SUPERAGENT_WORK_DIR ?? '').trim()
  const chosen = configured || fromEnv
  if (chosen === '') return resolve(join(stateDir, 'work'))
  if (!isAbsolute(chosen)) throw new Error(`the work root must be an absolute path, got ${JSON.stringify(chosen)}`)
  const root = resolve(chosen)
  const blocked = [resolve('/'), resolve(homedir()), stateDir ? resolve(stateDir) : '']
  if (blocked.includes(root)) throw new Error(`refusing to reclaim inside ${root}: it is not a ticket-clone root`)
  return root
}

/** Terminal-friendly size: bytes under 1 KB stay exact, then one decimal place with binary units. */
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

/** A size in binary megabytes with one decimal place, for the mount log line (same unit as `formatBytes`). */
export function megabytes(bytes) {
  return (Number(bytes || 0) / 1024 / 1024).toFixed(1)
}

/** Quote one value for a POSIX shell. The rebuild commands are meant to be pasted, so this matters. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// ------------------------------------------------------------- open tickets

/**
 * The one implementation of "which directories may not be reclaimed because an open Ticket owns them".
 *
 * `provider` is the only part that differs between the two callers:
 *   - the CLI passes `() => fetchOpenTickets()` (HTTP to the running service);
 *   - the mount hook passes `() => ({ tickets: source.tickets.open() })` (in-process).
 *
 * The result is deliberately three-state: `{ ok: true, directories }`, `{ ok: false, down: true }` when nothing is
 * listening (nothing can be working, so the caller proceeds), and `{ ok: false, reason }` for every other failure
 * (malformed response, unexpected shape, thrown provider), which must keep everything. A ticket may expose its
 * directory as `execution.directory` (the domain record) or `directory` (the management API view).
 */
export async function openTicketDirectories(provider) {
  let value
  try {
    value = await provider()
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) }
  }
  if (value === undefined || value === null) return { ok: false, reason: 'the provider returned no response' }
  if (value.down === true) return { ok: false, down: true, reason: value.reason ?? 'the service is not running' }
  if (value.error !== undefined) return { ok: false, reason: String(value.error) }
  if (!Array.isArray(value.tickets)) return { ok: false, reason: 'the response is not a list of tickets' }
  const directories = new Map()
  for (const ticket of value.tickets) {
    if (ticket === null || typeof ticket !== 'object') {
      return { ok: false, reason: 'a ticket is not an object' }
    }
    const directory = ticket.execution?.directory ?? ticket.directory
    // A queued ticket may have no execution yet; it owns no clone, so there is nothing to protect. A *present* but
    // unusable directory is a different thing: the answer cannot be trusted, so keep everything.
    if (directory === undefined || directory === null) continue
    if (typeof directory !== 'string' || directory === '') {
      return { ok: false, reason: 'a ticket has an unusable execution.directory' }
    }
    directories.set(directory, String(ticket.id ?? ticket.title ?? directory))
  }
  return { ok: true, directories }
}

// ------------------------------------------------------------ workspaces

/**
 * Remove workspace records whose directory no longer exists.
 *
 * dsh never prunes a workspace record when its directory disappears, so the sidebar keeps showing rows for reclaimed
 * clones. The registry is a dsh service only the mount hook can reach; the CLI has no registry. The guards are
 * strict: the record's canonical path must be a child of the resolved work root, the directory must be gone, and
 * nothing outside the work root is ever considered (the operator's own `~/bioagentforge` workspace must survive
 * anything this code does). The call only removes the registry row; directories, session ids and session logs are
 * untouched.
 *
 * Fail-soft: a missing, throwing, or malformed registry returns zero prunes and an optional reason; a failed delete
 * for one record does not stop the others. This function never throws.
 */
export async function pruneStaleWorkspaces({ registry, root } = {}) {
  const pruned = []
  try {
    if (typeof root !== 'string' || root === '') return { pruned, error: 'no work root' }
    let list
    let remove
    try {
      list = registry?.list
      remove = registry?.delete
    } catch {
      return { pruned, error: 'the workspace registry could not be read' }
    }
    if (typeof list !== 'function' || typeof remove !== 'function') {
      return { pruned, skipped: 'no workspace registry' }
    }
    const rootPath = resolve(root)
    // A symlinked work root would make the canonical prefix a different (possibly broader) subtree. Skipping keeps
    // the hard "child of the work root" promise; the operator can point DSH_SUPERAGENT_WORK_DIR at the real path.
    let rootInfo
    try {
      rootInfo = await lstat(rootPath)
    } catch {
      rootInfo = undefined
    }
    if (rootInfo?.isSymbolicLink() === true) {
      return { pruned, skipped: 'the work root is a symlink; workspace prune skipped' }
    }
    const canonicalRoot = await realpath(rootPath).catch(() => rootPath)
    if (canonicalRoot !== rootPath) {
      return { pruned, skipped: 'the work root is not canonical; workspace prune skipped' }
    }
    let records
    try {
      records = list.call(registry)
    } catch (error) {
      return { pruned, error: `workspace registry list failed: ${error?.message ?? error}` }
    }
    if (!Array.isArray(records)) return { pruned, error: 'workspace registry list is not an array' }
    for (const record of records) {
      const id = record?.id
      const path = record?.path
      if (typeof id !== 'string' || id === '' || typeof path !== 'string' || path === '') continue
      // dsh stores canonical absolute paths; anything else is an unexpected shape and is left alone.
      if (!isAbsolute(path)) continue
      const target = resolve(path)
      if (!target.startsWith(`${rootPath}${sep}`)) continue
      let missing = false
      try {
        const info = await stat(target)
        if (info.isDirectory()) continue
        missing = true
      } catch (error) {
        if (error.code !== 'ENOENT') continue
        missing = true
      }
      if (!missing) continue
      // Re-check immediately before the registry write; this narrows the recreate race but cannot remove it.
      try {
        if ((await stat(target)).isDirectory()) continue
      } catch (error) {
        if (error.code !== 'ENOENT') continue
      }
      try {
        const deleted = await remove.call(registry, id)
        if (deleted !== false) {
          pruned.push({ id, path: target, title: typeof record.title === 'string' ? record.title : '' })
        }
      } catch {
        // One bad row must not stop the rest; the summary simply reports fewer prunes.
      }
    }
    return { pruned }
  } catch (error) {
    return { pruned, error: `workspace prune failed: ${error?.message ?? error}` }
  }
}

// ------------------------------------------------------------------ the gate

/** Environment for a child git that must inspect exactly the clone at `-C`, not the caller's repository. */
function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of GIT_CALLER_ENV) delete env[key]
  return env
}

/** True when the proc mount hides process details (`hidepid=`), where an unreadable pid could hide a live worker. */
async function hidepidActive(procMounts) {
  try {
    const text = await readFile(procMounts, 'utf8')
    for (const line of text.split('\n')) {
      const fields = line.split(/\s+/)
      if (fields[1] !== '/proc') continue
      const options = String(fields[3] ?? '').split(',')
      if (options.some(option => option === 'hidepid' || option.startsWith('hidepid='))) return true
    }
  } catch {
    // No mounts table: fall back to treating same-user unreadable pids as benign (the systemd case).
  }
  return false
}

/**
 * Processes whose cwd is `path` (or below it). `readlink /proc/<pid>/cwd` follows the kernel's symlink, which is
 * exactly the runtime fact the gate wants: a live process cannot be inferred from ticket state.
 *
 * An unreadable pid of another user cannot own one of our private ticket directories, so it is skipped. An
 * unreadable pid of *our* user is the dangerous case (a hidden live worker): if the proc mount uses `hidepid`, the
 * whole scan becomes unavailable and callers keep everything, because "cannot prove unused" must not be treated as
 * unused. Without hidepid, unreadable same-user pids are the normal systemd/`dumpable=0` case and are skipped. A
 * kernel without `/proc` is unavailable for the same reason.
 */
export async function cwdHolders(path, { procRoot = '/proc', procMounts = '/proc/mounts' } = {}) {
  const target = await realpath(path).catch(() => resolve(path))
  let names
  try {
    names = await readdir(procRoot)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { unavailable: true, pids: [] }
    if (error.code === 'EACCES' || error.code === 'EPERM') return { unavailable: true, pids: [] }
    throw error
  }
  const pids = []
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const hiding = await hidepidActive(procMounts)
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    let cwd
    try {
      cwd = await readlink(join(procRoot, name, 'cwd'))
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue
      if (error.code !== 'EACCES' && error.code !== 'EPERM') return { unavailable: true, pids: [] }
      let owner = uid
      try {
        owner = (await stat(join(procRoot, name))).uid
      } catch {
        if (hiding || uid === undefined) return { unavailable: true, pids: [] }
        continue
      }
      if (uid !== undefined && owner !== uid) continue
      if (hiding) return { unavailable: true, pids: [] }
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

/** Run git in `path` without a terminal, optional locks, or the caller's repository variables. */
async function git(path, args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', path, ...args], {
      encoding: 'utf8',
      env: gitEnv(),
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, out: stdout, err: stderr }
  } catch (error) {
    if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { ok: false, out: error.stdout ?? '', err: 'git output exceeded 4 MiB' }
    }
    if (error?.killed) return { ok: false, out: error.stdout ?? '', err: 'timed out after 60s' }
    return { ok: false, out: error?.stdout ?? '', err: error?.stderr ?? error?.message ?? '' }
  }
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
async function unpublishedReason(path) {
  const upstream = await git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (upstream.ok && upstream.out.trim() !== '') {
    const count = await git(path, ['rev-list', '--count', `${upstream.out.trim()}..HEAD`])
    if (!count.ok) return { reason: `cannot compare HEAD with ${upstream.out.trim()}` }
    const commits = Number(count.out.trim())
    if (commits > 0) return { reason: `${commits} commit${commits === 1 ? '' : 's'} not pushed` }
    return { upstream: upstream.out.trim() }
  }
  const originMain = await git(path, ['rev-parse', 'origin/main'])
  if (!originMain.ok) return { reason: 'no upstream and no origin/main to compare' }
  const count = await git(path, ['rev-list', '--count', 'origin/main..HEAD'])
  if (!count.ok) return { reason: 'cannot compare HEAD with origin/main' }
  const commits = Number(count.out.trim())
  if (commits > 0) return { reason: `${commits} commit${commits === 1 ? '' : 's'} not pushed` }
  return { upstream: null }
}

/**
 * The remote a branch actually tracks, so the record names the repository that holds the published commit rather
 * than assuming `origin`. Falls back to `origin`, then to the first configured remote.
 */
async function trackedRemote(path, branch, names) {
  if (branch !== null) {
    const configured = await git(path, ['config', '--get', `branch.${branch}.remote`])
    const name = configured.ok ? configured.out.trim() : ''
    if (name !== '' && name !== '.') return name
  }
  if (names.includes('origin')) return 'origin'
  return names[0]
}

/**
 * Inspect one ticket-shaped directory. `{ ok: true, record }` means the reconstructibility gate passed and the record
 * fields were captured; `{ ok: false, reason }` means it must be kept.
 */
async function inspectClone(path) {
  const holders = await cwdHolders(path)
  if (holders.unavailable) return { ok: false, reason: 'cannot scan /proc to prove nothing is using it' }
  if (holders.pids.length > 0) return { ok: false, reason: cwdReason(holders.pids) }

  const status = await git(path, ['status', '--porcelain'])
  if (!status.ok) return { ok: false, reason: `git status failed: ${firstLine(status.err) || 'unknown error'}` }
  if (status.out.trim() !== '') return { ok: false, reason: dirtyReason(status.out) }

  const remotes = await git(path, ['remote'])
  if (!remotes.ok) return { ok: false, reason: `git remote failed: ${firstLine(remotes.err) || 'unknown error'}` }
  const names = remotes.out.split('\n').map(name => name.trim()).filter(Boolean)
  if (names.length === 0) return { ok: false, reason: 'no remote (the clone is the only copy)' }

  const pushed = await unpublishedReason(path)
  if (pushed.reason) return { ok: false, reason: pushed.reason }

  const head = await git(path, ['rev-parse', 'HEAD'])
  const branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const originMain = await git(path, ['rev-parse', 'origin/main'])
  const branchName = branch.ok ? branch.out.trim() : ''
  const name = branchName === '' || branchName === 'HEAD' ? null : branchName
  const remoteName = await trackedRemote(path, name, names)
  const remoteUrl = await git(path, ['remote', 'get-url', remoteName])
  if (!head.ok || !remoteUrl.ok) {
    return { ok: false, reason: `cannot read HEAD or the ${remoteName} remote URL` }
  }
  return {
    ok: true,
    record: {
      name: basename(path),
      path,
      head: head.out.trim(),
      originMain: originMain.ok ? originMain.out.trim() : null,
      branch: name,
      upstream: pushed.upstream,
      remote: remoteUrl.out.trim(),
      remoteName,
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
 * and `--keep-days` only delay an otherwise passing entry; they never override a failed gate. `skipDirectories` maps
 * a directory to the open Ticket that owns it; those are kept for that reason even when the gate passes, which only
 * makes the sweep less aggressive. `blockedReason` (an unreadable open-ticket answer) keeps every passing entry.
 */
export async function planWork({
  root,
  keep = KEEP_DEFAULT,
  keepDays = KEEP_DAYS_DEFAULT,
  now = Date.now(),
  skipDirectories = new Map(),
  blockedReason,
}) {
  const entries = []
  let children = []
  try {
    children = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') children = []
    else throw new Error(`cannot read the work root ${root}: ${error.code ?? error.message}`)
  }
  children.sort((a, b) => a.name.localeCompare(b.name))
  const pairs = skipDirectories instanceof Map
    ? [...skipDirectories]
    : [...skipDirectories].map(directory => [directory, directory])
  const skip = new Map(pairs.map(([directory, ticket]) => [resolve(directory), String(ticket)]))

  for (const child of children) {
    const path = join(root, child.name)
    try {
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
      if (skip.has(resolve(path))) {
        entries.push({ ...base, action: 'keep', reason: `open ticket ${skip.get(resolve(path))} is using this directory` })
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
    } catch (error) {
      entries.push({ name: child.name, path, bytes: 0, action: 'keep', reason: `cannot inspect: ${error.message}` })
    }
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
  if (blockedReason !== undefined) {
    for (const entry of entries) {
      if (entry.action === 'reclaim') {
        entry.action = 'keep'
        entry.reason = blockedReason
      }
    }
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

/** Append one record line; the caller decides whether a failure keeps the directory. */
function appendRecord(file, value) {
  return appendFile(file, `${JSON.stringify(value)}\n`, 'utf8')
}

/**
 * Plan and (unless `dryRun`) reclaim. The record line is appended **before** the delete: if the write fails, the
 * directory stays, so no reclaimed directory can be missing from the record. A cwd recheck happens immediately before
 * each delete as well, closing the window between planning and removal. A failed delete appends a retraction line, so
 * `work restored` never claims a directory that is still there.
 */
export async function reclaimWork({
  root,
  home,
  stateDir,
  env = process.env,
  keep = KEEP_DEFAULT,
  keepDays = KEEP_DAYS_DEFAULT,
  dryRun = false,
  now = Date.now(),
  skipDirectories = new Map(),
  blockedReason,
}) {
  const plan = await planWork({ root, keep, keepDays, now, skipDirectories, blockedReason })
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

  const file = resolveData({ env, home, stateDir }).reclaimed
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
      await mkdir(dirname(file), { recursive: true })
      await appendRecord(file, entry.record)
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
      // The record was already written; retract it so a later `work restored` does not target a surviving directory.
      await appendRecord(file, {
        name: entry.name,
        retracted: true,
        retractedAt: new Date().toISOString(),
        error: entry.reason,
      }).catch(() => {})
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

/**
 * The last record for `ticket`, or an error that names the exact file that was searched. A retraction line
 * (`retracted: true`) cancels the record before it, so a failed delete never produces rebuild instructions.
 */
export async function readReclaimed({ home, stateDir, env = process.env, ticket }) {
  const file = resolveData({ env, home, stateDir }).reclaimed
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
  let chosen
  for (const record of records) {
    if (record?.name !== ticket) continue
    if (record.retracted === true) chosen = undefined
    else chosen = record
  }
  if (chosen === undefined) throw new Error(`no reclaim record for ${ticket} in ${file}`)
  return { file, record: chosen }
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
  // The clone's `origin` is exactly `record.remote`, whatever the original remote was named.
  lines.push(record.branch ? `git fetch origin ${shellQuote(record.branch)}` : 'git fetch origin')
  lines.push(`git checkout --detach ${shellQuote(record.head)}`)
  return lines.join('\n')
}
