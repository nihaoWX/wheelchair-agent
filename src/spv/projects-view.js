/**
 * 「项目」段的数据：把 spv 项目表、部署注册表和每份部署自己的面板 API 拼成一张只读视图。
 *
 * 这个模块不读队列、不写任何文件：worker 卡片里的「正在跑」直接来自每份部署的
 * `GET /orchestrator/api/{state,overview,tickets}`。任何一份部署失败/超时只影响它自己的
 * worker 卡片（`state.kind = "unavailable"`），不会让整个路由失败或长时间挂住。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { deploymentSlug, listDeployments } from '../shared/deployments.js'
import { listSpvProjects, projectsRootOf, spvProjectsPath } from '../shared/spv-projects.js'

/** 单份部署的请求上限；并发发出，所以整张卡最多等这么久。 */
export const PROJECT_PROBE_TIMEOUT_MS = 2000

const API_HEADERS = { accept: 'application/json', 'x-orchestrator-request': '1' }

/** `dsh web` prints this once per start; the token is the only way into the harness page. */
const TOKEN_URL = /https?:\/\/[^\s]*[?&]token=[A-Za-z0-9._-]+/g

/**
 * The tokenised URL of one deployment's own full UI.
 *
 * A deployment's panel is authenticated per process, so the token lives in its startup log and
 * nowhere else. Reading the log here (rather than probing the live page) keeps the projects route
 * cheap and lets a card offer a jump link exactly when that deployment has printed one.
 */
export function deploymentUrl(project, { env = process.env } = {}) {
  const dshHome = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const log = join(dshHome, '.artifacts', `wca-${deploymentSlug(project)}.log`)
  try {
    const matches = [...readFileSync(log, 'utf8').matchAll(TOKEN_URL)]
    return matches.length === 0 ? null : matches[matches.length - 1][0]
  } catch {
    return null
  }
}

function reasonOf(error) {
  if (error?.name === 'AbortError') return `timed out after ${PROJECT_PROBE_TIMEOUT_MS}ms`
  return String(error?.message ?? error)
}

/** 访问一份部署的 loopback 面板 API；Host 必须与监听端口一致，否则上游会拒绝。 */
async function getJson(port, path) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROJECT_PROBE_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { ...API_HEADERS, Host: `127.0.0.1:${port}` },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function runningTickets(tickets) {
  const items = Array.isArray(tickets?.items) ? tickets.items : []
  return items
    .filter(item => String(item?.stage ?? '') === 'working')
    .map(item => ({
      id: String(item?.id ?? ''),
      title: String(item?.title ?? ''),
      stage: String(item?.stage ?? ''),
      action: item?.action === null || item?.action === undefined ? null : String(item.action),
    }))
}

/**
 * 探测一份部署。三个请求并发；任一失败都把这个 worker 标成 unavailable，并带上最直接的
 * 原因（连接拒绝/超时/HTTP 状态）。
 */
export async function probeDeployment(port) {
  try {
    const [state, overview, tickets] = await Promise.all([
      getJson(port, '/orchestrator/api/state'),
      getJson(port, '/orchestrator/api/overview'),
      getJson(port, '/orchestrator/api/tickets?state=working&limit=20'),
    ])
    const running = runningTickets(tickets)
    const executor = overview?.executor ?? {}
    return {
      kind: 'ok',
      port,
      running,
      queued: Number.isInteger(executor.queued) ? executor.queued : 0,
      workers: Number.isInteger(executor.running) ? executor.running : running.length,
      setupProblem: typeof state?.setup?.problem === 'string' ? state.setup.problem : null,
    }
  } catch (error) {
    return { kind: 'unavailable', port, reason: reasonOf(error) }
  }
}

/**
 * 面板 `GET /wheelchair-projects` 的响应体。spv 表本身坏了会抛出（路由返回 500）；
 * 单份部署的 API 坏了只落到那张卡片的 unavailable。
 */
export async function projectCards({ env = process.env, home, stateDir } = {}) {
  const registry = listSpvProjects({ env, home, stateDir })
  let deployments = []
  let deploymentProblem = null
  try {
    deployments = listDeployments({ env, home, stateDir }).deployments
  } catch (error) {
    deploymentProblem = `the deployment registry is unreadable: ${error instanceof Error ? error.message : error}`
  }
  const byProject = new Map(deployments.map(entry => [entry.project, entry]))
  const projectsRoot = projectsRootOf({ env })
  const ports = new Set()
  for (const entry of registry.spvProjects) {
    for (const worker of entry.workers) {
      const deployment = byProject.get(worker)
      if (deployment !== undefined && deployment.port !== null) ports.add(deployment.port)
    }
  }
  const probes = new Map()
  await Promise.all(
    [...ports].map(async port => {
      probes.set(port, await probeDeployment(port))
    }),
  )
  const spvProjects = registry.spvProjects.map(entry => ({
    root: entry.root,
    exists: true,
    workers: entry.workers.map(worker => {
      const deployment = byProject.get(worker)
      let state
      if (deploymentProblem !== null) {
        state = { kind: 'unavailable', reason: deploymentProblem }
      } else if (deployment === undefined) {
        state = {
          kind: 'unavailable',
          reason: `no registered deployment reads this worker; run "wheelchair-agent deployment add ${worker}"`,
        }
      } else if (deployment.port === null) {
        state = {
          kind: 'unavailable',
          reason: `deployment ${worker} has no port; run "wheelchair-agent deployment add ${worker} --port <n>"`,
        }
      } else {
        state = probes.get(deployment.port) ?? {
          kind: 'unavailable',
          reason: `deployment ${worker} was not probed`,
        }
      }
      return {
        project: worker,
        path: join(projectsRoot, worker),
        deployment:
          deployment === undefined || deployment.port === null
            ? null
            : { port: deployment.port, url: deploymentUrl(worker, { env }) },
        state,
      }
    }),
  }))
  return {
    spvProjects,
    registry: spvProjectsPath({ env, home, stateDir }),
    ...(deploymentProblem === null ? {} : { problem: deploymentProblem }),
  }
}
