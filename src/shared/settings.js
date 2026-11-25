/**
 * 面板设置：`<root>/settings.json` 的唯一实现（schema、校验、解析、保存、HTTP 面）。
 *
 * 为什么需要它：面板上的旋钮原先散落在环境变量、CLI 参数和源码常量里，改一个值要重启服务或会话。这里把
 * 它们收成**一个有版本号的文件**，服务（webui 的 host 半身）和 SPV 会话（注入器、`work gc`）都读同一份，
 * 每次用到时重读，所以「试一个自定义提示词，不好就切回默认」不需要重启。
 *
 * 三层优先级（低 → 高）：内置默认 < 环境变量 < 插件 config < 设置文件。文件是自包含的：新建时把
 * `KEY_SPECS` 的全部默认值写进 `values`，读到一个缺键的旧文件时也只补缺的那些键（revision 不动、已有值
 * 不改）。补进去的键记在顶层 `filled` 里：它们不是用户选择，所以 panel 的 source 仍是 `default`，环境变量/
 * 插件 config 也仍然能压过它们；用户显式设成默认值的键不在 `filled` 里，source 仍是 `file`。`rows` 同时
 * 给出被压住的低层值——「看起来生效其实没生效」是这里最该避免的失败模式。
 *
 * 模板：每个模板永远有一个不可修改的内置预设 `default`，外加任意个命名预设，同一时刻只有一个 active。
 * 占位符按模板声明，保存时校验；未知占位符和缺失的必填占位符都直接报错——收件箱的接收方需要评论与线程
 * 这两个事实才能行动。
 *
 * 插口（hook）：`hooks` 是同一文件的顶层字段（形状与执行契约见 `ARCHITECTURE/hooks/execution.md`）。事件 id 与内建行来自
 * `src/shared/hook-events.js`，本文件只负责**校验、合并、落盘**，不执行任何脚本。它与其他字段共享同一条
 * 乐观并发规则：过期 revision 是 409，磁盘一个字节都不动；坏子块则按字段 warning 后跳过，文件仍然可用。
 *
 * 失败模式是刻意分开的：
 *   - 提交非法值（PUT / `saveSettings`）→ 抛 `SETTINGS_INVALID`，什么都不写；
 *   - 过期的 revision → 抛 `SETTINGS_CONFLICT`，什么都不写（HTTP 409）；
 *   - 磁盘上的文件坏了/手改错了 → 绝不从 `resolveSettings` 抛：忽略坏字段、退回默认，`fileState` 与
 *     `warning` 说明原因。注入器、轮询器、CLI 因此都不会被一个坏文件拖死。
 *
 * 文件位置由 `src/shared/home.js` 决定：`<root>/settings.json`，默认 `~/.wheelchair-agent`，可用
 * `$WHEELCHAIR_AGENT_HOME` 覆盖。旧位置 `<stateDir>/panel-settings.json` 仍会被读取一次并搬到新位置
 * （见那个模块的迁移说明）；文件内容、schema 与键名**不变**。
 *
 * 纯 Node builtins；`install.sh` 会把这个文件与 `home.js` / `hook-events.js` 一起复制进 webui 包的
 * `lib/shared/`，它必须能单独存在。`stateDir` 参数仍可用，但只表示**旧的** state 目录（迁移与回退的来源）。
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { SETTINGS_FILE, dataPaths, resolveData } from './home.js'
import { runCore } from './queue.js'
import { BUILTIN_ROWS, EVENTS, builtinRowById, eventById } from './hook-events.js'

export { SETTINGS_FILE } from './home.js'

/** 文件格式版本；不认识的版本按 corrupt 处理，退回默认（未来升级时这里才能加迁移）。 */
export const SETTINGS_VERSION = 1

/** 面板的 settings 路由；与 `/wheelchair-inbox/*` 同一套 connection fence。 */
export const SETTINGS_PATH = '/wheelchair-settings'

/** 三个模板 id；顺序也是面板的展示顺序。 */
export const TEMPLATE_IDS = ['injection', 'prIssue', 'spvObjection']

/** 模板文本上限：沿用消息正文的 20000；评论本身在 inbox.js 仍限 5000。 */
const TEMPLATE_LIMIT = 20000

/** 请求体上限：与 `/wheelchair-inbox/review` 的 64 KiB 约定一致。 */
const MAX_BODY_BYTES = 64 * 1024

/** 预设名的控制字符（含换行、制表符）一律拒绝：它会破坏面板的一行式选择器。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * 这些名字即使放进 `Object.create(null)` 之外的普通对象也会碰到原型：`__proto__` 会改原型，
 * `constructor` / `prototype` 会让人误以为能改内置对象。直接大声拒绝，别静默丢一个预设。
 */
const RESERVED_PRESET_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * 值 schema：键就是 JSON 里的扁平 dotted key，顺序就是面板的行顺序。
 *
 * `env` 是同一旋钮的环境变量（只用于展示 precedence，不写回）；`min`/`max` 对数字与长度生效；
 * `label` 是双语行名（面板仍可自行本地化，这里给默认值）。
 */
/**
 * 值 schema 的唯一来源在 Rust core 的 `settings` 子命令里（`specs` 动作）。这里用延迟代理保持同样的对象
 * 形状：模块导入本身不 spawn，首次 `Object.keys(KEY_SPECS)` / `KEY_SPECS[key]` 时才读取。这样
 * `injector.js` / `inbox.js` / 测试拿到的仍是同一张表，而 JS 里没有第二份定义会漂移。
 */
const settingsOp = request => runCore(['settings'], JSON.stringify(request))

let specsCache
function keySpecs() {
  if (specsCache === undefined) {
    const data = settingsOp({ op: 'specs' })
    if (!isPlainObject(data?.specs)) throw new Error('the Rust core returned no settings specs')
    specsCache = data.specs
  }
  return specsCache
}

export const KEY_SPECS = new Proxy(Object.create(null), {
  get(target, property) {
    if (typeof property === 'symbol') return target[property]
    const specs = keySpecs()
    return Object.hasOwn(specs, property) ? specs[property] : undefined
  },
  has(target, property) {
    return typeof property === 'string' && Object.hasOwn(keySpecs(), property)
  },
  ownKeys() {
    return Reflect.ownKeys(keySpecs())
  },
  getOwnPropertyDescriptor(target, property) {
    if (typeof property !== 'string' || !Object.hasOwn(keySpecs(), property)) return undefined
    return { value: keySpecs()[property], enumerable: true, writable: false, configurable: true }
  },
})
/**
 * 内置模板。`injection` 与 `spvObjection` 保持改造前的输出；`prIssue` 现在是 PR「有问题」评论发给
 * SPV 入口会话的 notice 正文（它不再派 worker，所以不能再复刻旧任务正文）：
 *   - `injection` 复刻 `formatResult()` 的头 + 正文；
 *   - `prIssue` 是 SPV 收到的 PR 质疑 notice；
 *   - `spvObjection` 复刻 `noticeText()`（对 SPV 自主决定的质疑）。
 */
