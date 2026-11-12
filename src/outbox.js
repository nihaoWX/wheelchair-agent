/**
 * 读 `<queue>/outbox/`：superagent 的 `spv` Channel 把回信一条一个 `.json` 写在这里。
 *
 * 只关心两种 kind：`reply`（含工单结果）与 `notice`。`acknowledgement` 不算结果，它是"接单了"，交给 `spv_status` 展示即可。
 *
 * 消费标记沿用本包既有约定：`rename(outbox/x.json → outbox/read/x.json)` 是原子的"已读"，所以同一条消息不会被读两次，
 * 跨进程也成立（`scripts/spv_read.py --consume` 用的是同一个目录）。
 */
import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** 算作"结果"的消息种类。 */
export const RESULT_KINDS = new Set(['reply', 'notice'])
/** 轮询间隔（毫秒）。Source 自己 2s 轮询 pending，回信的等待粒度 1s 足够。 */
const POLL_MS = 1000

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

/** 把一条消息移入 `outbox/read/`，返回它的 id。重复消费同一个文件不是错误（另一个进程可能先移走了）。 */
export async function consumeMessage(dirs, message) {
  const id = String(message.id ?? basename(message.file))
  const target = join(dirs.read, basename(message.file))
  try {
    await mkdir(dirs.read, { recursive: true })
    await rename(message.file, target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return id
}

/**
 * 等到该线程出现一条 `reply` 或 `notice`，消费它并返回。
 *
 * 超时抛错而不是返回空串：空串会让调用方以为 worker 什么都没说。错误里带上超时时长、线程、以及此刻队列里还剩什么，
 * 并给出能照抄的排查命令。
 */
export async function waitForResult(dirs, { thread, timeoutSeconds, signal }) {
  const deadline = Date.now() + timeoutSeconds * 1000
  for (;;) {
    const messages = await unreadMessages(dirs, thread)
    const found = messages.find(message => RESULT_KINDS.has(String(message.kind)))
    if (found !== undefined) {
      const id = await consumeMessage(dirs, found)
      return { id, kind: String(found.kind), text: String(found.text ?? '').trim(), at: found.at, ticketId: found.ticketId }
    }
    if (signal?.aborted) throw new Error(`spv_result for thread "${thread}" was cancelled before a reply arrived.`)
    if (Date.now() >= deadline) {
      throw new Error(
        `no reply on thread "${thread}" within ${timeoutSeconds}s: the task may still be queued, still running, or ` +
          'failed before answering. Call spv_status (no arguments) to see what is still pending and which messages ' +
          'arrived unclaimed, then call spv_result again with a larger timeout. To inspect the queue yourself: ' +
          `"python3 tools/wheelchair-agent/scripts/spv_read.py --queue ${dirs.root}".`,
      )
    }
    // 睡到下一个检查点，但不越过 deadline；取消由循环顶部的 signal 检查负责。
    await sleep(Math.min(POLL_MS, Math.max(50, deadline - Date.now())))
  }
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
