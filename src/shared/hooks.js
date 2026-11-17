/**
 * 插口（hook）引擎：**在项目事件上自动跑一段脚本**，跑完就把结果写进记录，绝不影响 core path。
 *
 * 两条路径，必须分清（`docs/hooks.md` 是完整说明）：
 *   - **core path**：review 落盘、notice 进 SPV 队列、合并后的 `git pull --ff-only`、队列 rename 式消费——
 *     这些永远发生，不可配置、不可取消。它们的实现分别在 `src/spv/inbox.js`、`src/spv/injector.js` 与
 *     `src/superagent/spv.js`，本文件**不碰**。
 *   - **hook**：额外的副作用。它可以失败、超时、exit 1；引擎记录后继续下一个。hook 从不包裹、不 gate、
 *     不重试 core path。
 *
 * 本文件负责四件事，全部是纯 Node builtins、无 dsh import、无 `process.exit`（`install.sh` 会把它复制进
 * preset 与 webui 包，它必须能单独存在，见 `ARCHITECTURE/layout.md` 规则 3）：
 *
 *   1. `readHooks()`——把设置存储里的 `hooks` 子块 + `hook-events.js` 的表拼成一份**纯 JSON 模型**，
 *      给执行器、CLI 与 stage 3 的面板用。每次调用都重新读盘（不缓存），坏文件不抛。
 *   2. `runHooksFor()` / `runOneHook()`——串行、有序执行；stdin 收 JSON、环境变量白名单、超时
 *      SIGTERM→SIGKILL、stdout/stderr 各留最后 8 KiB、逐条写 `hooks.jsonl`。
 *   3. `record*` / `eventsCursor`——`<root>/records/hooks.jsonl` 与 `<root>/records/events-cursor.json`。
 *      cursor 让同一个 occurrence 跨进程、跨重启只跑一次；它**永不裁剪**已处理的 id（归档是 append-only，
 *      裁掉一条旧 id 就等于同意它在之后的读取里重放一次）。
 *   4. `readQueueEvents()`——stage 2 的队列读取原语：**只读** `outbox/*.json` 与 `outbox/read/*.json`，
 *      按消息 id 去重、按时间排序、用 cursor 过滤；永不 rename、永不消费那条消息（消费属于 injector）。
 *
 * 安全：脚本收到的是**白名单环境**，不是 `process.env`；凭证样子的变量（`*TOKEN*`、`*KEY*`、`GH_*`、
 * `DSH_*` …）一律不传。`WCA_*` 是我们自己设的，只有事件事实，没有凭证。
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { EVENTS, BUILTIN_ROWS, builtinRowsFor, eventById } from './hook-events.js'
import { assertNotTicketClone, dataPaths } from './home.js'
import { dirsOf } from './queue.js'
import {
  HOOK_INTERVAL_DEFAULT,
  HOOK_INTERVAL_MAX,
  HOOK_TIMEOUT_CAP,
  HOOK_TIMEOUT_DEFAULT,
  defaultHooks,
  defaultSettings,
  resolveSettings,
} from './settings.js'

export { EVENTS, BUILTIN_ROWS, builtinRowById, builtinRowsFor, eventById } from './hook-events.js'
export { HOOK_INTERVAL_DEFAULT, HOOK_INTERVAL_MAX, HOOK_TIMEOUT_CAP, HOOK_TIMEOUT_DEFAULT } from './settings.js'

/** 记录文件：一行一次运行（JSON Lines）。 */
export const HOOKS_RECORD_FILE = 'hooks.jsonl'

/** cursor 文件：处理过的 occurrence id。 */
export const EVENTS_CURSOR_FILE = 'events-cursor.json'

/** 插口 spool 的目录名，位于 `<数据根>/records/` 下；一个文件一次 occurrence。 */
export const HOOK_SPOOL_DIR = 'hook-events'

/** spool 文件格式版本；不认识的版本按坏文件隔离（不猜怎么执行）。 */
export const HOOK_SPOOL_VERSION = 1

/** 队列事件负载里 `text` 的上限（Unicode code point）。超过时截断并带 `textTruncated`。 */
export const QUEUE_TEXT_LIMIT = 12_000

/** cursor 文件格式版本；不认识就当作空 cursor（重放一轮，而不是永远卡住）。 */
export const CURSOR_VERSION = 1

/** 一次运行在记录里保留的 stdout / stderr **尾部**字节数。 */
export const OUTPUT_LIMIT = 8 * 1024

/** 超时后先 SIGTERM，宽限这么久再 SIGKILL（见 `docs/hooks.md`）。 */
export const KILL_GRACE_MS = 500

/** cursor 锁：等待上限、重试间隔、过期时间（与 `src/shared/home.js` 的迁移锁同一套习惯）。 */
const LOCK_WAIT_MS = 2000
const LOCK_RETRY_MS = 25
const LOCK_STALE_MS = 30_000

/** 队列消息种类 → 事件 id。只映射这三种；`ticket.started` / `inbox.*` / `spv.dispatch` 不来自队列。 */
export const QUEUE_EVENT_KINDS = Object.freeze({
  acknowledgement: 'ticket.acknowledged',
  reply: 'ticket.delivered',
  notice: 'ticket.attention',
})

/**
 * 环境变量白名单：最小、非秘密的一组。`LC_*` 是前缀规则，其余按名字精确匹配。
 * 凭证类变量即使命中白名单也不会传（见 `isCredentialName`）。
 */
const ENV_ALLOWED = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TZ',
  'TERM',
  'TMPDIR',
])

/** 名字里出现这些词就当作凭证：宁可少传，不可泄漏。 */
const CREDENTIAL_WORDS = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|KEY)/i

// ------------------------------------------------------------------- helpers

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 默认的 warning 出口：stderr。库函数不抛，但"cursor 坏了、锁拿不到"必须让操作者看得见。 */
function stderrWarn(line) {
  try {
    process.stderr.write(`wheelchair-agent: ${line}\n`)
  } catch {
    // stderr 也写不了就只能放弃。
  }
}

/** 非空字符串，否则 `undefined`（空串在负载里等于"没有这个字段"）。 */
function nonEmpty(value) {
  const text = String(value ?? '').trim()
  return text === '' ? undefined : text
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function has(object, key) {
  return Object.hasOwn(object, key)
}

/** 同步睡一小会儿；cursor 锁只持有毫秒级，阻塞是诚实的形状。 */
function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, ms)
}