const INJECTION_DEFAULT = [
  '[spv] {kind} on thread "{thread}"{ticket}:',
  '{body}',
].join('\n')

const PR_ISSUE_DEFAULT = [
  '审查收件箱转来一条对 GitHub PR 的质疑，请先处理。',
  '',
  'repo: {repo}',
  'PR: #{pr}',
  'title: {title}',
  'url: {url}',
  'kind: issue',
  '',
  '评论原文（原样保留）：',
  '{comment}',
  '',
  '操作者认为这个 PR 有问题。请你（SPV）先结合上下文和操作者讨论怎么改，再决定是否派活。',
].join('\n')

const SPV_OBJECTION_DEFAULT = [
  '审查收件箱转来一次对 SPV 自主决定的质疑，请处理。',
  '',
  '信件：{title}',
  '信件 id: {id}',
  'thread: {thread}',
  '',
  '操作者评论（原样保留）：',
  '{comment}',
  '',
  '这是对你在无人看管时自己作出的决定的质疑；请回顾当时的判断并处理。',
].join('\n')

/** 每个模板的声明：默认文本、允许的占位符、必填占位符、长度上限。 */
export const TEMPLATE_SPECS = {
  injection: {
    default: INJECTION_DEFAULT,
    placeholders: ['kind', 'thread', 'ticket', 'body'],
    required: ['thread', 'body'],
    limit: TEMPLATE_LIMIT,
  },
  prIssue: {
    default: PR_ISSUE_DEFAULT,
    placeholders: ['repo', 'pr', 'title', 'url', 'comment'],
    required: ['repo', 'pr', 'comment'],
    limit: TEMPLATE_LIMIT,
  },
  spvObjection: {
    default: SPV_OBJECTION_DEFAULT,
    placeholders: ['title', 'id', 'thread', 'comment'],
    required: ['thread', 'comment'],
    limit: TEMPLATE_LIMIT,
  },
}

/** 模板文本里任何 `{...}` 都算占位符；未知的一律拒绝，不静默留下一个坏消息。 */
const PLACEHOLDER = /\{([^{}]*)\}/g

/**
 * 设置文件的绝对路径，迁移之后**实际要读写**的那一条。
 *
 * `home` 是显式的数据根（测试与 `--root` 类调用），`stateDir` 只是旧 superagent state 目录：旧文件还在
 * 那里时，这次调用会先尝试把它搬到新位置；搬不动就继续用旧路径（见 `src/shared/home.js`）。
 */
export function settingsFile({ env = process.env, home, stateDir, migrate = true } = {}) {
  return resolveData({ env, home, stateDir, migrate }).settings
}

// ------------------------------------------------------------------ helpers

function settingsError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  return Object.assign(error, extra)
}

