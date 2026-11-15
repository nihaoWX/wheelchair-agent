/**
 * SPV preset 的 `spv_*` 工具，外加把结果推进会话的后台注入器。
 *
 * 这是**工具插件**（`ctx.tools.register`），不是斜杠命令：用户希望 SPV 这个 agent 自己调用它们来派活，所以它们必须出现在
 * 模型的工具表里，由模型决定何时调用。
 *
 * 与 superagent 侧严格分开：本文件不 import `tools/dsh-superagent/` 的任何东西，只按下文描述的文件布局与它对话。
 * 唯一的接口是 `<queue>/{pending,done,outbox}/` 里的 JSON 文件（见 `src/shared/queue.js` 与 `docs/spv-source.md`）。
 *
 * 两个工具：
 *   spv_dispatch  写 pending/，立刻返回 id/thread/project
 *   spv_status    非阻塞：pending 里还没取走的任务 + 已到但未读的消息
 *
 * 结果不是工具：阻塞式的结果工具已删除。worker 的 reply/notice 由 `src/spv/injector.js` 在后台轮询 outbox，
 * 消费后作为一条新消息 `followup` 进本会话（见 `apply` 里的 `ctx.effect`）。所以模型没有「读结果」这个动作，
 * 也没有超时；派完活接着说自己的话即可。
 *
 * 读写 outbox/pending 在 `src/spv/outbox.js`，写任务在 `src/spv/dispatch.js`，路径规则在 `src/spv/paths.js`。
 *
 * 为什么不 `import { defineTool } from '@deepseek-ai/dsh-tools'`：本包是用户级 preset 引用的普通目录，不在 dsh 的
 * 安装树里，`@deepseek-ai/dsh-tools` 这个 bare specifier 从本包位置解析不到，preset 会整个 mount 失败。
 * 用原始 JSON Schema 直接注册就没有任何 dsh 包依赖：参数校验由各 `execute` 自己做（校验文案本来也该写在这里）。
 */
import { dirsOf } from '../shared/queue.js'
import { checkPreset, checkProject, checkTask, checkThread, submitTask } from './dispatch.js'
import { probe, serviceDown } from './health.js'
import { startResultInjector } from './injector.js'
import { pendingTasks, unreadMessages } from './outbox.js'
import { missingQueue, resolveRoot } from './paths.js'

/** 插件名（Loader 诊断里显示的名字）。 */
export const name = 'spv-tools'
/** 需要 `tools` 注册表；不需要任何 superagent 服务，通道只有文件。 */
export const inject = ['tools']

/** 一行预览：把正文压成单行，避免工具输出被长文本淹没。 */
function preview(text, limit) {
  const flat = String(text ?? '').trim().replace(/\s+/g, ' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * 两个工具的定义。`root` 由挂载时解析：`queueDir` 设置 > `$SPV_QUEUE_DIR` > `<stateDir>/spv`。
 * 队列目录不存在不在挂载时报错——那时 superagent 可能只是还没启动，报错会挡住整个会话；改由每次调用报。
 *
 * `state` 是插件实例的共享状态：`spv_dispatch` 从 `exec.agent` 记下这个会话的 agent，注入器用
 * `getAgent()` 读它。会话没派过活之前是 undefined，注入器此时不会消费任何消息。
 */
export function defineSpvTools(root, state) {
  const dirs = dirsOf(root)

  return [
    {
      name: 'spv_dispatch',
      description:
        'Hand one task to the background superagent service and return immediately. Use it when work should run ' +
        'outside this conversation - a code change, a test run, a repository inspection - so you stay responsive ' +
        'while it runs. The task is a single natural-language instruction; the worker has its own filesystem ' +
        'access and reports once. The project argument selects which project the worker gets: "tools/<name>" or ' +
        '"research/<name>". The optional preset selects the dsh agent preset the worker runs; omit it for ' +
        'superagent\'s default. The call returns as soon as the task is queued: the worker reply arrives later by ' +
        'itself as a new message on the same conversation thread. Do not wait for it, do not poll, and do not ' +
        'call a tool to read it. Fails instead of queuing when the service is not running, because a queued task ' +
        'with no reader looks dispatched but never runs.',
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
          preset: {
            type: 'string',
            description: 'dsh agent preset the worker runs, e.g. "cordis" (creator mode, for dsh plugin or web UI work), "ptc", "standard". Omit to use superagent\'s default worker preset.',
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
            `The result will arrive later by itself as a new message on thread "${value.thread}"; ` +
            'keep the conversation going and do not wait for it.',
        }],
      },
      async execute(args, exec) {
        const project = checkProject(args.project)
        const task = checkTask(args.task)
        const thread = checkThread(args.thread)
        const preset = checkPreset(args.preset)
        const health = await probe()
        if (!health.alive) throw serviceDown(health)
        try {
          const record = await submitTask(dirs, { project, task, thread, preset })
          // 记下会话的 agent：后台注入器靠它决定把结果投给谁。第一次派活之前没有会话可投。
          if (exec?.agent) state.agent = exec.agent
          return { id: record.id, thread: record.thread, project: record.project }
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
        'taken in. Results are not read here: the background injector pushes each reply or notice into the ' +
        'conversation by itself. A result older than this session stays listed as unread on purpose, so do not ' +
        'treat that list as news.',
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

/**
 * 注册两个工具，并让插件自己持有结果注入器。
 *
 * 队列根只解析一次：两个工具与注入器必须看同一个目录。注入器挂在 `ctx.effect` 上，返回的 stop 函数交给
 * 插件 fiber，所以会话关闭时定时器随之清掉，不会在进程里空转；它本身没有超时，插件挂着就一直等。
 */
export function apply(ctx, config = {}) {
  const root = resolveRoot(config)
  const state = { agent: undefined }
  for (const tool of defineSpvTools(root, state)) ctx.tools.register(tool)
  ctx.effect(
    () =>
      startResultInjector({
        dirs: dirsOf(root),
        getAgent: () => state.agent,
        // 与 `injectBrief`（src/spv/cron-plugin.js）同样的消息形状：`followup` 排到下一轮，不打断当前回合。
        inject: (agent, text, message) => {
          agent.followup({
            id: 'spv-result-' + (message.id || Date.now()),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          })
        },
        logger: ctx.logger,
      }),
    'spv result injector',
  )
}
