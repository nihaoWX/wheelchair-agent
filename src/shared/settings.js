/**
 * 面板设置：`<stateDir>/panel-settings.json` 的唯一实现（schema、校验、解析、保存、HTTP 面）。
 *
 * 为什么需要它：面板上的旋钮原先散落在环境变量、CLI 参数和源码常量里，改一个值要重启服务或会话。这里把
 * 它们收成**一个有版本号的文件**，服务（webui 的 host 半身）和 SPV 会话（注入器、`work gc`）都读同一份，
 * 每次用到时重读，所以「试一个自定义提示词，不好就切回默认」不需要重启。
 *
 * 三层优先级（低 → 高）：内置默认 < 环境变量 < 插件 config < 设置文件。设置文件里的显式覆盖存 `values`；
 * 没写过的键不落盘，所以改默认值不会被旧文件永久钉住。`rows` 同时给出有效值、默认值、来源，以及被压住的
 * 低层值——「看起来生效其实没生效」是这里最该避免的失败模式。
 *
 * 模板：每个模板永远有一个不可修改的内置预设 `default`，外加任意个命名预设，同一时刻只有一个 active。
 * 占位符按模板声明，保存时校验；未知占位符和缺失的必填占位符都直接报错——收件箱的接收方需要评论与线程
 * 这两个事实才能行动。
 *
 * 失败模式是刻意分开的：
 *   - 提交非法值（PUT / `saveSettings`）→ 抛 `SETTINGS_INVALID`，什么都不写；
 *   - 过期的 revision → 抛 `SETTINGS_CONFLICT`，什么都不写（HTTP 409）；
 *   - 磁盘上的文件坏了/手改错了 → 绝不从 `resolveSettings` 抛：忽略坏字段、退回默认，`fileState` 与
 *     `warning` 说明原因。注入器、轮询器、CLI 因此都不会被一个坏文件拖死。
 *
 * 纯 Node builtins，不 import 本仓库其它模块：`install.sh` 会把这个文件复制进 webui 包的
 * `lib/shared/settings.js`，它必须能单独存在。stateDir 的默认值与 `src/spv/paths.js` 同一条规则
 * （`$DSH_SUPERAGENT_STATE_DIR`，否则 `~/.dsh/state/superagent`），在这里重算一遍而不是 import 它。
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 文件格式版本；不认识的版本按 corrupt 处理，退回默认（未来升级时这里才能加迁移）。 */
export const SETTINGS_VERSION = 1

/** 设置文件名。 */
export const SETTINGS_FILE = 'panel-settings.json'

/** 面板的 settings 路由；与 `/wheelchair-inbox/*` 同一套 connection fence。 */
export const SETTINGS_PATH = '/wheelchair-settings'

/** 三个模板 id；顺序也是面板的展示顺序。 */
export const TEMPLATE_IDS = ['injection', 'prIssue', 'spvObjection']

/** 模板文本上限：沿用消息正文的 20000；评论本身在 inbox.js 仍限 5000。 */
const TEMPLATE_LIMIT = 20000

/** 请求体上限：与 `/wheelchair-inbox/review` 的 64 KiB 约定一致。 */
const MAX_BODY_BYTES = 64 * 1024

/** 安装目标仓库的形状：`owner/name` 或 `name`。 */
const INSTALL_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/

/** 预设名的控制字符（含换行、制表符）一律拒绝：它会破坏面板的一行式选择器。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * 值 schema：键就是 JSON 里的扁平 dotted key，顺序就是面板的行顺序。
 *
 * `env` 是同一旋钮的环境变量（只用于展示 precedence，不写回）；`min`/`max` 对数字与长度生效；
 * `label` 是双语行名（面板仍可自行本地化，这里给默认值）。
 */
export const KEY_SPECS = {
  'inbox.intervalSeconds': {
    type: 'integer',
    default: 60,
    env: 'SPV_INBOX_INTERVAL_SECONDS',
    min: 0,
    max: 2147483,
    label: { zh: '收件箱刷新间隔（秒）', en: 'Inbox refresh interval (seconds)' },
  },
  'merge.installRepo': {
    type: 'string',
    default: 'wheelchair-agent',
    env: 'SPV_INSTALL_REPO',
    label: { zh: '合并即冷安装的仓库', en: 'Install-target repository' },
  },
  'injection.intervalMs': {
    type: 'integer',
    default: 1000,
    min: 50,
    max: 3600000,
    label: { zh: '结果注入间隔（毫秒）', en: 'Result injection interval (ms)' },
  },
  'injection.maxBodyChars': {
    type: 'integer',
    default: 12000,
    min: 100,
    max: 200000,
    label: { zh: '注入正文上限（字符）', en: 'Injected body limit (characters)' },
  },
  'work.keep': {
    type: 'integer',
    default: 0,
    min: 0,
    max: 100000,
    label: { zh: 'work gc 保留最新的目录数', en: 'work gc newest directories to keep' },
  },
  'work.keepDays': {
    type: 'integer',
    default: 0,
    min: 0,
    max: 36500,
    label: { zh: 'work gc 保留最近天数', en: 'work gc retention days' },
  },
  'work.sweepOnMount': {
    type: 'boolean',
    default: true,
    label: { zh: '服务启动时自动回收', en: 'Reclaim at mount' },
  },
}

