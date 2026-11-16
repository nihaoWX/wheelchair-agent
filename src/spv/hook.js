/**
 * `wheelchair-agent hook ...` 的实现：插口（hook）表的打印、增删改、试跑、日志与中文提示词。
 *
 * 契约见 `docs/hooks.md`，事件表在 `src/shared/hook-events.js`，执行器在 `src/shared/hooks.js`。
 * 本文件只做**命令逻辑**：不 `process.exit`（退出码由 `bin/wheelchair-agent.mjs` 决定），也不 import
 * 任何 dsh 包（`tests/test-layout.sh` 规则 3）。
 *
 * 退出码（与既有 CLI 一致）：
 *   - 0 成功；
 *   - 1 运行期错误（找不到 hook、内建行不可改、设置写入冲突/非法、`hook test` 的脚本失败）；
 *   - 2 argv / 用法错误（缺参数、未知事件、`--payload` 不是 JSON、`--timeout` 超限）。
 * 用法错误抛 `code: "HOOK_USAGE"`，由 bin 换成它自己的 `UsageError`（那里才打印通用 `--help` 提示）。
 *
 * **所有写入都走设置存储**（`resolveSettings` 读当前 revision → `saveSettings` 带同一 revision 写），
 * 过期就是 `SETTINGS_CONFLICT`（HTTP 语义的 409），一个字节都不会落盘。没有任何一条路径手改
 * `settings.json`。
 */
import { randomBytes } from 'node:crypto'

import {
  EVENTS,
  buildHookPrompt,
  eventById,
  hookCwd,
  readHookRecords,
  readHooks,
  resolveHookTimeout,
  runOneHook,
  samplePayload,
} from '../shared/hooks.js'
import { HOOK_TIMEOUT_CAP, resolveSettings, saveSettings } from '../shared/settings.js'

/** 一次写入尝试里最多重试几次 revision 冲突（并发写几乎只来自面板，重试一次就够）。 */
const REVISION_RETRIES = 3

const HOOK_USAGE = `usage: wheelchair-agent hook <command>

Extra scripts that run on the project's own events (the "插口" / hook engine). A hook is an extra side
effect: it may fail, time out or exit non-zero, and the core path (review records, SPV notices, the
--ff-only pull) never depends on it.

commands:
  events                       print the event table: id, title, when it fires, cancellable, rows
  list                         list every builtin row and every custom hook, per event
  add --event <id> --name <text> --script <sh> [--timeout <ms>]
                               add a custom hook (prints its new id)
  enable <id> / disable <id>   turn one custom hook on or off (builtin rows cannot be changed)
  rm <id>                      delete one custom hook
  rename <builtin id> "<label>"  rename a builtin row (an empty label restores the default)
  test <id> [--event <id>] [--payload <json>]
                               run one custom hook with a sample payload; nothing is recorded
  log [--tail <n>] [--event <id>]
                               tail <data root>/records/hooks.jsonl (default 20 lines)
  prompt <event>               print a copyable Chinese prompt for adding a hook on that event

Every write goes through the settings store's revision check (a stale revision is a 409 and writes
nothing). Do not edit settings.json by hand; run "wheelchair-agent hook <command> --help" for options.`

const EVENTS_USAGE = `usage: wheelchair-agent hook events

Print the event contract: one block per event with its stable id, title, when exactly it fires, whether it
can fire more than once, whether its builtin rows are cancellable, and how many rows it has.
The table lives in src/shared/hook-events.js; this command only prints it.`

const LIST_USAGE = `usage: wheelchair-agent hook list

List every builtin row (core path: cancellable=false) and every custom hook, grouped by event, in the order
they run. Custom rows show their effective timeout and a one-line script preview.`

const ADD_USAGE = `usage: wheelchair-agent hook add --event <id> --name <text> --script <sh> [--timeout <ms>]

Add one custom hook for an event and print its generated id (hook-<slug>-<hex>). The hook is enabled
immediately and runs on the next occurrence of that event.

options:
  --event <id>      an event from "wheelchair-agent hook events" (required)
  --name <text>     a human label, 1..120 characters (required)
  --script <sh>     the shell script, run as "sh -c <script>" (required)
  --timeout <ms>    per-hook timeout; defaults to hooks.scriptTimeoutMs, hard cap ${HOOK_TIMEOUT_CAP}`

