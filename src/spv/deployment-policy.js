/**
 * 让一份部署真的能接单：补上它自己的 Source 许可身份，以及 executor 的 prepare 命令。
 *
 * dsh-superagent 的 Source 策略是**每份部署**存一份的（`settings.policy.sources.<id>.allowed`），而新建部署的
 * `policy.sources` 是空对象：spv Source 声明的 `allowed` 默认值只在面板保存过该来源之后才会出现。于是队列里的
 * 任务照常被消费，却以 `not_a_member` 被 ignore，派单方只看到「已写入」——这正是本模块要修掉的静默丢弃。
 * 同一个坑还有一面：`executor.prepare` 默认是空串，新部署的工单会在空目录里开跑，不 clone、不建分支。
 *
 * 这里只走面板的 loopback HTTP API，不碰 dsh-superagent 的源码，也不调用 CLI：`readPolicy()` 读
 * `GET /orchestrator/api/settings` 的 `blocks.policy`，`ensureAllowed()` 用整份 `{rules, sources}` 做
 * `PUT /orchestrator/api/settings/policy`（只补 allowed，绝不丢其他来源或其他字段），`ensureExecutorPrepare()`
 * 同理只在一个空 prepare 上写默认命令。两个 ensure 都是幂等的，冲突（409）重读一次再试一次。
 *
 * `audit` 子命令给 `install.sh --check` 用：只读，把每份注册部署缺的身份 / 空 prepare 报成一行事实。
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listDeployments } from '../shared/deployments.js'

/** spv Source 在 dsh-superagent 里的 id。 */
export const DEFAULT_SOURCE = 'spv'
/** 本工具写进队列的身份；policy 里缺了它，任务就会被 `not_a_member` 静默 ignore。 */
export const DEFAULT_ACTOR = 'operator'
/** 面板 Sources 页显示的默认名字。 */
export const DEFAULT_ACTOR_NAME = 'local operator'
/** 新部署缺 prepare 时补上的命令；与 preset 里 worker 的准备命令一致。 */
export const DEFAULT_PREPARE = 'wheelchair-agent prepare'

const SETTINGS_PATH = '/orchestrator/api/settings'
const POLICY_PATH = '/orchestrator/api/settings/policy'
const EXECUTOR_PATH = '/orchestrator/api/settings/executor'
const REQUEST_TIMEOUT_MS = 5_000
const AUDIT_TIMEOUT_MS = 1_500

/** 面板 URL；Host 头必须与监听端口一致，loopback API 才接受。 */
function panelUrl(port) {
  return `http://127.0.0.1:${port}`
}

function messageOf(error) {
  return String(error?.message ?? error)
}

/**
 * 一次面板 JSON 请求。非 2xx 与非 JSON 都抛错，错误里带状态码和响应文本前 200 字（可复制给操作者）。
 * 409 的 Error 带 `status`，供调用方重读后重试。
 */