/**
 * 解析数据根与 records 目录。路径本身坏了（相对 `WHEELCHAIR_AGENT_HOME` 等）不抛：`readHooks()` 的契约
 * 是"坏设置不拖死调用方"，把错误变成一条 warning，执行器则在真正写记录时再报一次。
 */
function pathsOf({ env = process.env, home, stateDir } = {}) {
  try {
    const paths = dataPaths({ env, home, stateDir })
    return { root: paths.root, records: paths.records, error: undefined }
  } catch (error) {
    return { root: undefined, records: undefined, error: messageOf(error) }
  }
}

/** 读一次设置；坏文件返回默认值 + warning，绝不抛。 */
function settingsOf({ env = process.env, home, stateDir } = {}) {
  try {
    return { snapshot: resolveSettings({ env, home, stateDir }), error: undefined }
  } catch (error) {
    try {
      return {
        snapshot: defaultSettings({ env, home, stateDir }),
        error: `the settings store could not be read (${messageOf(error)}); using the built-in hooks defaults.`,
      }
    } catch (nested) {
      return {
        snapshot: { revision: 0, fileState: 'unreadable', hooks: defaultHooks() },
        error: `the settings store could not be read (${messageOf(nested)}); using the built-in hooks defaults.`,
      }
    }
  }
}

// ---------------------------------------------------------------------- model

/** 一个内建行的有效标签与展示字段（面板与 `hook list` 共用）。 */
function describeBuiltinRow(row, labels) {
  const renamed = has(labels, row.id)
  return {
    ...row,
    label: renamed ? labels[row.id] : row.defaultLabel,
    defaultLabel: row.defaultLabel,
    renamed,
  }
}

/**
 * 当前插口模型（**纯 JSON，无函数**）。读盘、不缓存；坏文件退回默认并给 `warning`。
 *
 * 形状（stage 3 的面板就按这个渲染）：
 *   {
 *     enabled, scriptTimeoutMs, intervalSeconds, timeoutCap, items, labels, revision, fileState, warning?,
 *     recordsFile, cursorFile,               // 两个文件的绝对路径（数据根不可用时为 undefined）
 *     events: [{ ...事件表, rows: [内建行], customCount, rowCount }],
 *     builtin: [所有内建行（含有效 label）],
 *   }
 *
 * `items` 按设置文件里的顺序（也就是每个事件内的执行顺序）；`events[].rows` 按 `BUILTIN_ROWS` 顺序。
 */
export function readHooks({ env = process.env, home, stateDir, settings } = {}) {
  const paths = pathsOf({ env, home, stateDir })
  let snapshot = settings
  const warnings = []
  if (snapshot === undefined) {
    const read = settingsOf({ env, home, stateDir })
    snapshot = read.snapshot
    if (read.error !== undefined) warnings.push(read.error)
  }
  if (snapshot?.warning !== undefined) warnings.push(snapshot.warning)
  if (paths.error !== undefined) warnings.push(paths.error)
  const hooks = snapshot?.hooks ?? defaultHooks()
  const labels = { ...(hooks.labels ?? {}) }
  const builtin = BUILTIN_ROWS.map(row => describeBuiltinRow(row, labels))
  const events = EVENTS.map(entry => {
    const rows = builtin.filter(row => row.events.includes(entry.id))
    const customCount = hooks.items.filter(item => item.event === entry.id).length
    return { ...entry, rows, customCount, rowCount: rows.length + customCount }
  })
  return {
    enabled: hooks.enabled !== false,
    scriptTimeoutMs: hooks.scriptTimeoutMs,
    intervalSeconds: hooks.intervalSeconds ?? HOOK_INTERVAL_DEFAULT,
    timeoutCap: HOOK_TIMEOUT_CAP,
    items: hooks.items.map(item => ({ ...item })),
    labels,
    revision: typeof snapshot?.revision === 'number' ? snapshot.revision : 0,
    fileState: snapshot?.fileState ?? 'missing',
    ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    recordsFile: paths.records === undefined ? undefined : join(paths.records, HOOKS_RECORD_FILE),
    cursorFile: paths.records === undefined ? undefined : join(paths.records, EVENTS_CURSOR_FILE),
    home: paths.root,
    events,
    builtin,
  }
}

/** 一个事件的展示条目；未知名抛错（调用方要给操作者一个能照抄的清单）。 */
export function requireEvent(eventId) {
  const entry = eventById(eventId)
  if (entry === undefined) {
    const error = new Error(
      `unknown hook event ${JSON.stringify(eventId)}; known ids are ${EVENTS.map(item => item.id).join(', ')}.`,
    )
    error.code = 'UNKNOWN_EVENT'
    throw error
  }
  return entry
}

/**
 * 事件的文档示例负载；`now` 给定时覆盖 `at`（`hook test` 用真实时间），`workspace` 给定时覆盖
 * `ticket.started` 的示例目录（`hook test` 必须有一个真实存在的 cwd，否则 spawn 会失败）。
 */
export function samplePayload(eventId, { now, workspace } = {}) {
  const entry = requireEvent(eventId)
  const payload = JSON.parse(JSON.stringify(entry.sample ?? {}))
  if (now !== undefined) payload.at = now
  if (workspace !== undefined && entry.id === 'ticket.started') payload.workspace = workspace
  return payload
}

/**
 * 一次 occurrence 的稳定 id：优先显式 `eventId`，否则从负载里按事件的**事实字段**派生。
 *
 * 派生规则（stage 2 的 runner 可以直接用，也可以自己传 eventId）：
 *   - 队列事件 → 消息 id；
 *   - 收件箱 review → `inbox.approved:<itemId>:<reviewIndex>` / `inbox.issue:<itemId>:<reviewIndex>`；
 *     **不要**用 notice 的 message id——队列读取器会用同一个 id 派生 `ticket.attention`，全局 cursor
 *     会把队列那次 occurrence 吞掉；
 *   - 合并 → `merge:<itemId>:<mergeCommit|pulledSha|at>`；
 *   - worker 启动 → `<ticketId>:<at>`（**必须带 at**，否则同一张工单的两次启动会被当成一次）；
 *   - 派活 → `dispatch:<taskId>`。
 *
 * 返回 `undefined` 表示"这次没有可用的 id"：此时不写 cursor，事件不会被去重。宁可重放，不可静默丢失。
 */