const ENABLE_USAGE = `usage: wheelchair-agent hook enable <id>

Turn one custom hook back on. Builtin rows are core path and have no on/off switch.`

const DISABLE_USAGE = `usage: wheelchair-agent hook disable <id>

Turn one custom hook off without deleting it. Builtin rows are core path and have no on/off switch.`

const RM_USAGE = `usage: wheelchair-agent hook rm <id>

Delete one custom hook. Builtin rows cannot be removed: cancelling them would cut the core path.`

const RENAME_USAGE = `usage: wheelchair-agent hook rename <builtin id> "<label>"

Give a builtin row a label that reads like something the operator did. Only builtin:* ids are accepted;
custom hooks are named at "hook add" time. An empty label ("") restores the default label.`

const TEST_USAGE = `usage: wheelchair-agent hook test <id> [--event <id>] [--payload <json>]

Run one custom hook once with the event's documented sample payload (or an explicit JSON object), print its
stdout/stderr, and do NOT record it as a real occurrence (no hooks.jsonl line, no cursor claim). An explicit
test always runs: a disabled row and the hooks.enabled master switch do not block it (both print a note).
Exit code 0 when the script exits 0, 1 otherwise.

options:
  --event <id>      run the hook as if this event fired (default: the hook's own event)
  --payload <json>  one JSON object, passed as-is on stdin (and as WCA_* stand-ins)`

const LOG_USAGE = `usage: wheelchair-agent hook log [--tail <n>] [--event <id>]

Print the last <n> lines of <data root>/records/hooks.jsonl (default 20), optionally only one event.
Each line shows the timestamp, event, hook id/name, exit code, duration and whether it timed out.`

const PROMPT_USAGE = `usage: wheelchair-agent hook prompt <event>

Print a copyable Chinese prompt that tells an agent how to add a hook for that event: what it means, when it
fires, the stdin payload, the WCA_* environment, cwd, timeout, the builtin rows, and the exact
"wheelchair-agent hook add ..." command. Generated only from src/shared/hook-events.js.`

/** argv / 用法错误：bin 会把它变成退出码 2。 */
class HookUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HookUsageError'
    this.code = 'HOOK_USAGE'
  }
}

function usageError(message) {
  return new HookUsageError(message)
}

function hasHelp(argv) {
  return argv.includes('--help') || argv.includes('-h')
}

/** 逐词解析带值选项；未知选项、缺值、意外的位置参数都在这里报用法错误。 */
function parseArgs(argv, { flags = {}, command }) {
  const parsed = { positional: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    if (word === '--help' || word === '-h') continue
    if (word.startsWith('-')) {
      const name = flags[word]
      if (name === undefined) throw usageError(`unknown option ${JSON.stringify(word)} for "${command}"`)
      const value = argv[index + 1]
      if (value === undefined) throw usageError(`${word} needs a value`)
      parsed[name] = value
      index += 1
      continue
    }
    parsed.positional.push(word)
  }
  return parsed
}

/** 把模型里的 hooks 子块复制成一份可改的普通对象。 */
function mutableHooks(snapshot) {
  return {
    enabled: snapshot.hooks.enabled,
    scriptTimeoutMs: snapshot.hooks.scriptTimeoutMs,
    items: snapshot.hooks.items.map(item => ({ ...item })),
    labels: { ...snapshot.hooks.labels },
  }
}

/**
 * 读当前 revision → 本地改 → 带同一 revision 写。并发写入（面板同时保存）会让 revision 变旧：
 * 重新读一遍再改，最多 `REVISION_RETRIES` 次；仍然冲突就如实说 409，什么都不写。
 */
