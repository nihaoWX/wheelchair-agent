/**
 * The `spv` Source kind: it turns tasks from the local file queue into Triggers, and Channel messages back into files
 * the entry session reads.
 *
 * A task must arrive as an explicit request, so it creates a Ticket without an Assessment. That needs all three facts
 * `docs/002-authorization.md` names:
 *
 *   human: true               a person wrote the task
 *   addressed: 'mention'      it addresses the agent
 *   actor.id in policy.allowed
 *
 * The queue holds one JSON task per file; `src/spv/dispatch.js` writes it and `src/shared/queue.js` documents the layout.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { integer, object, records, text } from '../shared/schema.js'
import { dirsOf, writeMessage } from '../shared/queue.js'

/** The Source kind id: the trigger `source`, the thread-key prefix, the settings block and the policy key. */
export const SOURCE = 'spv'
/** Thread a task belongs to when its file names none. */
export const DEFAULT_THREAD = 'main'
/** Actor id a task carries when its file names none; the policy's `allowed` list must hold it. */
export const DEFAULT_ACTOR = 'operator'
const THREAD_UNSAFE = /[^A-Za-z0-9._-]+/g

/** Fixed English health texts, keyed like dsh-superagent's own so the panel localizes the same `code` values. */
const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  pollFailures: '{count} consecutive failed polls; last: {error}',
}

/** Build one health report; `code` is what the panel localizes and `detail` what the status script prints. */
export function health(state, code, values = {}) {
  const detail = HEALTH_TEXT[code].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '')
  return { state, detail, code, ...(Object.keys(values).length ? { values } : {}) }
}

/** Stable content-derived id, built the way dsh-superagent builds its own. */
export function key(...values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
}

/** Full Thread key of a Source thread id: `main` becomes `spv:main`. */
export function threadKey(id) {
  return `${SOURCE}:${id}`
}

/** Reduce a task's thread name to what Thread keys and file names accept. */
export function threadOf(value) {
  const name = String(value ?? '').trim().replace(THREAD_UNSAFE, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64)
  return name || DEFAULT_THREAD
}

/** Queue root used before the deployment is resolved: `<stateDir>/spv`. */
export function fallbackRoot() {
  const stateDir = process.env.DSH_SUPERAGENT_STATE_DIR || join(homedir(), '.dsh', 'state', 'superagent')
  return join(stateDir, 'spv')
}

/** The queue root the plugin reads and writes; it follows the saved configuration without a restart. */
export class Queue {
  #root = fallbackRoot()

