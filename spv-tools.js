/**
 * SPV preset 的 `spv_*` 工具：把任务交给 superagent，并把结果读回来。
 *
 * 这是**工具插件**（`ctx.tools.register`），不是斜杠命令：用户希望 SPV 这个 agent 自己调用它们来派活，所以它们必须出现在
 * 模型的工具表里，由模型决定何时调用。
 *
 * 与 superagent 侧严格分开：本文件不 import `tools/dsh-superagent/` 的任何东西，只按下文描述的文件布局与它对话。
 * 唯一的接口是 `<queue>/{pending,done,outbox}/` 里的 JSON 文件（见 `src/queue.js` 与 `docs/spv-source.md`）。
 *
 * 三个工具：
 *   spv_dispatch  写 pending/，立刻返回 id/thread/project
 *   spv_result    阻塞轮询 outbox/ 直到该 thread 出现 reply/notice，返回 text（同一条消息只消费一次）
 *   spv_status    非阻塞：pending 里还没取走的任务 + 已到但未读的消息
 *
 * 读 outbox/pending 在 `src/outbox.js`，写任务在 `src/dispatch.js`，路径规则在 `src/paths.js`。
 *
 * 为什么不 `import { defineTool } from '@deepseek-ai/dsh-tools'`：本包是用户级 preset 引用的普通目录，不在 dsh 的
 * 安装树里，`@deepseek-ai/dsh-tools` 这个 bare specifier 从本包位置解析不到，preset 会整个 mount 失败。
 * 用原始 JSON Schema 直接注册就没有任何 dsh 包依赖：参数校验由各 `execute` 自己做（校验文案本来也该写在这里）。
 */
import { dirsOf } from './src/queue.js'
import { checkProject, checkTask, checkThread, submitTask } from './src/dispatch.js'
import { probe, serviceDown } from './src/health.js'
import { pendingTasks, unreadMessages, waitForResult } from './src/outbox.js'
import { missingQueue, resolveRoot } from './src/paths.js'

/** 插件名（Loader 诊断里显示的名字）。 */
export const name = 'spv-tools'
/** 需要 `tools` 注册表；不需要任何 superagent 服务，通道只有文件。 */
export const inject = ['tools']

/** `spv_result` 的默认等待秒数。 */
const DEFAULT_TIMEOUT = 300
/** 上限：再长会让工具调用本身变成一次几乎不可取消的挂起。 */
const MAX_TIMEOUT = 1800

/** 一行预览：把正文压成单行，避免工具输出被长文本淹没。 */
function preview(text, limit) {
  const flat = String(text ?? '').trim().replace(/\s+/g, ' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/** 校验秒数；非法值给出能照着改的说明。 */
function checkTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `invalid timeout ${JSON.stringify(value)}: pass a positive number of seconds, for example 300 for five ` +
        'minutes or 60 for a quick task. Omit it to use the 300 second default.',
    )
  }
  return Math.min(Math.round(seconds), MAX_TIMEOUT)
}

/**
 * 三个工具的定义。`root` 由挂载时解析：`queueDir` 设置 > `$SPV_QUEUE_DIR` > `<stateDir>/spv`。
 * 队列目录不存在不在挂载时报错——那时 superagent 可能只是还没启动，报错会挡住整个会话；改由每次调用报。
 */
