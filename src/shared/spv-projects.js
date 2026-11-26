/**
 * spv 项目：数据根下的 `spv-projects.json`，记录每个 spv 根目录绑定了哪些 worker 项目。
 *
 * 这个文件是操作者的：读取时把每一处不一致都报出来，写的时候只做校验、原子写入和增删改。
 * 坏 JSON、坏版本、重复绑定、嵌套根一律大声报错，并且**一个字节都不改**；模型校验与
 * `deployments.json` 保持同一套语气和同一条路径（读已有文件与写新条目共用 `normalize`）。
 *
 * 约束：
 *   - 一个 spv 根必须存在且是目录，不能是已登记的 worker 项目 checkout，两个 spv 根不能互相嵌套；
 *   - 每个 worker 必须落在该 spv 根之下，且是 `tools/<name>` 或 `research/<name>`；
 *   - 一个 worker 只能属于一个 spv 项目（读取时检测重复，不悄悄取第一个）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { dataPaths } from './home.js'
import { PROJECT_PATTERN, listDeployments, projectsRootOf } from './deployments.js'
import { object, text } from './schema.js'

export const SPV_PROJECTS_FILE = 'spv-projects.json'
export const SPV_PROJECTS_VERSION = 1

/** worker 项目的 checkout 根：`$SPV_PROJECTS_ROOT`，默认 `~/bioagentforge`。 */
export { projectsRootOf }

/** `root` 字段的类型校验；容器（spvProjects 数组与 workers 数组）手工检查。 */
const rootSchema = object({ root: text({ min: 1, max: 4096 }) })

/** spv 项目文件的路径：数据根下，与 deployments.json 平级。 */
export function spvProjectsPath({ env = process.env, home, stateDir } = {}) {
  return join(dataPaths({ env, home, stateDir }).root, SPV_PROJECTS_FILE)
}

function registryError(file, detail) {
  return new Error(
    `the spv project registry at ${file} ${detail}. It is the operator's file: fix it by hand; it is never ` +
      'rewritten automatically, because that would silently unbind workers.',
  )
}

function absoluteDirectory(value, field, where) {
  const directory = String(value ?? '').trim()
  if (directory === '') {
    throw new Error(`${where}: ${field} is required; pass an absolute directory, e.g. /home/you/bioagentforge`)
  }
  if (!isAbsolute(directory)) {
    throw new Error(`${where}: ${field} must be an absolute path, got ${JSON.stringify(directory)}`)
  }
  return resolve(directory)
}

function realOrResolved(value) {
  try {
    return realpathSync(value)
  } catch {
    return resolve(value)
  }
}