async function panelJson(port, path, {
  method = 'GET',
  body,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('cannot talk to the deployment: no fetch implementation')
  const url = `${panelUrl(port)}${path}`
  const headers = { accept: 'application/json', 'x-orchestrator-request': '1', Host: `127.0.0.1:${port}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`cannot reach the deployment at ${url} (${messageOf(error)})`)
  }
  let text
  try {
    text = await response.text()
  } catch (error) {
    throw new Error(`cannot read the reply from the deployment at ${url} (${messageOf(error)})`)
  }
  const status = Number(response.status)
  let value
  try {
    value = text.trim() === '' ? null : JSON.parse(text)
  } catch {
    throw new Error(
      `the deployment at ${url} returned non-JSON for ${method} ${path} (HTTP ${status}): ${text.slice(0, 200)}`,
    )
  }
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    const detail = typeof value?.error === 'string' ? value.error : text.slice(0, 200)
    const error = new Error(
      `the deployment at ${url} answered ${method} ${path} with HTTP ${status}${detail === '' ? '' : `: ${detail}`}`,
    )
    error.status = status
    throw error
  }
  return value
}

/** 读 settings 里的一个 block（`policy` / `executor`），返回 `{revision, value}`。 */
async function readBlock(port, block, { fetch: fetchImpl, timeoutMs } = {}) {
  const settings = await panelJson(port, SETTINGS_PATH, { fetch: fetchImpl, timeoutMs })
  const found = settings?.blocks?.[block]
  if (found === null || typeof found !== 'object' || found.value === null || typeof found.value !== 'object') {
    throw new Error(
      `the deployment at ${panelUrl(port)} returned no "${block}" settings block; its panel may predate the ` +
        'per-deployment policy editor, so update dsh-superagent',
    )
  }
  if (!Number.isInteger(found.revision) || found.revision < 0) {
    throw new Error(`the deployment at ${panelUrl(port)} returned a "${block}" block without a valid revision`)
  }
  return { revision: found.revision, value: found.value }
}

/** 读当前 policy：`{revision, value:{rules, sources}}`。 */
export async function readPolicy({ port, fetch: fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return readBlock(port, 'policy', { fetch: fetchImpl, timeoutMs })
}

/** 读当前 executor 配置：`{revision, value}`；`value.prepare` 为空串表示没有 prepare。 */
export async function readExecutor({ port, fetch: fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return readBlock(port, 'executor', { fetch: fetchImpl, timeoutMs })
}

/** 一个来源的 policy 部分；缺省/坏了都当作空对象，避免因为一次读失败而覆盖别人的规则。 */
function sourcePart(value, source) {
  const part = value?.sources?.[source]
  return part !== null && typeof part === 'object' ? part : {}
}

/** 某来源现有的 allowed 条目（原样保留，包括操作者手填的 `name`）。 */
function allowedEntries(value, source) {
  const allowed = sourcePart(value, source).allowed
  return Array.isArray(allowed) ? allowed.filter(entry => entry !== null && typeof entry === 'object') : []
}

/** 某来源 allowed 里的 id 列表（只读辅助，给审计与测试用）。 */
export function allowedIds(value, source = DEFAULT_SOURCE) {
  return allowedEntries(value, source)
    .map(entry => String(entry.id ?? '').trim())
    .filter(id => id !== '')
}

/** 身份比较与 dsh-superagent 的 `sameName` 一致：去空白、忽略大小写。 */
function sameIdentity(left, right) {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
}

/** 只替换某一个来源的 allowed，其余来源、rules 与未知字段全部原样带回。 */
function withAllowed(value, source, entries, entry) {
  return {
    ...value,
    sources: {
      ...(value.sources ?? {}),
      [source]: { ...sourcePart(value, source), allowed: [...entries, entry] },
    },
  }
}

/**
 * 确保 `source` 的 allowed 里有 `id`。已有则不发 PUT；缺了才补，并在写后重读确认。
 * 409 冲突只重读一次：如果那时已经有人补上了，就当作成功；否则用最新 revision 再写一次，仍失败就抛。
 */
export async function ensureAllowed({
  port,
  source = DEFAULT_SOURCE,
  id = DEFAULT_ACTOR,
  name = DEFAULT_ACTOR_NAME,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const actor = String(id ?? '').trim()
  if (actor === '') throw new Error('an allowed identity needs a non-empty id')
  const first = await readPolicy({ port, fetch: fetchImpl, timeoutMs })
  const current = allowedEntries(first.value, source)
  if (current.some(entry => sameIdentity(entry.id, actor))) {
    return { changed: false, allowed: allowedIds(first.value, source) }
  }

  const entry = { id: actor }
  const display = String(name ?? '').trim()
  if (display !== '') entry.name = display
  let revision = first.revision
  let value = withAllowed(first.value, source, current, entry)
  try {
    await panelJson(port, POLICY_PATH, {
      method: 'PUT',
      body: { revision, value },
      fetch: fetchImpl,
      timeoutMs,
    })
  } catch (error) {
    if (error.status !== 409) throw error
    const latest = await readPolicy({ port, fetch: fetchImpl, timeoutMs })
    const latestEntries = allowedEntries(latest.value, source)
    if (latestEntries.some(existing => sameIdentity(existing.id, actor))) {
      return { changed: false, allowed: allowedIds(latest.value, source) }
    }
    revision = latest.revision
    value = withAllowed(latest.value, source, latestEntries, entry)
    await panelJson(port, POLICY_PATH, {
      method: 'PUT',
      body: { revision, value },
      fetch: fetchImpl,
      timeoutMs,
    })
  }

  const saved = await readPolicy({ port, fetch: fetchImpl, timeoutMs })
  const ids = allowedIds(saved.value, source)
  if (!ids.some(existing => sameIdentity(existing, actor))) {
    throw new Error(
      `the deployment at ${panelUrl(port)} accepted the policy save but source "${source}" still does not ` +
        `allow "${actor}"; check its Sources page`,
    )
  }
  return { changed: true, allowed: ids }
}

/**
 * 只在 `executor.prepare` 为空时写入默认命令。非空的 prepare 是操作者的自定义值，一个字节都不改。
 * 409 的处理与 `ensureAllowed` 相同：重读一次，已经有人设置就不再写，否则用最新 revision 再试一次。
 */
export async function ensureExecutorPrepare({
  port,
  command = DEFAULT_PREPARE,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const first = await readExecutor({ port, fetch: fetchImpl, timeoutMs })
  const existing = String(first.value.prepare ?? '')
  if (existing.trim() !== '') return { changed: false, prepare: existing }

  const value = { ...first.value, prepare: command }
  try {
    await panelJson(port, EXECUTOR_PATH, {
      method: 'PUT',
      body: { revision: first.revision, value },
      fetch: fetchImpl,
      timeoutMs,
    })
  } catch (error) {
    if (error.status !== 409) throw error
    const latest = await readExecutor({ port, fetch: fetchImpl, timeoutMs })
    const latestPrepare = String(latest.value.prepare ?? '')
    if (latestPrepare.trim() !== '') return { changed: false, prepare: latestPrepare }
    await panelJson(port, EXECUTOR_PATH, {
      method: 'PUT',
      body: { revision: latest.revision, value: { ...latest.value, prepare: command } },
      fetch: fetchImpl,
      timeoutMs,
    })
  }

  const saved = await readExecutor({ port, fetch: fetchImpl, timeoutMs })
  const savedPrepare = String(saved.value.prepare ?? '')
  if (savedPrepare.trim() === '') {
    throw new Error(
      `the deployment at ${panelUrl(port)} accepted the executor save but executor.prepare is still empty`,
    )
  }
  return { changed: true, prepare: savedPrepare }
}

/**
 * 只读审计：给 `install.sh --check` 用。每份注册部署缺什么就输出一行事实；都配好则没有输出。
 * 部署没在跑时也只输出一行「读不到」，不把它算成安装问题。
 */
export async function auditDeploymentPolicies({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = AUDIT_TIMEOUT_MS,
} = {}) {
  const registry = listDeployments({ env })
  if (!registry.exists) return [`no deployment registry at ${registry.file} yet; nothing to check`]
  if (registry.deployments.length === 0) return [`the deployment registry at ${registry.file} has no entries`]
  return Promise.all(registry.deployments.map(async entry => {
    const where = `deployment ${entry.project} (port ${entry.port ?? 'none'})`
    if (!Number.isInteger(entry.port)) return `${where}: has no port, so its settings cannot be checked`
    try {
      const [policy, executor] = await Promise.all([
        readPolicy({ port: entry.port, fetch: fetchImpl, timeoutMs }),
        readExecutor({ port: entry.port, fetch: fetchImpl, timeoutMs }),
      ])
      const missing = []
      if (!allowedIds(policy.value).some(id => sameIdentity(id, DEFAULT_ACTOR))) {
        missing.push(
          `lacks the "${DEFAULT_ACTOR}" allowed identity for source "${DEFAULT_SOURCE}", so dispatches are ` +
            'silently ignored',
        )
      }
      if (String(executor.value.prepare ?? '').trim() === '') {
        missing.push('has an empty executor.prepare, so workers start without a clone')
      }
      if (missing.length === 0) return null
      return `${where}: ${missing.join('; and ')}; run "wheelchair-agent deployment setup --project ${entry.project}"`
    } catch (error) {
      return `${where}: could not read its settings (${messageOf(error)}); start it and rerun "bash install.sh --check"`
    }
  })).then(lines => lines.filter(line => line !== null))
}

/** `install.sh --check` / `deployment setup` 之外的只读入口：`... deployment-policy.js audit`。 */
async function main() {
  if (process.argv[1] === undefined || resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) return
  if (process.argv[2] !== 'audit') return
  try {
    const lines = await auditDeploymentPolicies({ env: process.env })
    for (const line of lines) process.stdout.write(`${line}\n`)
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`)
    process.exitCode = 1
  }
}

await main()
