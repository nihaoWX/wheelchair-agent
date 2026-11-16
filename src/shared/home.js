/**
 * wheelchair-agent's own data root.
 *
 * Everything this project writes that is *ours* lives under one directory, defaulting to
 * `~/.wheelchair-agent` and overridable with `$WHEELCHAIR_AGENT_HOME` (which must be absolute):
 *
 *   <root>/settings.json                 panel settings (was <stateDir>/panel-settings.json)
 *   <root>/inbox/                        review inbox items (was <stateDir>/inbox)
 *   <root>/records/work-reclaimed.jsonl  rebuild records for reclaimed ticket clones
 *   <root>/logs/restart-all.log          restart-all audit trail
 *   <root>/logs/prepare.log              prepare command traceability log
 *   <root>/logs/migration.log            what the one-shot move below did
 *
 * The superagent state directory (`$DSH_SUPERAGENT_STATE_DIR`, else
 * `<DSH_HOME|~/.dsh>/state/superagent`) is **not** replaced: the `spv/` file queue, the `work/` root,
 * `orchestrator.sqlite*`, `worker-bin/` and `worker-gitconfig` are the interface with superagent and stay
 * there. A plausible "reset superagent" (`rm -rf ~/.dsh/state/superagent`) must not take our review
 * history, settings or rebuild records with it.
 *
 * Migration is deliberately boring and synchronous. The first reader from either side (the service's webui
 * host half, or the SPV session/CLI) moves each old file or directory to its new place exactly once:
 *
 *   - only when the new path is absent (an empty new inbox directory created by install.sh counts as absent)
 *     and the old one exists;
 *   - under one cross-process lock (`<root>/.migrate.lock`, the same `open(..., 'wx')` idiom the inbox uses
 *     for per-item writes; a lock older than 30 s is reaped);
 *   - idempotent (a lost race is a success, not an error);
 *   - logged as `moved <old> -> <new>` in `<root>/logs/migration.log`, and a failure is logged too.
 *
 * On failure the old path is left untouched and every reader falls back to it: data is never reachable from
 * neither path. `$SPV_INBOX_DIR` and `$SPV_PREPARE_LOG` are explicit overrides; when set they win outright
 * and no migration of that artifact is attempted.
 *
 * Ticket clones are guarded: when this file is running from a copy inside `<stateDir>/work/` (a worker's
 * throwaway clone), resolving a default root throws instead of silently reading or writing the deployment's
 * data. Explicit overrides (`home`/`$WHEELCHAIR_AGENT_HOME`, `$SPV_INBOX_DIR`, `$SPV_PREPARE_LOG`) are still
 * honoured, and a sandboxed state dir makes the roots that follow it safe; the one-shot migration refuses
 * outright, because that is the operation that moved a live inbox. `assertNotTicketClone()` is the single
 * implementation, shared with `src/spv/{paths,inbox}.js` and `src/superagent/spv.js`.
 *
 * Pure Node builtins, no dsh imports, no `process.exit`: `install.sh` copies this file into the preset and
 * the webui package, where it must stand alone (see `ARCHITECTURE/layout.md` rule 3).
 */
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Name of the root under `$HOME` when `$WHEELCHAIR_AGENT_HOME` is not set. */
export const HOME_DIR_NAME = '.wheelchair-agent'

/** Environment override for the root; absolute paths only. */
export const HOME_ENV = 'WHEELCHAIR_AGENT_HOME'

/** Superagent's state directory override (the legacy location and the queue/work contract). */
export const STATE_DIR_ENV = 'DSH_SUPERAGENT_STATE_DIR'
/** Explicit inbox override; wins over the data root. */
export const INBOX_ENV = 'SPV_INBOX_DIR'
/** Explicit prepare-log override; wins over the data root. */
export const PREPARE_LOG_ENV = 'SPV_PREPARE_LOG'

