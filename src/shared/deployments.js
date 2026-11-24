/**
 * 「一仓一部署」的注册表：项目名 → 部署（profile / stateDir / queueDir / port / installedSha）。
 *
 * 注册表是 `~/.wheelchair-agent/deployments.json`（`$WHEELCHAIR_AGENT_HOME` 可移动数据根），它是
 * 「哪个项目归哪份部署」的**唯一**真相。派活时先在这里查项目的部署，再写那份部署的队列；没有条目就
 * 报错并给出 `wheelchair-agent deployment add <project>`，**绝不**自动创建——创建部署要 profile、端口和
 * systemd 单元，属于显式动作。
 *
 * 文件是操作者的：本模块只做校验、原子写入和增删改。坏文件（非法 JSON、版本不认识、重复项目）一律
 * 大声报错并且**一个字节都不改**；`remove` 后保留空列表而不是删文件，所以「注册表存在但没有条目」和
 * 「这台机器还没迁移」是可区分的两种状态。
 *
 * 两个边界：
 *   - 本模块属于 `src/shared/`，不 import `src/spv/`。`PROJECT_PATTERN` 放在这里，由
 *     `src/spv/dispatch.js` import，保证 regex 只有一份。
 *   - 校验走 `src/shared/schema.js` 的 `object()`：字段类型、默认值、报错文案都与其他设置文件一致。
 *     容器本身（version + deployments 数组）没有对应的 schema 原语（`records()` 要求每条都有 id），
 *     所以在 `object()` 之外手工检查数组形状；这不是另一套字段校验。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { dataPaths } from './home.js'
import { installStampPath, readStamp } from './install-stamp.js'
import { integer, object, text } from './schema.js'

/** 注册表文件名，位于数据根下。 */
export const DEPLOYMENTS_FILE = 'deployments.json'
/** 文件格式版本；不认识的版本拒绝读取，绝不猜测迁移。 */
export const DEPLOYMENTS_VERSION = 1
/** 本仓库自己的项目名：`deployment migrate` 把旧单部署记成它。 */
export const DEFAULT_PROJECT = 'tools/wheelchair-agent'
/** 单部署时代的 dsh profile。 */
export const DEFAULT_PROFILE = 'superagent'

/** superagent executor 能 clone 并交给 worker 的项目；`src/spv/dispatch.js` 复用这一份。 */
export const PROJECT_PATTERN = /^(?:tools|research)\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 一条部署的字段校验。`port` 允许 null（stage 1 还没有分配端口，stage 2 的安装才写真实值）；
 * `installedSha` 允许 null（旧安装或手工条目）。数组/容器由下面的 `listDeployments` 检查。
 */
const entrySchema = object({
  project: text({ min: 1, max: 200 }),
  profile: text({ fallback: DEFAULT_PROFILE, min: 1, max: 128 }),
  stateDir: text({ min: 1, max: 4096 }),
  queueDir: text({ max: 4096 }),
  port: integer({ fallback: null, min: 1, max: 65535 }),
  installedSha: text({ fallback: null, max: 200 }),
})

/**
 * 注册表路径：数据根下的 `deployments.json`。
 * 数据根沿用 `src/shared/home.js` 的解析与 ticket-clone 守卫，所以 worker clone 必须显式设置
 * `$WHEELCHAIR_AGENT_HOME` 才能读写注册表。
 */
export function registryPath({ env = process.env, home, stateDir } = {}) {
  return join(dataPaths({ env, home, stateDir }).root, DEPLOYMENTS_FILE)
}

/** 注册表不能读取/写入时的统一错误：说清文件、原因和下一步，且绝不建议静默重写。 */
function registryError(file, detail) {
  return new Error(
    `the deployment registry at ${file} ${detail}. It is the operator's file: fix it by hand, or move it ` +
      `aside and run "wheelchair-agent deployment migrate" to record the current single deployment. It is ` +
      'never rewritten automatically, because that would silently lose deployments.',
  )
}