export function eventIdFor(eventId, payload = {}) {
  const explicit = nonEmpty(payload?.eventId)
  if (explicit !== undefined) return explicit
  const entry = eventById(eventId)
  if (entry === undefined) return nonEmpty(payload?.id)
  switch (entry.id) {
    case 'ticket.acknowledged':
    case 'ticket.delivered':
    case 'ticket.attention':
      return nonEmpty(payload.messageId)
    case 'inbox.approved':
    case 'inbox.issue': {
      // Namespace by event: inbox.approved and inbox.issue are different occurrences, and the notice's
      // message id must never be reused (the queue reader derives ticket.attention from it; the cursor is
      // global). A separate prefix also removes the latent approved/issue collision class entirely.
      const prefix = entry.id
      const itemId = nonEmpty(payload.itemId)
      if (itemId !== undefined) {
        return `${prefix}:${itemId}:${payload.reviewIndex === undefined ? 'latest' : payload.reviewIndex}`
      }
      const messageId = nonEmpty(payload.messageId)
      return messageId === undefined ? undefined : `${prefix}:${messageId}`
    }
    case 'inbox.merged': {
      const itemId = nonEmpty(payload.itemId)
      if (itemId === undefined) return undefined
      const anchor = nonEmpty(payload.mergeCommit) ?? nonEmpty(payload.pulledSha) ?? nonEmpty(payload.at)
      return anchor === undefined ? `merge:${itemId}` : `merge:${itemId}:${anchor}`
    }
    case 'ticket.started': {
      const ticketId = nonEmpty(payload.ticketId)
      const at = nonEmpty(payload.at)
      // 没有 at 就没有稳定的 occurrence：宁可不认领（不去重），也不要把同一张工单的两次启动合成一次。
      if (ticketId === undefined || at === undefined) return undefined
      return `${ticketId}:${at}`
    }
    case 'spv.dispatch': {
      const taskId = nonEmpty(payload.taskId)
      return taskId === undefined ? undefined : `dispatch:${taskId}`
    }
    default:
      return undefined
  }
}

/**
 * 超时解析：行内 `timeoutMs` → `hooks.scriptTimeoutMs` → 10000，最后夹到硬上限 300000。
 * 非法值（非数字、<1）在这一层退回上一层默认，而不是让一次运行永远挂着。
 */
export function resolveHookTimeout(item, hooks) {
  const candidates = [item?.timeoutMs, hooks?.scriptTimeoutMs, HOOK_TIMEOUT_DEFAULT]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue
    const value = typeof candidate === 'number' ? candidate : Number(candidate)
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) continue
    return Math.min(value, HOOK_TIMEOUT_CAP)
  }
  return HOOK_TIMEOUT_DEFAULT
}

/**
 * cwd 优先级（设计决定，文档里也写同一句）：
 *   - `ticket.*` 事件：`opts.workspace` → `payload.workspace` → `opts.cwd`（CLI 传 checkout 根）；
 *   - 其他事件：`opts.cwd`。
 * 目录不存在时不在这里抛：子进程会以 ENOENT 失败，那一条记进记录，下一个 hook 照常跑。
 */
export function hookCwd(eventId, payload = {}, opts = {}) {
  const base = nonEmpty(opts.cwd) ?? process.cwd()
  if (!String(eventId).startsWith('ticket.')) return base
  return nonEmpty(opts.workspace) ?? nonEmpty(payload.workspace) ?? base
}

/** 名字是否像凭证（白名单之外的第二道闸；白名单与它任一拒绝就不传）。 */
function isCredentialName(name) {
  if (/^(GH_|GITHUB_|DSH_)/i.test(name)) return true
  return CREDENTIAL_WORDS.test(name)
}

/** 名字是否在白名单内（`LC_*` 是前缀规则）。 */
function isAllowedEnvName(name) {
  return ENV_ALLOWED.has(name) || /^LC_[A-Z]+$/.test(name)
}

/**
 * 脚本的环境：白名单 + 凭证过滤 + `WCA_*`。
 * `WCA_HOME` 是数据根；`WCA_TICKET` 只在负载真的有 `ticketId` 时出现。
 */
export function hookEnv({ event, eventId, payload = {}, opts = {}, home, cwd } = {}) {
  const source = isPlainObject(opts.env) ? opts.env : process.env
  const env = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue
    if (!isAllowedEnvName(name) || isCredentialName(name)) continue
    env[name] = String(value)
  }
  env.WCA_EVENT = String(event)
  env.WCA_EVENT_AT = nonEmpty(payload.at) ?? nonEmpty(payload.eventAt) ?? new Date().toISOString()
  if (eventId !== undefined && eventId !== null && String(eventId) !== '') {
    env.WCA_EVENT_ID = String(eventId)
  }
  if (home !== undefined) env.WCA_HOME = home
  const ticket = nonEmpty(payload.ticketId)
  if (ticket !== undefined) env.WCA_TICKET = ticket
  if (cwd !== undefined) env.WCA_CWD = cwd
  return env
}

// ------------------------------------------------------------------- records

/** `<root>/records/hooks.jsonl`。数据根不可用时返回 `undefined`。 */
export function hooksRecordPath({ env = process.env, home, stateDir } = {}) {
  const { records } = pathsOf({ env, home, stateDir })
  return records === undefined ? undefined : join(records, HOOKS_RECORD_FILE)
}

/**
 * 追加一条记录。**绝不抛**：记录失败只写一句 stderr，然后返回 `false`——一次运行的结果不该因为磁盘满了
 * 而变成调用方的异常。
 */
export function hookRecord(record, { env = process.env, home, stateDir } = {}) {
  const records = pathsOf({ env, home, stateDir }).records
  const file = records === undefined ? undefined : join(records, HOOKS_RECORD_FILE)
  try {
    if (file === undefined) throw new Error('the data root could not be resolved')
    mkdirSync(dirname(file), { recursive: true })
    const existed = existsSync(file)
    appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o644 })
    // appendFileSync honours the umask when it creates the file; pin 0644 like the settings store does.
    if (!existed) chmodSync(file, 0o644)
    return true
  } catch (error) {
    try {
      process.stderr.write(`wheelchair-agent: cannot append the hook record: ${messageOf(error)}\n`)
    } catch {
      // stderr 也写不了就只能放弃：记录失败永远不能变成异常。
    }
    return false
  }
}