/** New settings file name (the JSON content is unchanged; only the location and name move). */
export const SETTINGS_FILE = 'settings.json'
/** Old settings file name, still read (and migrated) from the superagent state directory. */
export const LEGACY_SETTINGS_FILE = 'panel-settings.json'
/** Inbox directory name under the root. */
export const INBOX_DIR = 'inbox'
/** Rebuild-record directory under the root. */
export const RECORDS_DIR = 'records'
/** Log directory under the root. */
export const LOGS_DIR = 'logs'
/** Rebuild record for reclaimed ticket clones. */
export const RECLAIMED_FILE = 'work-reclaimed.jsonl'
/** restart-all audit trail. */
export const RESTART_LOG_FILE = 'restart-all.log'
/** prepare command traceability log. */
export const PREPARE_LOG_FILE = 'prepare.log'
/** What the one-shot move did, so a half-migrated machine can be explained. */
export const MIGRATION_LOG_FILE = 'migration.log'
/** Cross-process lock shared by every migrating reader (the webui host and the SPV side). */
export const MIGRATION_LOCK = '.migrate.lock'

/** Lock retry window and stale age, matching the inbox's per-item lock. */
const LOCK_WAIT_MS = 2000
const LOCK_RETRY_MS = 25
const LOCK_STALE_MS = 30_000

/** Error code of every ticket-clone refusal, so callers and tests can branch on it. */
export const TICKET_CLONE_CODE = 'TICKET_CLONE'

/** `realpath`, falling back to an absolute resolve for a path that does not exist (yet). */
function realPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Typed error for a relative `WHEELCHAIR_AGENT_HOME`: the user must fix the value, not the code. */
function invalidHome(value) {
  const error = new Error(
    `${HOME_ENV} must be an absolute path, got ${JSON.stringify(value)}. ` +
      `fix: set ${HOME_ENV} to an absolute directory such as ${join(homedir(), HOME_DIR_NAME)}.`,
  )
  error.code = 'HOME_INVALID'
  return error
}

/** Trimmed environment value, or `''` when the variable is unset/blank. */
function envValue(env, name) {
  return String(env?.[name] ?? '').trim()
}

/** `WHEELCHAIR_AGENT_HOME` (or the explicit `home` option) as an absolute, resolved path. */
export function resolveHome({ env = process.env, home, stateDir } = {}) {
  const explicit = String(home ?? '').trim()
  if (explicit !== '') {
    if (!isAbsolute(explicit)) throw invalidHome(explicit)
    return resolve(explicit)
  }
  const fromEnv = envValue(env, HOME_ENV)
  if (fromEnv !== '') {
    if (!isAbsolute(fromEnv)) throw invalidHome(fromEnv)
    return resolve(fromEnv)
  }
  // The defaults are the live deployment's data; a ticket clone must not resolve them (read or write).
  // This check is deployment-scoped: overriding only the state dir does not move the default data root.
  const homeDir = envValue(env, 'HOME') || homedir()
  const root = resolve(join(homeDir, HOME_DIR_NAME))
  assertNotTicketClone({
    env,
    stateDir,
    scope: 'deployment',
    what: 'the default data root (settings / inbox / records / logs)',
    target: root,
  })
  return root
}

/**
 * Superagent's state directory, which is where the old copies may live.
 *
 * The explicit `stateDir` option wins (the mount hook and the CLI already resolved it), then
 * `$DSH_SUPERAGENT_STATE_DIR`, then `$DSH_HOME/state/superagent`, then `~/.dsh/state/superagent`.
 */
export function resolveLegacyStateDir({ env = process.env, stateDir } = {}) {
  const explicit = String(stateDir ?? '').trim()
  if (explicit !== '') return resolve(explicit)
  const fromEnv = envValue(env, STATE_DIR_ENV)
  if (fromEnv !== '') return resolve(fromEnv)
  const homeDir = envValue(env, 'HOME') || homedir()
  const dshHome = envValue(env, 'DSH_HOME') || join(homeDir, '.dsh')
  return resolve(join(dshHome, 'state', 'superagent'))
}

