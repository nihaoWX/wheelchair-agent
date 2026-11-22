/**
 * The file-queue layout of the `spv` Source, moved into `wheelchair-agent-core`.
 *
 * The on-disk contract is unchanged: `pending/` holds task files, `done/` holds consumed and
 * quarantined ones, `outbox/` holds Channel messages and `outbox/read/` holds consumed messages.
 * The rename out of a queue directory is the consumed marker; the binary performs it with the same
 * atomic `rename` and destination names this module used before.
 *
 * This module is also the one process bridge (`runCore`) shared by the moved modules, because
 * `install.sh` and the webui fixture copy `queue.js` but not an extra helper file. The wrappers keep
 * every signature (including the synchronous `dirsOf`) and return `undefined` for the operations
 * that returned nothing. There is no JavaScript fallback.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CORE_ARTIFACT = 'build/artifacts/wheelchair-agent-core-linux-x64'
const CORE_BINARY = `../../${CORE_ARTIFACT}`
const CORE_COMMAND = 'wheelchair-agent-core'
const CORE_TIMEOUT_MS = 5 * 60_000
const CORE_MAX_BUFFER = 16 * 1024 * 1024

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A checkout runs the artifact directly; an installed preset finds the copy install.sh put on PATH. */
function coreBinary() {
  const fromCheckout = fileURLToPath(new URL(CORE_BINARY, import.meta.url))
  if (existsSync(fromCheckout)) return fromCheckout
  // A copied `src/` tree (a ticket clone or a test fixture) has no build output next to it, but the
  // process may have been started at the checkout root; the installed binary is the last resort.
  const fromCwd = resolve(process.cwd(), CORE_ARTIFACT)
  return existsSync(fromCwd) ? fromCwd : CORE_COMMAND
}

/** The one message for a missing/invalid binary: it names the exact build step. */
export function coreHint(detail) {
  return new Error(`the Rust core ${detail}; run "bash build/build-core.sh" to build it`)
}

/**
 * Run one core subcommand. `input` is the request text; the promise-free API matches `spawnSync`
 * because every caller needs the result immediately.
 */
export function runCore(args, input) {
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
  if (!isObject(envelope) || typeof envelope.ok !== 'boolean') {
    throw coreHint('returned an invalid envelope (expected an object with a boolean "ok")')
  }
  if (envelope.ok) {
    if (!Object.hasOwn(envelope, 'data')) throw coreHint('returned an invalid envelope (missing data)')
    if (result.status !== 0) throw coreHint(`exited ${result.status} after reporting success`)
    return envelope.data
  }
  const code = typeof envelope.code === 'string' ? envelope.code : undefined
  const message =
    typeof envelope.message === 'string' && envelope.message !== ''
      ? envelope.message
      : `the Rust core failed (${code ?? 'unknown'})`
  const error = new Error(message)
  if (code !== undefined) error.code = code
  throw error
}

/** Directory name of the queue inside the Source's root, which defaults to `<stateDir>/spv`. */
export const QUEUE_NAME = 'spv'


function queueOp(request) {
  return runCore(['queue-op'], JSON.stringify(request))
}

/** The four directories of one queue root. */
export function dirsOf(root) {
  return queueOp({ op: 'layout', root })
}

/** Create the directories the plugin owns. `outbox/read` belongs to the reader and is left to it. */
export async function ensureDirs(dirs) {
  queueOp({ op: 'ensure-dirs', dirs })
}

/** Names of the task files waiting in `pending/`, oldest first; a missing directory reads as empty. */
export async function pendingNames(dirs) {
  return queueOp({ op: 'pending-names', dirs })
}

/** Read and parse one task file; throws when it is not valid JSON. */
export async function readTask(file) {
  try {
    return queueOp({ op: 'read-task', file })
  } catch (error) {
    // Keep the old `SyntaxError` class for a malformed task file; the message comes from the binary.
    if (error?.code === 'invalid_json') throw new SyntaxError(error.message)
    throw error
  }
}

/** Move a consumed task into `done/`. */
export async function consumeTask(file, dirs) {
  queueOp({ op: 'consume-task', file, dirs })
}

/** Move an unparsable file into `done/` with a `.bad` suffix so it stops being retried but stays inspectable. */
export async function quarantineTask(file, dirs) {
  queueOp({ op: 'quarantine-task', file, dirs })
}

/** Write one outbox message atomically, keyed by its id so a repeated send overwrites instead of duplicating. */
export async function writeMessage(dirs, message) {
  queueOp({ op: 'write-message', dirs, message })
}
