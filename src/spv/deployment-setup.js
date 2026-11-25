/**
 * `wheelchair-agent deployment setup`：把一份部署指向它自己的 GitHub 仓库。
 *
 * `repository` 不是 dsh 的 config 键（`dsh-superagent` 的 `Config` 会因为「keys it does not use」拒绝它），
 * 它存在实例自己 stateDir 的 `source:github` 设置里。wheelchair 侧唯一稳定的写法是实例的面板 HTTP API：
 *   GET  /orchestrator/api/settings           → 找到 id 为 github 的 source，拿 revision / enabled / config
 *   PUT  /orchestrator/api/settings/source:github  {value:{enabled,config:{repository,cli}}, revision}
 *   GET  /orchestrator/api/state              → setup.accounts.repository / setup.problem
 * 面板 API 只在 loopback 上、且要求 `x-orchestrator-request: 1` 与同源 Host；不需要 token。这里只根据注册表
 * 的端口拼 `http://127.0.0.1:<port>`，不接受任意 URL。
 *
 * setup 未 configured 时保存会重启该实例并重新跑 setup，所以 PUT 之后要轮询 `state`，不能假设同步完成。
 */
import { accessSync, constants as fsConstants, existsSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { listDeployments, missingDeploymentError } from '../shared/deployments.js'

const SETTINGS_PATH = '/orchestrator/api/settings'
const STATE_PATH = '/orchestrator/api/state'
const DEFAULT_TIMEOUT_MS = 90_000

function setupTimeoutMs(env) {
  const raw = Number(env.WHEELCHAIR_AGENT_SETUP_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 100 ? raw : DEFAULT_TIMEOUT_MS
}

function setupIntervalMs(env) {
  const raw = Number(env.WHEELCHAIR_AGENT_SETUP_INTERVAL_MS)
  return Number.isFinite(raw) && raw >= 10 ? raw : 2000
}

/** 面板 API 的 loopback 地址；端口只来自注册表，调用方不拼 URL。 */
export function panelUrl(port) {
  return `http://127.0.0.1:${port}/`
}

/** 一个极小的 HTTP 客户端：同源 Host、`x-orchestrator-request: 1`、JSON，只连 127.0.0.1。 */
function panelRequest(port, path, { method = 'GET', body, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      timeout: timeoutMs,
      headers: {
        host: `127.0.0.1:${port}`,
        'x-orchestrator-request': '1',
        ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': payload.length }),
      },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let value
        try {
          value = text === '' ? null : JSON.parse(text)
        } catch {
          reject(new Error(`the deployment at ${panelUrl(port)} returned non-JSON for ${method} ${path} (HTTP ${response.statusCode})`))
          return
        }
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          const detail = value && typeof value === 'object' && typeof value.error === 'string' ? value.error : text.slice(0, 300)
          reject(new Error(`the deployment at ${panelUrl(port)} answered ${method} ${path} with HTTP ${response.statusCode}${detail ? `: ${detail}` : ''}`))
          return
        }
        resolve(value)
      })
    })
    req.on('timeout', () => req.destroy(new Error(`the deployment at ${panelUrl(port)} did not answer ${method} ${path} within ${timeoutMs}ms`)))
    req.on('error', error => reject(new Error(`cannot reach the deployment at ${panelUrl(port)} (${error.message}); is it running? Start it with "wheelchair-agent service start --project <project>"`)))
    if (payload !== null) req.write(payload)
    req.end()
  })
}

/** 从 `GET settings` 的 sources 里找 github 块；缺这个 source 是实例配置问题，直接报清楚。 */
function githubSource(settings, port) {
  const source = Array.isArray(settings?.sources)
    ? settings.sources.find(item => item?.id === 'github')
    : undefined
  if (source === undefined) {
    throw new Error(`the deployment at ${panelUrl(port)} has no "github" source in its settings; it cannot be pointed at a repository`)
  }
  const config = source.value && typeof source.value === 'object' && source.value.config && typeof source.value.config === 'object'
    ? source.value.config
    : {}
  return { source, config }
}

function sameRepository(left, right) {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
}

/** 一个可执行的 cli 路径；空/不存在/不可执行都算没有。 */
function executable(value) {
  const candidate = String(value ?? '').trim()
  if (candidate === '' || !candidate.startsWith('/') || !existsSync(candidate)) return null
  try {
    accessSync(candidate, fsConstants.X_OK)
    return candidate
  } catch {
    return null
  }
}