  get root() { return this.#root }

  /** Set the root, ignoring an empty value so the fallback stays until a directory is configured. */
  set root(value) {
    const next = String(value ?? '').trim()
    if (next) this.#root = next
  }

  /** Root for `configured`: the configured directory, else `stateDir/spv`. */
  resolve(configured, stateDir) {
    const next = String(configured ?? '').trim()
    this.#root = next || join(stateDir, 'spv')
    return this.#root
  }

  dirs() { return dirsOf(this.#root) }
}

/** Configuration of the Source instance, as the settings form edits it. */
export const ConfigSchema = object({
  queueDir: text({ max: 4096 }),
  pollSeconds: integer({ fallback: 2, min: 1, max: 3600 }),
  actor: text({ fallback: DEFAULT_ACTOR, min: 1, max: 200 }),
})

const taskAt = value => {
  const time = Date.parse(String(value ?? ''))
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString()
}

/**
 * Translate one task file into a Trigger, or undefined when it carries no text.
 * The id comes from the task's own id (else its file name), so replaying the same file is a duplicate, not new work.
 */
export function triggerOf(task, file, config) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return undefined
  const body = typeof task.text === 'string' ? task.text.trim() : ''
  if (!body) return undefined
  const queueId = typeof task.id === 'string' && task.id.trim() ? task.id.trim() : file.replace(/\.json$/, '')
  const thread = threadOf(task.thread)
  const actor = typeof task.actor === 'string' && task.actor.trim() ? task.actor.trim() : config.actor
  const { text: _text, thread: _thread, actor: _actor, ...rest } = task
  return {
    id: `${SOURCE}:${queueId}`,
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: actor },
    human: true,
    addressed: 'mention',
    at: taskAt(task.at),
    text: body,
    channel: { source: SOURCE, thread, address: { thread } },
    meta: { ...rest, queueId, thread, file, actor },
  }
}

/**
 * The Channel: writes each outbound message into `outbox/`, keyed by the message id so a retried send overwrites
 * instead of duplicating. Only acknowledgements, answers, results and attention questions reach a Channel; a worker's
 * progress has no reply purpose and never gets here.
 */
export function channelFor(queue) {
  return {
    link: address => ({
      url: '',
      label: {
        zh: `本机队列线程 ${threadOf(address.thread)}`,
        en: `Local queue thread ${threadOf(address.thread)}`,
      },
    }),
    async send(_host, message) {
      const thread = threadOf(message.channel?.thread ?? message.channel?.address?.thread)
      await writeMessage(queue.dirs(), {
        id: message.id,
        source: SOURCE,
        thread,
        kind: message.kind,
        text: message.text,
        at: new Date().toISOString(),
        address: message.channel?.address ?? {},
        ...(message.ticketId ? { ticketId: message.ticketId } : {}),
      })
      return 'sent'
    },
  }
}

/** The Source kind, bound to the queue the plugin watches. */
export function spvKind(queue) {
  return {
    kind: SOURCE,
    title: { zh: '本机队列', en: 'Local queue' },
    description: {
      zh: '本机文件队列里的任务：入口会话把任务写进待处理目录，结果和需要决策的问题写回待读目录。',
      en: 'Tasks in a local file queue: the entry session writes them into the pending directory, and results and questions come back in the outbox one.',
    },
    schema: ConfigSchema,
    fields: [
      {
        key: 'queueDir',
        type: 'text',
        label: { zh: '队列目录', en: 'Queue directory' },
        hint: {
          zh: '留空表示 <stateDir>/spv。目录里的 pending/、done/、outbox/ 由插件自动建立。',
          en: 'Empty means <stateDir>/spv. The plugin creates pending/, done/ and outbox/ inside it.',
        },
      },
      {
        key: 'pollSeconds',
        type: 'number',
        advanced: true,
        min: 1,
        max: 3600,
        label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      },
      {
        key: 'actor',
        type: 'text',
        label: { zh: '任务未写明身份时用的身份', en: 'Identity of a task that names none' },
        hint: {
          zh: '这个 id 必须在本来源策略的允许名单里，否则任务只会被记录为未准入。',
          en: 'This id must be on this Source\'s policy list, or the task is recorded as not admitted.',
        },
      },
    ],
    health: [SOURCE],
    channel: channelFor(queue),
    policy: {
      schema: object({
        allowed: records({ fallback: [{ id: DEFAULT_ACTOR }] }),
      }),
      fields: [
        {
          key: 'allowed',
          type: 'rows',
          label: { zh: '能在本机队列里派任务的身份', en: 'Identities that may originate work from the local queue' },
          columns: [
            { key: 'id', type: 'text', label: { zh: '身份', en: 'Identity' } },
            { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
          ],
        },
      ],
      explicit: {
        zh: '队列里的任务文件都算作列出的身份明确发给智能体的请求，因此不再经过评估。',
        en: 'Every task file counts as an explicit request from a listed identity, so it is routed without an assessment.',
      },
    },
    environment: {
      variables: [
        {
          key: 'DSH_SUPERAGENT_SPV_THREAD',
          description: {
            zh: '接下工单的队列线程；工单不是从本机队列来的时为空',
            en: 'The queue thread that started the ticket; empty when the ticket did not start on the local queue',
          },
        },
        {
          key: 'DSH_SUPERAGENT_SPV_PROJECT',
          description: {
            zh: '本工单要操作的项目，取自任务文件的 project 字段（通常是 tools/<name> 或 research/<name>）；' +
              '执行器的 prepare 命令用它决定把哪个项目 clone 进 worker 目录',
            en: 'The project this ticket works on, from the task file\'s project field (usually tools/<name> or ' +
              'research/<name>); the executor prepare command uses it to choose which project to clone into the worker directory',
          },
        },
      ],
      values: ({ trigger }) => ({
        DSH_SUPERAGENT_SPV_THREAD: trigger?.source === SOURCE ? String(trigger.meta?.thread ?? trigger.channel?.thread ?? '') : '',
        DSH_SUPERAGENT_SPV_PROJECT: trigger?.source === SOURCE ? String(trigger.meta?.project ?? '') : '',
      }),
    },
  }
}