function writeHooks(io, mutate) {
  for (let attempt = 0; attempt < REVISION_RETRIES; attempt += 1) {
    const snapshot = resolveSettings({ env: io.env })
    const hooks = mutableHooks(snapshot)
    const result = mutate(hooks)
    // `false` 只表示"这一行不在了"：不改、不写，由调用方给出准确的提示。
    if (result === false) return { ok: false, aborted: true, code: 1 }
    try {
      const saved = saveSettings({
        env: io.env,
        revision: snapshot.revision,
        hooks,
      })
      return { ok: true, result, saved }
    } catch (error) {
      if (error?.code === 'SETTINGS_CONFLICT') continue
      if (error?.code === 'SETTINGS_INVALID') return { ok: false, code: 1, message: error.message }
      throw error
    }
  }
  return {
    ok: false,
    code: 1,
    message:
      'the settings file kept changing while this command was writing (revision conflict); nothing was ' +
      'written. Retry once the panel is idle.',
  }
}

/** 一行预览：压成单行并截断，避免 CLI 输出被脚本淹没。 */
function preview(text, limit) {
  const flat = String(text ?? '').trim().replace(/\s+/g, ' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/** 事件 id 变成 id 片段：`ticket.delivered` → `ticket-delivered`。 */
function slugOf(eventId) {
  return eventId.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
}

/** 生成一个唯一的 `hook-<slug>-<hex>` id。 */
function nextHookId(eventId, items) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `hook-${slugOf(eventId)}-${randomBytes(3).toString('hex')}`
    if (!items.some(item => item.id === candidate)) return candidate
  }
  return `hook-${slugOf(eventId)}-${Date.now().toString(36)}`
}

/** 设置写入失败时的统一输出。 */
function reportWrite(io, outcome) {
  if (outcome.ok || outcome.aborted) return 0
  io.writeError(`wheelchair-agent: ${outcome.message}\n`)
  return outcome.code
}

/** 内建行的拒绝理由：三处（enable/disable/rm/test）共用同一句，避免三种说法。 */
function builtinRefusal(id, what) {
  return (
    `${id} is a builtin row: the core path owns it, so it cannot be ${what}. ` +
    'Its text (when editable) is changed through the existing template, not here; see ' +
    '"wheelchair-agent hook list".'
  )
}

// ------------------------------------------------------------------ commands

function commandEvents(argv, io) {
  if (hasHelp(argv)) {
    io.write(`${EVENTS_USAGE}\n`)
    return 0
  }
  if (argv.length > 0) throw usageError(`unknown option ${JSON.stringify(argv[0])} for "hook events"`)
  const model = readHooks({ env: io.env })
  const custom = model.items.length
  const lines = [
    `hook events: ${model.events.length} event(s), ${model.builtin.length} builtin row(s), ${custom} custom row(s)`,
    `enabled: ${model.enabled ? 'yes' : 'no (paused; nothing runs)'}   ` +
      `script timeout: ${model.scriptTimeoutMs} ms (cap ${model.timeoutCap} ms)   ` +
      `runner interval: ${model.intervalSeconds} s (0 = paused)   ` +
      `settings revision: ${model.revision}`,
    model.recordsFile === undefined ? 'records: (the data root could not be resolved)' : `records: ${model.recordsFile}`,
    ...(model.warning === undefined ? [] : [`warning: ${model.warning}`]),
    '',
  ]
  for (const entry of model.events) {
    lines.push(`${entry.id}  ${entry.title}`)
    lines.push(`  when: ${entry.when}`)
    lines.push(`  repeatable: ${entry.repeatable ? 'yes' : 'no'} — ${entry.repeatNote}`)
    lines.push(`  cancellable: ${entry.cancellable ? 'yes' : 'no'}`)
    lines.push(`  rows: ${entry.rows.length} builtin + ${entry.customCount} custom`)
    if (entry.rows.length > 0) {
      lines.push(`  builtin: ${entry.rows.map(row => `${row.id} (${row.label})`).join(', ')}`)
    }
    lines.push('')
  }
  io.write(`${lines.join('\n')}\n`)
  return 0
}

