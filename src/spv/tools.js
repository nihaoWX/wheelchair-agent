/**
 * SPV preset 的 `spv_*` 工具，外加把结果推进会话的后台注入器。
 *
 * 这是**工具插件**（`ctx.tools.register`），不是斜杠命令：用户希望 SPV 这个 agent 自己调用它们来派活，所以它们必须出现在
 * 模型的工具表里，由模型决定何时调用。
 *
 * 与 superagent 侧严格分开：本文件不 import `~/opt/dsh-plugins/dsh-superagent/` 的任何东西，只按下文描述的文件布局与它对话。
 * 唯一的接口是 `<queue>/{pending,done,outbox}/` 里的 JSON 文件（见 `src/shared/queue.js` 与 `ARCHITECTURE/spv-source.md`）。
 *
 * 三个工具：
 *   spv_dispatch  写 pending/，立刻返回 id/thread/project
 *   spv_status    非阻塞：pending 里还没取走的任务 + 已到但未读的消息
 *   spv_notify    写一封 `spv_message` 决策信进操作者的收件箱，返回 id/thread
 *
 * 结果不是工具：阻塞式的结果工具已删除。worker 的 reply/notice 由 `src/spv/injector.js` 在后台轮询 outbox，
 * 消费后作为一条新消息 `followup` 进本会话（见 `apply` 里的 `ctx.effect`）。所以模型没有「读结果」这个动作，
 * 也没有超时；派完活接着说自己的话即可。
 *
 * 读写 outbox/pending 在 `src/spv/outbox.js`，写任务在 `src/spv/dispatch.js`，路径规则在 `src/spv/paths.js`。
 * 收件箱的写入在 `src/spv/inbox.js`，与 CLI 的 `inbox add` 共用 `createSpvMessage()`。
 *
 * 为什么不 `import { defineTool } from '@deepseek-ai/dsh-tools'`：本包是用户级 preset 引用的普通目录，不在 dsh 的
 * 安装树里，`@deepseek-ai/dsh-tools` 这个 bare specifier 从本包位置解析不到，preset 会整个 mount 失败。
 * 用原始 JSON Schema 直接注册就没有任何 dsh 包依赖：参数校验由各 `execute` 自己做（校验文案本来也该写在这里）。
 */
import { listDeployments, missingDeploymentError } from '../shared/deployments.js'
import { dirsOf } from '../shared/queue.js'
import { checkPreset, checkProject, checkTask, checkThread, submitTask } from './dispatch.js'
import { probe, serviceDown } from './health.js'
import { createSpvMessage, resolveInboxRoot } from './inbox.js'
import { startResultInjector } from './injector.js'
import { ownDeployment } from './ownership.js'
import { pendingTasks, unreadMessages } from './outbox.js'
import { missingQueue, resolveRoot, resolveRoots } from './paths.js'

/** 读一条队列并整理成 status 的形状：pending 任务条目 + 未读消息条目。 */
async function readQueueReport(dirs, thread) {
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
}

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
 * 三个工具的定义。派单按项目解析：`queueDir` 设置 > `$SPV_QUEUE_DIR` > 注册表中该项目 > 报错。
 * 挂载时不知道这次会话会派给哪个项目，所以 `spv_dispatch` 在调用时用 `config` 再解析一次。
 * `spv_status` 也按注册表现场解析，逐份部署分组汇报，`--project` 只报一份；注册表不存在（或本进程无法
 * 识别自己属于哪份部署）时，把原因作为 `problem` 报出来，而不是退回旧队列。
 *
 * 队列目录不存在不在挂载时报错——那时 superagent 可能只是还没启动，报错会挡住整个会话；改由每次调用报。
 *
 * `state` 是插件实例的共享状态：`spv_dispatch` 从 `exec.agent` 记下这个会话的 agent，注入器用
 * `getAgent()` 读它。会话没派过活之前是 undefined，注入器此时不会消费任何消息。
 */