/** 一个目录字段必须是绝对路径；相对路径会让注册表依赖读取者的 cwd，直接拒绝。 */
function absoluteDirectory(value, field, where) {
  const directory = String(value ?? '').trim()
  if (directory === '') {
    throw new Error(`${where}: ${field} is required; pass an absolute directory, e.g. /home/you/.dsh/state/superagent`)
  }
  if (!isAbsolute(directory)) {
    throw new Error(
      `${where}: ${field} must be an absolute path, got ${JSON.stringify(directory)}. A relative directory would ` +
        'mean different queues for different working directories.',
    )
  }
  return resolve(directory)
}

/**
 * 把一条原始条目校验成规范形状。读取已有文件与写入新条目共用这一条路径，避免两套规则。
 * `where` 只用于报错前缀（例如 `deployments[0]`）。
 */
function normalizeEntry(raw, where) {
  let parsed
  try {
    parsed = entrySchema.parse(raw)
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const project = String(parsed.project).trim()
  if (!PROJECT_PATTERN.test(project)) {
    throw new Error(
      `${where}.project is ${JSON.stringify(project)}, but the executor can only clone "tools/<name>" or ` +
        '"research/<name>" with a plain name. Use the same shape dispatch accepts, e.g. "tools/wheelchair-agent".',
    )
  }
  const stateDir = absoluteDirectory(parsed.stateDir, 'stateDir', where)
  const queueDir = parsed.queueDir.trim() === ''
    ? join(stateDir, 'spv')
    : absoluteDirectory(parsed.queueDir, 'queueDir', where)
  return {
    project,
    profile: String(parsed.profile).trim() || DEFAULT_PROFILE,
    stateDir,
    queueDir,
    port: parsed.port === null ? null : parsed.port,
    installedSha: parsed.installedSha === null || String(parsed.installedSha).trim() === ''
      ? null
      : String(parsed.installedSha).trim(),
  }
}

/** 按项目名逐字节排序：与 locale 无关，保证不同机器的注册表字节一致。 */
function byProject(a, b) {
  if (a.project < b.project) return -1
  if (a.project > b.project) return 1
  return 0
}

/** 严格比较两条规范条目；`changedFields` 用同一组字段顺序生成可读差异。 */
const ENTRY_FIELDS = ['profile', 'stateDir', 'queueDir', 'port', 'installedSha']

function changedFields(before, after) {
  return ENTRY_FIELDS.filter(field => before[field] !== after[field])
}

function sameEntry(before, after) {
  return changedFields(before, after).length === 0
}

/**
 * 读注册表。
 *
 * 返回 `{ file, exists, version, deployments }`；文件不存在时 `exists: false`、`deployments: []`，这正是
 * 单部署时代的行为，调用方据此回退到旧路径。文件存在但无法解析时抛错，绝不当作空表。
 */
export function listDeployments({ env = process.env, home, stateDir } = {}) {
  const file = registryPath({ env, home, stateDir })
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { file, exists: false, version: DEPLOYMENTS_VERSION, deployments: [] }
    }
    throw registryError(file, `cannot be read (${error?.message ?? error})`)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw registryError(file, `is not valid JSON (${error?.message ?? error})`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw registryError(file, 'must be a JSON object with "version" and "deployments"')
  }
  if (value.version !== DEPLOYMENTS_VERSION) {
    throw registryError(file, `has version ${JSON.stringify(value.version)}, but this build understands version ${DEPLOYMENTS_VERSION}`)
  }
  if (!Array.isArray(value.deployments)) {
    throw registryError(file, 'must hold a "deployments" list')
  }
  const deployments = []
  const seen = new Set()
  for (const [index, item] of value.deployments.entries()) {
    const entry = normalizeEntry(item, `deployments[${index}]`)
    if (seen.has(entry.project)) {
      throw registryError(file, `lists project ${JSON.stringify(entry.project)} more than once`)
    }
    seen.add(entry.project)
    deployments.push(entry)
  }
  deployments.sort(byProject)
  return { file, exists: true, version: DEPLOYMENTS_VERSION, deployments }
}