/** 读全部记录（坏行跳过）；`file` 不存在时返回 `[]`。 */
export function readHookRecords({ env = process.env, home, stateDir, tail, warn = stderrWarn } = {}) {
  const file = hooksRecordPath({ env, home, stateDir })
  if (file === undefined) return []
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    // 读不动（权限、路径其实是目录……）不该让 `hook log` 崩：说一句，当作还没有记录。
    warn(`cannot read the hook record ${file}: ${messageOf(error)}`)
    return []
  }
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value = JSON.parse(trimmed)
      if (isPlainObject(value)) records.push(value)
    } catch {
      // 崩溃留下的半行：跳过，不要让后面更早的记录也看不见。
    }
  }
  if (tail !== undefined && tail > 0) return records.slice(-tail)
  return records
}

// -------------------------------------------------------------------- cursor

/** `<root>/records/events-cursor.json`；数据根不可用时 `undefined`。 */
export function eventsCursorPath({ env = process.env, home, stateDir } = {}) {
  const records = pathsOf({ env, home, stateDir }).records
  return records === undefined ? undefined : join(records, EVENTS_CURSOR_FILE)
}

/** 空 cursor（null 原型：消息 id 是不可信输入，`__proto__` 不能变成原型赋值）。 */
function emptyCursor() {
  return { version: CURSOR_VERSION, updatedAt: undefined, ids: Object.create(null) }
}

/** 读 cursor；坏文件/坏版本当作空 cursor 并给一条 warning（宁可重放一轮，也不要永远不跑）。 */
export function readCursor({ env = process.env, home, stateDir, warn = () => {} } = {}) {
  const file = eventsCursorPath({ env, home, stateDir })
  const cursor = emptyCursor()
  if (file === undefined) return cursor
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`cannot read the hook cursor ${file}: ${messageOf(error)}; replaying.`)
    return cursor
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    warn(`the hook cursor ${file} is not valid JSON (${messageOf(error)}); replaying.`)
    return cursor
  }
  if (!isPlainObject(parsed) || parsed.version !== CURSOR_VERSION || !isPlainObject(parsed.ids)) {
    warn(`the hook cursor ${file} has an unsupported shape; replaying.`)
    return cursor
  }
  for (const [id, at] of Object.entries(parsed.ids)) {
    cursor.ids[id] = typeof at === 'string' ? at : new Date(0).toISOString()
  }
  if (typeof parsed.updatedAt === 'string') cursor.updatedAt = parsed.updatedAt
  return cursor
}

/** 原子写 cursor：同目录临时文件 + rename（与设置存储同一手法）。 */
export function writeCursor(cursor, { env = process.env, home, stateDir } = {}) {
  const file = eventsCursorPath({ env, home, stateDir })
  if (file === undefined) throw new Error('the data root could not be resolved')
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  const payload = {
    version: CURSOR_VERSION,
    updatedAt: new Date().toISOString(),
    ids: Object.fromEntries(Object.entries(cursor.ids)),
  }
  try {
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
    // writeFileSync's mode is filtered by the umask; pin 0644 before the atomic rename.
    chmodSync(temporary, 0o644)
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // 临时文件可能根本没建出来。
    }
    throw error
  }
  return payload
}

/** 这个 occurrence id 是否已经处理过。 */
export function hasEvent(eventId, opts = {}) {
  const id = nonEmpty(eventId)
  if (id === undefined) return false
  return has(readCursor(opts).ids, id)
}

/** 在 cursor 锁内跑 `fn`；锁被别的进程持有超过 2 s 就抛错（调用方决定怎么退化）。 */
function withCursorLock(records, fn) {
  mkdirSync(records, { recursive: true })
  const lock = join(records, '.events-cursor.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = openSync(lock, 'wx', 0o644)
      try {
        writeSync(handle, `${process.pid} ${new Date().toISOString()}\n`)
      } finally {
        closeSync(handle)
      }
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let info
      try {
        info = statSync(lock)
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        // 用 rename 收割：只有 rename 的赢家 unlink，才可能删到别人刚拿到的新锁。
        const reaped = `${lock}.reap.${process.pid}.${Date.now()}`
        try {
          renameSync(lock, reaped)
          unlinkSync(reaped)
        } catch (reapError) {
          if (reapError?.code !== 'ENOENT') throw reapError
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`the hook cursor lock ${lock} is held by another process`)
      }
      sleepSync(LOCK_RETRY_MS)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lock)
    } catch {
      // 已被别人当过期锁收割：没什么可清理的。
    }
  }
}

/**
 * 认领一次 occurrence：返回 `true` 表示"这次归我，可以跑"，`false` 表示"已经跑过，跳过"。
 *
 * 认领在**跑脚本之前**写入并落盘，所以一次崩溃最多丢掉那一次运行，绝不会在重启后补跑一遍。锁只覆盖
 * "读-改-写"这几毫秒，脚本运行在锁外（串行由 `runHooksFor` 保证，不是靠这把锁）。
 *
 * 数据根不可用或锁拿不到时返回 `true` 并在 stderr 说一句：宁可多跑一次（脚本应当用 `WCA_EVENT_ID`
 * 做到幂等），也不要静默丢掉一次事件。
 */
export function claimEvent(eventId, { env = process.env, home, stateDir, warn } = {}) {
  const id = nonEmpty(eventId)
  if (id === undefined) return true
  const records = pathsOf({ env, home, stateDir }).records
  const say = warn ?? (() => {})
  if (records === undefined) {
    say(`cannot resolve the data root; running ${JSON.stringify(id)} without the cursor.`)
    return true
  }
  try {
    return withCursorLock(records, () => {
      const cursor = readCursor({ env, home, stateDir, warn: say })
      if (has(cursor.ids, id)) return false
      cursor.ids[id] = new Date().toISOString()
      writeCursor(cursor, { env, home, stateDir })
      return true
    })
  } catch (error) {
    say(`cannot claim ${JSON.stringify(id)} in the hook cursor (${messageOf(error)}); running it anyway.`)
    return true
  }
}

// -------------------------------------------------------------- execution