function inside(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`)
}

function byRoot(a, b) {
  if (a.root < b.root) return -1
  if (a.root > b.root) return 1
  return 0
}

function byWorker(a, b) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** 一条 spv 项目：root 存在、在磁盘上唯一，workers 全部合法且落在 root 下。 */
function normalizeEntry(raw, where, { projectsRoot, deployments }) {
  let parsed
  try {
    parsed = rootSchema.parse(raw)
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const root = absoluteDirectory(parsed.root, 'root', where)
  if (!existsSync(root)) {
    throw new Error(`${where}.root is ${JSON.stringify(root)}, but that directory does not exist`)
  }
  if (!statSync(root).isDirectory()) {
    throw new Error(`${where}.root is ${JSON.stringify(root)}, but it is not a directory`)
  }
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.workers)) {
    throw new Error(`${where}.workers must be a list of "tools/<name>" or "research/<name>" project names`)
  }
  const workers = []
  const seen = new Set()
  for (const [index, item] of raw.workers.entries()) {
    const worker = String(item ?? '').trim().replace(/^\/+|\/+$/g, '')
    if (!PROJECT_PATTERN.test(worker)) {
      throw new Error(
        `${where}.workers[${index}] is ${JSON.stringify(item ?? null)}, but a worker must be "tools/<name>" or ` +
          '"research/<name>" with a plain name.',
      )
    }
    if (seen.has(worker)) {
      throw new Error(`${where}.workers lists ${JSON.stringify(worker)} more than once`)
    }
    seen.add(worker)
    if (!inside(root, resolve(root, worker))) {
      throw new Error(
        `${where}.workers[${index}] is ${JSON.stringify(worker)}, but it does not fall under the spv root ` +
          `${JSON.stringify(root)}: a worker checkout is always <root>/<worker>.`,
      )
    }
    workers.push(worker)
  }
  const rootReal = realOrResolved(root)
  const registered = deployments.find(entry => inside(realOrResolved(join(projectsRoot, entry.project)), rootReal))
  if (registered !== undefined) {
    throw new Error(
      `${where}.root is ${JSON.stringify(root)}, but that is the checkout of registered worker project ` +
        `${JSON.stringify(registered.project)} (or a directory inside it). An spv root is the directory that ` +
        'contains worker projects, not one of them or a subdirectory of one.',
    )
  }
  return { root, workers: workers.sort(byWorker) }
}

/** 把整张表规范化并做跨条目校验：根不重复/不嵌套，worker 不重复绑定。 */
function normalizeAll(spvProjects, options) {
  if (spvProjects === null || typeof spvProjects !== 'object' || !Array.isArray(spvProjects.spvProjects)) {
    throw new Error('the spv project registry must hold a "spvProjects" list')
  }
  const deployments = listDeployments(options).deployments
  const entries = spvProjects.spvProjects.map((raw, index) =>
    normalizeEntry(raw, `spvProjects[${index}]`, { projectsRoot: projectsRootOf(options), deployments }),
  )
  const roots = new Map()
  const owners = new Map()
  for (const entry of entries) {
    const key = realOrResolved(entry.root)
    const existing = roots.get(key)
    if (existing !== undefined) {
      throw new Error(
        `the spv project registry lists root ${JSON.stringify(entry.root)} more than once (the same directory as ` +
          `${JSON.stringify(existing)}); fix the duplicate by hand`,
      )
    }
    for (const worker of entry.workers) {
      const owner = owners.get(worker)
      if (owner !== undefined) {
        throw new Error(
          `the spv project registry binds worker ${JSON.stringify(worker)} to both ${JSON.stringify(owner)} and ` +
            `${JSON.stringify(entry.root)}; a worker can belong to only one spv project. Fix it by hand or re-run ` +
            `"wheelchair-agent spv-project remove" on one of them.`,
        )
      }
      owners.set(worker, entry.root)
    }
    roots.set(key, entry.root)
  }
  const list = [...entries]
  for (const left of list) {
    for (const right of list) {
      if (left === right) continue
      if (inside(realOrResolved(left.root), realOrResolved(right.root))) {
        throw new Error(
          `the spv project registry has nested roots ${JSON.stringify(left.root)} and ${JSON.stringify(right.root)}; ` +
            'one spv project cannot live inside another. Remove one or move it out.',
        )
      }
    }
  }
  list.sort(byRoot)
  return list
}

function renderRegistry(list) {
  return `${JSON.stringify({ version: SPV_PROJECTS_VERSION, spvProjects: list }, null, 2)}\n`
}

function writeFile(file, contents) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp.${process.pid}`
  try {
    writeFileSync(temporary, contents, { mode: 0o644 })
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
}

/** 原子写整张表；内容与磁盘逐字节相同时不写，mtime 不变。 */
export function writeSpvProjects(spvProjects, options = {}) {
  const file = spvProjectsPath(options)
  const list = normalizeAll({ spvProjects }, options)
  const contents = renderRegistry(list)
  try {
    if (readFileSync(file, 'utf8') === contents) {
      return { file, version: SPV_PROJECTS_VERSION, spvProjects: list, changed: false }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw registryError(file, `cannot be read (${error?.message ?? error})`)
  }
  writeFile(file, contents)
  return { file, version: SPV_PROJECTS_VERSION, spvProjects: list, changed: true }
}

/**
 * 读整张表。不存在时返回 `{ exists:false, spvProjects:[] }`；坏文件/坏条目抛错且不改字节。
 */
export function listSpvProjects(options = {}) {
  const file = spvProjectsPath(options)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { file, exists: false, version: SPV_PROJECTS_VERSION, spvProjects: [] }
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
    throw registryError(file, 'must be a JSON object with "version" and "spvProjects"')
  }
  if (value.version !== SPV_PROJECTS_VERSION) {
    throw registryError(
      file,
      `has version ${JSON.stringify(value.version)}, but this build understands version ${SPV_PROJECTS_VERSION}`,
    )
  }
  try {
    const spvProjects = normalizeAll(value, options)
    return { file, exists: true, version: SPV_PROJECTS_VERSION, spvProjects }
  } catch (error) {
    throw registryError(file, error instanceof Error ? error.message : String(error))
  }
}

/** 找绑定了某个 worker 的 spv 项目；没有时返回 undefined。坏文件照常抛错。 */
export function findSpvProjectOfWorker(worker, options = {}) {
  const wanted = String(worker ?? '').trim()
  return listSpvProjects(options).spvProjects.find(entry => entry.workers.includes(wanted))
}

/** 根的规范化身份；CLI 用它与已有条目比较，避免同一目录写两次。 */
export function sameSpvRoot(a, b) {
  return realOrResolved(String(a ?? '')) === realOrResolved(String(b ?? ''))
}

/**
 * 新增或更新一个 spv 项目；`workers` 与已有列表合并（幂等）。
 * 返回 `{created, changed, before, entry, file}`；没有变化时不写盘。
 */
export function upsertSpvProject(root, workers = [], options = {}) {
  const registry = listSpvProjects(options)
  const wanted = absoluteDirectory(root, 'root', 'spv-project')
  const index = registry.spvProjects.findIndex(entry => sameSpvRoot(entry.root, wanted))
  const before = index === -1 ? undefined : registry.spvProjects[index]
  const merged = new Set(before?.workers ?? [])
  for (const worker of workers) merged.add(String(worker).trim())
  const candidate = { root: before?.root ?? wanted, workers: [...merged].sort(byWorker) }
  for (const entry of registry.spvProjects) {
    if (index !== -1 && sameSpvRoot(entry.root, wanted)) continue
    for (const worker of entry.workers) {
      if (candidate.workers.includes(worker)) {
        throw new Error(
          `worker ${JSON.stringify(worker)} is already bound to spv project ${JSON.stringify(entry.root)}; it cannot ` +
            `also belong to spv project ${JSON.stringify(candidate.root)}. A worker can belong to only one spv ` +
            `project. Remove it from ${JSON.stringify(entry.root)} first.`,
        )
      }
    }
  }
  const next = index === -1 ? [...registry.spvProjects, candidate] : registry.spvProjects.map((entry, at) => (at === index ? candidate : entry))
  const written = writeSpvProjects(next, options)
  const entry = written.spvProjects.find(item => sameSpvRoot(item.root, candidate.root))
  const changed = before === undefined || JSON.stringify(before.workers) !== JSON.stringify(entry.workers)
  return {
    created: before === undefined,
    changed: written.changed && changed,
    before,
    entry,
    file: written.file,
  }
}

/**
 * 删除一个 spv 项目。还有 worker 时必须 `force`；报错里列出会解绑哪些 worker。
 */
export function removeSpvProject(root, { force = false, ...options } = {}) {
  const registry = listSpvProjects(options)
  const wanted = absoluteDirectory(root, 'root', 'spv-project')
  const entry = registry.spvProjects.find(item => sameSpvRoot(item.root, wanted))
  if (entry === undefined) return undefined
  if (entry.workers.length > 0 && !force) {
    throw new Error(
      `spv project ${JSON.stringify(entry.root)} still binds ${entry.workers.length} worker(s): ` +
        `${entry.workers.join(', ')}. Re-run with --force to remove it and unbind them, or move them to another spv ` +
        'project first.',
    )
  }
  const remaining = registry.spvProjects.filter(item => !sameSpvRoot(item.root, wanted))
  const written = writeSpvProjects(remaining, options)
  return { entry, file: written.file, spvProjects: written.spvProjects }
}

/**
 * 找出一个 worker 应绑定的 spv 根：显式 `root` 必须已登记；否则看已登记的根里哪些是 worker
 * checkout（`<projectsRoot>/<project>`）的祖先。
 *
 * 没有 spv 项目文件/空表时返回 `{root:null}`，保持未使用 spv 项目的安装可继续 `deployment add`；
 * 一旦有 spv 项目，0 个候选或 ≥2 个候选都报错并列出候选，由调用方要求显式 `--spv`。
 */
export function resolveSpvRootForWorker(project, { root, ...options } = {}) {
  const registry = listSpvProjects(options)
  const wanted = String(project ?? '').trim()
  if (root !== undefined && root !== null && String(root).trim() !== '') {
    const explicit = absoluteDirectory(root, 'root', 'deployment')
    const entry = registry.spvProjects.find(item => sameSpvRoot(item.root, explicit))
    if (entry === undefined) {
      const known = registry.spvProjects.map(item => item.root)
      throw new Error(
        `spv project ${JSON.stringify(explicit)} is not registered, so ${JSON.stringify(wanted)} cannot be bound to ` +
          'it. Create it first with "wheelchair-agent spv-project add ' +
          `${explicit}"${
            known.length === 0 ? '' : `; registered spv projects: ${known.join(', ')}`
          }.`,
      )
    }
    return { root: entry.root, entry }
  }
  if (registry.spvProjects.length === 0) return { root: null, entry: undefined }
  const checkout = resolve(projectsRootOf(options), wanted)
  const candidates = registry.spvProjects.filter(entry => inside(realOrResolved(entry.root), realOrResolved(checkout)))
  if (candidates.length === 1) return { root: candidates[0].root, entry: candidates[0] }
  const known = registry.spvProjects.map(item => item.root)
  if (candidates.length === 0) {
    throw new Error(
      `cannot infer an spv project for ${JSON.stringify(wanted)}: no registered spv root is an ancestor of ` +
        `${JSON.stringify(checkout)}. Pass --spv <root> explicitly. Registered spv projects: ${known.join(', ') || '(none)'}.`,
    )
  }
  throw new Error(
    `cannot infer an spv project for ${JSON.stringify(wanted)}: more than one registered spv root is an ancestor of ` +
      `${JSON.stringify(checkout)} (${candidates.map(item => item.root).join(', ')}). Pass --spv <root> explicitly.`,
  )
}

/** 把一个 worker 记入已解析的 spv 根；根为 null 或已包含它时原样返回。 */
export function bindWorkerToSpvProject(project, binding, options = {}) {
  if (binding === null || binding === undefined || binding.root === null) {
    return { changed: false, root: null }
  }
  const result = upsertSpvProject(binding.root, [project], options)
  return { changed: result.changed, root: result.entry.root, entry: result.entry }
}

/** 从所有 spv 项目里摘掉一个 worker；返回被解绑的根。没有变化时不写盘。 */
export function unbindWorkerFromSpvProjects(project, options = {}) {
  const registry = listSpvProjects(options)
  const wanted = String(project ?? '').trim()
  const roots = registry.spvProjects.filter(entry => entry.workers.includes(wanted)).map(entry => entry.root)
  if (roots.length === 0) return { changed: false, roots }
  const next = registry.spvProjects.map(entry =>
    entry.workers.includes(wanted) ? { root: entry.root, workers: entry.workers.filter(worker => worker !== wanted) } : entry,
  )
  writeSpvProjects(next, options)
  return { changed: true, roots }
}