function commandList(argv, io) {
  if (hasHelp(argv)) {
    io.write(`${LIST_USAGE}\n`)
    return 0
  }
  if (argv.length > 0) throw usageError(`unknown option ${JSON.stringify(argv[0])} for "hook list"`)
  const model = readHooks({ env: io.env })
  const lines = [
    `hooks: ${model.enabled ? 'enabled' : 'paused'}   script timeout: ${model.scriptTimeoutMs} ms   ` +
      `runner interval: ${model.intervalSeconds} s   revision: ${model.revision}`,
    ...(model.warning === undefined ? [] : [`warning: ${model.warning}`]),
    '',
  ]
  for (const entry of model.events) {
    const custom = model.items.filter(item => item.event === entry.id)
    if (entry.rows.length === 0 && custom.length === 0) continue
    lines.push(`${entry.id}  ${entry.title}`)
    for (const row of entry.rows) {
      const edit = row.template === undefined ? '' : ` (template: ${row.template})`
      const pointer = row.pointer === undefined ? '' : ` (pointer: ${row.pointer})`
      lines.push(`  ${row.id.padEnd(32)} [core] ${row.label}${edit}${pointer}`)
    }
    for (const item of custom) {
      const state = item.enabled === false ? 'disabled' : 'enabled'
      const timeout = resolveHookTimeout(item, model)
      lines.push(
        `  ${item.id.padEnd(32)} ${state.padEnd(8)} ${String(timeout).padStart(6)} ms  ` +
          `${item.name}  —  ${preview(item.script, 60)}`,
      )
    }
    lines.push('')
  }
  if (model.items.length === 0) {
    lines.push('no custom hooks yet; add one with "wheelchair-agent hook prompt <event>".', '')
  }
  io.write(`${lines.join('\n')}\n`)
  return 0
}

function commandAdd(argv, io) {
  if (hasHelp(argv)) {
    io.write(`${ADD_USAGE}\n`)
    return 0
  }
  const parsed = parseArgs(argv, {
    command: 'hook add',
    flags: { '--event': 'event', '--name': 'name', '--script': 'script', '--timeout': 'timeout' },
  })
  if (parsed.positional.length > 0) {
    throw usageError(`unexpected argument ${JSON.stringify(parsed.positional[0])}; use --event/--name/--script`)
  }
  if (parsed.event === undefined) throw usageError('hook add needs --event <id>')
  if (parsed.name === undefined) throw usageError('hook add needs --name <text>')
  if (parsed.script === undefined) throw usageError('hook add needs --script <sh>')
  const entry = requireEventForArgv(parsed.event)
  const name = String(parsed.name).trim()
  if (name === '') throw usageError('--name cannot be empty')
  if (name.length > 120) throw usageError(`--name is ${name.length} characters, over the 120 limit`)
  if (/[\u0000-\u001f\u007f]/.test(name)) throw usageError('--name cannot contain a control character')
  if (String(parsed.script).trim() === '') throw usageError('--script cannot be empty')
  if (String(parsed.script).length > 20000) throw usageError('--script is over the 20000 character limit')
  let timeoutMs
  if (parsed.timeout !== undefined) {
    if (!/^\d+$/.test(String(parsed.timeout).trim())) {
      throw usageError(`--timeout must be a whole number of milliseconds, got ${JSON.stringify(parsed.timeout)}`)
    }
    timeoutMs = Number(String(parsed.timeout).trim())
    if (timeoutMs < 1) throw usageError('--timeout must be at least 1 millisecond')
    if (timeoutMs > HOOK_TIMEOUT_CAP) {
      throw usageError(`--timeout must be at most ${HOOK_TIMEOUT_CAP} ms (the hard cap), got ${timeoutMs}`)
    }
  }
  const outcome = writeHooks(io, hooks => {
    const generated = nextHookId(entry.id, hooks.items)
    const item = { id: generated, event: entry.id, name, enabled: true, script: String(parsed.script) }
    if (timeoutMs !== undefined) item.timeoutMs = timeoutMs
    hooks.items.push(item)
    return generated
  })
  if (!outcome.ok) return reportWrite(io, outcome)
  io.write(`${outcome.result}\n`)
  return 0
}