/** 有界的输出尾部：内存只保留最后 `limit` 字节，同时记下总共来了多少字节。 */
function tailBuffer(limit) {
  const state = { buffer: Buffer.alloc(0), total: 0 }
  return {
    push(chunk) {
      state.total += chunk.length
      state.buffer = Buffer.concat([state.buffer, chunk])
      if (state.buffer.length > limit) state.buffer = state.buffer.subarray(state.buffer.length - limit)
    },
    get total() {
      return state.total
    },
    get truncated() {
      return state.total > limit
    },
    text() {
      return state.buffer.toString('utf8')
    },
  }
}

/**
 * 跑**一个** hook 行并返回记录。两个调用方：`runHooksFor`（`record` 默认 true）与 `hook test`
 * （`record: false`，不认领 cursor，也不写 `hooks.jsonl`）。
 *
 * 契约：永不 reject。脚本不存在、cwd 不存在、sh 起不来，都变成一条带 `error` 的记录。
 */
export async function runOneHook(item, event, payload = {}, opts = {}) {
  const model = opts.hooks ?? readHooks(opts)
  const timeoutMs = resolveHookTimeout(item, model)
  const cwd = hookCwd(event, payload, opts)
  const eventId = opts.eventId === undefined ? eventIdFor(event, payload) : nonEmpty(opts.eventId)
  const env = hookEnv({ event, eventId, payload, opts, home: model.home, cwd })
  const startedAt = Date.now()
  const record = {
    ts: new Date(startedAt).toISOString(),
    event: String(event),
    eventId: eventId ?? null,
    hookId: String(item?.id ?? ''),
    name: String(item?.name ?? ''),
    exit: null,
    signal: null,
    durationMs: 0,
    timedOut: false,
    stdout: '',
    stderr: '',
    truncated: { stdout: false, stderr: false },
  }
  const script = typeof item?.script === 'string' ? item.script : ''
  if (script.trim() === '') {
    record.error = `hook ${JSON.stringify(record.hookId)} has no script to run.`
    record.durationMs = Date.now() - startedAt
    if (opts.record !== false) hookRecord(record, opts)
    return record
  }
  const stdout = tailBuffer(OUTPUT_LIMIT)
  const stderr = tailBuffer(OUTPUT_LIMIT)

  await new Promise(resolve => {
    let settled = false
    let child
    let timer
    let killTimer
    let bailTimer
    let timedOut = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(bailTimer)
      record.durationMs = Date.now() - startedAt
      record.timedOut = timedOut
      record.stdout = stdout.text()
      record.stderr = stderr.text()
      record.truncated = { stdout: stdout.truncated, stderr: stderr.truncated }
      // A grandchild that inherited the pipes can keep 'close' from ever firing. We already have the
      // tail we promised; drop the handles so this process can exit.
      try {
        child?.stdout?.destroy()
        child?.stderr?.destroy()
        child?.stdin?.destroy()
      } catch {
        // Nothing to clean up.
      }
      resolve()
    }
    timer = setTimeout(() => {
      timedOut = true
      record.timedOut = true
      try {
        child?.kill('SIGTERM')
      } catch {
        // 进程可能刚好自己退出了。
      }
      killTimer = setTimeout(() => {
        try {
          child?.kill('SIGKILL')
        } catch {
          // 同上。
        }
        // SIGKILL 之后还不 'close'：说明有孙进程继承了管道。记录已有的尾部，然后放手。
        bailTimer = setTimeout(finish, KILL_GRACE_MS * 4)
      }, KILL_GRACE_MS)
      if (typeof killTimer.unref === 'function') killTimer.unref()
    }, timeoutMs)

    try {
      child = spawn('sh', ['-c', script], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      record.error = messageOf(error)
      finish()
      return
    }
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    // 脚本可能根本不读 stdin 就退出：EPIPE 不是错误。
    child.stdin.on('error', () => {})
    child.on('error', error => {
      record.error = `cannot run the hook in ${cwd}: ${messageOf(error)}`
      finish()
    })
    child.on('close', (code, signal) => {
      record.exit = code
      record.signal = signal ?? null
      finish()
    })
    try {
      child.stdin.end(`${JSON.stringify(payload ?? {})}\n`)
    } catch {
      // 子进程已经退出：记录里仍然有 exit/signal。
    }
  })

  if (opts.record !== false) hookRecord(record, opts)
  return record
}

/**
 * 在某个事件上跑**全部**启用的自定义 hook：按 `items` 顺序、串行、一个失败不影响下一个，**永不 reject**。
 *
 * `opts`：`{home, stateDir, env, cwd, workspace, eventId, eventAt, record, cursor, hooks, warn}`。
 *   - `eventId` 缺省时按 `eventIdFor()` 从负载派生；两者都没有就不写 cursor（不去重）；
 *   - `record: false` 不写 `hooks.jsonl`；
 *   - `cursor: false` 不读也不写 cursor（只跑一次的工具用）；
 *   - `warn` 覆盖 warning 出口（默认 stderr）。
 *
 * 返回值（便于 CLI/测试断言，不是错误通道）：
 *   `{event, eventId, ran, skipped, paused, derived, records, error?}`
 *   `skipped`: `"cursor"`（这次已经跑过）、`"paused"`（总开关关着）、`"empty"`（没有启用的行）。
 */