/**
 * 内置模板。三段文本必须与改造前的输出**逐字节一致**，否则没有设置文件的老部署会看到消息变了：
 *   - `injection` 复刻 `formatResult()` 的头 + 正文；
 *   - `prIssue` 复刻 `taskText()`（「有问题」评论派给 worker 的任务正文）；
 *   - `spvObjection` 复刻 `noticeText()`（对 SPV 自主决定的质疑）。
 */
const INJECTION_DEFAULT = [
  '[spv] {kind} on thread "{thread}"{ticket}:',
  '{body}',
].join('\n')

const PR_ISSUE_DEFAULT = [
  '审查收件箱转来一条 GitHub PR 评论，请处理。',
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
  '操作者认为这个 PR 有问题，请按评论处理。',
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

/** 默认 stateDir：与 `src/spv/paths.js` 同一条规则（这里重算，不 import，见文件头）。 */
function defaultStateDir(env = process.env) {
  const fromEnv = String(env?.DSH_SUPERAGENT_STATE_DIR ?? '').trim()
  if (fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh', 'state', 'superagent')
}

/** 设置文件的绝对路径；`stateDir` 省略时用默认 stateDir。 */
export function settingsFile(stateDir) {
  const dir = String(stateDir ?? '').trim()
  return resolve(join(dir === '' ? defaultStateDir() : dir, SETTINGS_FILE))
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

/** 过期 revision：HTTP 409，什么都不写。 */
function conflict(current, given) {
  const why =
    given === undefined
      ? 'settings revision is required'
      : `settings revision ${JSON.stringify(given)} is stale`
  return settingsError(
    'SETTINGS_CONFLICT',
    `${why}: the current revision is ${current}. Reload the panel and retry; nothing was written.`,
    { revision: current },
  )
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
  const spec = KEY_SPECS[key]
  if (spec === undefined) throw invalid(`unknown settings key ${JSON.stringify(key)}.`)
  return spec
}

/**
 * 校验并规范化一个值。
 *
 * `strict` 用于磁盘文件与 PUT：整数键必须是整数（0.02 秒这类分数只允许来自旧插件 config / 环境变量）；
 * 布尔键必须是 JSON 布尔，字符串 `"true"` 不算。非 strict 只用于 config / env 这两层，且只有
 * `inbox.intervalSeconds` 允许分数——`webui/lib/index.js` 的既有 config 就写过 0.02。
 */
function normalizeValue(key, raw, { strict = true } = {}) {
  const spec = specOf(key)
  if (spec.type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (!strict && (raw === 'true' || raw === 'false')) return raw === 'true'
    throw invalid(`${key} must be true or false, got ${describeValue(raw)}.`)
  }
  if (spec.type === 'string') {
    if (typeof raw !== 'string') {
      throw invalid(`${key} must be a string, got ${describeValue(raw)}.`)
    }
    const value = raw.trim()
    if (key === 'merge.installRepo' && !INSTALL_REPO_PATTERN.test(value)) {
      throw invalid(
        `${key} must be "name" or "owner/name" using letters, digits, dot, dash and underscore, ` +
          `got ${JSON.stringify(raw)}.`,
      )
    }
    return value
  }
  // integer
  if (typeof raw === 'boolean' || raw === null || typeof raw === 'object' || String(raw).trim() === '') {
    throw invalid(`${key} must be a number, got ${describeValue(raw)}.`)
  }
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(value)) {
    throw invalid(`${key} must be a number, got ${describeValue(raw)}.`)
  }
  if (!Number.isInteger(value) && (strict || key !== 'inbox.intervalSeconds')) {
    throw invalid(`${key} must be a whole number, got ${describeValue(raw)}.`)
  }
  if (spec.min !== undefined && value < spec.min) {
    throw invalid(`${key} must be at least ${spec.min}, got ${describeValue(raw)}.`)
  }
  if (spec.max !== undefined && value > spec.max) {
    throw invalid(`${key} must be at most ${spec.max}, got ${describeValue(raw)}.`)
  }
  return value
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
  return value
}

/** 引号里的模板 id；未知 id 在保存时报错，不静默忽略。 */
function templateSpec(id) {
  const spec = TEMPLATE_SPECS[id]
  if (spec === undefined) {
    throw invalid(`unknown template id ${JSON.stringify(id)}; known ids are ${TEMPLATE_IDS.join(', ')}.`)
  }
  return spec
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

/** 内部模板表示：`active` 总是指向 `default` 或 `customs` 里的一个键。 */
function emptyTemplateState() {
  return { active: 'default', customs: {} }
}

function cloneTemplateState(state) {
  const customs = {}
  for (const [name, text] of Object.entries(state.customs)) customs[name] = text
  return { active: state.active, customs }
}

// -------------------------------------------------------------- file storage

function corrupt(file, warning) {
  return { file, fileState: 'corrupt', revision: 0, values: {}, templates: {}, warning }
}

/** 读磁盘；任何坏文件都变成一个 `fileState`/`warning`，绝不抛给调用方。 */
function readStored(stateDir) {
  const file = settingsFile(stateDir)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { file, fileState: 'missing', revision: 0, values: {}, templates: {}, warning: undefined }
    }
    return corrupt(file, `${file} cannot be read (${error?.code ?? error?.message ?? error}); using defaults.`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return corrupt(file, `${file} is not valid JSON (${error.message}); using defaults.`)
  }
  if (!isPlainObject(parsed)) {
    return corrupt(file, `${file} must hold one JSON object; using defaults.`)
  }
  if (parsed.version !== SETTINGS_VERSION) {
    return corrupt(
      file,
      `${file} has version ${describeValue(parsed.version)}, but only version ${SETTINGS_VERSION} is ` +
        'supported; using defaults.',
    )
  }
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
    return corrupt(
      file,
      `${file} has revision ${describeValue(parsed.revision)}; it must be a non-negative integer. Using defaults.`,
    )
  }
  const warnings = []
  for (const field of Object.keys(parsed)) {
    if (!['version', 'revision', 'values', 'templates'].includes(field)) {
      warnings.push(`ignoring unknown settings field ${JSON.stringify(field)} in ${file}.`)
    }
  }
  return {
    file,
    fileState: 'ok',
    revision: parsed.revision,
    values: readStoredValues(parsed.values, warnings),
    templates: readStoredTemplates(parsed.templates, warnings),
    warning: warnings.length > 0 ? warnings.join('; ') : undefined,
  }
}

/** `values` 只保留通过校验的显式覆盖；坏键/坏值各自一条 warning，然后落到下一层。 */
function readStoredValues(raw, warnings) {
  const values = {}
  if (raw === undefined) return values
  if (!isPlainObject(raw)) {
    warnings.push('ignoring "values": it must be a JSON object of dotted keys.')
    return values
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!has(KEY_SPECS, key)) {
      warnings.push(`ignoring unknown settings key ${JSON.stringify(key)} in the file.`)
      continue
    }
    try {
      values[key] = normalizeValue(key, value)
    } catch (error) {
      warnings.push(`ignoring ${key} in the file: ${error.message}`)
    }
  }
  return values
}

