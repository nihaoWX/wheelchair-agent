/**
 * SPV agent 侧的工具从哪个目录读写文件队列。
 *
 * 队列是本包 `spv_*` 工具（SPV agent preset）与 superagent 侧（`src/superagent/spv.js`、`src/superagent/watch.js`）
 * 之间**唯一**的接口，两侧必须指同一个目录，所以这里的规则与 `src/superagent/spv.js` 刻意保持一致。
 *
 * 单部署时代只有一份队列：
 *
 *   <stateDir>/spv          stateDir = $DSH_SUPERAGENT_STATE_DIR，缺省 ~/.dsh/state/superagent
 *
 * 「一仓一部署」之后，每份部署有自己的队列，队列由项目在注册表里的条目决定。优先级（前一项永远赢）：
 *
 *   1. 显式 `queueDir` 设置
 *   2. `$SPV_QUEUE_DIR`
 *   3. 注册表中该项目的 `queueDir`（仅在调用方给出 `project` 且注册表文件存在时）
 *   4. 旧规则 `<stateDir>/spv`
 *
 * 注册表**存在**却没有该项目的条目时直接报错并给出 `deployment add`，绝不悄悄写进别人的队列，也绝不
 * 自动创建部署；注册表**不存在**时完全走旧规则，所以升级本身不改变任何现有行为，只有 `deployment migrate`
 * 显式写下第一条条目之后才进入分部署模式。
 *
 * 观测与结果回收不按单个项目取队列，而是用 `resolveRoots()` 一次拿到所有要监听的队列根：注册表里每一份
 * 部署的队列，外加旧规则那个 `<stateDir>/spv`（还没迁移的部署仍然工作）。显式 `queueDir` 或
 * `$SPV_QUEUE_DIR` 仍然只有一根——显式设置永远赢，不再聚合。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { missingDeploymentError, listDeployments } from '../shared/deployments.js'
import { assertNotTicketClone } from '../shared/home.js'

/** 未指定时 superagent 部署的状态目录。 */
export const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'state', 'superagent')

/** 旧规则：`<stateDir>/spv`，带 ticket-clone 守卫。 */
function legacyRoot(stateDir) {
  // The live queue belongs to the deployment; a worker's ticket clone must not resolve it by default
  // (the same shared check refuses the data root in src/shared/home.js). An explicit override wins.
  const root = join(stateDir, 'spv')
  assertNotTicketClone({ env: process.env, stateDir, what: 'the default spv queue root', target: root })
  return root
}

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
 * SPV 工具读写的队列根目录（绝对路径）。
 *
 * 不传 `project` 时保持旧语义（挂载时解析注入器/status 读的目录）；传了 `project` 时按注册表路由到该项目
 * 部署的队列。注册表坏掉时抛错而不是回退——回退会把任务写进错误的队列。
 */
export function resolveRoot(config = {}, { project } = {}) {
  const configured = String(config.queueDir ?? '').trim()
  if (configured) return configured
  const fromEnv = String(process.env.SPV_QUEUE_DIR ?? '').trim()
  if (fromEnv) return fromEnv
  const stateDir = String(process.env.DSH_SUPERAGENT_STATE_DIR ?? '').trim() || DEFAULT_STATE_DIR
  if (project === undefined || project === null || String(project).trim() === '') return legacyRoot(stateDir)
  const wanted = String(project).trim()
  const registry = listDeployments()
  if (!registry.exists) return legacyRoot(stateDir)
  const entry = registry.deployments.find(item => item.project === wanted)
  if (entry === undefined) throw missingDeploymentError(wanted, registry.file)
  return registryRoot(entry)
}

/**
 * 要监听/观测的**所有**队列根：`[{ project, root }]`。
 *
 * 注入器与 `spv_status` 用这一份列表，不再只盯挂载时那一个目录：
 *   1. 显式 `queueDir` 设置 → 只有它一根（`project: null`）；
 *   2. `$SPV_QUEUE_DIR` → 同样只有一根；
 *   3. 注册表存在 → 每一条部署的 `queueDir`（按项目排序、按路径去重），并且把旧规则解析出的
 *      `<stateDir>/spv` 也加进去（`project: null`），让还没迁移的部署继续工作；
 *   4. 注册表不存在 → 只有旧规则那一根。
 *
 * 每一根都过 `assertNotTicketClone`；坏注册表照旧大声报错，绝不悄悄丢掉某一条——丢掉意味着那份部署的
 * 回信永远没人读。
 */
export function resolveRoots(config = {}) {
  const configured = String(config.queueDir ?? '').trim()
  if (configured) return [{ project: null, root: configured }]
  const fromEnv = String(process.env.SPV_QUEUE_DIR ?? '').trim()
  if (fromEnv) return [{ project: null, root: fromEnv }]
  const stateDir = String(process.env.DSH_SUPERAGENT_STATE_DIR ?? '').trim() || DEFAULT_STATE_DIR
  const registry = listDeployments()
  if (!registry.exists) return [{ project: null, root: legacyRoot(stateDir) }]
  const roots = []
  const seen = new Set()
  for (const entry of registry.deployments) {
    const root = registryRoot(entry)
    if (seen.has(root)) continue
    seen.add(root)
    roots.push({ project: entry.project, root })
  }
  const legacy = legacyRoot(stateDir)
  if (!seen.has(legacy)) roots.push({ project: null, root: legacy })
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
      'and until then a dispatched task would have nobody to read it. Start it with ' +
      '"wheelchair-agent service start", run "wheelchair-agent service status" until it reports runtime ' +
      'ready, confirm the superagent profile enables the spv Source, then call this tool again.',
  )
}