export async function runHooksFor(event, payload = {}, opts = {}) {
  const summary = {
    event: String(event),
    eventId: undefined,
    ran: 0,
    skipped: undefined,
    paused: false,
    derived: false,
    records: [],
  }
  try {
    const entry = eventById(event)
    if (entry === undefined) {
      summary.error = `unknown hook event ${JSON.stringify(event)}`
      return summary
    }
    const model = opts.hooks ?? readHooks(opts)
    const explicit = nonEmpty(opts.eventId)
    const eventId = explicit ?? eventIdFor(event, payload)
    summary.eventId = eventId
    summary.derived = explicit === undefined && eventId !== undefined
    const usingCursor = opts.cursor !== false && eventId !== undefined
    const warn = typeof opts.warn === 'function' ? opts.warn : stderrWarn
    // cursor 的 warning 不能静默：cursor 坏了/锁拿不到时脚本会照常跑（可能重复），操作者必须知道。
    const claim = () => claimEvent(eventId, { ...opts, warn })

    if (model.enabled === false) {
      summary.paused = true
      summary.skipped = 'paused'
      // 暂停也算一次 occurrence：认领之后，重新打开时不会把暂停期间的旧消息全部补跑一遍。
      if (usingCursor && !claim()) {
        summary.skipped = 'cursor'
        return summary
      }
      const record = {
        ts: new Date().toISOString(),
        event: String(event),
        eventId: eventId ?? null,
        skipped: 'paused',
      }
      if (opts.record !== false) hookRecord(record, opts)
      summary.records.push(record)
      return summary
    }

    const items = model.items.filter(item => item.event === entry.id && item.enabled !== false)
    if (items.length === 0) {
      // 没有可跑的行：不写记录、不跑脚本——但**认领这次 occurrence**。否则以后加上第一个 hook 时，
      // `outbox/read/` 里所有历史消息会被当成新事件补跑一遍。认领没有可观察的副作用，只是"这次看过"。
      if (usingCursor && !claim()) {
        summary.skipped = 'cursor'
        return summary
      }
      summary.skipped = 'empty'
      return summary
    }

    if (usingCursor && !claim()) {
      summary.skipped = 'cursor'
      return summary
    }

    for (const item of items) {
      // 每一行再包一层：`runOneHook` 本身承诺不抛，但一个意外的内部错误也绝不能带走后面的行。
      try {
        const record = await runOneHook(item, entry.id, payload, { ...opts, hooks: model, eventId })
        summary.ran += 1
        summary.records.push(record)
      } catch (error) {
        const record = {
          ts: new Date().toISOString(),
          event: entry.id,
          eventId: eventId ?? null,
          hookId: String(item?.id ?? ''),
          name: String(item?.name ?? ''),
          exit: null,
          signal: null,
          durationMs: 0,
          timedOut: false,
          stdout: '',
          stderr: '',
          truncated: { stdout: false, stderr: false },
          error: messageOf(error),
        }
        summary.ran += 1
        if (opts.record !== false) hookRecord(record, opts)
        summary.records.push(record)
      }
    }
  } catch (error) {
    summary.error = messageOf(error)
    try {
      process.stderr.write(`wheelchair-agent: hook run for ${JSON.stringify(String(event))} failed: ${messageOf(error)}\n`)
    } catch {
      // 不能再做什么了；runHooksFor 的契约是永不 reject。
    }
  }
  return summary
}

// ---------------------------------------------------------------------- spool

/**
 * 插口 spool 目录：`<数据根>/records/hook-events/`。数据根不可用时 `undefined`。
 *
 * 为什么需要它：`ticket.started` 与 `spv.dispatch` 发生在任何服务 tick 之外（worker 启动前的
 * `prepare.sh`、SPV 派活），而执行脚本的 runner 只在服务侧 webui host 里跑（一个读者，见 docs/hooks.md）。
 * 写一个文件是微秒级、不需要 node/python、也不会阻塞调用方；服务活着就由它在同一轮 drain 里执行，服务
 * 关着就等着。重建执行目录是懒的：`hookSpoolDir()` 只算路径，`writeHookSpoolEvent()` 才 mkdir。
 */
export function hookSpoolDir({ env = process.env, home, stateDir } = {}) {
  const records = pathsOf({ env, home, stateDir }).records
  return records === undefined ? undefined : join(records, HOOK_SPOOL_DIR)
}

/** 文件名里安全的一段：只留字母、数字、点、下划线、连字符。 */
function spoolFilePart(value, limit = 80) {
  const text = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+/, '')
  return (text === '' ? 'occurrence' : text).slice(0, limit)
}

/**
 * 写一个 spool occurrence：同目录临时文件（点开头，读者跳过）+ rename，所以读者永远看不到半写的 JSON。
 *
 * **best effort，永不抛**：spool 是额外的副作用，写不进去最多丢掉一次 hook 运行，绝不能让
 * `prepare.sh` 的工单或派活失败。返回落盘的文件路径；失败返回 `undefined`。
 */
export function writeHookSpoolEvent(event, payload = {}, { eventId, at, env = process.env, home, stateDir } = {}) {
  let temporary
  try {
    const name = nonEmpty(event)
    if (name === undefined) return undefined
    const dir = hookSpoolDir({ env, home, stateDir })
    if (dir === undefined) return undefined
    mkdirSync(dir, { recursive: true })
    const id = nonEmpty(eventId) ?? eventIdFor(name, payload)
    const stamp = nonEmpty(at) ?? new Date().toISOString()
    const record = {
      version: HOOK_SPOOL_VERSION,
      event: name,
      ...(id === undefined ? {} : { eventId: String(id) }),
      at: stamp,
      payload: isPlainObject(payload) ? payload : {},
    }
    const file = join(
      dir,
      `${spoolFilePart(name)}-${spoolFilePart(id ?? stamp)}-${process.pid}-${randomBytes(4).toString('hex')}.json`,
    )
    temporary = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o644 })
    // writeFileSync's mode is filtered by the umask; pin 0644 before the atomic rename.
    chmodSync(temporary, 0o644)
    renameSync(temporary, file)
    temporary = undefined
    return file
  } catch {
    if (temporary !== undefined) {
      try {
        unlinkSync(temporary)
      } catch {
        // The temporary file may never have been created.
      }
    }
    return undefined
  }
}

/**
 * 读 spool 目录：跳过点开头的临时文件，坏 JSON / 不认识的事件 / 坏版本进 `bad`（由调用方隔离），
 * **不删除任何文件**——删除是负责任的 drain 的最后一步。
 *
 * 排序与队列读取同一套规则：`at` 可解析就按它，否则用文件 mtime 派生的 ISO，再按 mtime、文件名决出同刻
 * 顺序。返回 `{events, bad, error?}`，其中 `events` 是 `[{file, event, eventId?, at, payload, mtime}]`。
 */