function commandToggle(argv, io, enabled) {
  const command = enabled ? 'hook enable' : 'hook disable'
  if (hasHelp(argv)) {
    io.write(`${enabled ? ENABLE_USAGE : DISABLE_USAGE}\n`)
    return 0
  }
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    throw usageError(`${command} needs exactly one hook id`)
  }
  const id = argv[0].trim()
  if (id.startsWith('builtin:')) {
    io.writeError(`wheelchair-agent: ${builtinRefusal(id, enabled ? 'enabled' : 'disabled')}\n`)
    return 1
  }
  let found
  const outcome = writeHooks(io, hooks => {
    const item = hooks.items.find(candidate => candidate.id === id)
    if (item === undefined) return false
    item.enabled = enabled
    found = item
    return true
  })
  if (outcome.aborted) {
    io.writeError(
      `wheelchair-agent: no custom hook with id ${JSON.stringify(id)}; run "wheelchair-agent hook list".\n`,
    )
    return 1
  }
  if (reportWrite(io, outcome) !== 0) return 1
  io.write(`${enabled ? 'enabled' : 'disabled'} ${id} (${found.name})\n`)
  return 0
}

function commandRm(argv, io) {
  if (hasHelp(argv)) {
    io.write(`${RM_USAGE}\n`)
    return 0
  }
  if (argv.length !== 1 || argv[0].startsWith('-')) throw usageError('hook rm needs exactly one hook id')
  const id = argv[0].trim()
  if (id.startsWith('builtin:')) {
    io.writeError(`wheelchair-agent: ${builtinRefusal(id, 'removed')}\n`)
    return 1
  }
  let removed
  const outcome = writeHooks(io, hooks => {
    const index = hooks.items.findIndex(candidate => candidate.id === id)
    if (index === -1) return false
    removed = hooks.items[index]
    hooks.items.splice(index, 1)
    return true
  })
  if (outcome.aborted) {
    io.writeError(
      `wheelchair-agent: no custom hook with id ${JSON.stringify(id)}; run "wheelchair-agent hook list".\n`,
    )
    return 1
  }
  if (reportWrite(io, outcome) !== 0) return 1
  io.write(`removed ${id} (${removed.name})\n`)
  return 0
}

function commandRename(argv, io) {
  if (hasHelp(argv)) {
    io.write(`${RENAME_USAGE}\n`)
    return 0
  }
  if (argv.length === 0) throw usageError('hook rename needs a builtin id and an optional label')
  const [id, ...rest] = argv
  if (rest.length > 1) throw usageError('hook rename takes at most one label argument')
  const label = rest.length === 1 ? rest[0] : ''
  const value = String(label).trim()
  // 标签形状是 argv 校验：太长或带控制字符是用法错误（2），不是运行期失败（1）。
  if (value.length > 120) throw usageError(`a label is ${value.length} characters, over the 120 limit`)
  if (/[\u0000-\u001f\u007f]/.test(value)) throw usageError('a label cannot contain a control character')
  const row = requireBuiltinForArgv(id, io)
  let effective
  const outcome = writeHooks(io, hooks => {
    if (value === '') delete hooks.labels[row.id]
    else hooks.labels[row.id] = value
    effective = value === '' ? row.defaultLabel : value
    return true
  })
  if (reportWrite(io, outcome) !== 0) return 1
  io.write(`${row.id}: ${effective}${value === '' ? ' (default label)' : ''}\n`)
  return 0
}

