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
import { join } from 'node:path'

import { writeHookSpoolEvent } from '../shared/hooks.js'
import { PROJECT_PATTERN } from '../shared/deployments.js'

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