export async function readHookSpoolEvents({ env = process.env, home, stateDir } = {}) {
  const result = { events: [], bad: [] }
  const dir = hookSpoolDir({ env, home, stateDir })
  if (dir === undefined) return result
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return result
    return { ...result, error: messageOf(error) }
  }
  const entries = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const file = join(dir, name)
    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      result.bad.push({ file, error: messageOf(error) })
      continue
    }
    if (!isPlainObject(parsed)) {
      result.bad.push({ file, error: 'the spool entry is not a JSON object' })
      continue
    }
    if (parsed.version !== HOOK_SPOOL_VERSION) {
      result.bad.push({ file, error: `unsupported spool version ${JSON.stringify(parsed.version)}` })
      continue
    }
    const event = nonEmpty(parsed.event)
    if (event === undefined || eventById(event) === undefined) {
      result.bad.push({ file, error: `unknown hook event ${JSON.stringify(parsed.event)}` })
      continue
    }
    if (!isPlainObject(parsed.payload)) {
      result.bad.push({ file, error: 'the spool entry has no payload object' })
      continue
    }
    const at = String(parsed.at ?? '')
    const parsedAt = at === '' ? Number.NaN : Date.parse(at)
    const mtime = info.mtimeMs ?? 0
    entries.push({
      file,
      event,
      eventId: nonEmpty(parsed.eventId),
      at,
      payload: parsed.payload,
      mtime,
      sortAt: Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : new Date(mtime || 0).toISOString(),
    })
  }
  result.events = entries.sort((left, right) => {
    const byTime = left.sortAt.localeCompare(right.sortAt)
    if (byTime !== 0) return byTime
    if (left.mtime !== right.mtime) return left.mtime - right.mtime
    return left.file.localeCompare(right.file)
  })
  return result
}