function commandTest(argv, io) {
  if (hasHelp(argv)) {
    io.write(`${TEST_USAGE}\n`)
    return 0
  }
  const parsed = parseArgs(argv, {
    command: 'hook test',
    flags: { '--event': 'event', '--payload': 'payload' },
  })
  if (parsed.positional.length !== 1) throw usageError('hook test needs exactly one custom hook id')
  const id = parsed.positional[0].trim()
  if (id.startsWith('builtin:')) {
    io.writeError(
      `wheelchair-agent: ${id} is a builtin row, not a script: it is core path and has no script to test. ` +
        'Only custom hook-* rows can be tested.\n',
    )
    return 1
  }
  const snapshot = resolveSettings({ env: io.env })
  const model = readHooks({ env: io.env })
  const item = snapshot.hooks.items.find(candidate => candidate.id === id)
  if (item === undefined) {
    io.writeError(
      `wheelchair-agent: no custom hook with id ${JSON.stringify(id)}; run "wheelchair-agent hook list".\n`,
    )
    return 1
  }
  const event = parsed.event === undefined ? item.event : requireEventForArgv(parsed.event).id
  let payload
  if (parsed.payload === undefined) {
    payload = samplePayload(event, { now: new Date().toISOString(), workspace: io.cwd })
  } else {
    try {
      payload = JSON.parse(parsed.payload)
    } catch (error) {
      throw usageError(`--payload is not valid JSON: ${error.message}`)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw usageError('--payload must be one JSON object')
    }
  }
  return runTest(io, item, event, payload, model)
}

async function runTest(io, item, event, payload, model) {
  const eventId = `test:${event}:${new Date().toISOString()}`
  const record = await runOneHook(item, event, payload, {
    env: io.env,
    cwd: io.cwd,
    record: false,
    eventId,
    hooks: model,
  })
  const lines = [
    `hook ${item.id} on ${event} (test only: nothing was recorded, no cursor claim)`,
    ...(item.enabled === false ? ['note: this row is disabled; hook test runs it anyway.'] : []),
    ...(model.enabled === false ? ['note: hooks.enabled is false; hook test runs it anyway.'] : []),
    `eventId: ${eventId}`,
    `payload: ${JSON.stringify(payload)}`,
    `cwd: ${hookCwd(event, payload, { cwd: io.cwd })}`,
    `exit: ${record.exit === null || record.exit === undefined ? '-' : record.exit}` +
      `  signal: ${record.signal ?? '-'}  duration: ${record.durationMs} ms  timed out: ${record.timedOut ? 'yes' : 'no'}`,
  ]
  if (record.error !== undefined) lines.push(`error: ${record.error}`)
  lines.push('', 'stdout (last 8 KiB):', record.stdout === '' ? '(empty)' : record.stdout)
  lines.push('', 'stderr (last 8 KiB):', record.stderr === '' ? '(empty)' : record.stderr)
  io.write(`${lines.join('\n')}\n`)
  const failed = record.error !== undefined || record.timedOut || record.exit !== 0
  if (failed) io.writeError(`wheelchair-agent: hook ${item.id} failed (see the output above).\n`)
  return failed ? 1 : 0
}

function commandLog(argv, io) {
  if (hasHelp(argv)) {
    io.write(`${LOG_USAGE}\n`)
    return 0
  }
  const parsed = parseArgs(argv, { command: 'hook log', flags: { '--tail': 'tail', '--event': 'event' } })
  if (parsed.positional.length > 0) {
    throw usageError(`unexpected argument ${JSON.stringify(parsed.positional[0])} for "hook log"`)
  }
  let tail = 20
  if (parsed.tail !== undefined) {
    if (!/^\d+$/.test(String(parsed.tail).trim()) || Number(parsed.tail) < 1) {
      throw usageError(`--tail must be a whole number of lines, got ${JSON.stringify(parsed.tail)}`)
    }
    tail = Number(parsed.tail)
  }
  const event = parsed.event === undefined ? undefined : requireEventForArgv(parsed.event).id
  const all = readHookRecords({ env: io.env })
  const filtered = event === undefined ? all : all.filter(record => record.event === event)
  const shown = filtered.slice(-tail)
  const model = readHooks({ env: io.env })
  const where = model.recordsFile ?? '(the data root could not be resolved)'
  if (shown.length === 0) {
    io.write(
      event === undefined
        ? `no hook records yet at ${where}\n`
        : `no hook records for ${event} at ${where}\n`,
    )
    return 0
  }
  const lines = [
    `hook records: ${where}${event === undefined ? '' : ` (event ${event})`} — showing ${shown.length} of ${filtered.length}`,
  ]
  for (const record of shown) {
    const state = record.skipped === undefined ? '' : `  skipped=${record.skipped}`
    const exit = record.exit === null || record.exit === undefined ? '-' : record.exit
    const hook = record.hookId === undefined || record.hookId === ''
      ? '(event)'
      : `${record.hookId}${record.name === undefined || record.name === '' ? '' : ` (${record.name})`}`
    lines.push(
      `${String(record.ts ?? '-')}  ${String(record.event ?? '-')}  ${hook}  exit=${exit}` +
        `  dur=${record.durationMs ?? 0}ms${record.timedOut ? '  TIMED OUT' : ''}${state}`,
    )
    const stderr = preview(record.stderr, 160)
    if (stderr !== '') lines.push(`  stderr: ${stderr}`)
    if (record.error !== undefined) lines.push(`  error: ${preview(record.error, 160)}`)
  }
  io.write(`${lines.join('\n')}\n`)
  return 0
}