/** 提交非法值：HTTP 400，什么都不写。 */
function invalid(message) {
  return settingsError('SETTINGS_INVALID', message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function has(object, key) {
  return Object.hasOwn(object, key)
}

function describeValue(raw) {
  if (typeof raw === 'string') return JSON.stringify(raw)
  try {
    return JSON.stringify(raw) ?? String(raw)
  } catch {
    return String(raw)
  }
}

/** 一个键的短标签，用在错误里：只报键名，不把整张表倒出来。 */
function specOf(key) {
  // own-property：`constructor` / `toString` 会从 Object.prototype 读到「值」，不能当成已知键。
  if (!has(KEY_SPECS, key)) throw invalid(`unknown settings key ${JSON.stringify(key)}.`)
  return KEY_SPECS[key]
}

// ----------------------------------------------------------------- templates

/** 预设名：trim 后 1..64 字符、无控制字符、不能占用内置名 `default`。 */
function normalizePresetName(name) {
  const raw = String(name ?? '')
  const value = raw.trim()
  if (value === '') throw invalid('a template preset name cannot be empty.')
  if (value.length > 64) {
    throw invalid(`template preset name ${JSON.stringify(value)} is ${value.length} characters, over the 64 limit.`)
  }
  if (CONTROL_CHARS.test(value)) {
    throw invalid(`template preset name ${JSON.stringify(value)} contains a control character.`)
  }
  if (value === 'default') {
    throw invalid('"default" is the built-in preset name; it cannot be created or renamed.')
  }
  if (RESERVED_PRESET_NAMES.has(value)) {
    throw invalid(
      `template preset name ${JSON.stringify(value)} is reserved: ` +
        `${[...RESERVED_PRESET_NAMES].map(name => JSON.stringify(name)).join(', ')} cannot be used.`,
    )
  }
  return value
}

/** 引号里的模板 id；未知 id 在保存时报错，不静默忽略。 */
function templateSpec(id) {
  // own-property：`constructor` 之类的名字不能从 Object.prototype 借到一个假 spec。
  if (!has(TEMPLATE_SPECS, id)) {
    throw invalid(`unknown template id ${JSON.stringify(id)}; known ids are ${TEMPLATE_IDS.join(', ')}.`)
  }
  return TEMPLATE_SPECS[id]
}

/**
 * 校验模板文本，返回原文本（不 trim：模板的空行与缩进是作者要的）。
 *
 * 报错一定点名出问题的占位符：`{commnet}` 这类拼写错误如果静默通过，只会产出收件箱接收方看不懂的消息。
 */
export function validateTemplate(id, text) {
  const spec = templateSpec(id)
  if (typeof text !== 'string') {
    throw invalid(`template ${JSON.stringify(id)} must be a string, got ${typeof text}.`)
  }
  if (text.length > spec.limit) {
    throw invalid(`template ${JSON.stringify(id)} is ${text.length} characters, over the ${spec.limit} limit.`)
  }
  const allowed = new Set(spec.placeholders)
  const seen = new Set()
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (!allowed.has(name)) {
      throw invalid(
        `unknown placeholder ${JSON.stringify(`{${name}}`)} in template ${JSON.stringify(id)}; ` +
          `allowed placeholders are ${spec.placeholders.map(item => `{${item}}`).join(', ')}.`,
      )
    }
    seen.add(name)
  }
  for (const name of spec.required) {
    if (!seen.has(name)) {
      throw invalid(
        `template ${JSON.stringify(id)} is missing required placeholder {${name}}: the receiving agent ` +
          'needs it to act. Add it back and save again.',
      )
    }
  }
  return text
}

/**
 * 用声明过的占位符填模板；没有值的占位符替换成空串（`{ticket}` 在没有工单号时就是这种情形）。
 * 未声明的 `{...}` 原样保留：正常路径上它已被 `validateTemplate` 挡住，留下原文比悄悄吞掉更好排查。
 */
export function renderTemplate(id, text, values = {}) {
  const spec = templateSpec(id)
  const allowed = new Set(spec.placeholders)
  const source = typeof text === 'string' && text !== '' ? text : spec.default
  return source.replace(PLACEHOLDER, (match, name) => {
    if (!allowed.has(name)) return match
    const value = values?.[name]
    return value === undefined || value === null ? '' : String(value)
  })
}

/** 内置预设（每个模板永远有、且不可修改）。 */
function builtinTemplate(id) {
  return { name: 'default', text: TEMPLATE_SPECS[id].default, builtin: true }
}

/**
 * 内部模板表示：`active` 总是指向 `default` 或 `customs` 里的一个键。
 *
 * `customs` 用 null 原型：预设名是用户输入，`toString` 这类键在普通对象上会读到继承属性，
 * 让 `has()` / 读取走偏；null 原型让每个键都只能是自己的。
 */
function emptyTemplateState() {
  return { active: 'default', customs: Object.create(null) }
}

function cloneTemplateState(state) {
  const customs = Object.create(null)
  for (const [name, text] of Object.entries(state.customs)) customs[name] = text
  return { active: state.active, customs }
}

// -------------------------------------------------------------------- hooks

/** 一次 hook 运行的默认超时；`hooks.scriptTimeoutMs` 的默认值也是它。 */
export const HOOK_TIMEOUT_DEFAULT = 10_000

/**
 * 单次 hook 的硬上限。读文件时超限的值被夹到上限并给一条 warning（文件整体仍然可用）；**写入时直接拒绝**
 * （`SETTINGS_INVALID`，什么都不写），所以不会出现"看起来存了 10 分钟其实 5 分钟"的静默偏差。
 * 一次只改 `values` / `templates` 的保存会原样保留磁盘上的 hooks 块，不会顺手把超限值改写成夹过的值。
 */
export const HOOK_TIMEOUT_CAP = 300_000

/**
 * 服务侧 runner 的默认轮询间隔（秒）：`hooks.intervalSeconds`。`0` 表示暂停（runner 仍挂着，改回正数
 * 不用重启），上限一天——再长就没有"自动"的意思了。默认值不落盘，未来的默认值升级才能到达旧文件。
 */
export const HOOK_INTERVAL_DEFAULT = 15

/** `hooks.intervalSeconds` 的硬上限（一天）。读盘超限夹住并 warning，写入直接拒绝。 */
export const HOOK_INTERVAL_MAX = 86_400

/** 行名 / 标签的长度上限；CLI 与模板名用的是同一档。 */
const HOOK_NAME_LIMIT = 120

/** 脚本长度上限：比消息正文的 20000 宽一点没有意义，一段 `sh -c` 不该长过大模板。 */
const HOOK_SCRIPT_LIMIT = 20_000

/** 自定义 hook id：`hook-` 前缀让内建行（`builtin:` 前缀）永远不会被自定义行遮住。 */
const HOOK_ITEM_ID = /^hook-[A-Za-z0-9][A-Za-z0-9._:-]{0,74}$/

/** `hooks` 子块认识的字段；多出来的按坏字段处理（读时 warning、写时拒绝）。 */
const HOOK_FIELDS = ['enabled', 'scriptTimeoutMs', 'intervalSeconds', 'items', 'labels']

/** 默认的 `hooks` 子块：全开、10 秒超时、15 秒轮询、没有自定义行、没有改名。 */
export function defaultHooks() {
  return {
    enabled: true,
    scriptTimeoutMs: HOOK_TIMEOUT_DEFAULT,
    intervalSeconds: HOOK_INTERVAL_DEFAULT,
    items: [],
    labels: {},
  }
}

/** 一个可改的深拷贝，保存路径在它上面做合并。 */
function cloneHooks(hooks) {
  return {
    enabled: hooks.enabled,
    scriptTimeoutMs: hooks.scriptTimeoutMs,
    intervalSeconds: hooks.intervalSeconds,
    items: hooks.items.map(item => ({ ...item })),
    labels: { ...hooks.labels },
  }
}

/**
 * 毫秒超时：整数、至少 1。超过硬上限时，`clamp` 为真（读磁盘）夹住，否则（写入）抛 `SETTINGS_INVALID`。
 * 0 / 负数 / 小数 / `"10s"` 这一类都是显式错误：一个"没有超时"的 hook 会把串行队列卡死。
 */
function normalizeHookTimeout(raw, { clamp = false } = {}) {
  if (typeof raw === 'boolean' || raw === null || typeof raw === 'object' || String(raw).trim() === '') {
    throw invalid(`a hook timeout must be a number of milliseconds, got ${describeValue(raw)}.`)
  }
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw invalid(`a hook timeout must be a whole number of milliseconds, got ${describeValue(raw)}.`)
  }
  if (value < 1) {
    throw invalid(`a hook timeout must be at least 1 millisecond, got ${describeValue(raw)}.`)
  }
  if (value > HOOK_TIMEOUT_CAP) {
    // 读文件时夹住（并 warning），写入时拒绝：磁盘上的手改可以救，API/CLI 的输入不行。
    if (clamp) return HOOK_TIMEOUT_CAP
    throw invalid(`a hook timeout must be at most ${HOOK_TIMEOUT_CAP} ms (the hard cap), got ${describeValue(raw)}.`)
  }
  return value
}

/**
 * 轮询间隔（秒）：整数、至少 0、至多一天。`0` 是"暂停"而不是错误；负数与小数是显式错误。
 * 与超时同一条规则：读盘超限夹住（并 warning），写入直接拒绝。
 */
function normalizeHookInterval(raw, { clamp = false } = {}) {
  if (typeof raw === 'boolean' || raw === null || typeof raw === 'object' || String(raw).trim() === '') {
    throw invalid(`a hook interval must be a whole number of seconds, got ${describeValue(raw)}.`)
  }
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw invalid(`a hook interval must be a whole number of seconds, got ${describeValue(raw)}.`)
  }
  if (value < 0) {
    throw invalid(`a hook interval must be zero (paused) or more seconds, got ${describeValue(raw)}.`)
  }
  if (value > HOOK_INTERVAL_MAX) {
    // 读文件时夹住（并 warning），写入时拒绝：磁盘上的手改可以救，API/CLI 的输入不行。
    if (clamp) return HOOK_INTERVAL_MAX
    throw invalid(
      `a hook interval must be at most ${HOOK_INTERVAL_MAX} seconds (one day), got ${describeValue(raw)}.`,
    )
  }
  return value
}

/** 行名：trim 后 1..120 字符、无控制字符（它会出现在一行式列表与提示词里）。 */
function normalizeHookName(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') throw invalid('a hook name cannot be empty.')
  if (value.length > HOOK_NAME_LIMIT) {
    throw invalid(`a hook name is ${value.length} characters, over the ${HOOK_NAME_LIMIT} limit.`)
  }
  if (CONTROL_CHARS.test(value)) {
    throw invalid(`a hook name ${JSON.stringify(value)} contains a control character.`)
  }
  return value
}

