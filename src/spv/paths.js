/**
 * SPV agent 侧的工具从哪个目录读写文件队列。
 *
 * 队列是本包 `spv_*` 工具（SPV agent preset）与 superagent 侧（`src/superagent/spv.js`、`src/superagent/watch.js`）
 * 之间**唯一**的接口，两侧必须指同一个目录，所以这里的规则与 `src/superagent/spv.js` 刻意保持一致。
 *
 * 部署注册表（`<data root>/deployments.json`）是**唯一**的部署来源。每份部署有自己的队列，队列由项目在
 * 注册表里的条目决定。优先级（前一项永远赢）：
 *
 *   1. 显式 `queueDir` 设置（调用方自己的覆盖）
 *   2. `$SPV_QUEUE_DIR`（**仅**测试/逃生口；它不是部署来源，正常启动由 `service start` 为实例设好）
 *   3. 注册表中该项目的 `queueDir`
 *
 * 注册表文件不存在，或者没有该项目的条目，都直接报 `missingDeploymentError`，给出
 * `wheelchair-agent deployment migrate`（认领旧安装）或 `deployment add <project>`。绝不悄悄回退到
 * `<stateDir>/spv`，绝不写进别人的队列，也绝不自动创建部署。
 *
 * 观测与结果回收不按单个项目取队列，而是用 `resolveRoots()` 一次拿到所有要监听的队列根：注册表里每一份
 * 部署的队列。显式 `queueDir` 或 `$SPV_QUEUE_DIR` 仍然只有一根——显式设置永远赢，不再聚合。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { listDeployments, missingDeploymentError } from '../shared/deployments.js'
import { assertNotTicketClone } from '../shared/home.js'

/** 未指定时 superagent 部署的状态目录（只在显示/默认值里用，不再决定队列）。 */
export const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'state', 'superagent')

/** 注册表条目的队列根，带 ticket-clone 守卫（注册表是自动解析，不是显式覆盖）。 */
function registryRoot(entry) {
  assertNotTicketClone({
    env: process.env,
    stateDir: entry.stateDir,
    what: `the spv queue root of project ${JSON.stringify(entry.project)}`,
    target: entry.queueDir,
  })
  return entry.queueDir
}

/**
 * 这个进程没有部署上下文时的错误。
 *
 * `$SPV_QUEUE_DIR` 与显式 `queueDir` 仍然优先，所以测试和手动排障可以指定一根队列；正常运行时由
 * 在项目 checkout 里运行 `service start` 为实例设好 `SPV_QUEUE_DIR`，不需要调用方猜。
 */
export function deploymentContextError() {
  return new Error(
    'cannot tell which deployment this process belongs to: the deployment registry is the only source, and ' +
      'this process has no project and no queue override. Start it from the project checkout with ' +
      '"wheelchair-agent service start" (or, for a one-off test, set SPV_QUEUE_DIR), or run ' +
      '"wheelchair-agent deployment list" to see the registered deployments.',
  )
}

/**
 * SPV 工具读写的队列根目录（绝对路径）。
 *
 * 传了 `project` 时按注册表路由到该项目部署的队列；不传时只接受显式覆盖（`config.queueDir` /
 * `$SPV_QUEUE_DIR`），否则报部署上下文错误，绝不回退到 `<stateDir>/spv`。注册表坏掉时抛错而不是回退——
 * 回退会把任务写进错误的队列。
 */
export function resolveRoot(config = {}, { project } = {}) {
  const configured = String(config.queueDir ?? '').trim()
  if (configured) return configured
  const fromEnv = String(process.env.SPV_QUEUE_DIR ?? '').trim()
  if (fromEnv) return fromEnv
  const wanted = String(project ?? '').trim()
  if (wanted === '') throw deploymentContextError()
  const registry = listDeployments()
  if (!registry.exists) throw missingDeploymentError(wanted, registry.file, false)
  const entry = registry.deployments.find(item => item.project === wanted)
  if (entry === undefined) throw missingDeploymentError(wanted, registry.file, true)
  return registryRoot(entry)
}

/**
 * 要监听/观测的**所有**队列根：`[{ project, root }]`。
 *
 * 注入器与 `spv_status` 用这一份列表，不再只盯挂载时那一个目录：
 *   1. 显式 `queueDir` 设置 → 只有它一根（`project: null`）；
 *   2. `$SPV_QUEUE_DIR` → 同样只有一根；
 *   3. 注册表 → 每一条部署的 `queueDir`（按项目排序、按路径去重）。
 *
 * 注册表不存在时抛同一个指路错误（先 `deployment migrate` 或 `deployment add`），不再返回旧规则那根。
 * 每一根都过 `assertNotTicketClone`；坏注册表照旧大声报错，绝不悄悄丢掉某一条——丢掉意味着那份部署的
 * 回信永远没人读。
 */
export function resolveRoots(config = {}) {
  const configured = String(config.queueDir ?? '').trim()
  if (configured) return [{ project: null, root: configured }]
  const fromEnv = String(process.env.SPV_QUEUE_DIR ?? '').trim()
  if (fromEnv) return [{ project: null, root: fromEnv }]
  const registry = listDeployments()
  if (!registry.exists) throw missingDeploymentError('<project>', registry.file, false)
  const roots = []
  const seen = new Set()
  for (const entry of registry.deployments) {
    const root = registryRoot(entry)
    if (seen.has(root)) continue
    seen.add(root)
    roots.push({ project: entry.project, root })
  }
  return roots
}

/**
 * 队列不存在时的错误：说清缺什么、为什么、以及能照抄的命令。
 * `pending/`、`done/`、`outbox/` 归 superagent 的 `spv` Source 所有，这里**不**代为创建——没有服务的空队列只会
 * 把任务悄悄吞掉。
 */
export function missingQueue(root) {
  return new Error(
    `no spv queue at ${root}: the superagent spv Source creates pending/, done/ and outbox/ when it starts, ` +
      'and until then a dispatched task would have nobody to read it. From the project checkout run ' +
      '"wheelchair-agent service start" (or "wheelchair-agent service start --all"), then ' +
      '"wheelchair-agent service status" until it reports runtime ready, confirm the superagent profile enables ' +
      'the spv Source, then call this tool again.',
  )
}
