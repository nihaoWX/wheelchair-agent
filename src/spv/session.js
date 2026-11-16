/**
 * The dsh session write lease, named by the kernel instead of by a command line.
 *
 * dsh persists one session as a directory `<root>/<projectKey(cwd)>/<session-id>/` and takes the write
 * lease as a POSIX `flock(2)` on `<dir>/session.lock` (the TUI/dsh also holds `<dir>/session.v4.jsonl.zstd`).
 * A killed TUI normally closes both descriptors with the process; the restart bug this module exists for
 * was a holder whose cmdline no longer matched the SPV chain but whose descriptor was still open, so the
 * relaunch lost the race and dsh-tui refused the resume.
 *
 * The authority is therefore `/proc/<pid>/fd/*`: a process is a holder when one of its descriptors resolves
 * (through `realpath`, with a trailing ` (deleted)` stripped) to exactly the session's lock or log file. A
 * process with the same file name elsewhere, or with an unrelated descriptor, is not a holder. A zombie is
 * not a holder: its descriptors are already closed as far as the kernel's lock is concerned.
 *
 * Exactly the algorithm `@deepseek-ai/dsh-session-persistence-jsonl` uses, reproduced here because `src/`
 * may not import a dsh package:
 *
 *   separators `/ \ :` -> one `-`; safe `[A-Za-z0-9._-]` kept; every other code unit `~XXXX` (uppercase,
 *   four hex digits); strip the leading `-`; `--${readable || 'root'}` truncated to 251, then `--`.
 *
 * Pure Node builtins and no `process.exit`; every function takes its test seams as arguments and resolves
 * paths from the environment it is given, so the offline tests can point it at a `mkdtemp` sandbox.
 */
import { readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/** Base name of the kernel lease file dsh takes beside a session's log. */
export const LOCK_NAME = 'session.lock'
/** The dsh session log; the TUI/dsh holds it open while it drives the session. */
export const SESSION_LOG_NAME = 'session.v4.jsonl.zstd'
/** Default bound for waiting on the lease, shared by `restart-all`, `spv` and `session release`. */
export const DEFAULT_LEASE_MS = 15_000
/** Default poll interval while waiting for a descriptor to close. */
const DEFAULT_POLL_MS = 100

const sleep = ms => new Promise(done => setTimeout(done, ms))

/** Resolve a path through symlinks; a path that does not exist resolves as an absolute path. */
function realPath(file) {
  try {
    return realpathSync(file)
  } catch {
    return resolve(file)
  }
}

/** Whether `dir` is a directory; any error (missing, permission) reads as false. */
function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** Directory entries, or an empty list when the directory cannot be read. */
function entries(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * The project directory key dsh uses for one working directory.
 *
 * This is a copy of `projectKey()` in `@deepseek-ai/dsh-session-persistence-jsonl` (see the module comment
 * for the grammar). `/home/nihao/bioagentforge` becomes `--home-nihao-bioagentforge--`.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** The root that holds every project directory of sessions: `DSH_TUI_SESSION_ROOT`, else `DSH_HOME/sessions`. */
export function sessionsRoot({ env = process.env } = {}) {
  const configured = String(env.DSH_TUI_SESSION_ROOT ?? '').trim()
  if (configured !== '') return configured
  const home = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/**
 * Encode one raw session id as the directory name dsh uses (copy of `encodeSegment` in the persistence
 * backend): `.`, `..` and every code unit outside `[A-Za-z0-9._-]` become `~XXXX`, with `~` always escaped.
 * A resume id is normally a UUID, but `--session` may name anything dsh itself could have written.
 */
export function encodeSegment(raw) {
  const value = String(raw)
  if (value.length === 0) throw new Error('cannot encode an empty path segment')
  if (value === '.') return '~002E'
  if (value === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) out += character
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Decode one directory segment back to the raw session id (`~XXXX` escapes undo `encodeSegment`). */
export function decodeSegment(raw) {
  const value = String(raw)
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '~' && index + 4 < value.length) {
      const code = Number.parseInt(value.slice(index + 1, index + 5), 16)
      if (Number.isInteger(code)) {
        out += String.fromCharCode(code)
        index += 4
        continue
      }
    }
    out += value[index]
  }
  return out
}

/** Whether a raw session id can be encoded as one path segment. */
function isSessionId(id) {
  return typeof id === 'string' && id.trim() !== ''
}

/** The newest directory under `dir` by mtime, or undefined when there is none. */
function newestDirectory(dir) {
  let best
  for (const name of entries(dir)) {
    const candidate = join(dir, name)
    let stat
    try {
      stat = statSync(candidate)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    if (best === undefined || stat.mtimeMs > best.mtimeMs ||
      (stat.mtimeMs === best.mtimeMs && name > best.name)) {
      best = { name, mtimeMs: stat.mtimeMs }
    }
  }
  return best === undefined ? undefined : join(dir, best.name)
}

/**
 * Resolve one session directory.
 *
 * With `id`: the exact `<root>/<projectKey(cwd)>/<encodeSegment(id)>/` first (a resume usually names a
 * session of this workspace), then a search of every `<root>/<project>/<encodeSegment(id)>/` for a session
 * opened from another cwd. Without `id`: the newest session directory of the current workspace.
 *
 * @returns `{id, dir}`, or undefined when no directory matches.
 */
export function resolveSession({ env = process.env, cwd = process.cwd(), id } = {}) {
  const root = sessionsRoot({ env })
  if (id !== undefined && id !== null && String(id).trim() !== '') {
    const wanted = String(id).trim()
    if (!isSessionId(wanted)) return undefined
    const segment = encodeSegment(wanted)
    const exact = join(root, projectKey(cwd), segment)
    if (isDirectory(exact)) return { id: wanted, dir: exact }
    for (const name of entries(root)) {
      const candidate = join(root, name, segment)
      if (isDirectory(candidate)) return { id: wanted, dir: candidate }
    }
    return undefined
  }
  const newest = newestDirectory(join(root, projectKey(cwd)))
  if (newest === undefined) return undefined
  return { id: decodeSegment(basename(newest)), dir: newest }
}

/** Read `/proc/<pid>/cmdline` as argv; an unreadable entry reads as an empty list. */
function cmdlineOf(procRoot, pid) {
  try {
    return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8')
      .split('\0')
      .filter(word => word !== '')
  } catch {
    return []
  }
}

/** Read the parent pid from `/proc/<pid>/status`; 0 when it cannot be read. */
function ppidOf(procRoot, pid) {
  try {
    const text = readFileSync(join(procRoot, String(pid), 'status'), 'utf8')
    const match = /^PPid:\s*(\d+)\s*$/m.exec(text)
    return match === null ? 0 : Number(match[1])
  } catch {
    return 0
  }
}

/**
 * Whether `pid` is a live (non-zombie) process, read from `procRoot`.
 *
 * A zombie still has a `/proc` entry briefly but its descriptors are gone; when the stat file cannot be
 * read at all the real process table is consulted, which keeps a `/proc` entry without a stat (a fake one,
 * or a partially hidden process) from being silently skipped.
 */
export function pidAlive(pid, { procRoot = '/proc' } = {}) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) return false
  try {
    const stat = readFileSync(join(procRoot, String(numeric), 'stat'), 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0]
    return state !== 'Z' && state !== 'X'
  } catch {
    try {
      process.kill(numeric, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }
}

/**
 * The pid chain above `pid`, nearest parent first. Always the real `/proc` by default: this describes the
 * caller, not the deployment it inspects.
 */
export function ancestorPids(pid, { procRoot = '/proc' } = {}) {
  const ancestors = []
  const seen = new Set([Number(pid)])
  let current = Number(pid)
  while (Number.isInteger(current) && current > 1) {
    const parent = ppidOf(procRoot, current)
    if (!Number.isInteger(parent) || parent <= 1 || seen.has(parent)) break
    ancestors.push(parent)
    seen.add(parent)
    current = parent
  }
  return ancestors
}

/** The exact paths that count as holding the session, resolved through symlinks. */
function wantedHolds(sessionDir) {
  const dir = realPath(sessionDir)
  return {
    lock: realPath(join(dir, LOCK_NAME)),
    log: realPath(join(dir, SESSION_LOG_NAME)),
  }
}

/**
 * Every live process that holds an open descriptor on `sessionDir`'s lock or log.
 *
 * The scan is fd-based and exact: `/proc/<pid>/fd/*` symlinks are resolved (with a trailing ` (deleted)`
 * stripped) and compared to the two session paths. A different `session.lock` elsewhere, an unrelated fd
 * and a zombie are not holders. The result is sorted by pid, carries the process's argv for display, and
 * `holds` says which artifact it holds (`lock`, `log` or `both`): the kill set keeps both, while the lease
 * wait and `session release`'s success condition only need the lock.
 *
 * `excludeAncestors` removes the caller and its parent chain, which a release must never signal; callers
 * that need to detect "only this process or its ancestors hold it" leave it false and subtract themselves.
 */
export function sessionHolders({
  sessionDir,
  procRoot = process.env.WHEELCHAIR_PROC_ROOT || '/proc',
  selfPid = process.pid,
  excludeAncestors = false,
} = {}) {
  if (typeof sessionDir !== 'string' || sessionDir === '') return []
  const wanted = wantedHolds(sessionDir)
  const excluded = new Set()
  if (excludeAncestors) {
    excluded.add(Number(selfPid))
    for (const pid of ancestorPids(selfPid, { procRoot })) excluded.add(pid)
  }
  const holders = []
  for (const name of entries(procRoot)) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (excluded.has(pid)) continue
    if (!pidAlive(pid, { procRoot })) continue
    let descriptors
    try {
      descriptors = readdirSync(join(procRoot, name, 'fd'))
    } catch {
      continue
    }
    let holdsLock = false
    let holdsLog = false
    for (const descriptor of descriptors) {
      let target
      try {
        target = readlinkSync(join(procRoot, name, 'fd', descriptor))
      } catch {
        continue
      }
      const clean = target.endsWith(' (deleted)')
        ? target.slice(0, -' (deleted)'.length)
        : target
      // Resolve the descriptor target the same way the wanted paths were resolved; a target that no longer
      // exists still compares by its absolute path.
      const resolved = realPath(clean)
      if (resolved === wanted.lock) holdsLock = true
      else if (resolved === wanted.log) holdsLog = true
      if (holdsLock && holdsLog) break
    }
    if (!holdsLock && !holdsLog) continue
    holders.push({
      pid,
      cmdline: cmdlineOf(procRoot, pid),
      holds: holdsLock && holdsLog ? 'both' : holdsLock ? 'lock' : 'log',
    })
  }
  return holders.sort((left, right) => left.pid - right.pid)
}

/** Parse a non-negative millisecond value from the environment, or fall back to `fallback`. */
export function envMs(env, name, fallback) {
  const value = Number.parseInt(String(env?.[name] ?? ''), 10)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Wait until no other process holds the write lease on `sessionDir`'s `session.lock`.
 *
 * A process that only holds `session.v4.jsonl.zstd` open (a read-only export/reader) does not block the
 * lease and is ignored here; it stays in the kill set scanners because the operator specified both files.
 * Prints `restart: waiting for pid <pid> to release the session…` for each lock holder it waits on (once
 * per pid), polls, and returns `{ok: true}` when none remains or `{ok: false, holder}` when the bound
 * expires. The caller's own pid is ignored: waiting on oneself can never succeed.
 *
 * @returns `{ok, holder}`; `holder` is `{pid, cmdline, holds}` of a remaining lock holder on timeout.
 */
export async function waitForLeaseFree({
  sessionDir,
  procRoot = process.env.WHEELCHAIR_PROC_ROOT || '/proc',
  timeoutMs = DEFAULT_LEASE_MS,
  pollMs = DEFAULT_POLL_MS,
  say = () => {},
  selfPid = process.pid,
  sleep: sleepFor = sleep,
} = {}) {
  if (typeof sessionDir !== 'string' || sessionDir === '') return { ok: true, holder: undefined }
  const remaining = () =>
    sessionHolders({ sessionDir, procRoot })
      .filter(holder => holder.pid !== Number(selfPid))
      // The wait is for the write lease: a read-only process that exported the log (zstdcat, a reader)
      // holds no flock on session.lock and must not keep the relaunch waiting.
      .filter(holder => holder.holds !== 'log')
  const announced = new Set()
  const announce = holders => {
    for (const holder of holders) {
      if (announced.has(holder.pid)) continue
      announced.add(holder.pid)
      say(`restart: waiting for pid ${holder.pid} to release the session…`)
    }
  }
  let holders = remaining()
  if (holders.length === 0) return { ok: true, holder: undefined }
  announce(holders)
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() < deadline) {
    await sleepFor(Math.max(10, pollMs))
    holders = remaining()
    if (holders.length === 0) return { ok: true, holder: undefined }
    announce(holders)
  }
  return { ok: false, holder: holders[0] }
}

/**
 * Release a session lease by terminating its holders: SIGTERM, wait, SIGKILL survivors, wait.
 *
 * The refusal rule is what keeps the command from killing the caller: when every holder is the caller or
 * one of its ancestors, nothing is signalled and the result is `{released: false, failed: true}` with the
 * exact `FAIL:` line. The superagent service is never ours to stop either: if any holder is in
 * `servicePids`, the whole release is refused before a signal, because skipping the service would leave the
 * lease held. Otherwise self/ancestors are skipped with one note and only the other holders are signalled.
 * A holder that survives SIGKILL is a failure too.
 *
 * The protocol is testable without real processes: `kill`, `isAlive`, `sleep` and `scan` (the current
 * holder list) can be injected. `say` receives every operator-facing line.
 *
 * @returns `{released, failed, holder}`.
 */
export async function releaseSession({
  sessionDir,
  holders = [],
  selfPid = process.pid,
  ancestors = [],
  servicePids = [],
  kill = (pid, signal) => process.kill(pid, signal),
  isAlive = pid => pidAlive(pid),
  sleep: sleepFor = sleep,
  timeoutMs = DEFAULT_LEASE_MS,
  pollMs = DEFAULT_POLL_MS,
  say = () => {},
  scan,
  procRoot = process.env.WHEELCHAIR_PROC_ROOT || '/proc',
} = {}) {
  const skipped = new Set([Number(selfPid), ...ancestors.map(Number)])
  const service = new Set(servicePids.map(Number))
  const present = holders.filter(holder => Number.isInteger(Number(holder?.pid)))
  if (present.length === 0) return { released: false, failed: false, holder: undefined }

  const serviceHolders = present.filter(holder => service.has(Number(holder.pid)))
  if (serviceHolders.length > 0) {
    const pids = serviceHolders.map(holder => Number(holder.pid)).join(' ')
    say(`FAIL: the session is held by the superagent service (pid ${pids}); refusing to release it`)
    say(
      'fix: stop the superagent service first (wheelchair-agent service stop), or pass --session ' +
        '<the TUI session id>',
    )
    return { released: false, failed: true, holder: undefined, refused: 'service' }
  }

  const other = present.filter(holder => !skipped.has(Number(holder.pid)))
  const own = present.filter(holder => skipped.has(Number(holder.pid)))
  if (other.length === 0) {
    say('FAIL: the only holder(s) are this process or its ancestor chain; refusing to kill them')
    return { released: false, failed: true, holder: undefined }
  }
  if (own.length > 0) {
    const pids = own.map(holder => Number(holder.pid)).join(' ')
    say(`note: not signalling pid ${pids}: this process or its ancestor chain holds the session`)
  }

  const current = typeof scan === 'function'
    ? () => scan({ sessionDir, procRoot }) || []
    : () => sessionHolders({ sessionDir, procRoot })
  const allUnskipped = () => current().filter(holder => !skipped.has(Number(holder.pid)))
  // The success condition is the write lock, not the log: a read-only exporter holding the log must not
  // keep a released session "held".
  const lockRemaining = () => allUnskipped().filter(holder => holder.holds !== 'log')

  const signal = (pids, name) => {
    for (const pid of pids) {
      if (!isAlive(pid)) continue
      if (service.has(Number(pid))) {
        say(`note: pid ${pid} is the superagent service; not signalling it`)
        continue
      }
      try {
        kill(pid, name)
        say(`sent ${name} to pid ${pid}`)
      } catch (error) {
        if (error?.code !== 'ESRCH') say(`note: cannot signal pid ${pid}: ${error.message}`)
      }
    }
  }

  // One budget for the whole release, not one per signal phase: the documented window cannot stretch to 2x.
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const waitLockFree = async () => {
    let still = lockRemaining()
    while (still.length > 0 && Date.now() < deadline) {
      await sleepFor(Math.max(10, pollMs))
      still = lockRemaining()
    }
    return still
  }

  let still = allUnskipped()
  signal(still.map(holder => Number(holder.pid)), 'SIGTERM')
  still = await waitLockFree()
  if (still.length > 0) {
    signal(still.map(holder => Number(holder.pid)), 'SIGKILL')
    still = await waitLockFree()
  }
  if (still.length > 0) {
    const pid = Number(still[0].pid)
    say(`FAIL: pid ${pid} still holds the session lease after SIGTERM and SIGKILL`)
    return { released: false, failed: true, holder: still[0] }
  }
  const ownStill = own.filter(holder =>
    holder.holds !== 'log' && current().some(other => other.pid === Number(holder.pid)))
  if (ownStill.length > 0) {
    const pids = ownStill.map(holder => Number(holder.pid)).join(' ')
    say(`FAIL: pid ${pids} still holds the session and was not signalled`)
    return { released: false, failed: true, holder: ownStill[0] }
  }
  return { released: true, failed: false, holder: undefined }
}

/**
 * The session id named by a launch argv, or undefined.
 *
 * `--resume <id>` and `--resume=<id>` are read directly; a bare `--resume` takes `fallbackId`, which is the
 * id `~/.dsh-tui/resume.txt` names (that is what dsh itself would read). This is only used to decide
 * whether a launch needs the lease wait; it never rewrites the argv.
 */
export function resumeIdFromArgv(argv = [], fallbackId) {
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    if (word === '--resume') {
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith('-')) return value
      return fallbackId
    }
    if (word.startsWith('--resume=')) {
      const value = word.slice('--resume='.length)
      return value === '' ? fallbackId : value
    }
  }
  return undefined
}

/** The operator-facing text for an fds holder list (used by the dry run and the plan). */
export function describeHolders(holders = []) {
  if (holders.length === 0) return '(none)'
  return holders
    .map(holder => `pid ${holder.pid}  ${(holder.cmdline ?? []).join(' ') || '(no cmdline)'}`)
    .join('\n')
}

/**
 * Wait until the session lease is free, bounded by `leaseTimeoutMs`; the shared entry point for the
 * orchestrator and `session release`. `env` overrides are read here so every caller honours the same seam.
 */
export function leaseTimeoutMs(env = process.env, fallback = DEFAULT_LEASE_MS) {
  return envMs(env, 'WHEELCHAIR_RESTART_LEASE_MS', fallback)
}
