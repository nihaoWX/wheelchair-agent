/**
 * File-queue layout of the `spv` Source and the small helpers that read and write it.
 *
 * Layout under one root directory:
 *   pending/   one .json per task, written by `scripts/spv_send.py`
 *   done/      a task moved here by an atomic rename is consumed; also `<name>.json.bad` for unparsable files
 *   outbox/    one .json per Channel message, written by the plugin, read by `scripts/spv_read.py`
 *   outbox/read/  messages the reader consumed (`--consume`)
 *
 * There is no cursor: the rename out of `pending/` is the consumed marker, so a crash replays at most the task that
 * was in flight and a task is never taken in twice.
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** Directory name of the queue inside the Source's root, which defaults to `<stateDir>/spv`. */
export const QUEUE_NAME = 'spv'

/** The four directories of one queue root. */
export function dirsOf(root) {
  const outbox = join(root, 'outbox')
  return { root, pending: join(root, 'pending'), done: join(root, 'done'), outbox, read: join(outbox, 'read') }
}

/** Create the directories the plugin owns. `outbox/read` belongs to the reader and is left to it. */
export async function ensureDirs(dirs) {
  for (const dir of [dirs.root, dirs.pending, dirs.done, dirs.outbox]) await mkdir(dir, { recursive: true })
}

/** Names of the task files waiting in `pending/`, oldest first; a missing directory reads as empty. */
export async function pendingNames(dirs) {
  const names = await readdir(dirs.pending).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const files = names.filter(name => name.endsWith('.json') && !name.startsWith('.'))
  const stamped = await Promise.all(files.map(async name => {
    const info = await stat(join(dirs.pending, name)).catch(() => undefined)
    return { name, mtime: info?.mtimeMs ?? 0 }
  }))
  return stamped.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name)).map(item => item.name)
}

/** Read and parse one task file; throws when it is not valid JSON. */
export async function readTask(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

/** Move a consumed task into `done/`. A name already taken there is overwritten: the task has been taken in either way. */
export async function consumeTask(file, dirs) {
  await rename(file, join(dirs.done, basename(file)))
}

/** Move an unparsable file into `done/` with a `.bad` suffix so it stops being retried but stays inspectable. */
export async function quarantineTask(file, dirs) {
  const target = join(dirs.done, `${basename(file)}.bad`)
  try {
    await rename(file, target)
  } catch (error) {
    // A rename across a full disk or a stale lock is not worth failing the round: drop the file only if it is still there.
    if (error.code === 'EXDEV' || error.code === 'EPERM') { await unlink(file).catch(() => {}); return }
    throw error
  }
}

/** Write one outbox message atomically, keyed by its id so a repeated send overwrites instead of duplicating. */
export async function writeMessage(dirs, message) {
  await mkdir(dirs.outbox, { recursive: true })
  const safe = String(message.id).replace(/[^A-Za-z0-9._-]/g, '_')
  const temporary = join(dirs.outbox, `.tmp-${safe}-${process.pid}-${Date.now()}`)
  await writeFile(temporary, `${JSON.stringify(message, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
  await rename(temporary, join(dirs.outbox, `${safe}.json`))
}