/** 脚本：非空、无 NUL、不超过上限；**不 trim**——缩进和换行是作者要的。 */
function normalizeHookScript(raw) {
  if (typeof raw !== 'string') {
    throw invalid(`a hook script must be a string, got ${typeof raw}.`)
  }
  if (raw.trim() === '') throw invalid('a hook script cannot be empty.')
  if (raw.includes('\u0000')) throw invalid('a hook script cannot contain a NUL byte.')
  if (raw.length > HOOK_SCRIPT_LIMIT) {
    throw invalid(`a hook script is ${raw.length} characters, over the ${HOOK_SCRIPT_LIMIT} limit.`)
  }
  return raw
}

/** 一个自定义 hook 行；`id` 必须唯一（由调用方检查），`event` 必须是表里的事件。 */
function normalizeHookItem(raw, index, { clampTimeout = false } = {}) {
  if (!isPlainObject(raw)) throw invalid(`hooks.items[${index}] must be a JSON object.`)
  for (const field of Object.keys(raw)) {
    if (!['id', 'event', 'name', 'enabled', 'script', 'timeoutMs'].includes(field)) {
      throw invalid(`unknown field ${JSON.stringify(field)} in hooks.items[${index}].`)
    }
  }
  const id = String(raw.id ?? '').trim()
  if (!HOOK_ITEM_ID.test(id)) {
    throw invalid(
      `hooks.items[${index}].id must look like "hook-<slug>" (letters, digits, dot, dash, colon, underscore; ` +
        `at most 80 characters), got ${describeValue(raw.id)}.`,
    )
  }
  const event = String(raw.event ?? '').trim()
  if (eventById(event) === undefined) {
    throw invalid(
      `hooks.items[${index}].event ${JSON.stringify(raw.event)} is not a known event; known ids are ` +
        `${EVENTS.map(entry => entry.id).join(', ')}.`,
    )
  }
  const item = {
    id,
    event,
    name: normalizeHookName(raw.name),
    enabled: true,
    script: normalizeHookScript(raw.script),
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      throw invalid(`hooks.items[${index}].enabled must be true or false, got ${describeValue(raw.enabled)}.`)
    }
    item.enabled = raw.enabled
  }
  if (raw.timeoutMs !== undefined) {
    item.timeoutMs = normalizeHookTimeout(raw.timeoutMs, { clamp: clampTimeout })
  }
  return item
}

/**
 * `hooks.labels`：只认内建行 id；空串表示"改回默认标签"（不落盘）。
 * 未知 id 一律拒绝：给一个不存在的行改名是永远看不到效果的输入错误。
 */
function normalizeHookLabels(raw) {
  if (!isPlainObject(raw)) {
    throw invalid('hooks.labels must be a JSON object of builtin row id -> label.')
  }
  const labels = {}
  for (const [id, label] of Object.entries(raw)) {
    if (builtinRowById(id) === undefined) {
      throw invalid(
        `hooks.labels refers to ${JSON.stringify(id)}, which is not a builtin row; known ids are ` +
          `${BUILTIN_ROWS.map(row => row.id).join(', ')}.`,
      )
    }
    if (typeof label !== 'string') {
      throw invalid(`hooks.labels[${JSON.stringify(id)}] must be a string, got ${typeof label}.`)
    }
    const value = label.trim()
    if (value === '') continue
    if (value.length > HOOK_NAME_LIMIT) {
      throw invalid(
        `hooks.labels[${JSON.stringify(id)}] is ${value.length} characters, over the ${HOOK_NAME_LIMIT} limit.`,
      )
    }
    if (CONTROL_CHARS.test(value)) {
      throw invalid(`hooks.labels[${JSON.stringify(id)}] contains a control character.`)
    }
    labels[id] = value
  }
  return labels
}

/**
 * 合并一次 `hooks` 写入。每个提供的字段**整体替换**（`items` / `labels` 不是逐个合并），省略的字段保留
 * 现有值——与 `values` / `templates` 的部分保存语义一致，所以"只改一个标签"不必重发整张表。
 */
function applyHooks(raw, hooks) {
  if (!isPlainObject(raw)) {
    throw invalid('hooks must be a JSON object with enabled/scriptTimeoutMs/items/labels.')
  }
  for (const field of Object.keys(raw)) {
    if (!HOOK_FIELDS.includes(field)) {
      throw invalid(`unknown field ${JSON.stringify(field)} in hooks; use ${HOOK_FIELDS.join(', ')}.`)
    }
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      throw invalid(`hooks.enabled must be true or false, got ${describeValue(raw.enabled)}.`)
    }
    hooks.enabled = raw.enabled
  }
  if (raw.scriptTimeoutMs !== undefined) hooks.scriptTimeoutMs = normalizeHookTimeout(raw.scriptTimeoutMs)
  if (raw.intervalSeconds !== undefined) hooks.intervalSeconds = normalizeHookInterval(raw.intervalSeconds)
  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items)) throw invalid('hooks.items must be an array of hook rows.')
    const items = []
    const seen = new Set()
    raw.items.forEach((entry, index) => {
      const item = normalizeHookItem(entry, index)
      if (seen.has(item.id)) {
        throw invalid(`hooks.items has a duplicate id ${JSON.stringify(item.id)}; ids must be unique.`)
      }
      seen.add(item.id)
      items.push(item)
    })
    hooks.items = items
  }
  if (raw.labels !== undefined) hooks.labels = normalizeHookLabels(raw.labels)
}

/**
 * 读盘用的 `hooks`：坏字段各自一条 warning，能用的部分保留。文件整体坏了（JSON / version / revision）
 * 仍然在 `readStored` 里变成 `fileState: "corrupt"`，这条路径只处理"文件整体没坏、子块有毛病"。
 */