/** `templates` 的坏预设同样跳过；内置预设不受文件影响。 */
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
            const text = isPlainObject(preset) ? preset.text : undefined
            if (text !== TEMPLATE_SPECS[id].default) {
              warnings.push(
                `ignoring a stored change to the built-in preset of template ${JSON.stringify(id)}; ` +
                  'the built-in text cannot be modified.',
              )
            }
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
function writeStored(stateDir, payload) {
  const file = settingsFile(stateDir)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
  chmodSync(temporary, 0o644)
  renameSync(temporary, file)
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
function compose({ stored, env, config }) {
  const warnings = []
  if (stored.warning !== undefined) warnings.push(stored.warning)
  const configValues = {}
  const envValues = {}
  const envInfo = {}
  for (const [key, spec] of Object.entries(KEY_SPECS)) {
    if (isPlainObject(config)) {
      let raw
      let present = false
      if (has(config, key)) {
        present = true
        raw = config[key]
      } else if (key === 'inbox.intervalSeconds' && has(config, 'intervalSeconds')) {
        // 旧 host 半身的 config 形状就是 `{intervalSeconds}`；保留它，面板改 HTML 之前也能读到值。
        present = true
        raw = config.intervalSeconds
      }
      if (present) {
        try {
          configValues[key] = normalizeValue(key, raw, { strict: false })
        } catch (error) {
          warnings.push(`ignoring the plugin config for ${key}: ${error.message}`)
        }
      }
    }
    if (spec.env !== undefined) {
      const raw = isPlainObject(env) || env === undefined ? env?.[spec.env] : undefined
      const present = raw !== undefined && raw !== null && String(raw).trim() !== ''
      envInfo[key] = { name: spec.env, present, value: present ? String(raw) : null }
      if (present) {
        try {
          envValues[key] = normalizeValue(key, raw, { strict: false })
        } catch (error) {
          warnings.push(`ignoring ${spec.env}: ${error.message}`)
        }
      }
    } else {
      envInfo[key] = null
    }
  }

  const effective = {}
  const rows = []
  for (const [key, spec] of Object.entries(KEY_SPECS)) {
    const candidates = []
    if (has(stored.values, key)) candidates.push(['file', stored.values[key]])
    if (has(configValues, key)) candidates.push(['config', configValues[key]])
    if (has(envValues, key)) candidates.push(['env', envValues[key]])
    const [source, value] = candidates[0] ?? ['default', spec.default]
    effective[key] = value
    rows.push({
      key,
      value,
      default: spec.default,
      source,
      overridden: candidates.slice(1).map(([layer, lower]) => ({ source: layer, value: lower })),
      env: envInfo[key],
    })
  }

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
    effective,
    rows,
    templates,
  }
}