/** 从任意已配置实例的 github.cli 取可执行路径；都没有就用 PATH 里的 gh。 */
async function resolveCli(registry, target, targetConfig, env) {
  const own = executable(targetConfig.cli)
  if (own !== null) return own
  for (const entry of registry.deployments) {
    if (entry.project === target.project || entry.port === null) continue
    try {
      const settings = await panelRequest(entry.port, SETTINGS_PATH, { timeoutMs: 2000 })
      const candidate = executable(githubSource(settings, entry.port).config.cli)
      if (candidate !== null) return candidate
    } catch {
      // 其他部署可能没在运行；这不影响从当前实例或 PATH 取 cli。
    }
  }
  for (const directory of String(env.PATH ?? '').split(':')) {
    if (directory.trim() === '') continue
    const candidate = executable(join(directory.trim(), 'gh'))
    if (candidate !== null) return candidate
  }
  throw new Error(
    'cannot choose the GitHub CLI for this deployment: no registered instance has an executable github.cli, and ' +
      'no "gh" executable is on PATH. Install GitHub CLI (or configure one deployment\'s github.cli first), then rerun ' +
      '"wheelchair-agent deployment setup --project <project>".',
  )
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** `deployment setup --project <p>` 的实现；返回 0，失败抛 Error（bin 转成 exit 1）。 */
export async function setupDeployment(projectInput, { env = process.env, out = process.stdout } = {}) {
  const wanted = String(projectInput ?? '').trim()
  const registry = listDeployments({ env })
  const entry = registry.deployments.find(item => item.project === wanted)
  if (entry === undefined) throw missingDeploymentError(wanted, registry.file, registry.exists)
  if (entry.port === null) {
    throw new Error(
      `deployment ${JSON.stringify(entry.project)} has no port, so its panel API cannot be reached. Give it one with ` +
        `"wheelchair-agent deployment add ${entry.project} --port <n>", then start it.`,
    )
  }
  const target = entry.repository
  if (target === null) {
    throw new Error(
      `deployment ${JSON.stringify(entry.project)} has no repository recorded, so setup cannot decide what to target. ` +
        `Record it with "wheelchair-agent deployment add ${entry.project} --repo owner/name" (or remove and re-add it ` +
        'with --repo), then rerun setup.',
    )
  }
  const url = panelUrl(entry.port)
  const settings = await panelRequest(entry.port, SETTINGS_PATH)
  const { source, config } = githubSource(settings, entry.port)
  if (sameRepository(config.repository, target)) {
    out.write(`already configured: ${entry.project} targets ${target} (${url})\n`)
    return 0
  }
  const cli = await resolveCli(registry, entry, config, env)
  const value = {
    enabled: source.value && typeof source.value === 'object' && typeof source.value.enabled === 'boolean'
      ? source.value.enabled
      : true,
    config: { ...config, repository: target, cli },
  }
  await panelRequest(entry.port, `${SETTINGS_PATH}/source:github`, {
    method: 'PUT',
    body: { value, revision: source.revision },
    timeoutMs: 15_000,
  })

  const deadline = Date.now() + setupTimeoutMs(env)
  const interval = setupIntervalMs(env)
  let last = null
  let lastProblem = null
  while (true) {
    try {
      last = await panelRequest(entry.port, STATE_PATH, { timeoutMs: 3000 })
      const accounts = last?.setup?.accounts
      if (accounts && typeof accounts === 'object' && sameRepository(accounts.repository, target)) {
        out.write(`configured: ${entry.project} now targets ${target} (${url})\n`)
        return 0
      }
      if (typeof last?.setup?.problem === 'string' && last.setup.problem.trim() !== '') lastProblem = last.setup.problem.trim()
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() >= deadline) break
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())))
  }
  const problem = lastProblem ?? 'the instance did not report a setup problem'
  throw new Error(
    `the deployment ${JSON.stringify(entry.project)} at ${url} did not report ${target} within ` +
      `${Math.round(setupTimeoutMs(env) / 1000)}s. setup problem: ${problem}. Open its panel: ${url} ` +
      '(the saved repository needs a GitHub token with push access and an executable github.cli).',
  )
}

/**
 * `service start --project <p>` 之后的轻提示：实例的 setup 还没有账号时，告诉操作者跑哪条命令。
 * 读不到（实例刚起、面板还没就绪）就返回 null，绝不影响 start。
 */
export async function setupHint(entry, { env = process.env } = {}) {
  if (entry.port === null) return null
  try {
    const state = await panelRequest(entry.port, STATE_PATH, { timeoutMs: 2000 })
    const accounts = state?.setup?.accounts
    const configured = accounts && typeof accounts === 'object' &&
      typeof accounts.repository === 'string' && accounts.repository.trim() !== ''
    if (configured) return null
    return `run "wheelchair-agent deployment setup --project ${entry.project}" to point this deployment at its repository`
  } catch {
    return null
  }
}