function readStoredHooks(raw, warnings) {
  const hooks = defaultHooks()
  if (raw === undefined) return hooks
  if (!isPlainObject(raw)) {
    warnings.push('ignoring "hooks": it must be a JSON object.')
    return hooks
  }
  for (const field of Object.keys(raw)) {
    if (!HOOK_FIELDS.includes(field)) {
      warnings.push(`ignoring unknown field ${JSON.stringify(field)} in "hooks".`)
    }
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') hooks.enabled = raw.enabled
    else warnings.push('ignoring hooks.enabled: it must be true or false.')
  }
  if (raw.scriptTimeoutMs !== undefined) {
    try {
      hooks.scriptTimeoutMs = normalizeHookTimeout(raw.scriptTimeoutMs, { clamp: true })
      if (Number(raw.scriptTimeoutMs) > HOOK_TIMEOUT_CAP) {
        warnings.push(`hooks.scriptTimeoutMs is over the ${HOOK_TIMEOUT_CAP} ms cap; using the cap.`)
      }
    } catch (error) {
      warnings.push(`ignoring hooks.scriptTimeoutMs: ${error.message}`)
    }
  }
  if (raw.intervalSeconds !== undefined) {
    try {
      hooks.intervalSeconds = normalizeHookInterval(raw.intervalSeconds, { clamp: true })
      if (Number(raw.intervalSeconds) > HOOK_INTERVAL_MAX) {
        warnings.push(`hooks.intervalSeconds is over the ${HOOK_INTERVAL_MAX}s cap; using the cap.`)
      }
    } catch (error) {
      warnings.push(`ignoring hooks.intervalSeconds: ${error.message}`)
    }
  }
  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items)) {
      warnings.push('ignoring "hooks.items": it must be an array of hook rows.')
    } else {
      const seen = new Set()
      raw.items.forEach((entry, index) => {
        try {
          const item = normalizeHookItem(entry, index, { clampTimeout: true })
          if (isPlainObject(entry) && entry.timeoutMs !== undefined && Number(entry.timeoutMs) > HOOK_TIMEOUT_CAP) {
            warnings.push(`hooks.items[${index}].timeoutMs is over the ${HOOK_TIMEOUT_CAP} ms cap; using the cap.`)
          }
          if (seen.has(item.id)) throw invalid(`duplicate hook id ${JSON.stringify(item.id)}; keeping the first.`)
          seen.add(item.id)
          hooks.items.push(item)
        } catch (error) {
          warnings.push(`ignoring hooks.items[${index}]: ${error.message}`)
        }
      })
    }
  }
  if (raw.labels !== undefined) hooks.labels = readStoredHookLabels(raw.labels, warnings)
  return hooks
}

/** `labels` 的逐条容错读取：一个坏条目不该把其他改名一起丢掉。 */
function readStoredHookLabels(raw, warnings) {
  const labels = {}
  if (!isPlainObject(raw)) {
    warnings.push('ignoring "hooks.labels": it must be a JSON object of builtin row id -> label.')
    return labels
  }
  for (const [id, label] of Object.entries(raw)) {
    if (builtinRowById(id) === undefined) {
      warnings.push(`ignoring hooks.labels entry for unknown builtin row ${JSON.stringify(id)}.`)
      continue
    }
    if (typeof label !== 'string') {
      warnings.push(`ignoring hooks.labels[${JSON.stringify(id)}]: it must be a string.`)
      continue
    }
    const value = label.trim()
    if (value === '') continue
    if (value.length > HOOK_NAME_LIMIT || CONTROL_CHARS.test(value)) {
      warnings.push(`ignoring hooks.labels[${JSON.stringify(id)}]: not a usable label.`)
      continue
    }
    labels[id] = value
  }
  return labels
}

/** 只写非默认字段：与模板一样，默认值不落盘，未来的默认值升级才不会被旧文件钉死。 */
function serializeHooks(hooks) {
  const stored = {}
  if (!hooks.enabled) stored.enabled = false
  if (hooks.scriptTimeoutMs !== HOOK_TIMEOUT_DEFAULT) stored.scriptTimeoutMs = hooks.scriptTimeoutMs
  if (hooks.intervalSeconds !== HOOK_INTERVAL_DEFAULT) stored.intervalSeconds = hooks.intervalSeconds
  if (hooks.items.length > 0) stored.items = hooks.items.map(item => ({ ...item }))
  if (Object.keys(hooks.labels).length > 0) stored.labels = { ...hooks.labels }
  return stored
}

// -------------------------------------------------------------- file storage

function corrupt(file, warning, { resolve = false, env, home, stateDir, config } = {}) {
  if (resolve) {
    return finishStored({
      file,
      fileState: 'corrupt',
      parsed: undefined,
      fillDefaults: false,
      env,
      home,
      stateDir,
      config,
      resolve: true,
      warning,
    })
  }
  return {
    file,
    fileState: 'corrupt',
    revision: 0,
    values: {},
    templates: {},
    hooks: defaultHooks(),
    hooksRaw: undefined,
    filled: new Set(),
    warning,
  }
}

/** 读磁盘；任何坏文件都变成一个 `fileState`/`warning`，绝不抛给调用方。 */
function readStored({
  env,
  home,
  stateDir,
  migrate = true,
  fillDefaults = false,
  resolve = false,
  config = {},
} = {}) {
  const file = settingsFile({ env, home, stateDir, migrate })
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return finishStored({
        file,
        fileState: 'missing',
        parsed: undefined,
        fillDefaults: false,
        env,
        home,
        stateDir,
        config,
        resolve,
      })
    }
    return corrupt(file, `${file} cannot be read (${error?.code ?? error?.message ?? error}); using defaults.`, { resolve, env, home, stateDir, config })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return corrupt(file, `${file} is not valid JSON (${error.message}); using defaults.`, { resolve, env, home, stateDir, config })
  }
  if (!isPlainObject(parsed)) {
    return corrupt(file, `${file} must hold one JSON object; using defaults.`, { resolve, env, home, stateDir, config })
  }
  if (parsed.version !== SETTINGS_VERSION) {
    return corrupt(
      file,
      `${file} has version ${describeValue(parsed.version)}, but only version ${SETTINGS_VERSION} is ` +
        'supported; using defaults.',
      { resolve, env, home, stateDir, config },
    )
  }
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
    return corrupt(
      file,
      `${file} has revision ${describeValue(parsed.revision)}; it must be a non-negative integer. Using defaults.`,
      { resolve, env, home, stateDir, config },
    )
  }
  return finishStored({ file, fileState: 'ok', parsed, fillDefaults, env, home, stateDir, config, resolve })
}