export function defineSpvTools(root, state, config = {}) {
  void root

  return [
    {
      name: 'spv_dispatch',
      description:
        'Hand one self-contained task to a background worker and return immediately. Do not do implementation ' +
        'work yourself: code changes and PR delivery go through this tool, because editing the repository here ' +
        'leaves no prepare step, no branch, no PR and no review; the worker owns that path.\n\n' +
        'The project argument is required and selects both the clone the worker gets ("tools/<name>" or ' +
        '"research/<name>") and the deployment that reads the task: it is written into that project\'s own ' +
        'queue. A project with no registered deployment fails with the exact "wheelchair-agent deployment ' +
        'add" command that creates one; deployments are never created automatically. The worker cannot see this ' +
        'conversation, so the task must carry everything it needs, including the outcome and how to verify it. ' +
        'Reuse the thread name for follow-ups on the same line of work. For dsh plugin, dsh web UI or panel ' +
        'work pass preset "cordis" (creator mode); otherwise omit it.\n\n' +
        'Do not wait, do not poll, and do not look for a tool that reads the result: there is no timeout and ' +
        'no such tool. The result arrives later by itself as a new user message on the thread; "reply" means ' +
        'the worker finished, "notice" needs the operator\'s attention. Fails instead of queuing when the ' +
        'service is not running.\n\n' +
        'Report only what the worker actually said: do not claim success on its behalf, and do not quietly ' +
        'substitute your own attempt when it fails.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['project', 'task'],
        properties: {
          project: {
            type: 'string',
            description: 'Required. Project the worker gets a clone of: "tools/<name>" or "research/<name>".',
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
        // 先路由再探活：项目的部署决定任务进哪条队列，没有条目时不必也不该去碰服务。
        const targetRoot = resolveRoot(config, { project })
        const health = await probe()
        if (!health.alive) throw serviceDown(health)
        try {
          const record = await submitTask(dirsOf(targetRoot), { project, task, thread, preset })
          // 记下会话的 agent：后台注入器靠它决定把结果投给谁。第一次派活之前没有会话可投。
          if (exec?.agent) state.agent = exec.agent
          return { id: record.id, thread: record.thread, project: record.project }
        } catch (error) {
          if (error.code === 'ENOENT') throw missingQueue(targetRoot)
          throw error
        }
      },
    },
    {
      name: 'spv_notify',
      description:
        'Push one autonomous decision into the human review inbox. Use this when you run unattended, make a call ' +
        'on the operator\'s behalf while they are away, and need them to review it later: the letter records what ' +
        'you decided and why, and the operator later accepts it or objects. It writes one `spv_message` letter ' +
        '(title + Markdown body + optional thread, default "main") and returns immediately; it does not dispatch a ' +
        'worker and does not wait for an answer. Do not use it for routine progress or for work you are handing to ' +
        'a worker.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body'],
        properties: {
          title: {
            type: 'string',
            description: 'One line naming the decision; this is the first thing the operator sees in the inbox.',
          },
          body: {
            type: 'string',
            description: 'Markdown: what you decided, why, and anything the operator needs to judge it.',
          },
          thread: {
            type: 'string',
            description: 'SPV queue thread this decision belongs to; defaults to "main". An objection comes back on it.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'thread'],
          properties: {
            id: { type: 'string' },
            thread: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Added decision letter ${value.id} to the review inbox on thread "${value.thread}". ` +
            'It stays there until the operator accepts it or objects; do not wait for an answer.',
        }],
      },
      async execute(args, exec) {
        const item = await createSpvMessage(resolveInboxRoot(), {
          title: args.title,
          body: args.body,
          thread: args.thread,
        })
        // 与 spv_dispatch 一样记下会话的 agent：即使这个会话没派过 worker，操作者之后对信的质疑
        // 也要由注入器推进本会话。
        if (exec?.agent) state.agent = exec.agent
        return { id: item.id, thread: item.thread }
      },
    },
    {
      name: 'spv_status',
      description:
        'Report the SPV queue without waiting: tasks still waiting to be picked up, and messages that arrived and ' +
        'were not read yet. Once projects have their own deployments the report is grouped by deployment, so a ' +
        'queue is never invisible just because it is not the one this session mounted with; pass project to report ' +
        'one deployment only. Use it to check whether superagent is alive and whether a dispatched task has been ' +
        'taken in. Results are not read here: the background injector pushes each reply or notice into the ' +
        'conversation by itself. A result older than this session stays listed as unread on purpose, so do not ' +
        'treat that list as news.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: {
            type: 'string',
            description: "Only this project's deployment (\"tools/<name>\" or \"research/<name>\"); omit to report every registered deployment.",
          },
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
            deployments: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['project', 'queueDir', 'pending', 'unread'],
                properties: {
                  // dsh 的 schema 子集只接受单个 type 字符串（type 数组会让整个 preset mount 失败），
                  // 可空字段必须写成 oneOf。
                  project: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  queueDir: { type: 'string' },
                  pending: { type: 'integer' },
                  unread: { type: 'integer' },
                },
              },
            },
            problem: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const lines = []
          if (value.problem !== undefined) lines.push(`problem: ${value.problem}`)
          for (const group of value.deployments) {
            const name = group.project === null ? 'this instance' : group.project
            lines.push(`${name} (${group.queueDir}): ${group.pending} waiting, ${group.unread} unread`)
          }
          if (value.deployments.length === 0) lines.push('no deployments: none')
          for (const item of value.pending) lines.push(`  ${item.id} ${item.thread} ${item.project}: ${item.preview}`)
          for (const item of value.unread) lines.push(`  ${item.id} [${item.kind}] ${item.thread}: ${item.preview}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        const thread = args.thread === undefined ? undefined : checkThread(args.thread)
        const project = args.project === undefined ? undefined : checkProject(args.project)
        const registry = listDeployments()
        if (project !== undefined && !registry.exists) {
          throw missingDeploymentError(project, registry.file, false)
        }
        const own = ownDeployment()
        let queues
        try {
          queues = project === undefined
            ? resolveRoots(config)
            : [{ project, root: resolveRoot(config, { project }) }]
        } catch (error) {
          // 注册表是唯一来源：没有它（或本进程无法识别自己）时把原因当 problem 报出来，不退回旧队列。
          if (project !== undefined) throw error
          return {
            pending: [],
            unread: [],
            deployments: [],
            problem: own.entry === null
              ? `${error.message} (instance: ${own.reason})`
              : error.message,
          }
        }
        const pending = []
        const unread = []
        const deployments = []
        for (const queue of queues) {
          const queueDirs = dirsOf(queue.root)
          let report
          try {
            report = await readQueueReport(queueDirs, thread)
          } catch (error) {
            // 一份部署的队列还没建好（服务没启动）不该让整个 status 失败：它报 0，别的部署照常。
            if (error.code !== 'ENOENT') throw error
            report = { pending: [], unread: [] }
          }
          pending.push(...report.pending)
          unread.push(...report.unread)
          deployments.push({
            project: queue.project,
            queueDir: queue.root,
            pending: report.pending.length,
            unread: report.unread.length,
          })
        }
        return {
          pending,
          unread,
          deployments,
          ...(own.entry === null ? { problem: `ownership: ${own.reason}; polling nothing until this instance can be identified` } : {}),
        }
      },
    },
  ]
}

/**
 * 注册三个工具，并让插件自己持有结果注入器。
 *
 * 注入器每轮重新解析注册表，监听**所有**已登记部署的队列（外加旧规则那条），所以会话运行期间新增的部署
 * 也会被接上，它第一次出现时取自己的基线、不重放积压结果。派活时 `spv_dispatch` 再按项目解析。
 * 注入器挂在 `ctx.effect` 上，返回的 stop 函数交给插件 fiber，所以会话关闭时定时器随之清掉，不会在进程里
 * 空转；它本身没有超时，插件挂着就一直等。
 */
export function apply(ctx, config = {}) {
  // 没有部署上下文不能挡住整个会话挂载：工具本身会在调用时报出指路错误，状态工具会把它显示成 problem。
  let root
  try {
    root = resolveRoot(config)
  } catch {
    root = undefined
  }
  const state = { agent: undefined }
  for (const tool of defineSpvTools(root, state, config)) ctx.tools.register(tool)
  ctx.effect(
    () =>
      startResultInjector({
        queuesOf: () =>
          resolveRoots(config).map(entry => ({ project: entry.project, root: entry.root })),
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