/** 删掉一个 spool 文件（drain 的最后一步）。best effort，返回是否真的删掉了。 */
export function removeHookSpoolEvent(file) {
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/**
 * 隔离一个坏 spool 文件：rename 成 `<file>.bad`（保留证据、不再重试）。rename 失败就删掉——
 * 一个永远读不了的文件不能被无限重试。
 */
export function quarantineHookSpoolEvent(file) {
  try {
    renameSync(file, `${file}.bad`)
    return `${file}.bad`
  } catch {
    removeHookSpoolEvent(file)
    return undefined
  }
}

// --------------------------------------------------------------------- queue

/** 队列根：`$SPV_QUEUE_DIR` → `<stateDir>/spv`。与 `src/spv/paths.js` 同一条规则（那个模块属于 SPV 侧，
 * 共享库不 import 它；stage 2 也可以直接把 `resolveRoot()` 的结果传进来）。 */
export function resolveQueueRoot({ env = process.env, stateDir } = {}) {
  const fromEnv = nonEmpty(env?.SPV_QUEUE_DIR)
  if (fromEnv !== undefined) return fromEnv
  const state =
    nonEmpty(stateDir) ??
    nonEmpty(env?.DSH_SUPERAGENT_STATE_DIR) ??
    join(homedir(), '.dsh', 'state', 'superagent')
  const root = join(state, 'spv')
  // 与 `src/spv/paths.js` 同一条守卫：默认队列属于正在跑的部署，一个 ticket clone 的读取器必须在这之前
  // 失败，而不是悄悄读到操作者的真实队列。显式 `SPV_QUEUE_DIR` / `dirs` / `root` 仍然优先，不触发守卫。
  assertNotTicketClone({
    env,
    stateDir,
    what: 'the default spv queue root',
    target: root,
  })
  return root
}

/** 一个目录里的 `.json` 文件与它们的 mtime；目录不存在读作空。 */
async function jsonFiles(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = names
    .filter(name => name.endsWith('.json') && !name.startsWith('.'))
    .map(name => join(dir, name))
  return Promise.all(
    files.map(async file => {
      const info = await stat(file).catch(() => undefined)
      return { file, mtime: info?.mtimeMs ?? 0 }
    }),
  )
}

/** 消息所属 thread；与 `src/spv/outbox.js` 的 `threadOf()` 同一条规则（一行，不值得跨层 import）。 */
function threadOfMessage(message) {
  return String(message.thread ?? message.address?.thread ?? 'main')
}

/**
 * stage 2 的读取原语：把队列里的 acknowledgement / reply / notice 变成候选事件，**只读**。
 *
 * - 同时读 `outbox/*.json`（未消费）与 `outbox/read/*.json`（append-only 归档），所以 injector 先一步
 *   rename 走的消息仍然会被看到；本函数不做任何 rename、不调用 `consumeMessage`。
 * - 按消息 id 去重（同一条消息可能在两个目录里各有一份）。排序：`at` 可解析就用它，缺失或写坏时用文件
 *   mtime 派生的 ISO，再按 mtime、id 决出同刻顺序，所以一条没有 `at` 的消息不会排到所有日期之前。
 * - 用 `<root>/records/events-cursor.json` 过滤已经处理过的 id；同一个 id 只会返回一次。
 * - 只映射三种 kind；`ticket.started` / `inbox.*` / `spv.dispatch` 不来自队列，安排给 stage 2 的其它
 *   调用点（见 docs/hooks.md 的「stage 2 放在哪」）。
 *
 * 返回 `[{event, eventId, payload, message, file}]`；`payload` 就是脚本会从 stdin 收到的那份。负载里的
 * `file` 是这条消息在磁盘上的路径（`outbox/` 或 `outbox/read/`），脚本可以自己读全文；`text` 在超过
 * `QUEUE_TEXT_LIMIT` 个 code point 时被截断并带 `textTruncated: true`。
 */
export async function readQueueEvents({
  root,
  dirs,
  env = process.env,
  stateDir,
  home,
  cursor,
  limit,
  warn = stderrWarn,
} = {}) {
  const queueDirs = dirs ?? dirsOf(root ?? resolveQueueRoot({ env, stateDir }))
  const files = [...(await jsonFiles(queueDirs.outbox)), ...(await jsonFiles(queueDirs.read))]
  const seen = new Map()
  for (const { file, mtime } of files) {
    let message
    try {
      message = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (!isPlainObject(message)) continue
    const id = nonEmpty(message.id) ?? basename(file, '.json')
    if (seen.has(id)) continue
    const at = String(message.at ?? '')
    // `at` 可解析就按它排序；缺失/写坏时用文件 mtime 派生的 ISO，而不是让空串排到所有日期之前。
    const parsedAt = at === '' ? Number.NaN : Date.parse(at)
    seen.set(id, {
      id,
      file,
      mtime,
      message,
      kind: String(message.kind ?? ''),
      at,
      atIsValid: Number.isFinite(parsedAt),
      sortAt: Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : new Date(mtime || 0).toISOString(),
      event: QUEUE_EVENT_KINDS[String(message.kind ?? '')],
    })
  }
  const current = cursor ?? readCursor({ env, home, stateDir, warn })
  const events = [...seen.values()]
    .filter(entry => entry.event !== undefined)
    .filter(entry => !has(current.ids, entry.id))
    .sort((left, right) => {
      const byTime = left.sortAt.localeCompare(right.sortAt)
      if (byTime !== 0) return byTime
      if (left.mtime !== right.mtime) return left.mtime - right.mtime
      return left.id.localeCompare(right.id)
    })
  const chosen = limit !== undefined && limit >= 0 ? events.slice(0, limit) : events
  return chosen.map(entry => {
    const text = String(entry.message.text ?? '')
    // 按 Unicode code point 截断（不是 UTF-16 code unit）：代理对不会被切成半个字符，脚本仍能从 `file`
    // 读到完整正文。12000 已经远大于一条正常结果，截断只是防止一个输出洪水把 stdin 撑爆。
    const points = Array.from(text)
    const truncated = points.length > QUEUE_TEXT_LIMIT
    const payload = {
      messageId: entry.id,
      kind: entry.kind,
      text: truncated ? points.slice(0, QUEUE_TEXT_LIMIT).join('') : text,
      ...(truncated ? { textTruncated: true } : {}),
      thread: threadOfMessage(entry.message),
      file: entry.file,
      at: entry.atIsValid ? entry.at : entry.sortAt,
    }
    const ticketId = nonEmpty(entry.message.ticketId)
    if (ticketId !== undefined) payload.ticketId = ticketId
    return { event: entry.event, eventId: entry.id, payload, message: entry.message, file: entry.file }
  })
}

// -------------------------------------------------------------------- prompt

const PROMPT_ADD_SHAPE = id => `wheelchair-agent hook add --event ${id} --name "<名字>" --script '<shell 脚本>' [--timeout <毫秒>]`

/**
 * 给操作者一段**可复制给 agent 的中文提示词**：新增一个 hook。
 *
 * 只从 `EVENTS`（+ `hook-events.js` 的内建行）生成，stage 3 的面板直接显示这段文字，**不许再抄一份**。
 * 提示词的用途：操作者不写 shell、也不手改 `settings.json`；他把这段话交给 agent，由 agent 用 CLI 加上。
 */
export function buildHookPrompt(eventId, opts = {}) {
  const { cwd } = opts
  const entry = requireEvent(eventId)
  const sample = samplePayload(entry.id)
  const rows = builtinRowsFor(entry.id)
  const executable = readHooks(opts).items.filter(item => item.event === entry.id)
  const lines = [
    `请给 wheelchair-agent 增加一个插口（hook）：事件 \`${entry.id}\`（${entry.title}）发生时自动运行一段 shell 脚本。`,
    '',
    '## 这个事件是什么',
    entry.explanation,
    '',
    '## 什么时候触发',
    entry.when,
    '',
    '## 能触发几次',
    `${entry.repeatable ? '可以多次。' : '每个对象只会触发一次。'}${entry.repeatNote}`,
    '',
    '## 脚本收到什么',
    '- stdin：一行 JSON。示例值（真实调用时是这次事件的真实数据，字段名不变）：',
    '```json',
    JSON.stringify(sample, null, 2),
    '```',
    ...entry.payload.map(field => `- \`${field.name}\`：${field.description}`),
    '- 环境变量：`WCA_EVENT`（事件 id）、`WCA_EVENT_ID`（本次 occurrence 的稳定 id，用它做幂等）、',
    '  `WCA_EVENT_AT`、`WCA_HOME`（数据根）、`WCA_TICKET`（有工单时）、`WCA_CWD`（脚本的 cwd）。',
    '  其余环境只有白名单（`PATH`、`HOME`、`LANG`、`LC_*`、`TZ`、`TMPDIR` 等）；凭证类变量一律不传。',
    `- cwd：${
      entry.id === 'ticket.started'
        ? '工单的 workspace（`payload.workspace`，prepare 写入）'
        : entry.id.startsWith('ticket.')
          ? '队列事件没有 workspace；service runner 用 service 进程的 cwd，CLI 用当前目录'
          : 'CLI 用当前目录；service runner 用 service 进程的 cwd'
    }。`,
    `- 超时：默认 ${HOOK_TIMEOUT_DEFAULT} ms，行内 \`timeoutMs\` 优先，硬上限 ${HOOK_TIMEOUT_CAP} ms；超时先 SIGTERM，${KILL_GRACE_MS} ms 后 SIGKILL。`,
    `- 输出：stdout / stderr 各只保留最后 ${OUTPUT_LIMIT / 1024} KiB，写进 \`<数据根>/records/hooks.jsonl\`。失败或超时只记录，**不影响 core path**。`,
    '',
    '## 内建行（core path，不可取消，不要试图替代它们）',
    ...(rows.length === 0
      ? ['（这个事件没有内建行，全部是操作者自己的脚本。）']
      : rows.map(row => {
          const edit = row.template === undefined ? '' : `，正文用已有模板 \`${row.template}\``
          const pointer = row.pointer === undefined ? '' : `，真正的实现在 \`${row.pointer}\`（别处，只做指针）`
          return `- \`${row.id}\`（${row.defaultLabel}）${edit}${pointer}`
        })),
    '',
    '## 怎么加（必须走 CLI，不要手改 settings.json）',
    '```sh',
    PROMPT_ADD_SHAPE(entry.id),
    '```',
    '',
    '加完之后这样验证：',
    '```sh',
    'wheelchair-agent hook list',
    `wheelchair-agent hook test <新 id> --event ${entry.id}`,
    `wheelchair-agent hook log --event ${entry.id}`,
    '```',
    '',
    '## 约束',
    '- 设置文件只能通过 CLI / 设置存储写（有 revision 乐观并发，过期写入是 409，什么都写不进去）；不要编辑器手改。',
    '- hook 是额外的副作用：不要用它实现或修改 review 落盘、notice 发送、`git pull --ff-only` 这些 core path。',
    '- 脚本应当用 `WCA_EVENT_ID` 做幂等：同一个 occurrence 在崩溃重放时可能再跑一次。',
    `- 这个事件当前已有 ${executable.length} 个自定义行；id 由 \`hook add\` 生成（\`hook-…\`），不要自己编。`,
  ]
  if (cwd !== undefined) lines.push('', `（生成这段文字时的 checkout：${cwd}）`)
  return lines.join('\n')
}