/** Parse the values/filled blocks through the Rust core, fill once if asked, and keep warning order. */
function finishStored({ file, fileState, parsed, fillDefaults, env, home, stateDir, config, resolve, warning }) {
  const warnings = warning === undefined ? [] : [warning]
  if (parsed !== undefined) {
    for (const field of Object.keys(parsed)) {
      if (!['version', 'revision', 'values', 'templates', 'hooks', 'filled'].includes(field)) {
        warnings.push(`ignoring unknown settings field ${JSON.stringify(field)} in ${file}.`)
      }
    }
  }
  const request = {
    op: resolve ? 'resolve' : 'read',
    fillMissing: fillDefaults,
    ...(parsed === undefined ? {} : { values: parsed.values, filled: parsed.filled }),
    ...(resolve ? { env, config } : {}),
  }
  const data = settingsOp(request)
  warnings.push(...(data.filledWarnings ?? []))
  let filled = new Set(data.filled ?? [])
  if (data.fill !== undefined) {
    try {
      writeStored({ env, home, stateDir }, { ...parsed, values: data.fill.values, filled: data.fill.filled })
      filled = new Set(data.fill.filled)
    } catch (error) {
      warnings.push(
        `could not fill missing default settings in ${file} (${error?.code ?? error?.message ?? error}); using defaults.`,
      )
    }
  }
  warnings.push(...(data.valuesWarnings ?? []))
  const templates = parsed === undefined ? {} : readStoredTemplates(parsed.templates, warnings)
  const hooks = parsed === undefined ? defaultHooks() : readStoredHooks(parsed.hooks, warnings)
  return {
    file,
    fileState,
    revision: parsed === undefined ? 0 : parsed.revision,
    values: data.values ?? {},
    templates,
    hooks,
    hooksRaw: parsed !== undefined && isPlainObject(parsed.hooks) ? parsed.hooks : undefined,
    filled,
    warning: warnings.length > 0 ? warnings.join('; ') : undefined,
    effective: data.effective,
    rows: data.rows,
    composeWarnings: data.composeWarnings ?? [],
  }
}/** `templates` 的坏预设同样跳过；内置预设不受文件影响。 */
function readStoredTemplates(raw, warnings) {
  const templates = {}
  if (raw === undefined) return templates
  if (!isPlainObject(raw)) {
    warnings.push('ignoring "templates": it must be a JSON object keyed by template id.')
    return templates
  }
  for (const [id, entry] of Object.entries(raw)) {
    if (!has(TEMPLATE_SPECS, id)) {
      warnings.push(`ignoring unknown template ${JSON.stringify(id)} in the file.`)
      continue
    }
    if (!isPlainObject(entry)) {
      warnings.push(`ignoring template ${JSON.stringify(id)}: it must be a JSON object.`)
      continue
    }
    for (const field of Object.keys(entry)) {
      if (!['active', 'presets'].includes(field)) {
        warnings.push(`ignoring unknown field ${JSON.stringify(field)} in template ${JSON.stringify(id)}.`)
      }
    }
    const state = emptyTemplateState()
    const presets = entry.presets
    if (presets !== undefined) {
      if (!isPlainObject(presets)) {
        warnings.push(`ignoring presets of template ${JSON.stringify(id)}: they must be a JSON object.`)
      } else {
        for (const [name, preset] of Object.entries(presets)) {
          const clean = String(name).trim()
          if (clean === 'default') {
            // The built-in preset is authoritative; a stored copy is advisory only. Older versions wrote
            // it, and a future builtin change must not turn every such file into a warning.
            continue
          }
          try {
            const presetName = normalizePresetName(clean)
            if (!isPlainObject(preset) || typeof preset.text !== 'string') {
              throw invalid(`preset ${JSON.stringify(presetName)} must be an object with a string "text".`)
            }
            state.customs[presetName] = validateTemplate(id, preset.text)
          } catch (error) {
            warnings.push(`ignoring preset ${JSON.stringify(clean)} of template ${JSON.stringify(id)}: ${error.message}`)
          }
        }
      }
    }
    const active = typeof entry.active === 'string' ? entry.active.trim() : ''
    if (active !== '' && active !== 'default' && !has(state.customs, active)) {
      warnings.push(
        `template ${JSON.stringify(id)} points at missing preset ${JSON.stringify(active)}; using the built-in default.`,
      )
    } else if (active === 'default' || active === '') {
      state.active = 'default'
    } else {
      state.active = active
    }
    templates[id] = state
  }
  return templates
}

/** 原子写：同目录临时文件 + rename；目标目录不存在时先建出来。 */
function writeStored({ env, home, stateDir } = {}, payload) {
  const file = settingsFile({ env, home, stateDir })
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
  chmodSync(temporary, 0o644)
  renameSync(temporary, file)
}

/**
 * Make sure the settings file exists, with the self-contained shape a fresh machine should have:
 * `{version, revision: 0, values: <every KEY_SPECS default>, templates: {}}`.
 *
 * Writing the defaults here is deliberate: the file is the machine's single source of truth, so a fresh
 * install can be inspected (and hand-edited) without knowing the source. Values equal to a built-in default
 * are still reported with source `default` (see the filled-default skip in `readStored`/the core `read` op),
 * so the panel is unchanged. An existing
 * file is never touched (`wx`); missing keys there are filled once by the first `resolveSettings` read, and a
 * legacy `panel-settings.json` is migrated by `settingsFile()` before that test, so the new file cannot
 * shadow real old values.
 */
export function ensureSettingsFile({ env = process.env, home, stateDir } = {}) {
  const file = settingsFile({ env, home, stateDir })
  try {
    readFileSync(file)
    return { file, created: false }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(file), { recursive: true })
  const defaults = settingsOp({ op: 'defaults' })
  const payload = {
    version: SETTINGS_VERSION,
    revision: 0,
    values: defaults.values,
    templates: {},
    // 默认值是补出来的、不是用户选的：记下来，面板的 source 仍是 default，env/config 也仍能压过它们。
    filled: defaults.filled,
  }
  try {
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    chmodSync(file, 0o644)
    return { file, created: true }
  } catch (error) {
    // Another writer won the race: its file is valid, so this is a success rather than an error.
    if (error?.code === 'EEXIST') return { file, created: false }
    throw error
  }
}

// ------------------------------------------------------------------- resolve

/** 把某个模板的内部状态变成 `resolveSettings().templates[id]` 的形状。 */
function describeTemplate(id, state) {
  const spec = TEMPLATE_SPECS[id]
  const active = state !== undefined && has(state.customs, state.active) ? state.active : 'default'
  const text = active === 'default' ? spec.default : state.customs[active]
  const presets = [builtinTemplate(id)]
  if (state !== undefined) {
    for (const [name, presetText] of Object.entries(state.customs)) {
      presets.push({ name, text: presetText, builtin: false })
    }
  }
  return {
    active,
    text,
    defaultText: spec.default,
    presets,
    placeholders: [...spec.placeholders],
    required: [...spec.required],
    limit: spec.limit,
  }
}

/**
 * 组装 `resolveSettings()` 的返回：文件有效值 > config > env > 内置默认，并保留每一层的痕迹。
 * `stored` 是 `readStored()` 的形状；`config` 只认 dotted key（外加 `intervalSeconds` 这个旧别名）。
 */
function composeSnapshot(stored) {
  const warnings = []
  if (stored.warning !== undefined) warnings.push(stored.warning)
  warnings.push(...(stored.composeWarnings ?? []))

  const templates = {}
  for (const id of TEMPLATE_IDS) {
    templates[id] = describeTemplate(id, stored.templates[id])
  }

  return {
    revision: stored.revision,
    version: SETTINGS_VERSION,
    file: stored.file,
    fileState: stored.fileState,
    ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
    values: { ...stored.values },
    effective: stored.effective ?? {},
    rows: stored.rows ?? [],
    templates,
    hooks: {
      enabled: stored.hooks.enabled,
      scriptTimeoutMs: stored.hooks.scriptTimeoutMs,
      intervalSeconds: stored.hooks.intervalSeconds,
      items: stored.hooks.items.map(item => ({ ...item })),
      labels: { ...stored.hooks.labels },
    },
  }
}

