/**
 * Reclaiming work-ticket clones and recording how to rebuild them.
 *
 * dsh-superagent creates one directory per Ticket under its execution root
 * (`settings.executor.directory`, default `<stateDir>/work`). A directory is a *reproducible duplicate* only when three
 * runtime facts hold: nothing has its cwd inside it, the working tree is clean, and every commit is already on a
 * remote. The planner that decides this lives in a standalone Rust binary (`crates/wca-core`); this module keeps
 * the delete path, the open-ticket resolver, the JSONL record and the `work restored` rendering.
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
 * The planner runs as a separate process so a Rust panic or abort cannot take down this Node process; a
 * `spawnSync` call is bounded by a timeout and an output cap. The delete path below still re-checks cwd holders
 * asynchronously immediately before each removal.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveData } from './home.js'
import { SchemaError, object } from './schema.js'

export { RECLAIMED_FILE } from './home.js'

/** No age retention by default: the reconstructibility gate, not age, is what makes a delete safe. */
export const KEEP_DAYS_DEFAULT = 0

/**
 * Opt-in count floor: `--keep N` protects the newest N passing directories when someone asks for it. The default is
 * 0 because `work restored` rebuilds a clone from the record in a moment; recency alone buys nothing.
 */
export const KEEP_DEFAULT = 0

/**
 * The Rust planner binary, built by `bash build/build-core.sh`. A checkout runs `build/artifacts/…` directly;
 * an installed preset (which does not carry build output) runs the copy `install.sh` puts on PATH as
 * `wheelchair-agent-core`.
 *
 * There is deliberately no JavaScript fallback: a missing or invalid binary is a broken build, and silently
 * planning with a second implementation would defeat the point of moving the gate into Rust. The error names
 * the exact fix.
 */
const CORE_BINARY = '../../build/artifacts/wheelchair-agent-core-linux-x64'
const CORE_COMMAND = 'wheelchair-agent-core'
const CORE_TIMEOUT_MS = 5 * 60_000
const CORE_MAX_BUFFER = 16 * 1024 * 1024

function coreBinary() {
  const fromCheckout = fileURLToPath(new URL(CORE_BINARY, import.meta.url))
  return existsSync(fromCheckout) ? fromCheckout : CORE_COMMAND
}

function coreHint(detail) {
  return new Error(`the Rust core ${detail}; run "bash build/build-core.sh" to build it`)
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function requiredText(value, name) {
  if (typeof value !== 'string' || value === '') throw new SchemaError(`${name} must be a non-empty string`)
  return value
}

function finiteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SchemaError(`${name} must be a finite number`)
  return value
}

function count(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new SchemaError(`${name} must be a non-negative integer`)
  return value
}

function nullableText(value, name) {
  if (value === null) return null
  if (typeof value !== 'string') throw new SchemaError(`${name} must be a string or null`)
  return value
}

/** The envelope is validated through `schema.js`, the same tiny validator the Source kinds use. */
const envelopeSchema = object({
  ok: value => {
    if (typeof value !== 'boolean') throw new SchemaError('must be a boolean')
    return value
  },
  data: value => value,
  code: value => (value === undefined ? null : nullableText(value, 'code')),
  message: value => (value === undefined ? null : nullableText(value, 'message')),
})

function checkRecord(value) {
  if (!isObject(value)) throw new SchemaError('record must be an object')
  count(value.version, 'record.version')
  requiredText(value.name, 'record.name')
  requiredText(value.path, 'record.path')
  requiredText(value.head, 'record.head')
  nullableText(value.originMain, 'record.originMain')
  nullableText(value.branch, 'record.branch')
  nullableText(value.upstream, 'record.upstream')
  if (typeof value.remote !== 'string') throw new SchemaError('record.remote must be a string')
  requiredText(value.remoteName, 'record.remoteName')
  finiteNumber(value.bytes, 'record.bytes')
  requiredText(value.when, 'record.when')
  return value
}

