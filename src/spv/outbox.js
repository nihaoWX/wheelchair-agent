/**
 * 读 `<queue>/outbox/`：superagent 的 `spv` Channel 把回信一条一个 `.json` 写在这里。
 *
 * 关心三种 kind：`reply`（含工单结果）、`notice`，以及别的部署转来的 `review`。`acknowledgement` 不算结果，
 * 它是"接单了"，交给 `spv_status` 展示即可。
 *
 * 这里**没有**阻塞读取器：结果由 `src/spv/injector.js` 在后台消费并注入会话，本文件只提供读/消费的原语。
 * 消费标记沿用本包既有约定：`rename(outbox/x.json → outbox/read/x.json)` 是原子的"已读"，而 `consumeMessage`
 * 只在真正搬走文件时返回 id、被别的读者抢先时返回 undefined，所以同一条消息不会被读两次，跨进程也成立。
 */
import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** 算作"结果"的消息种类。 */
export const RESULT_KINDS = new Set(['reply', 'notice', 'review'])

/** outbox 里尚未消费的消息文件，最旧的在前；临时文件与子目录跳过。 */
async function messageFiles(dirs) {
  const entries = await readdir(dirs.outbox).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const files = entries.filter(name => name.endsWith('.json') && !name.startsWith('.'))
  const stamped = await Promise.all(files.map(async name => {
    const info = await stat(join(dirs.outbox, name)).catch(() => undefined)
    return { name, mtime: info?.mtimeMs ?? 0 }
  }))
  return stamped.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name)).map(item => join(dirs.outbox, item.name))
}

/** 读一条消息；读不动或不是对象时返回 undefined（当作不存在，而不是让整轮失败）。 */
async function readMessage(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value, file } : undefined
  } catch {
    return undefined
  }
}

/** 消息所属的队列线程；`channel.address.thread` 是早期布局，也一并认。 */
export function threadOf(message) {
  return String(message.thread ?? message.address?.thread ?? 'main')
}

/** outbox 里全部未消费消息，最旧的在前。`thread` 给定时只留该线程。 */
export async function unreadMessages(dirs, thread) {
  const messages = []
  for (const file of await messageFiles(dirs)) {
    const message = await readMessage(file)
    if (message === undefined) continue
    if (thread !== undefined && threadOf(message) !== thread) continue
    messages.push(message)
  }
  return messages
}

/**
 * 把一条消息移入 `outbox/read/`，返回**本次调用**真正搬走的那条消息的 id。
 *
 * 文件已经不在 outbox 里（另一个读者先搬走了）时返回 `undefined`：调用方必须靠这个返回值判断「这条是不是我
 * 消费的」，否则两个读者会各注入一次。重复消费同一个文件不是错误，只是这一次不再是消费方。
 */
export async function consumeMessage(dirs, message) {
  const id = String(message.id ?? basename(message.file))
  const target = join(dirs.read, basename(message.file))
  try {
    await mkdir(dirs.read, { recursive: true })
    await rename(message.file, target)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  return id
}

/** `pending/` 里还没被 Source 取走的任务，最旧的在前。 */
export async function pendingTasks(dirs) {
  const entries = await readdir(dirs.pending).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const files = entries.filter(name => name.endsWith('.json') && !name.startsWith('.'))
  const stamped = await Promise.all(files.map(async name => {
    const info = await stat(join(dirs.pending, name)).catch(() => undefined)
    return { name, mtime: info?.mtimeMs ?? 0 }
  }))
  stamped.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
  const tasks = []
  for (const { name } of stamped) {
    const file = join(dirs.pending, name)
    let value
    try {
      value = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    tasks.push({
      id: String(value.id ?? name.replace(/\.json$/, '')),
      thread: String(value.thread ?? 'main'),
      project: String(value.project ?? ''),
      at: String(value.at ?? ''),
      text: String(value.text ?? '').trim(),
    })
  }
  return tasks
}