/**
 * 解析当前有效设置。每次调用都重读磁盘（文件很小），所以改了文件不需要重启。
 *
 * 读到版本正确但缺键的旧文件时，会**只补缺失的默认键**（revision 不变、已有值不动，只写一次）；文件
 * 不存在时仍然不创建——新装由 `ensureSettingsFile()`（install.sh / webui 挂载）负责。坏文件只回退默认，
 * 不猜、不写。
 *
 * 不会因为坏文件抛错；只有「配置层本身写错」会被记进 `warning` 并跳过。
 */
export function resolveSettings({ home, stateDir, env = process.env, config = {}, migrate = true } = {}) {
  return composeSnapshot(
    readStored({ home, stateDir, env, migrate, fillDefaults: true, resolve: true, config }),
  )
}

/**
 * 内置默认的完整快照：不读盘、不读 env。
 *
 * 注入器在没拿到 settings（老测试、或 settings 层自己失败）时用它，输出才与今天逐字节一致。
 * `file` 只是展示用的配置路径；这里刻意不触发迁移（`defaultSettings` 的契约是不碰磁盘）。
 */
export function defaultSettings({ home, stateDir, env = process.env } = {}) {
  const data = settingsOp({ op: 'resolve', fillMissing: false, env: {}, config: {} })
  return composeSnapshot({
    file: dataPaths({ home, stateDir, env }).settings.current,
    fileState: 'missing',
    revision: 0,
    values: {},
    templates: {},
    hooks: defaultHooks(),
    warning: undefined,
    effective: data.effective,
    rows: data.rows,
    composeWarnings: data.composeWarnings ?? [],
  })
}

// -------------------------------------------------------------------- saving

/** 合并 PUT 的 `reset`：先把显式覆盖删掉/把模板还原，再应用同一请求里的新值。 */
function applyReset(reset, values, templates) {
  if (!isPlainObject(reset)) {
    throw invalid('reset must be a JSON object with "values" and/or "templates".')
  }
  for (const field of Object.keys(reset)) {
    if (!['values', 'templates'].includes(field)) {
      throw invalid(`unknown reset field ${JSON.stringify(field)}; use "values" or "templates".`)
    }
  }
  if (reset.values !== undefined) {
    if (reset.values === true) {
      for (const key of Object.keys(values)) delete values[key]
    } else if (Array.isArray(reset.values)) {
      for (const key of reset.values) {
        specOf(key)
        delete values[key]
      }
    } else {
      throw invalid('reset.values must be true or an array of setting keys.')
    }
  }
  if (reset.templates !== undefined) {
    if (reset.templates === true) {
      for (const id of TEMPLATE_IDS) templates[id] = emptyTemplateState()
    } else if (Array.isArray(reset.templates)) {
      for (const id of reset.templates) {
        templateSpec(id)
        templates[id] = emptyTemplateState()
      }
    } else {
      throw invalid('reset.templates must be true or an array of template ids.')
    }
  }
}

/**
 * 合并 PUT 的 `templates`。每个 id 是一次**完整替换**：提供的 `presets` 就是该模板新的自定义预设全集，
 * 内置 `default` 永远在且改不了；`presets` 省略时保留现有自定义预设（只切 active 时不需要重发文本）。
 */
function applyTemplates(raw, templates) {
  if (!isPlainObject(raw)) {
    throw invalid('templates must be a JSON object keyed by template id.')
  }
  for (const [id, entry] of Object.entries(raw)) {
    templateSpec(id)
    if (!isPlainObject(entry)) {
      throw invalid(`templates[${JSON.stringify(id)}] must be a JSON object with "active" and/or "presets".`)
    }
    for (const field of Object.keys(entry)) {
      if (!['active', 'presets'].includes(field)) {
        throw invalid(
          `unknown field ${JSON.stringify(field)} in templates[${JSON.stringify(id)}]; ` +
            'use "active" and/or "presets".',
        )
      }
    }
    const current = templates[id] ?? emptyTemplateState()
    const next = cloneTemplateState(current)
    if (entry.presets !== undefined) {
      if (!isPlainObject(entry.presets)) {
        throw invalid(`templates[${JSON.stringify(id)}].presets must be a JSON object of preset name -> {text}.`)
      }
      const customs = Object.create(null)
      for (const [name, preset] of Object.entries(entry.presets)) {
        const clean = String(name).trim()
        if (clean === 'default') {
          if (!isPlainObject(preset) || typeof preset.text !== 'string') {
            throw invalid('the built-in preset "default" needs a string "text".')
          }
          if (preset.text !== TEMPLATE_SPECS[id].default) {
            throw invalid(
              `the built-in preset of template ${JSON.stringify(id)} cannot be changed; ` +
                'create a named preset instead.',
            )
          }
          continue
        }
        const presetName = normalizePresetName(clean)
        if (!isPlainObject(preset)) {
          throw invalid(`preset ${JSON.stringify(presetName)} must be an object with a string "text".`)
        }
        for (const field of Object.keys(preset)) {
          if (field !== 'text') {
            throw invalid(`unknown field ${JSON.stringify(field)} in preset ${JSON.stringify(presetName)}.`)
          }
        }
        if (typeof preset.text !== 'string') {
          throw invalid(`preset ${JSON.stringify(presetName)} needs a string "text".`)
        }
        customs[presetName] = validateTemplate(id, preset.text)
      }
      next.customs = customs
    }
    if (entry.active !== undefined) {
      if (typeof entry.active !== 'string') {
        throw invalid(`templates[${JSON.stringify(id)}].active must be a preset name.`)
      }
      const active = entry.active.trim() === '' ? 'default' : entry.active.trim()
      if (active !== 'default' && !has(next.customs, active)) {
        throw invalid(
          `templates[${JSON.stringify(id)}].active names ${JSON.stringify(entry.active)}, which is not a ` +
            'preset of that template.',
        )
      }
      next.active = active
    }
    // 删掉 active 指向的预设：回落到内置默认，而不是留下一个悬空引用。
    if (next.active !== 'default' && !has(next.customs, next.active)) next.active = 'default'
    templates[id] = next
  }
}

/** 只把非默认状态的模板写进文件：默认模板不落盘，文件才小、默认值升级也不受旧文件影响。 */
function serializeTemplates(templates) {
  const stored = {}
  for (const id of TEMPLATE_IDS) {
    const state = templates[id] ?? emptyTemplateState()
    if (state.active === 'default' && Object.keys(state.customs).length === 0) continue
    // Only custom presets are persisted: the built-in text comes from TEMPLATE_SPECS, so a future builtin
    // change applies to old files instead of being shadowed (and warned about) forever.
    const presets = Object.create(null)
    for (const [name, text] of Object.entries(state.customs)) {
      presets[name] = { text, builtin: false }
    }
    stored[id] = { active: state.active, presets }
  }
  return stored
}

