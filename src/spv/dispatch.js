/**
 * 往 `<queue>/pending/` 写一个任务文件：SPV agent 让 superagent 侧开始干活的唯一方式。
 *
 * 记录形状就是 `src/superagent/spv.js:triggerOf` 读的那个；`spv_dispatch` 工具与 `wheelchair-agent dispatch` 都走这里，
 * 所以队列格式只有一份实现。
 * `project` 会进入 Trigger 的 meta，最终以 `$DSH_SUPERAGENT_SPV_PROJECT` 交给 executor 的 prepare 命令，用来决定 clone
 * 哪个项目。可选的 `preset` 同样随 spread 进入 meta（`trigger.meta.preset`），由 superagent 决定 worker 跑哪个 dsh
 * agent preset；省略时 superagent 用自己的默认值。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { writeHookSpoolEvent } from '../shared/hooks.js'
import { listDeployments, PROJECT_PATTERN } from '../shared/deployments.js'
import { deploymentState } from './health.js'
import { deploymentUrl, runDeploymentService } from './service-instance.js'

/**
 * 本工具写的任务固定携带的身份，以及它**不**作为参数接受的原因。
 *
 * `spv` 的 Source 策略只有在 `actor.id` 位于 `allowed` 名单（缺省 `operator`）时才把任务当作 explicit 请求直接接单。
 * 任务文件只是磁盘上的普通 JSON，任何能写队列的东西都可以声称任何身份——包括刚刚跑完上一个任务的 worker 的身份。
 * 让模型自己选 `actor`，就是把"谁下的令"变成 worker 可控制的值，策略随之失效。SPV preset 是操作者本人的对话入口，
 * 所以它的任务就是 operator 的任务；其他写入方必须走自己的 Source 和自己的许可名单。
 */
export const ACTOR = 'operator'

/** 队列线程名：短、可作文件名、可作 `spv:<id>` Thread key。 */
const THREAD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** dsh agent preset id 的形状（`standard` / `minimal` / `ptc` / `cordis` 都是小写字母、数字与连字符）。 */
const PRESET_PATTERN = /^[a-z0-9][a-z0-9-]*$/
/** 任务正文上限；远低于模型单次请求预算。 */
const TASK_LIMIT = 20000

