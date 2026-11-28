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
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
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

/** GitHub 仓库的 `owner/name` 形状；这是面板里 `source:github` 的 repository 字段。 */
export const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 从 `git config --get remote.origin.url` 的输出反推 `owner/name`。
 *
 * 支持操作者会遇到的三种写法：`https://github.com/owner/name(.git)`、
 * `git@github.com:owner/name(.git)`（ssh 短写）以及 scp 形式 `github.com:owner/name(.git)`。
 * 非 GitHub、缺 owner/name 时返回 null，由调用方给出带原始 URL 的错误——这里不猜。
 */
export function repositoryFromRemote(remote) {
  const value = String(remote ?? '').trim()
  if (value === '') return null
  let path = ''
  const https = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(value)
  if (https) path = `${https[1]}/${https[2]}`
  else {
    const ssh = /^(?:ssh:\/\/)?(?:git@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(value)
    if (ssh) path = `${ssh[1]}/${ssh[2]}`
  }
  return REPOSITORY_PATTERN.test(path) ? path : null
}

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
  repository: text({ fallback: null, max: 200 }),
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
  const expectedQueue = join(stateDir, 'spv')
  const queueDir = parsed.queueDir.trim() === ''
    ? expectedQueue
    : absoluteDirectory(parsed.queueDir, 'queueDir', where)
  if (queueDir !== expectedQueue) {
    throw new Error(
      `${where}.queueDir is ${JSON.stringify(queueDir)}, but a deployment must read ${JSON.stringify(expectedQueue)} ` +
        '(<stateDir>/spv): the instance\'s wheelchair-spv Source resolves its queue from that deployment\'s own ' +
        'stateDir and saved settings, so a different registry value would dispatch into a queue the deployment ' +
        `never reads. Use ${JSON.stringify(expectedQueue)}.`,
    )
  }
  const repository = parsed.repository === null || String(parsed.repository).trim() === ''
    ? null
    : String(parsed.repository).trim()
  if (repository !== null && !REPOSITORY_PATTERN.test(repository)) {
    throw new Error(
      `${where}.repository is ${JSON.stringify(repository)}, but it must be a GitHub "owner/name" (letters, digits, ` +
        '".", "_" and "-"). It is the value the deployment\'s own dsh-superagent instance stores as its ' +
        'source:github repository, not an arbitrary URL.',
    )
  }
  return {
    project,
    profile: String(parsed.profile).trim() || DEFAULT_PROFILE,
    stateDir,
    queueDir,
    port: parsed.port === null ? null : parsed.port,
    installedSha: parsed.installedSha === null || String(parsed.installedSha).trim() === ''
      ? null
      : String(parsed.installedSha).trim(),
    repository,
  }
}

/** 按项目名逐字节排序：与 locale 无关，保证不同机器的注册表字节一致。 */
function byProject(a, b) {
  if (a.project < b.project) return -1
  if (a.project > b.project) return 1
  return 0
}

/** 严格比较两条规范条目；`changedFields` 用同一组字段顺序生成可读差异。 */
const ENTRY_FIELDS = ['profile', 'stateDir', 'queueDir', 'port', 'installedSha', 'repository']

/**
 * 一个项目的实例名：去掉 `tools/`/`research/` 前缀，小写，非法字符换成 `-`。
 * 它同时是实例文件 `<data root>/deployments/<slug>.yml`、tmux 会话与日志的名字，所以必须只含
 * `[a-z0-9._-]`；两个项目撞名会让它们共用一个实例文件，读取时拒绝而不是悄悄覆盖。
 */