export function defineSpvTools(root) {
  const dirs = dirsOf(root)

  return [
    {
      name: 'spv_dispatch',
      description:
        'Hand one task to the background superagent service and return immediately. Use it when work should run ' +
        'outside this conversation - a code change, a test run, a repository inspection - so you stay responsive ' +
        'while it runs. The task is a single natural-language instruction; the worker has its own filesystem ' +
        'access and reports once. The project argument selects which project the worker gets: "tools/<name>" or ' +
        '"research/<name>". Afterwards call spv_result on the same thread to read the answer. Fails instead of ' +
        'queuing when the service is not running, because a queued task with no reader looks dispatched but never runs.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['project', 'task'],
        properties: {
          project: {
            type: 'string',
            description: 'Project the worker operates on: "tools/<name>" or "research/<name>".',
          },
          task: {
            type: 'string',
            description: 'The instruction, in natural language, with the outcome and how to verify it.',
          },
          thread: {
            type: 'string',
            description: 'Conversation thread for this work; defaults to "main". Replies come back on the same thread.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'thread', 'project'],
          properties: {
            id: { type: 'string' },
            thread: { type: 'string' },
            project: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Dispatched ${value.id} on thread "${value.thread}" for project ${value.project}. ` +
            `Call spv_result with thread "${value.thread}" to read the reply.`,
        }],
      },
      async execute(args) {
        const project = checkProject(args.project)
        const task = checkTask(args.task)
        const thread = checkThread(args.thread)
        const health = await probe()
        if (!health.alive) throw serviceDown(health)
        try {
          const record = await submitTask(dirs, { project, task, thread })
          return { id: record.id, thread: record.thread, project: record.project }
        } catch (error) {
          if (error.code === 'ENOENT') throw missingQueue(root)
          throw error
        }
      },
    },
    {
      name: 'spv_result',
      description:
        'Wait for the superagent reply on one thread and return its text. Call it after spv_dispatch, or when the ' +
        'user asks what the background work produced. It blocks until a reply or notice arrives, and each message ' +
        'is returned only once, so a second call waits for the next one. On timeout it reports what is still ' +
        'outstanding and what to check instead of guessing.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['thread'],
        properties: {
          thread: {
            type: 'string',
            description: 'Thread to read, exactly as passed to spv_dispatch (default there is "main").',
          },
          timeout: {
            type: 'number',
            description: `Seconds to wait before giving up; defaults to ${DEFAULT_TIMEOUT}, maximum ${MAX_TIMEOUT}.`,
          },
        },
      },
      timeoutMs: (MAX_TIMEOUT + 60) * 1000,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'kind', 'text'],
          properties: {
            id: { type: 'string' },
            kind: { type: 'string' },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.text === '' ? `[${value.kind}] (empty message)` : value.text,
        }],
      },
      async execute(args, exec) {
        const thread = checkThread(args.thread)
        const timeoutSeconds = checkTimeout(args.timeout)
        try {
          const reply = await waitForResult(dirs, { thread, timeoutSeconds, signal: exec.signal })
          return { id: reply.id, kind: reply.kind, text: reply.text }
        } catch (error) {
          if (error.code === 'ENOENT') throw missingQueue(root)
          throw error
        }
      },
    },
    {
      name: 'spv_status',
      description:
        'Report the SPV queue without waiting: tasks still waiting to be picked up, and messages that arrived and ' +
        'were not read yet. Use it to check whether superagent is alive and whether a dispatched task has been ' +
        'taken in, before committing to a long spv_result wait.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          thread: {
            type: 'string',
            description: 'Only this thread; omit to report every thread.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['pending', 'unread'],
          properties: {
            pending: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'thread', 'project', 'preview'],
                properties: {
                  id: { type: 'string' },
                  thread: { type: 'string' },
                  project: { type: 'string' },
                  preview: { type: 'string' },
                },
              },
            },
            unread: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'thread', 'kind', 'preview'],
                properties: {
                  id: { type: 'string' },
                  thread: { type: 'string' },
                  kind: { type: 'string' },
                  preview: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = [
            value.pending.length === 0 ? 'waiting for pickup: none' : `waiting for pickup: ${value.pending.length}`,
          ]
          for (const item of value.pending) lines.push(`  ${item.id} ${item.thread} ${item.project}: ${item.preview}`)
          lines.push(value.unread.length === 0 ? 'unread messages: none' : `unread messages: ${value.unread.length}`)
          for (const item of value.unread) lines.push(`  ${item.id} [${item.kind}] ${item.thread}: ${item.preview}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        const thread = args.thread === undefined ? undefined : checkThread(args.thread)
        try {
          const tasks = await pendingTasks(dirs)
          const messages = await unreadMessages(dirs, thread)
          return {
            pending: tasks
              .filter(task => thread === undefined || task.thread === thread)
              .map(task => ({
                id: task.id,
                thread: task.thread,
                project: task.project,
                preview: preview(task.text, 120),
              })),
            unread: messages.map(message => ({
              id: String(message.id ?? ''),
              thread: String(message.thread ?? message.address?.thread ?? 'main'),
              kind: String(message.kind ?? 'unknown'),
              preview: preview(message.text, 120),
            })),
          }
        } catch (error) {
          if (error.code === 'ENOENT') throw missingQueue(root)
          throw error
        }
      },
    },
  ]
}

/** 把三个工具注册进本 agent 的 tools 层。 */
export function apply(ctx, config = {}) {
  for (const tool of defineSpvTools(resolveRoot(config))) ctx.tools.register(tool)
}