/** Is `child` at or under `parent`? Both must already be absolute paths. */
function isInside(parent, child) {
  const rel = relative(parent, child)
  // `relative` returns '' for the root itself and a leading '..' for a sibling; both are not inside.
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Ticket-directory name: the `<short name>-<hex>` shape `src/shared/work.js` reclaims. */
const TICKET_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*-[0-9a-f]{8,64}$/

/**
 * The `.../work` root embedded in a module path, when the last path segment before `<ticket>` is `work`.
 *
 * This is the structural fallback for a deployment whose state dir was moved with `$DSH_HOME` (which the
 * un-overridden-default candidate does not see). A normal checkout has no `work/<ticket>-<hex>/` parent.
 */
function structuralWorkRoot(moduleFile) {
  const parts = moduleFile.split(sep)
  for (let index = 1; index < parts.length - 1; index += 1) {
    if (parts[index] === 'work' && TICKET_DIR.test(parts[index + 1])) {
      return parts.slice(0, index + 1).join(sep) || sep
    }
  }
  return undefined
}

/**
 * Is the data root derived from this `env` still the machine's real `~/.wheelchair-agent`?
 *
 * The structural fallback only matters when the default data root is live; a caller that set `$HOME` to a
 * throwaway directory has sandboxed the data root already, so an over-eager refusal there would be noise.
 */
function dataRootIsDeploymentDefault(env) {
  const homeDir = envValue(env, 'HOME') || homedir()
  return realPath(resolve(join(homeDir, HOME_DIR_NAME))) === realPath(join(homedir(), HOME_DIR_NAME))
}

/**
 * Candidate work roots for this copy, with both the raw and the realpath'd form of each.
 *
 * `scope: 'effective'` follows the state dir the caller is actually using (plus `$DSH_SUPERAGENT_WORK_DIR`),
 * so a fully sandboxed state dir is not the live deployment. `scope: 'deployment'` additionally covers the
 * un-overridden `$HOME/.dsh` default: the default data root (`~/.wheelchair-agent`) does not follow
 * `$DSH_SUPERAGENT_STATE_DIR` or `$DSH_HOME`, so moving those two must not turn a physical ticket clone
 * into a normal checkout.
 */
function workRootCandidates({ env = process.env, stateDir, scope = 'effective' } = {}) {
  const stateDirs = new Set([resolveLegacyStateDir({ env, stateDir })])
  if (scope === 'deployment') {
    const homeDir = envValue(env, 'HOME') || homedir()
    stateDirs.add(resolve(join(homeDir, '.dsh', 'state', 'superagent')))
  }
  const roots = new Set()
  for (const state of stateDirs) {
    const work = join(state, 'work')
    roots.add(resolve(work))
    roots.add(realPath(work))
  }
  const explicitWork = envValue(env, 'DSH_SUPERAGENT_WORK_DIR')
  if (explicitWork !== '' && isAbsolute(explicitWork)) {
    roots.add(resolve(explicitWork))
    roots.add(realPath(explicitWork))
  }
  return roots
}

/**
 * The ticket work root this copy of the code lives under, else `undefined`.
 *
 * A worker's clone is by definition throwaway, while the default settings/inbox/queue/records/log roots
 * belong to the running deployment. Module and work roots are checked both raw and realpath'd, so a
 * symlinked module, state directory or work root cannot slip past.
 *
 * `moduleUrl` is a seam for the tests only; production callers use this module's own `import.meta.url`.
 */
export function ticketCloneRoot({
  env = process.env,
  stateDir,
  moduleUrl = import.meta.url,
  scope = 'effective',
} = {}) {
  const modulePath = resolve(fileURLToPath(moduleUrl))
  const moduleFile = realPath(modulePath)
  const roots = workRootCandidates({ env, stateDir, scope })
  if (scope === 'deployment' && dataRootIsDeploymentDefault(env)) {
    const structural = structuralWorkRoot(moduleFile)
    if (structural !== undefined) roots.add(structural)
  }
  for (const workRoot of roots) {
    if (isInside(workRoot, modulePath) || isInside(workRoot, moduleFile)) return workRoot
  }
  return undefined
}

/** The refusal for resolving a default root from a clone: say what, where, and the environment to set. */
function cloneRefusal(what, target, moduleFile, workRoot) {
  const attempted = target === undefined ? '' : ` at ${target}`
  return (
    `refusing to resolve ${what}${attempted} from a ticket clone: this copy of wheelchair-agent lives at ` +
    `${moduleFile} inside ${workRoot}, so its default roots point at the live deployment's operator data. ` +
    'Reads are refused too, because a throwaway clone must fail before it can touch that data.\n' +
    'fix: point every root at a sandbox, then retry:\n' +
    '  sandbox=$(mktemp -d)\n' +
    '  export WHEELCHAIR_AGENT_HOME=$sandbox\n' +
    '  export SPV_INBOX_DIR=$sandbox/inbox\n' +
    '  export SPV_QUEUE_DIR=$sandbox/spv\n' +
    '  export DSH_SUPERAGENT_STATE_DIR=$sandbox/state\n' +
    "In a Node test, use mkdtemp(join(tmpdir(), 'wheelchair-agent-')) and set the same four variables " +
    'before importing this module.'
  )
}

/** The refusal for the one-shot migration: it is deployment-only, so a clone may never run it. */
function migrationRefusal(target, moduleFile, workRoot) {
  const attempted = target === undefined ? '' : ` for ${target}`
  return (
    `refusing to run the data-root migration${attempted} from a ticket clone: this copy of wheelchair-agent ` +
    `lives at ${moduleFile} inside ${workRoot}, and the migration is what moved the operator's live inbox. ` +
    'fix: run it from the installed preset or a normal checkout.'
  )
}

/**
 * Throw when `what` is a default root (or the migration) and this module is a ticket clone.
 *
 * This is the single implementation shared by `resolveHome()`, `src/spv/paths.js` (the queue root),
 * `src/spv/inbox.js` (the inbox root) and `src/superagent/spv.js` (the Source's fallback queue), so all
 * refuse with the same wording. Callers must skip this check when the path was explicitly overridden: an
 * override is always honoured. `target` is the concrete path the caller was about to use, and the
 * deployment scope is for roots whose default does not follow the state dir (the data root).
 */
export function assertNotTicketClone({
  env = process.env,
  stateDir,
  moduleUrl = import.meta.url,
  what = 'a default root',
  target,
  migration = false,
  scope = 'effective',
} = {}) {
  const workRoot = ticketCloneRoot({ env, stateDir, moduleUrl, scope })
  if (workRoot === undefined) return
  const moduleFile = realPath(fileURLToPath(moduleUrl))
  const error = new Error(
    migration
      ? migrationRefusal(target, moduleFile, workRoot)
      : cloneRefusal(what, target, moduleFile, workRoot),
  )
  error.code = TICKET_CLONE_CODE
  error.workRoot = workRoot
  throw error
}

/**
 * A directory exists. An unreadable path reads as false: `resolveSettings` promises to degrade rather than
 * throw, and the migration then simply keeps the fallback (the reader that can open it still works).
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    if (error.code === 'EACCES' || error.code === 'EPERM') return false
    throw error
  }
}

/** A directory exists and holds at least one entry (an install-created empty inbox is not data). */
function dirHasEntries(path) {
  try {
    return readdirSync(path).length > 0
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    if (error.code === 'EACCES' || error.code === 'EPERM') return false
    throw error
  }
}

/** Is this artifact present at `path`? Directories count only when they hold something. */
function presentAt(artifact, path) {
  return artifact.kind === 'dir' ? dirHasEntries(path) : existsSync(path)
}

/**
 * Every path this project owns, new and old. Pure: it does not touch the filesystem.
 *
 * `override` marks `$SPV_INBOX_DIR` / `$SPV_PREPARE_LOG`: those paths are used as given, keep their
 * today-before precedence, and are never migrated.
 */
export function dataPaths({ env = process.env, home, stateDir } = {}) {
  const root = resolveHome({ env, home, stateDir })
  const legacyStateDir = resolveLegacyStateDir({ env, stateDir })
  const inboxOverride = envValue(env, INBOX_ENV)
  const prepareOverride = envValue(env, PREPARE_LOG_ENV)
  const pathOf = (relative, legacyRelative) => ({
    current: join(root, relative),
    legacy: join(legacyStateDir, legacyRelative),
    kind: 'file',
    override: false,
  })
  return {
    root,
    legacyStateDir,
    logs: join(root, LOGS_DIR),
    records: join(root, RECORDS_DIR),
    migrationLog: join(root, LOGS_DIR, MIGRATION_LOG_FILE),
    settings: {
      current: join(root, SETTINGS_FILE),
      legacy: join(legacyStateDir, LEGACY_SETTINGS_FILE),
      kind: 'file',
      override: false,
    },
    inbox: {
      current: inboxOverride || join(root, INBOX_DIR),
      legacy: inboxOverride ? '' : join(legacyStateDir, 'inbox'),
      kind: 'dir',
      override: inboxOverride !== '',
    },
    reclaimed: pathOf(join(RECORDS_DIR, RECLAIMED_FILE), RECLAIMED_FILE),
    restartLog: pathOf(join(LOGS_DIR, RESTART_LOG_FILE), RESTART_LOG_FILE),
    prepareLog: {
      current: prepareOverride || join(root, LOGS_DIR, PREPARE_LOG_FILE),
      legacy: prepareOverride ? '' : join(legacyStateDir, PREPARE_LOG_FILE),
      kind: 'file',
      override: prepareOverride !== '',
    },
  }
}

/** The five artifacts that move, in one list so every caller agrees on what "the layout" means. */
export function dataArtifacts(paths) {
  return [paths.settings, paths.inbox, paths.reclaimed, paths.restartLog, paths.prepareLog]
}

/** Is the artifact present at its new place? */
function present(artifact) {
  return presentAt(artifact, artifact.current)
}

/** Is the artifact present at its old place? Explicit overrides have no old place. */
function legacyPresent(artifact) {
  return !artifact.override && artifact.legacy !== '' && presentAt(artifact, artifact.legacy)
}

/**
 * Describe which layout is on disk without changing anything.
 *
 * `layout` is `new`, `old`, `both` or `none`; `migrationPending` is true when at least one artifact still
 * has an old copy and no new one (an empty install-created inbox directory does not count as new).
 */
export function describeData({ env = process.env, home, stateDir } = {}) {
  const paths = dataPaths({ env, home, stateDir })
  // Describing the layout inspects the legacy state root to decide the fallback. In a clone that is the
  // live deployment's state dir, so this read is refused as well; a full sandbox overrides that root too.
  assertNotTicketClone({
    env,
    stateDir,
    what: 'the default legacy state root (settings / inbox / records / logs)',
    target: paths.legacyStateDir,
  })
  const artifacts = dataArtifacts(paths)
  // Explicit overrides ($SPV_INBOX_DIR / $SPV_PREPARE_LOG) are outside the root and never migrate, so they
  // do not make the layout "new" or "both"; they are listed as paths, not as migration state.
  const managed = artifacts.filter(artifact => !artifact.override)
  const isOld = managed.some(legacyPresent)
  // install.sh creates an empty root up front; that is the new layout, not "none". When only old data
  // exists (an upgraded machine), the layout is still "old" even if the empty root was just created.
  const isNew = managed.some(present) || (isDirectory(paths.root) && !isOld)
  return {
    ...paths,
    layout: isNew && isOld ? 'both' : isNew ? 'new' : isOld ? 'old' : 'none',
    migrationPending: artifacts.some(artifact => !artifact.override && !present(artifact) && legacyPresent(artifact)),
  }
}

/** Resolve the path a caller should actually use: the new one when it exists, else the old fallback. */
function effectivePath(artifact) {
  if (artifact.override) return artifact.current
  if (artifact.kind === 'dir') {
    if (dirHasEntries(artifact.current)) return artifact.current
    if (legacyPresent(artifact)) return artifact.legacy
    return artifact.current
  }
  if (existsSync(artifact.current)) return artifact.current
  if (legacyPresent(artifact)) return artifact.legacy
  return artifact.current
}

/** Best-effort append to the migration log; returns false when the root cannot hold the log. */
function writeMigrationLog(paths, text) {
  try {
    mkdirSync(paths.logs, { recursive: true })
    appendFileSync(paths.migrationLog, `[${new Date().toISOString()}] ${text}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Default migration logger: the root's log, else stderr, so a failed move is never silent. */
function migrationLogger(paths) {
  return text => {
    if (writeMigrationLog(paths, text)) return
    try {
      process.stderr.write(`wheelchair-agent: ${text}\n`)
    } catch {
      // Nothing else to do; the fallback path still works.
    }
  }
}

/** Retry a persistently failing migration at most this often, so a broken path cannot flood the log. */
const FAILURE_RETRY_MS = 30_000
/** Process-local failure marks and one-time "both layouts" notes, keyed by root + legacy state dir. */
const migrationFailures = new Map()
const bothLayoutWarned = new Set()

/** Key for the process-local migration state above. */
function migrationKey(paths) {
  return `${paths.root}\u0000${paths.legacyStateDir}`
}

/**
 * A cheap fingerprint of the failure-relevant filesystem state. A retry is allowed immediately when it
 * changes (the lock is released, the root becomes a directory, permissions change), so a throttled failure
 * does not delay the recovery a user just made.
 */
function migrationSignature(paths) {
  try {
    const info = statSync(paths.root)
    return `${info.isDirectory() ? 'd' : 'f'}:${info.mode}:${info.mtimeMs}:${existsSync(join(paths.root, MIGRATION_LOCK))}`
  } catch {
    return `none:${existsSync(join(paths.root, MIGRATION_LOCK))}`
  }
}

/** Synchronous sleep; the migration lock is held for milliseconds, so blocking is the honest shape. */
function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, ms)
}

/**
 * Run `fn` under the cross-process migration lock, reaping a lock left by a crashed process.
 *
 * The lock is a plain file created with `O_EXCL`, the same idiom `src/spv/inbox.js` uses for item writes,
 * so the webui host half and the SPV session arbitrate through the filesystem alone. A hold longer than
 * 30 s is stale; after 2 s of waiting the caller gives up, logs, and keeps using the fallback.
 */
function withMigrationLock(root, fn) {
  mkdirSync(root, { recursive: true })
  const lock = join(root, MIGRATION_LOCK)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = openSync(lock, 'wx', 0o644)
      try {
        writeSync(handle, `${process.pid} ${new Date().toISOString()}\n`)
      } finally {
        closeSync(handle)
      }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let info
      try {
        info = statSync(lock)
      } catch (statError) {
        if (statError.code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        // Reap by rename: only the rename winner unlinks, so a fresh lock acquired between stat and
        // unlink is never deleted out from under its owner.
        const reaped = `${lock}.reap.${process.pid}.${Date.now()}`
        try {
          renameSync(lock, reaped)
          unlinkSync(reaped)
        } catch (reapError) {
          if (reapError.code !== 'ENOENT') throw reapError
        }
        continue
      }
      if (Date.now() >= deadline) {
        const locked = new Error(
          `the data migration lock ${lock} is held; keeping the old paths until it is released.`,
        )
        locked.code = 'MIGRATION_LOCKED'
        throw locked
      }
      sleepSync(LOCK_RETRY_MS)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lock)
    } catch {
      // Already gone (stale reaping by a later process): nothing to clean up.
    }
  }
}

/** Is the old copy still there after a non-move? Used to distinguish a lost race from a real failure. */
function legacyStillThere(artifact) {
  return artifact.override ? false : legacyPresent(artifact)
}

/**
 * Move one path, falling back to copy-then-unlink across filesystems.
 *
 * A cross-device rename (EXDEV) is common when `$WHEELCHAIR_AGENT_HOME` lives on another mount. Copying to
 * a staging sibling first keeps the destination whole, so a failed copy never replaces the old data.
 */
function installPath(legacy, current, kind, log) {
  try {
    renameSync(legacy, current)
    return
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
  }
  const staging = `${current}.migrating-${process.pid}-${Date.now()}`
  try {
    if (kind === 'dir') {
      cpSync(legacy, staging, { recursive: true, force: false, errorOnExist: true })
    } else {
      copyFileSync(legacy, staging)
    }
    renameSync(staging, current)
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // Best effort; the completed destination is what matters.
    }
  }
  try {
    if (kind === 'dir') rmSync(legacy, { recursive: true, force: false })
    else unlinkSync(legacy)
  } catch (error) {
    log(`copied ${legacy} -> ${current} but could not remove the old copy: ${error.message}`)
  }
}

/** Move one artifact if its new path is absent and its old path exists. Returns true when it moved. */
function moveArtifact(artifact, log) {
  if (artifact.override) return false
  const { current, legacy, kind } = artifact
  if (kind === 'dir') {
    if (dirHasEntries(current)) return false
    if (!dirHasEntries(legacy)) return false
  } else {
    if (existsSync(current)) return false
    if (!existsSync(legacy)) return false
  }
  try {
    if (kind === 'dir' && isDirectory(current)) {
      // install.sh creates an empty inbox up front; treat that as "absent" so the old items still move.
      rmdirSync(current)
    }
    mkdirSync(dirname(current), { recursive: true })
    installPath(legacy, current, kind, log)
    log(`moved ${legacy} -> ${current}`)
    return true
  } catch (error) {
    if (error.code === 'ENOENT' && presentAt(artifact, current)) {
      // Another process won the race between our check and the rename; its move is the one that counts.
      return false
    }
    log(`failed to move ${legacy} -> ${current}: ${error.message}; keeping ${legacy} reachable`)
    return false
  }
}

/**
 * The one-shot forward move. Safe to call on every resolution: with both paths in place it is two stats.
 *
 * `log` defaults to `<root>/logs/migration.log`; callers that already have a logger (the mount hook) may
 * pass their own, which is also how tests observe a forced failure without depending on the file.
 */
export function migrateData({ env = process.env, home, stateDir, log } = {}) {
  // `dataPaths` refuses the default data root first (with the sandbox instructions); this check then
  // refuses the migration even when the caller pointed the data root somewhere explicit.
  const paths = dataPaths({ env, home, stateDir })
  assertNotTicketClone({
    env,
    stateDir,
    what: 'the data-root migration',
    target: `${paths.root} (from ${paths.legacyStateDir})`,
    migration: true,
  })
  const emit = typeof log === 'function' ? log : migrationLogger(paths)
  const key = migrationKey(paths)
  let candidates
  try {
    candidates = dataArtifacts(paths).filter(artifact => {
      if (artifact.override) return false
      return artifact.kind === 'dir'
        ? !dirHasEntries(artifact.current) && dirHasEntries(artifact.legacy)
        : !existsSync(artifact.current) && existsSync(artifact.legacy)
    })
  } catch (error) {
    // A permission problem on one side must degrade to the fallback, never make every settings read throw.
    migrationFailures.set(key, { at: Date.now(), signature: migrationSignature(paths) })
    emit(`migration check failed: ${error.message}; keeping the fallback paths`)
    return []
  }
  if (candidates.length === 0) {
    if (!bothLayoutWarned.has(key)) {
      const both = dataArtifacts(paths).some(
        artifact => !artifact.override && present(artifact) && legacyPresent(artifact),
      )
      if (both) {
        bothLayoutWarned.add(key)
        emit('both old and new data exist; readers use the new path and the old copy is left untouched')
      }
    }
    return []
  }
  // One process must not retry a persistent failure (unwritable root, held lock) every injector tick.
  const failed = migrationFailures.get(key)
  if (
    failed !== undefined &&
    Date.now() - failed.at < FAILURE_RETRY_MS &&
    failed.signature === migrationSignature(paths)
  ) {
    return []
  }
  let failedNow = false
  const moved = []
  try {
    withMigrationLock(paths.root, () => {
      for (const artifact of candidates) {
        if (moveArtifact(artifact, emit)) {
          moved.push({ from: artifact.legacy, to: artifact.current })
        } else if (legacyStillThere(artifact)) {
          failedNow = true
        }
      }
    })
  } catch (error) {
    failedNow = true
    emit(`migration skipped: ${error.message}; keeping the fallback paths`)
  }
  if (failedNow) migrationFailures.set(key, { at: Date.now(), signature: migrationSignature(paths) })
  else migrationFailures.delete(key)
  return moved
}

/**
 * Resolve every path a consumer should use, migrating first by default.
 *
 * The returned object is flat for the common cases (`settings`, `inbox`, ...) and keeps `root`,
 * `legacyStateDir`, `layout`, `migrationPending` for `wheelchair-agent where` and diagnostics.
 */
export function resolveData({ env = process.env, home, stateDir, migrate = true, log } = {}) {
  // Resolve (guarded) paths before any filesystem read: a forgotten clone must fail on its first line,
  // and the migration must refuse before `describeData` stats the live legacy state directory.
  const paths = dataPaths({ env, home, stateDir })
  if (migrate) {
    assertNotTicketClone({
      env,
      stateDir,
      what: 'the data-root migration',
      target: `${paths.root} (from ${paths.legacyStateDir})`,
      migration: true,
    })
  }
  const before = describeData({ env, home, stateDir })
  if (migrate) migrateData({ env, home, stateDir, log })
  const described = migrate ? describeData({ env, home, stateDir }) : before
  return {
    root: described.root,
    legacyStateDir: described.legacyStateDir,
    logs: described.logs,
    records: described.records,
    migrationLog: described.migrationLog,
    settings: effectivePath(paths.settings),
    inbox: effectivePath(paths.inbox),
    reclaimed: effectivePath(paths.reclaimed),
    restartLog: effectivePath(paths.restartLog),
    prepareLog: effectivePath(paths.prepareLog),
    layout: described.layout,
    migrationPending: described.migrationPending,
  }
}
