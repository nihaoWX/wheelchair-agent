/**
 * 内建 hook 效果：`ticket.delivered` 之后归档 worker 会话（`worker-<ticketId>`）。
 *
 * **为什么在 hook runner 里、而不是 `runHooksFor` 的 items 循环里**：delivered 通常没有自定义脚本行，
 * `runHooksFor` 在 `items.length === 0` 时会认领 occurrence 后提前返回（`src/shared/hooks.js`），效果会被
 * 跳掉。所以效果由 runner 在脚本跑完之后按 `builtinRowsFor(event)` 执行（见 `src/spv/hook-runner.js`）。
 *
 * **为什么归档是安全的**：dsh 的归档只是把会话 id 写进 registry-global 的集合，日志原地保留；默认侧栏不再
 * 画它（"显示已归档"或面板的 Session 按钮仍能打开），下一次唤醒前 superagent 自己 `revive()` 取消归档。
 * `stopActivity: false` 表示绝不因为归档去杀 turn / subagent / job。
 *
 * **为什么要先看 job**：`workspace/session-activity` 也会把 running 的 job 报成活动，所以有 job 时
 * `archiveSession` 本来就会拒绝；但 job 结束后的唤醒路径（superagent 的 "background job ended"）**不经过
 * `revive()`**，一旦这时归档已经落下，那次唤醒会被 archived gate 拒成 `blocked`。因此有 running/stopping
 * 的 job 就完全不归档，留给 `ticket.ended` 的归档（那条路径会先杀 job）。
 *
 * 纯 Node：不 import dsh。`workspaceRegistry`、`jobs`、日志都由 host 注入（`webui/lib/index.js` 用 lazy
 * `ctx.get` 取，测试用假实现）。效果**永不抛**：失败只走日志，绝不影响 hook 脚本。
 */

/** 归档是否真的发生：`{ retry: true }` 表示调用方下一轮可以再试（turn 还没结束）。 */
export const EFFECT_RETRY = Object.freeze({ retry: true })

/** `WorkspaceActiveSessionError` / `WorkspaceUnknownSessionError` 的 name（不 import dsh，按名字识别）。 */
const ACTIVE_SESSION_ERROR = 'WorkspaceActiveSessionError'
const UNKNOWN_SESSION_ERROR = 'WorkspaceUnknownSessionError'

/** job 状态里只有这两种算"还在用这个会话"；settled 的 job 不会再唤醒它。 */
const ACTIVE_JOB_STATUSES = new Set(['running', 'stopping'])

/** `ticket.delivered` 的负载里只有工单 id；worker 会话 id 由 superagent 的约定推导。 */
export function workerSessionIdOf(ticketId) {
  const id = typeof ticketId === 'string' ? ticketId.trim() : ''
  return id === '' ? undefined : `worker-${id}`
}

function errorName(error) {
  return typeof error?.name === 'string' ? error.name : ''
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 造一个可以交给 `startHookRunner({ effects })` 的效果。
 *
 * @param {object} options
 * @param {() => Promise<object|undefined>|object|undefined} options.workspaceRegistryOf
 *   取 `ctx.workspaceRegistry`（最多等几秒的 lazy 取法由调用方实现）。
 * @param {() => Promise<object|undefined>|object|undefined} options.jobsOf 取 `ctx.jobs`。
 * @param {(line: string) => void} [options.log] 日志出口；`warning: ` 前缀由 host 映射到 `logger.warn`。
 */
export function createArchiveSessionEffect({ workspaceRegistryOf, jobsOf, log = () => {} } = {}) {
  const say = line => {
    try {
      log(line)
    } catch {
      // 日志 sinks 永远不能把效果拖死。
    }
  }
  const warn = message => say(`warning: ${message}`)

  /** 该会话是否还有未结束的 job。返回 `true`（有）、`false`（没有）或 `undefined`（读不到，降级为"有"）。 */
  const hasActiveJob = async sessionId => {
    let jobs
    try {
      jobs = await jobsOf()
    } catch (error) {
      warn(`cannot read the jobs service (${messageOf(error)}); treating ${sessionId} as busy`)
      return undefined
    }
    if (jobs === undefined || jobs === null || typeof jobs.list !== 'function') {
      warn(`the jobs service is unavailable; treating ${sessionId} as busy and not archiving`)
      return undefined
    }
    try {
      // `list(caller)` 返回该 caller 名下的 job（以及无主 job），所以 owner 过滤仍然必要。
      const owned = jobs.list(sessionId) ?? []
      return owned.some(job => job?.owner === sessionId && ACTIVE_JOB_STATUSES.has(job?.status))
    } catch (error) {
      warn(`cannot list the jobs of ${sessionId} (${messageOf(error)}); treating it as busy`)
      return undefined
    }
  }

  return async function archiveSessionEffect(context) {
    const ticketId = context?.payload?.ticketId
    const sessionId = workerSessionIdOf(ticketId)
    if (sessionId === undefined) {
      // 没有工单 id 就推不出 worker 会话；不要猜一个 id 去归档。
      warn(`ticket.delivered without a ticketId; cannot archive a worker session`)
      return undefined
    }

    const busy = await hasActiveJob(sessionId)
    if (busy === undefined) return undefined
    if (busy) {
      say(`skipping the archive of ${sessionId}: it still owns a running/stopping job (ticket.ended will archive it)`)
      return undefined
    }

    let registry
    try {
      registry = await workspaceRegistryOf()
    } catch (error) {
      warn(`cannot read the workspace registry (${messageOf(error)}); not archiving ${sessionId}`)
      return undefined
    }
    if (registry === undefined || registry === null || typeof registry.archiveSession !== 'function') {
      warn(`the workspace registry is unavailable; not archiving ${sessionId}`)
      return undefined
    }

    try {
      const already = Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(sessionId)
      await registry.archiveSession(sessionId, { stopActivity: false })
      if (!already) say(`archived ${sessionId}`)
    } catch (error) {
      const name = errorName(error)
      if (name === UNKNOWN_SESSION_ERROR) {
        // 会话从未创建（worker 在第一次 prepare 之前就报告了）——没什么可归档，静默。
        return undefined
      }
      if (name === ACTIVE_SESSION_ERROR) {
        // reply 可能写在 turn 中途：turn 还没结束，下一轮 tick 再试；次数上限由 runner 管。
        return EFFECT_RETRY
      }
      warn(`cannot archive ${sessionId}: ${messageOf(error)}`)
    }
    return undefined
  }
}