function commandPrompt(argv, io) {
  if (hasHelp(argv)) {
    io.write(`${PROMPT_USAGE}\n`)
    return 0
  }
  if (argv.length !== 1 || argv[0].startsWith('-')) throw usageError('hook prompt needs exactly one event id')
  const entry = requireEventForArgv(argv[0])
  io.write(`${buildHookPrompt(entry.id, { env: io.env, cwd: io.cwd })}\n`)
  return 0
}

/** 事件 id 的 argv 校验：未知事件是用法错误（2），并列出可用的 id。 */
function requireEventForArgv(value) {
  const entry = eventById(String(value ?? '').trim())
  if (entry === undefined) {
    throw usageError(
      `unknown event ${JSON.stringify(value)}; known ids are ${EVENTS.map(item => item.id).join(', ')}`,
    )
  }
  return entry
}

/** 内建行 id 的 argv 校验：只有 `builtin:*` 能改名。 */
function requireBuiltinForArgv(value, io) {
  const id = String(value ?? '').trim()
  const model = readHooks({ env: io.env })
  if (!id.startsWith('builtin:')) {
    throw usageError(
      `hook rename only accepts builtin ids (builtin:*); ${JSON.stringify(value)} is not one. ` +
        'Custom hooks are named at "hook add" time; remove and re-add to change the name.',
    )
  }
  const row = model.builtin.find(candidate => candidate.id === id)
  if (row === undefined) {
    throw usageError(
      `unknown builtin row ${JSON.stringify(value)}; known ids are ${model.builtin.map(candidate => candidate.id).join(', ')}`,
    )
  }
  return row
}

/**
 * 入口：`runHookCommand(argv, io)` 返回退出码（0/1），用法错误抛 `code: "HOOK_USAGE"` 由 bin 变 2。
 * `io`：`{write, writeError, env, cwd}`，默认写 stdout/stderr 与 `process.env` / `process.cwd()`。
 */
export async function runHookCommand(argv = [], io = {}) {
  const write = io.write ?? (text => process.stdout.write(text))
  const writeError = io.writeError ?? (text => process.stderr.write(text))
  const env = io.env ?? process.env
  const cwd = io.cwd ?? process.cwd()
  const context = { write, writeError, env, cwd }
  const [sub, ...rest] = argv
  switch (sub) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      write(`${HOOK_USAGE}\n`)
      return 0
    case 'events':
      return commandEvents(rest, context)
    case 'list':
      return commandList(rest, context)
    case 'add':
      return commandAdd(rest, context)
    case 'enable':
      return commandToggle(rest, context, true)
    case 'disable':
      return commandToggle(rest, context, false)
    case 'rm':
      return commandRm(rest, context)
    case 'rename':
      return commandRename(rest, context)
    case 'test':
      return await commandTest(rest, context)
    case 'log':
      return commandLog(rest, context)
    case 'prompt':
      return commandPrompt(rest, context)
    default:
      throw usageError(`unknown option ${JSON.stringify(sub)} for "hook"`)
  }
}