/** 查一个项目的部署；注册表不存在时返回 undefined（单部署回退）。坏文件仍然抛错。 */
export function findDeployment(project, options = {}) {
  const wanted = String(project ?? '').trim()
  return listDeployments(options).deployments.find(entry => entry.project === wanted)
}

/** 原子写注册表：同目录 pid 后缀临时文件 → chmod 0644 → rename；失败时清掉临时文件。 */
export function writeDeployments(deployments, { env = process.env, home, stateDir } = {}) {
  const file = registryPath({ env, home, stateDir })
  const value = { version: DEPLOYMENTS_VERSION, deployments: [...deployments].sort(byProject) }
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp.${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 })
    chmodSync(temporary, 0o644)
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // 写入可能在文件出现之前就失败，没有临时文件可清。
    }
    throw error
  }
  return { file, version: DEPLOYMENTS_VERSION, deployments: value.deployments }
}

/**
 * 新增或更新一条部署，返回 `{ created, changed, before, entry, file }`。
 *
 * 完全相同的条目是幂等成功且**不写文件**（不改 mtime）；字段变化时覆盖并返回变化的字段名，供 CLI 打印。
 * 坏注册表在任何写入之前就抛错，内容不变。
 */
export function upsertDeployment(entry, options = {}) {
  const registry = listDeployments(options)
  const next = normalizeEntry(entry, 'deployment')
  const index = registry.deployments.findIndex(item => item.project === next.project)
  const before = index === -1 ? undefined : registry.deployments[index]
  if (before !== undefined && sameEntry(before, next)) {
    return { created: false, changed: [], before, entry: before, file: registry.file }
  }
  const deployments = [...registry.deployments]
  if (index === -1) deployments.push(next)
  else deployments[index] = next
  const written = writeDeployments(deployments, options)
  return {
    created: index === -1,
    changed: before === undefined ? ENTRY_FIELDS.filter(field => next[field] !== null) : changedFields(before, next),
    before,
    entry: next,
    file: written.file,
  }
}

/** 删除一条部署；不存在时返回 undefined（CLI 负责报错），文件内容只在真的删掉时才改写。 */
export function removeDeployment(project, options = {}) {
  const registry = listDeployments(options)
  const wanted = String(project ?? '').trim()
  const entry = registry.deployments.find(item => item.project === wanted)
  if (entry === undefined) return undefined
  const remaining = registry.deployments.filter(item => item.project !== wanted)
  writeDeployments(remaining, options)
  return { entry, file: registry.file, remaining: remaining.length }
}

/**
 * 某个项目没有部署时的错误：指名下一步命令，而不是自动创建。
 * 只有注册表存在（已进入分部署模式）时才可能走到这里；文件不存在时调用方回退旧行为。
 */
export function missingDeploymentError(project, file) {
  return new Error(
    `no deployment for project ${JSON.stringify(project)}: a task is written into its project's own deployment ` +
      `queue, and ${file} has no entry for it. Create the deployment explicitly with ` +
      `"wheelchair-agent deployment add ${project}" (it needs a profile, a state directory and a port, so it is ` +
      'never created automatically), start that deployment, then dispatch again.',
  )
}

/** `installed.json` 里的 commit，作为注册表的 installedSha；没有可读的戳时返回 null。 */
export function installedShaOf({ env = process.env, home, stateDir } = {}) {
  // 坏戳由 `install.sh --check` 报告；注册表只把它当成“不知道安装的 commit”，不因此挡住迁移/安装。
  const stamp = readStamp(installStampPath(dataPaths({ env, home, stateDir }).root))
  return typeof stamp?.commit === 'string' && stamp.commit !== '' ? stamp.commit : null
}