export function deploymentSlug(project) {
  const leaf = String(project ?? '').trim().split('/').pop() ?? ''
  return leaf.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * spv 项目根：`$SPV_PROJECTS_ROOT`，否则 `~/bioagentforge`。
 *
 * 注册表只存项目名（`tools/<name>`），一个项目对应 `<projects root>/<project>`。判断「两个项目是否
 * 同一个路径」必须先把项目名拼成绝对路径再解析符号链接；否则 `tools/alpha` 与指向它的
 * `tools/alpha-link` 会被当成两个互不相干的项目。
 */
export function projectsRootOf({ env = process.env } = {}) {
  const configured = String(env.SPV_PROJECTS_ROOT ?? '').trim()
  return resolve(configured === '' ? join(homedir(), 'bioagentforge') : configured)
}

/** 一个项目在 spv 项目根下的绝对路径（不解析符号链接）。 */
export function projectPathOf(project, options = {}) {
  return resolve(projectsRootOf(options), String(project ?? '').trim())
}

/** 项目的规范路径：存在时用 realpath，不存在时退回 resolve 的绝对路径。 */
export function canonicalProjectPath(project, options = {}) {
  const path = projectPathOf(project, options)
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** 注册表中与 `project` 指向同一真实路径的所有条目（含它自己）。 */
export function deploymentsAtProjectPath(project, deployments, options = {}) {
  const wanted = canonicalProjectPath(project, options)
  return deployments.filter(entry => canonicalProjectPath(entry.project, options) === wanted)
}

/**
 * 注册表里被多于一个部署认领的路径。
 *
 * `listDeployments()` 已经拒绝重复的项目名/端口/实例名；这里补的是另一类重复：两个不同的项目名
 * 通过符号链接或目录别名指向同一份 checkout。读取仍是只读的——冲突由 `deployment list` 警告、
 * `install.sh --check` 报错和 `deployment add` 拒绝新增来暴露，绝不悄悄改注册表。
 */
export function projectPathConflicts(deployments, options = {}) {
  const groups = new Map()
  for (const entry of deployments) {
    const path = canonicalProjectPath(entry.project, options)
    const entries = groups.get(path)
    if (entries === undefined) groups.set(path, [entry])
    else entries.push(entry)
  }
  return [...groups.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([path, entries]) => ({ path, entries }))
}

/** 一句可打印的路径冲突说明，供 `deployment list` 与安装自检共用。 */
export function describePathConflict(conflict) {
  const claims = conflict.entries.map(entry => `${entry.project} (port ${entry.port ?? '-'})`).join(', ')
  return `${conflict.path} is claimed by more than one deployment: ${claims}; an orchestrator project belongs to ` +
    'exactly one instance. Remove all but one with "wheelchair-agent deployment remove <project>".'
}

/** 每部署实例 YAML 的目录：`<data root>/deployments/`。 */
export function deploymentsDir(options = {}) {
  return join(dataPaths(options).root, 'deployments')
}

/** 一个项目的实例配置文件路径。 */
export function instancePath(project, options = {}) {
  return join(deploymentsDir(options), `${deploymentSlug(project)}.yml`)
}

/**
 * 渲染一份实例 overlay（`dsh --profile <profile> --patch <file>` 的输入）。
 *
 * 只有三件事能按部署不同：面板端口（`webserver`）、会话/工单/worker 的状态目录（`dsh-superagent`）和
 * 队列（`wheelchair-spv`）。面板标题与 host 没有可配置项（标题是 webui 的固定常量），所以所有部署
 * 共用同一个标签；端口不同，操作者不会认错。
 */
export function renderInstance(entry) {
  return `# Instance overlay for project ${entry.project}, generated by "wheelchair-agent deployment add".
# The registry (${DEPLOYMENTS_FILE}, under the data root) is the source of truth for this deployment;
# this file only feeds "dsh --profile ${entry.profile} --patch <this file>".
# Remove it and run "deployment add" again to render it from the registry.
# The panel label is the same for every deployment (the web UI has no title setting); ports differ.
# Repository: ${entry.repository ?? '-'} (a comment only: the deployment's source:github configuration is not a
# patchable dsh config key, so "deployment setup" writes it through the instance's own panel API).
- id: webserver
  config:
    host: "127.0.0.1"
    port: ${entry.port}
- id: dsh-superagent
  config:
    stateDir: ${JSON.stringify(entry.stateDir)}
- id: wheelchair-spv
  config:
    queueDir: ${JSON.stringify(entry.queueDir)}
`
}

/**
 * 写实例文件；**只在文件不存在时**创建，已存在的文件不动（可能是操作者按主机情况改过的）。
 * 返回 `{ file, created }`。
 */
export function writeInstance(entry, options = {}) {
  const file = instancePath(entry.project, options)
  if (existsSync(file)) return { file, created: false }
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp.${process.pid}`
  try {
    writeFileSync(temporary, renderInstance(entry), { mode: 0o644 })
    chmodSync(temporary, 0o644)
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // 临时文件可能还没出现。
    }
    throw error
  }
  return { file, created: true }
}

/** 从 3082 起分配注册表里第一个没被占用的端口；只做分配，不探测内核占用（那由 service start 报错）。 */
export function allocatePort(deployments, { start = 3082 } = {}) {
  const used = new Set(deployments.map(entry => entry.port).filter(port => port !== null))
  let port = start
  while (used.has(port)) port += 1
  if (port > 65535) throw new Error(`cannot allocate a port for a new deployment: every port from ${start} to 65535 is registered`)
  return port
}

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
  const ports = new Map()
  const slugs = new Map()
  for (const [index, item] of value.deployments.entries()) {
    const entry = normalizeEntry(item, `deployments[${index}]`)
    if (seen.has(entry.project)) {
      throw registryError(file, `lists project ${JSON.stringify(entry.project)} more than once`)
    }
    seen.add(entry.project)
    if (entry.port !== null) {
      const owner = ports.get(entry.port)
      if (owner !== undefined) {
        throw registryError(file, `assigns port ${entry.port} to both ${JSON.stringify(owner)} and ${JSON.stringify(entry.project)}`)
      }
      ports.set(entry.port, entry.project)
    }
    const slug = deploymentSlug(entry.project)
    if (slug === '') {
      throw registryError(file, `cannot derive an instance name from project ${JSON.stringify(entry.project)}`)
    }
    const sameName = slugs.get(slug)
    if (sameName !== undefined) {
      throw registryError(
        file,
        `maps both ${JSON.stringify(sameName)} and ${JSON.stringify(entry.project)} to the instance name ${JSON.stringify(slug)}; ` +
          'they would share one instance file and one service name, so rename one project',
      )
    }
    slugs.set(slug, entry.project)
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
 * 注册表不存在时的错误：这是升级前的旧安装，引导到 `deployment migrate`（认领）或 `deployment add`。
 * CLI 的 `service`/`spv`/`restart-all` 在需要注册表但文件还不存在时直接抛它，不打印栈。
 */
export function missingRegistryError(file) {
  return new Error(
    `no deployment registry at ${file}: this machine has no registered deployment yet, and the registry is the ` +
      'only source of truth for which deployment reads a project. Adopt the existing installation with ' +
      '"wheelchair-agent deployment migrate", or create one explicitly with ' +
      '"wheelchair-agent deployment add <project>", then start it from its project checkout with ' +
      '"wheelchair-agent service start" (or "wheelchair-agent service start --all").',
  )
}

/**
 * 某个项目没有部署时的错误：指名下一步命令，而不是自动创建。
 *
 * `registryExists` 为 false 时说明文件本身还不存在（旧安装）：这时先给 `deployment migrate`，因为它是把
 * 现有安装认领进注册表的唯一入口；否则给 `deployment add`。两种情形都不回退旧规则、不自动创建部署。
 */
export function missingDeploymentError(project, file, registryExists = true) {
  const where = registryExists
    ? `${file} has no entry for it`
    : `there is no deployment registry at ${file}`
  const next = registryExists
    ? `Create the deployment explicitly with "wheelchair-agent deployment add ${project}" ` +
      '(it needs a profile, a state directory and a port, so it is never created automatically), ' +
      'start that deployment, then dispatch again.'
    : 'If this machine predates the registry, adopt the existing installation with ' +
      '"wheelchair-agent deployment migrate"; otherwise create a deployment explicitly with ' +
      `"wheelchair-agent deployment add ${project}" and start it.`
  return new Error(
    `no deployment for project ${JSON.stringify(project)}: a task is written into its project's own deployment ` +
      `queue, and ${where}. ${next} Run "wheelchair-agent deployment list" to see every registered project.`,
  )
}

/** `installed.json` 里的 commit，作为注册表的 installedSha；没有可读的戳时返回 null。 */
export function installedShaOf({ env = process.env, home, stateDir } = {}) {
  // 坏戳由 `install.sh --check` 报告；注册表只把它当成“不知道安装的 commit”，不因此挡住迁移/安装。
  const stamp = readStamp(installStampPath(dataPaths({ env, home, stateDir }).root))
  return typeof stamp?.commit === 'string' && stamp.commit !== '' ? stamp.commit : null
}