function checkEntry(value, index) {
  const where = `entries[${index}]`
  if (!isObject(value)) throw new SchemaError(`${where} must be an object`)
  requiredText(value.name, `${where}.name`)
  requiredText(value.path, `${where}.path`)
  finiteNumber(value.bytes, `${where}.bytes`)
  if (value.action !== 'reclaim' && value.action !== 'keep' && value.action !== 'unknown') {
    throw new SchemaError(`${where}.action is not a known action`)
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    throw new SchemaError(`${where}.reason must be a string`)
  }
  if (value.mtimeMs !== undefined) finiteNumber(value.mtimeMs, `${where}.mtimeMs`)
  if (value.record !== undefined) checkRecord(value.record)
  return value
}

const planSchema = object({
  root: value => {
    if (typeof value !== 'string') throw new SchemaError('must be a string')
    return value
  },
  entries: value => {
    if (!Array.isArray(value)) throw new SchemaError('must be a list')
    return value.map((entry, index) => checkEntry(entry, index))
  },
  reclaimable: value => count(value, 'must be a non-negative integer'),
  reclaimableBytes: value => finiteNumber(value, 'must be a finite number'),
  kept: value => count(value, 'must be a non-negative integer'),
  unknown: value => count(value, 'must be a non-negative integer'),
})

/** Validate the planner data through `schema.js` and restore the runtime's display order. */
function checkPlan(value) {
  const plan = planSchema.parse(value)
  // The planner sorts deterministically in Rust; the CLI's output order has always been
  // `localeCompare`, so restore that here rather than embedding ICU in the binary.
  plan.entries.sort((left, right) => left.name.localeCompare(right.name))
  return plan
}

/** Run one core subcommand and return the validated `data` of a successful envelope. */
function runCore(args, input) {
  const result = spawnSync(coreBinary(), args, {
    input,
    encoding: 'utf8',
    timeout: CORE_TIMEOUT_MS,
    maxBuffer: CORE_MAX_BUFFER,
  })
  if (result.error !== undefined) {
    if (result.error.code === 'ENOENT') throw coreHint('binary was not found')
    if (result.error.code === 'EACCES') throw coreHint('binary is not executable')
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(`the Rust core timed out after ${CORE_TIMEOUT_MS / 1000} seconds`)
    }
    throw new Error(`the Rust core failed to run: ${result.error.message}`)
  }
  if (typeof result.stdout !== 'string') throw coreHint('printed no output')
  let envelope
  try {
    envelope = JSON.parse(result.stdout)
  } catch (error) {
    throw coreHint(`returned unparseable JSON (${error?.message ?? error})`)
  }
  const parsed = envelopeSchema.safeParse(envelope)
  if (!parsed.success) throw coreHint(`returned an invalid envelope (${parsed.error.message})`)
  const { ok, code, message } = parsed.data
  if (!ok) throw new Error(message || `the Rust core failed (${code ?? 'unknown'})`)
  if (result.status !== 0) throw coreHint(`exited ${result.status} after reporting success`)
  try {
    return checkPlan(parsed.data.data)
  } catch (error) {
    throw coreHint(`returned an invalid plan (${error instanceof Error ? error.message : error})`)
  }
}

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

// ------------------------------------------------------------------ planning

/**
 * Build the plan: every direct child of `root`, its size, and either `reclaim` or the reason it is kept.
 *
 * The planner is the Rust binary (`crates/wca-core`); there is no JavaScript copy. This wrapper only adapts the
 * inputs (`skipDirectories` may be a `Map` or an iterable of directory names, exactly as before), runs the
 * binary, and validates its envelope before returning the mutable plain objects the CLI and delete path expect.
 */
export async function planWork({
  root,
  keep = KEEP_DEFAULT,
  keepDays = KEEP_DAYS_DEFAULT,
  now = Date.now(),
  skipDirectories = new Map(),
  blockedReason,
}) {
  const pairs = skipDirectories instanceof Map
    ? [...skipDirectories]
    : [...skipDirectories].map(directory => [directory, directory])
  const skip = Object.fromEntries(
    pairs.map(([directory, ticket]) => [resolve(directory), String(ticket)]),
  )
  const request = { root, keep, keepDays, now, skipDirectories: skip }
  if (blockedReason !== undefined) request.blockedReason = blockedReason
  return runCore(['work-plan'], JSON.stringify(request))
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