/** 校验 `project` 并返回规范形式；非法时给出含可接受写法的错误。 */
export function checkProject(value) {
  const project = String(value ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (project === '') {
    throw new Error(
      'project is required: the superagent executor clones the named project before a worker starts, so it ' +
        'cannot be omitted. Pass "tools/<name>" or "research/<name>", for example "tools/wheelchair-agent".',
    )
  }
  if (!PROJECT_PATTERN.test(project)) {
    throw new Error(
      `invalid project ${JSON.stringify(project)}: expected "tools/<name>" or "research/<name>" with a plain ` +
        'name, because the executor clones exactly that directory of the bioagentforge workspace before a ' +
        'worker starts. Retry with a value like "tools/wheelchair-agent" or "research/<name>".',
    )
  }
  return project
}

/** 校验 `thread` 并返回规范形式；省略时为 `main`。 */
export function checkThread(value) {
  const thread = String(value ?? '').trim()
  if (thread === '') return 'main'
  if (!THREAD_PATTERN.test(thread)) {
    throw new Error(
      `invalid thread ${JSON.stringify(thread)}: use 1-64 characters from A-Z a-z 0-9 . _ -, starting with a ` +
        'letter or digit. The thread names a queue Thread (spv:<thread>) and a reply is read back by that same ' +
        'name, so it must be a single filename-safe word; "main", "parser" or "t-42" all work.',
    )
  }
  return thread
}

/**
 * 校验可选的 `preset` 并返回规范形式；省略/空串返回 `undefined`，表示让 superagent 用它的默认 worker preset。
 *
 * 只校验 id 的形状，**不校验 preset 是否存在**：registry 在 superagent 侧，本包不该耦合进去。
 */
export function checkPreset(value) {
  const preset = String(value ?? '').trim()
  if (preset === '') return undefined
  if (!PRESET_PATTERN.test(preset)) {
    throw new Error(
      `invalid preset ${JSON.stringify(preset)}: this is a dsh agent preset id, e.g. "cordis" / "ptc" / ` +
        '"standard", written as lowercase letters, digits and hyphens. Omit it to use the superagent default ' +
        'worker preset.',
    )
  }
  return preset
}

/** 校验 `task` 并返回去空白后的正文；空正文直接报错说明什么才算可用的任务。 */
export function checkTask(value) {
  const task = String(value ?? '').trim()
  if (task === '') {
    throw new Error(
      'task is required: describe in natural language what the superagent worker should do. It runs with its ' +
        'own file access and reports back once, so name the outcome and how to verify it, e.g. "add a test for ' +
        'the queue reader and run it".',
    )
  }
  if (task.length > TASK_LIMIT) {
    throw new Error(
      `task is ${task.length} characters, over the ${TASK_LIMIT} limit. A superagent task is one self-contained ` +
        'piece of work: split it into several dispatches on the same thread, or point the worker at a file that ' +
        'carries the detail.',
    )
  }
  return task
}

/**
 * 原子写入一个任务文件并返回 Source 将读到的记录。
 * 临时文件名以点开头，Source 扫描 `pending/` 时会跳过，因此半写的文件不可能被取走。
 */
export async function submitTask(dirs, { project, task, thread, preset }) {
  const id = randomUUID().replaceAll('-', '')
  const record = {
    id,
    thread,
    text: task,
    at: new Date().toISOString(),
    source: 'spv_tools',
    project,
    actor: ACTOR,
  }
  // 省略时不要留下 `preset: undefined`：下游按 `trigger.meta.preset` 取值，缺省即用 superagent 的默认 preset。
  if (preset !== undefined) record.preset = preset
  await mkdir(dirs.pending, { recursive: true })
  const temporary = join(dirs.pending, `.${id}.tmp`)
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
  await rename(temporary, join(dirs.pending, `${id}.json`))
  // 任务已经原子落盘（core path 完成），spool 只是额外副作用：写不进去也不影响派活，writer 永不抛。
  writeHookSpoolEvent(
    'spv.dispatch',
    {
      taskId: record.id,
      thread: record.thread,
      project: record.project,
      text: record.text,
      ...(record.preset === undefined ? {} : { preset: record.preset }),
      at: record.at,
    },
    { eventId: `dispatch:${record.id}` },
  )
  return record
}

/** How long a freshly started instance may take to answer its health endpoint. */
const START_TIMEOUT_MS = 60_000
const START_POLL_MS = 250

/**
 * The registered deployment that reads `root`, or null when the queue is a pure override (a one-off test
 * queue, or a pre-registry layout). The queue directory is the deployment's identity, exactly as
 * `ownDeployment()` treats `SPV_QUEUE_DIR`.
 */
export function deploymentForQueue(root, { env = process.env } = {}) {
  let registry
  try {
    registry = listDeployments({ env })
  } catch {
    return null
  }
  if (!registry.exists) return null
  const wanted = resolve(root)
  return registry.deployments.find(entry => entry.queueDir === root || resolve(entry.queueDir) === wanted) ?? null
}

/** The manager output, both streams, for classifying a non-zero exit. */
function managerOutput(child) {
  return `${child.stdout ?? ''}${child.stderr ?? ''}`.trim()
}

/** The manager output tail that explains a failed start without flooding the caller. */
function outputTail(child) {
  const text = managerOutput(child)
  return text === '' ? '' : `: ${text.split('\n').slice(-5).join(' | ')}`
}

/**
 * The accurate paused error. `started` says whether this call is what brought the instance up, so the message
 * never claims a start that did not happen; both forms give the same next step.
 */
function pausedMessage(entry, { started, problem }) {
  const state = started ? 'started but is paused' : 'is paused'
  return (
    `the deployment instance for ${JSON.stringify(entry.project)} ${state}` +
    `${problem === null ? '' : ` (${problem})`}: its GitHub source has no repository yet, so setup is waiting. ` +
    'Nothing was queued. Configure the deployment with ' +
    `"wheelchair-agent deployment setup --project ${entry.project}", then dispatch again.`
  )
}

/**
 * Make sure the deployment reading `root` is running before a task is written into its queue.
 *
 * Dispatch must not write `pending/<id>.json` first and hope the instance catches it: the task is handed to
 * the instance only once it is up. So this starts a stopped deployment with exactly the argv of
 * `wheelchair-agent service start` (same `serviceArgsFor` implementation) and waits for its own URL to answer.
 *
 * A reachable instance is not automatically able to take work: a deployment whose GitHub source has no
 * repository (setup: waiting, `repositoryUnset`, …) keeps its instance running but paused, and its queue has no
 * consumer. The readiness check therefore runs before the start and again after it, so a second dispatch to an
 * already-paused deployment is refused instead of reporting success.
 *
 * A non-zero manager exit is not automatically a failed start, either. `service start` starts the instance and
 * then exits 3 when the deployment is paused; reachable means report the paused (or other reported-exit) reason
 * and queue nothing, unreachable means the start itself failed. A queue that belongs to no registered
 * deployment has no instance to start; the caller keeps its single-service health check for that legacy case.
 */
export async function ensureDeploymentStarted(root, { env = process.env, timeoutMs = START_TIMEOUT_MS } = {}) {
  const entry = deploymentForQueue(root, { env })
  if (entry === null) return { entry: null, started: false }
  const url = deploymentUrl(entry)
  const before = await deploymentState(url)
  if (before.paused) {
    throw new Error(pausedMessage(entry, { started: false, problem: before.problem }))
  }
  if (before.alive) return { entry, started: false, url, health: before }

  const started = runDeploymentService(entry, ['start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const status = started.status ?? 1
  const output = managerOutput(started)
  const tail = outputTail(started)

  // Probe once before looking at the exit code: a paused deployment leaves its instance running and still
  // makes `service start` exit non-zero, which is not a failed start.
  let last = await deploymentState(url)
  if (!last.alive && status !== 0) {
    throw new Error(
      `could not start the deployment instance for ${JSON.stringify(entry.project)}${tail}. ` +
        `Run "wheelchair-agent service status" from that project's checkout (or "wheelchair-agent service ` +
        'status --all") to diagnose it.',
    )
  }
  const deadline = Date.now() + timeoutMs
  while (!last.alive && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, START_POLL_MS))
    last = await deploymentState(url)
  }
  if (!last.alive) {
    const reason = last.reason === undefined ? '' : ` (${last.reason})`
    throw new Error(
      `the deployment instance for ${JSON.stringify(entry.project)} started but ${url} did not answer within ` +
        `${Math.round(timeoutMs / 1000)}s${reason}${tail}. Run "wheelchair-agent service status" from that ` +
        'project\'s checkout (or "wheelchair-agent service status --all") to diagnose it.',
    )
  }
  // The manager's own output still explains a paused deployment when the state document is unavailable.
  if (last.paused || (status !== 0 && /setup:\s*waiting/.test(output))) {
    throw new Error(pausedMessage(entry, { started: true, problem: last.problem }))
  }
  if (status !== 0) {
    throw new Error(
      `the deployment instance for ${JSON.stringify(entry.project)} started but the manager reported exit ` +
        `${status}${tail}. Nothing was queued; run "wheelchair-agent service status" from that project's ` +
        'checkout (or "wheelchair-agent service status --all") to check it.',
    )
  }
  return { entry, started: true, url, health: last }
}