/**
 * 解析当前有效设置。每次调用都重读磁盘（文件很小），所以改了文件不需要重启。
 *
 * 不会因为坏文件抛错；只有「配置层本身写错」会被记进 `warning` 并跳过。
 */
export function resolveSettings({ stateDir, env = process.env, config = {} } = {}) {
  return compose({ stored: readStored(stateDir), env, config })
}

/**
 * 内置默认的完整快照：不读盘、不读 env。
 *
 * 注入器在没拿到 settings（老测试、或 settings 层自己失败）时用它，输出才与今天逐字节一致。
 */
export function defaultSettings() {
  return compose({
    stored: {
      file: settingsFile(),
      fileState: 'missing',
      revision: 0,
      values: {},
      templates: {},
      warning: undefined,
    },
    env: {},
    config: {},
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

/** 合并 PUT 的 `values`：未知键/坏值整体拒绝，一个都不写。 */
function applyValues(raw, values) {
  if (!isPlainObject(raw)) {
    throw invalid('values must be a JSON object of dotted keys.')
  }
  for (const [key, value] of Object.entries(raw)) {
    specOf(key)
    values[key] = normalizeValue(key, value)
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
      const customs = {}
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
    const presets = { default: { text: TEMPLATE_SPECS[id].default, builtin: true } }
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
 * `reset` 先执行（删覆盖 / 清空预设并回默认）。
 */
export function saveSettings({ stateDir, revision, values, templates, reset } = {}) {
  const stored = readStored(stateDir)
  if (!Number.isInteger(revision) || revision < 0) {
    throw conflict(stored.revision, revision)
  }
  if (revision !== stored.revision) {
    throw conflict(stored.revision, revision)
  }
  const nextValues = { ...stored.values }
  const nextTemplates = {}
  for (const id of TEMPLATE_IDS) {
    nextTemplates[id] = cloneTemplateState(stored.templates[id] ?? emptyTemplateState())
  }
  if (reset !== undefined) applyReset(reset, nextValues, nextTemplates)
  if (values !== undefined) applyValues(values, nextValues)
  if (templates !== undefined) applyTemplates(templates, nextTemplates)

  writeStored(stateDir, {
    version: SETTINGS_VERSION,
    revision: revision + 1,
    values: nextValues,
    templates: serializeTemplates(nextTemplates),
  })
  return resolveSettings({ stateDir })
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

const PUT_FIELDS = ['revision', 'values', 'templates', 'reset']

/**
 * 面板设置的 HTTP 面：只认 `/wheelchair-settings` 一条精确路由。
 *
 * - `GET`  → 200 完整快照（no-store；每次请求都重读文件）；
 * - `PUT`  → `{ revision, values?, templates?, reset? }`；预设 CRUD 与 reset 都搭这一次 PUT，不另开路由；
 *            过期 revision → 409 `{code:"conflict", revision, message}` 且不写；
 *            非法值 → 400 `{code:"SETTINGS_INVALID", message}`；体积/类型错误分别 413/415。
 *
 * Host 半身把它包在既有的 `ctx.connection.requestRejection` fence 后面注册，与 `/wheelchair-inbox/*` 一致。
 */
export function createSettingsHandler({ stateDir, config, env = process.env } = {}) {
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
        sendJson(res, 200, resolveSettings({ stateDir, env, config }))
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
        stateDir,
        revision: body.revision,
        values: body.values,
        templates: body.templates,
        reset: body.reset,
      })
      sendJson(res, 200, snapshot)
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