/**
 * 保存一次改动，返回保存后的完整快照。
 *
 * `revision` 必须等于当前文件的 revision（乐观并发）：不等就抛 `SETTINGS_CONFLICT`，**磁盘一个字节都不动**。
 * `values` 是 dotted key -> 值（合并进已有显式覆盖）；`templates` 按模板 id 完整替换自定义预设；
 * `hooks` 是插口子块的部分更新（提供的字段整体替换，省略的保留）；`reset` 先执行（删覆盖 / 清空预设并回默认）。
 */
export function saveSettings({
  home,
  stateDir,
  revision,
  values,
  templates,
  hooks,
  reset,
  env = process.env,
  config = {},
} = {}) {
  const stored = readStored({ home, stateDir, env })
  try {
    settingsOp({
      op: 'check-revision',
      current: stored.revision,
      givenPresent: revision !== undefined,
      given: revision ?? null,
    })
  } catch (error) {
    if (error?.code === 'SETTINGS_CONFLICT') error.revision = stored.revision
    throw error
  }
  const nextValues = { ...stored.values }
  const nextTemplates = {}
  for (const id of TEMPLATE_IDS) {
    nextTemplates[id] = cloneTemplateState(stored.templates[id] ?? emptyTemplateState())
  }
  const nextHooks = cloneHooks(stored.hooks)
  if (reset !== undefined) applyReset(reset, nextValues, nextTemplates)
  // 值校验与「默认值铺底 + 显式覆盖」的 payload 都在 core 里做；patch 省略表示只保留已有显式值。
  const saved = settingsOp({
    op: 'save',
    current: stored.revision,
    values: nextValues,
    ...(values === undefined ? {} : { patch: values }),
  })
  if (templates !== undefined) applyTemplates(templates, nextTemplates)
  if (hooks !== undefined) applyHooks(hooks, nextHooks)

  const payload = {
    version: SETTINGS_VERSION,
    revision: saved.revision,
    // 保存也写全量：默认值铺底 + 显式覆盖。这样写入永远产出完整文件，下一次读取不需要再补键。
    values: saved.values,
    templates: serializeTemplates(nextTemplates),
  }
  if (Array.isArray(saved.filled) && saved.filled.length > 0) payload.filled = saved.filled
  if (hooks !== undefined) {
    // 默认的 hooks 子块不落盘：与 templates 同样的理由（默认值升级要能到达旧文件），也让只改 values 的
    // 保存不凭空多出一个空的 hooks 块。
    const storedHooks = serializeHooks(nextHooks)
    if (Object.keys(storedHooks).length > 0) payload.hooks = storedHooks
  } else if (stored.hooksRaw !== undefined) {
    // 这次没动 hooks：把磁盘上的块原样放回去（见 readStored 的 hooksRaw 说明）。
    payload.hooks = stored.hooksRaw
  }

  writeStored({ home, stateDir, env }, payload)
  // 必须带上调用方的 env/config：否则 PUT 响应会丢掉 precedence 层，页面会把一个未被改动的行
  // 误报成 default/内置值（GET 与 PUT 于是给出两个不同的 effective/source）。
  return resolveSettings({ home, stateDir, env, config })
}

// ---------------------------------------------------------------------- HTTP

function pathOf(req) {
  try {
    return new URL(String(req.url ?? '/'), 'http://settings.local').pathname
  } catch {
    return '/'
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 读完请求体；超过上限时排空并返回 null（调用方回 413）。 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume?.()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

const PUT_FIELDS = ['revision', 'values', 'templates', 'hooks', 'reset']

/**
 * 面板设置的 HTTP 面：只认 `/wheelchair-settings` 一条精确路由。
 *
 * - `GET`  → 200 完整快照（no-store；每次请求都重读文件）；
 * - `PUT`  → `{ revision, values?, templates?, hooks?, reset? }`；预设 CRUD、插口行与 reset 都搭这一次 PUT；
 *            过期 revision → 409 `{code:"conflict", revision, message}` 且不写；
 *            非法值 → 400 `{code:"SETTINGS_INVALID", message}`；体积/类型错误分别 413/415。
 *
 * Host 半身把它包在既有的 `ctx.connection.requestRejection` fence 后面注册，与 `/wheelchair-inbox/*` 一致。
 */
export function createSettingsHandler({ home, stateDir, config, env = process.env, decorate } = {}) {
  // Optional read-only view decorator (stage 3 panel). It runs on the same snapshot the store just
  // produced, so the panel never gains a second reader or writer. A decorator failure must not turn a
  // successful save into a 500: fall back to the plain snapshot and let the caller's view report itself.
  const decorated = snapshot => {
    if (typeof decorate !== 'function') return snapshot
    try {
      return decorate(snapshot)
    } catch {
      return snapshot
    }
  }
  return async function handle(req, res) {
    const pathname = pathOf(req)
    if (pathname !== SETTINGS_PATH) {
      sendJson(res, 404, { code: 'not-found', message: `no route for ${pathname}` })
      return
    }
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'PUT') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, PUT')
      res.end()
      return
    }
    if (method === 'GET') {
      try {
        sendJson(res, 200, decorated(resolveSettings({ home, stateDir, env, config })))
      } catch (error) {
        sendJson(res, 500, { code: 'internal-error', message: messageOf(error) })
      }
      return
    }

    const contentType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
      return
    }
    let text
    try {
      text = await readBoundedBody(req)
    } catch {
      sendJson(res, 400, { code: 'SETTINGS_INVALID', message: 'the request body could not be read' })
      return
    }
    if (text === null) {
      sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large (limit 64 KiB)' })
      return
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      sendJson(res, 400, { code: 'SETTINGS_INVALID', message: 'request body must be JSON' })
      return
    }
    if (!isPlainObject(body)) {
      sendJson(res, 400, { code: 'SETTINGS_INVALID', message: 'request body must be a JSON object' })
      return
    }
    const unknown = Object.keys(body).find(field => !PUT_FIELDS.includes(field))
    if (unknown !== undefined) {
      sendJson(res, 400, {
        code: 'SETTINGS_INVALID',
        message: `unknown request field ${JSON.stringify(unknown)}; use ${PUT_FIELDS.join(', ')}.`,
      })
      return
    }
    try {
      const snapshot = saveSettings({
        home,
        stateDir,
        revision: body.revision,
        values: body.values,
        templates: body.templates,
        hooks: body.hooks,
        reset: body.reset,
        env,
        config,
      })
      sendJson(res, 200, decorated(snapshot))
    } catch (error) {
      if (error?.code === 'SETTINGS_CONFLICT') {
        sendJson(res, 409, { code: 'conflict', revision: error.revision, message: messageOf(error) })
        return
      }
      if (error?.code === 'SETTINGS_INVALID') {
        sendJson(res, 400, { code: 'SETTINGS_INVALID', message: messageOf(error) })
        return
      }
      sendJson(res, 500, { code: 'internal-error', message: messageOf(error) })
    }
  }
}
