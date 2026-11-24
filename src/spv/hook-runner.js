/**
 * 服务侧 hook runner：把 spool（`ticket.started` / `spv.dispatch`）与 SPV 队列
 * （`ticket.acknowledged` / `ticket.delivered` / `ticket.attention`）变成真正的脚本运行。
 *
 * **为什么只有一个读者**：队列的 `outbox/read/` 归档只能被 injector rename 消费；本 runner 只读
 * （`readQueueEvents` 不 rename、不 unlink），并用 `<数据根>/records/events-cursor.json` 去重。它挂在
 * service 侧的 webui host（`webui/lib/index.js`）里，而不是 SPV 会话里——injector 只在 SPV 会话里跑，
 * 两个读者会让同一个事件触发两次。`src/shared/hooks.js` 管执行原语，本文件只负责"什么时候读哪里"。
 *
 * **依赖注入**（测试与 host 都用）：`queueRootOf` 返回队列根（默认 `src/spv/paths.js` 的 `resolveRoot()`），
 * `intervalSecondsOf` 返回 `hooks.intervalSeconds`（默认每次重读设置），`log` 接日志，`unref` 让 host 的
 * 定时器不阻止进程退出。`drainOnce()` 是测试与 host 的"立刻跑一轮"入口；`startHookRunner()` 先 drain 一次
 * 再按间隔调度，所以服务停着期间累积的事件在启动时被补跑（cursor 保证每个 occurrence 只跑一次）。
 *
 * **内建效果（`effects`）**：`{ 'builtin:archiveSession': async context => … }`，或需要单独超时的
 * `{ 'builtin:autoMerge': { run: async context => …, timeoutMs: 120_000 } }`。它们不是用户脚本，而是
 * core path 的服务侧实现（交付后归档 worker 会话、按开关自动合并工单 PR）。为什么在这里执行而不是
 * `runHooksFor` 的 items 循环里：delivered 通常没有自定义行，`runHooksFor` 在 `items.length === 0` 时
 * 认领 occurrence 后提前返回，效果会被跳掉。本文件在每次 `runHooksFor` 之后按 `builtinRowsFor(event)`
 * 调用效果，且只在 occurrence 真的被认领时调用（`skipped` 为 `paused` / `cursor` 时跳过；`empty` 照跑）。
 * 效果永不抛；单次默认最多等 `EFFECT_TIMEOUT_MS`，`{ timeoutMs }` 可以逐个放宽/收紧；返回
 * `{ retry: true }` 的会在后续 drain 里最多重试 `EFFECT_MAX_RETRIES` 次。
 *
 * 纯 Node builtins：不 import dsh，不 `process.exit`。
 */
import { dirsOf } from '../shared/queue.js'
import {
  HOOK_INTERVAL_DEFAULT,
  builtinRowsFor,
  quarantineHookSpoolEvent,
  readHookSpoolEvents,
  readHooks,
  readQueueEvents,
  removeHookSpoolEvent,
  runHooksFor,
} from '../shared/hooks.js'
import { resolveRoot } from './paths.js'

/** `setTimeout` 的毫秒上限；再长的间隔会溢出成约 1ms 的忙循环。 */
const MAX_TIMER_MS = 2_147_483_647

/** 暂停（interval=0）时回来看设置的间隔：不是轮询队列，只是让"改回正数"不需要重启。 */
const PAUSE_RECHECK_MS = 1000

/**
 * 内建效果返回 `{ retry: true }`（"这一轮还不行，下一个 tick 再来"）时最多重试几次。
 *
 * `ticket.delivered` 的典型重试原因是 turn 还没结束（`WorkspaceActiveSessionError`）：reply 可能在 turn
 * 中途写进队列。默认间隔 15s，3 次≈45s；正常报告之后 turn 很快收尾，等不到的交给 `ticket.ended` 的归档。
 */
export const EFFECT_MAX_RETRIES = 3

/**
 * 单个内建效果的上限。效果跑在串行 drain 里，一个永不 settle 的 `archiveSession`（registry 的
 * `enqueueOperation` 与 `workspace/session-activity` waterfall 都可能卡住）会让所有 hook 脚本停摆，
 * `stop()` 也结束不了；用户脚本在 `src/shared/settings.js` 里本来就有超时，内建效果同样必须有。
 *
 * 15s 大于 webui 里 registry 最多 5s 的等待，正常归档（一次文件写）远在那之前完成。个别效果可以传
 * `{ run, timeoutMs }` 覆盖它（例如 `builtin:autoMerge` 的 gh 调用上限是 120s）。
 */
export const EFFECT_TIMEOUT_MS = 15_000

/** `Promise.race` 里表示"超时"的哨兵，不会与效果的真实返回值混淆。 */
const EFFECT_TIMED_OUT = Symbol('effect-timeout')

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 解析 runner 的轮询间隔：`0` 表示暂停，正数秒；非法值抛错（host 与测试在边界上处理）。
 * `configured` 给了就用它，否则读设置里的 `hooks.intervalSeconds`（坏文件退回默认 15）。
 */
export function resolveHookIntervalSeconds(configured, { env = process.env, home, stateDir } = {}) {
  let raw = configured
  if (raw === undefined) {
    try {
      raw = readHooks({ env, home, stateDir }).intervalSeconds
    } catch {
      raw = HOOK_INTERVAL_DEFAULT
    }
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value * 1000 > MAX_TIMER_MS) {
    throw new Error(
      `hooks.intervalSeconds must be 0 (paused) or a positive number of seconds under ` +
        `${Math.floor(MAX_TIMER_MS / 1000)}, got ${JSON.stringify(raw)}.`,
    )
  }
  return value
}

/**
 * 启动 runner；返回 `{ stop, done, drainOnce }`。
 *
 * - `drainOnce()`：先重试未完成的内建效果，再 spool、队列，串行执行；任何一条失败只记日志，不影响下一条。
 * - `startHookRunner()`：立即 drain 一次，然后 setTimeout 链；`intervalSecondsOf` 每次调度前重读，所以
 *   设置改成 0/正数都不需要重启。`stop()` 清定时器，`done` 在停止且当前轮结束后 resolve。
 */
export function startHookRunner({
  home,
  stateDir,
  env = process.env,
  queueRootOf = () => resolveRoot(),
  intervalSecondsOf,
  log = () => {},
  unref = false,
  effects = {},
  effectTimeoutMs = EFFECT_TIMEOUT_MS,
} = {}) {
  const warn = message => {
    try {
      log(message)
    } catch {
      // 日志 sinks 永远不能把 runner 拖死。
    }
  }
  const opts = { env, home, stateDir }
  let stopped = false
  let timer
  let inflight
  let wake
  const done = new Promise(resolve => {
    wake = resolve
  })
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    wake()
  }

  /** 内建效果返回 `{ retry: true }` 后的待重试表；同一效果 + 同一工单的新 occurrence 覆盖旧 context 并从 0 计。 */
  const pendingEffects = new Map()

  const effectKeyOf = (rowId, context) => `${rowId}:${context.payload?.ticketId ?? context.eventId ?? ''}`

  /** 效果可以是函数，也可以是 `{ run, timeoutMs }`；返回可执行函数或 `undefined`。 */
  const effectOf = rowId => {
    const entry = effects[rowId]
    const effect = typeof entry === 'function' ? entry : entry?.run
    return typeof effect === 'function' ? effect : undefined
  }

  /** 这个效果的等待上限：逐项的有限正数优先，否则用 runner 的默认值。 */
  const effectTimeoutOf = rowId => {
    const entry = effects[rowId]
    const timeout = entry !== null && typeof entry === 'object' ? entry.timeoutMs : undefined
    return Number.isFinite(timeout) && timeout > 0 ? timeout : effectTimeoutMs
  }

  const invokeEffect = async (rowId, context) => {
    const effect = effectOf(rowId)
    if (effect === undefined) return undefined
    const timeoutMs = effectTimeoutOf(rowId)
    let timer
    const pending = Promise.resolve().then(() => effect(context))
    const timeout = new Promise(resolve => {
      // 不 unref：效果还挂着的这十几秒本来就是"有工作没做完"，不能让进程在等待中超时前退出。
      timer = setTimeout(() => resolve(EFFECT_TIMED_OUT), timeoutMs)
    })
    try {
      const outcome = await Promise.race([pending, timeout])
      if (outcome === EFFECT_TIMED_OUT) {
        // 超时不重试：卡住的 registry 再等一轮也一样，交给 ticket.ended 的归档。
        warn(
          `warning: builtin ${rowId} for ${context.eventId ?? context.event} ` +
            `timed out after ${timeoutMs}ms; not retrying`,
        )
        return undefined
      }
      return outcome !== null && typeof outcome === 'object' ? outcome : undefined
    } catch (error) {
      // 效果自己承诺不抛；这里是最后一道防线，脚本与下一条事件不能因它停摆。
      warn(`warning: builtin ${rowId} failed for ${context.eventId ?? context.event}: ${messageOf(error)}`)
      return undefined
    } finally {
      clearTimeout(timer)
      // 超时后原 promise 仍可能 reject；挂一个 catch，避免 unhandledRejection 打崩 host。
      void pending.catch(() => {})
    }
  }

  /**
   * 一次 occurrence 的脚本跑完之后执行它的内建效果。
   *
   * 只在 occurrence 真的被认领时跑：`paused` / `cursor` 都意味着这一轮没有执行（连带效果），
   * `empty` 是"事件发生了但没有自定义脚本"，效果照跑。
   */
  const runEffectsFor = async (event, eventId, payload, summary) => {
    if (summary?.skipped === 'paused' || summary?.skipped === 'cursor') return
    let rows
    try {
      // 行按事件名（`ticket.delivered`）解析，不是 occurrence id（消息 id）：后者不是事件 id。
      rows = builtinRowsFor(event)
    } catch (error) {
      warn(`warning: cannot resolve the builtin rows of ${event}: ${messageOf(error)}`)
      return
    }
    for (const row of rows) {
      if (effectOf(row.id) === undefined) continue
      const context = { event, eventId, payload }
      const key = effectKeyOf(row.id, context)
      const outcome = await invokeEffect(row.id, context)
      if (outcome?.retry !== true) {
        // 新的 occurrence 已经成功（或明确失败）：旧的待重试项不能留到下一个 tick，
        // 否则可能在用户手动取消归档后又把它归档一次、多发一条 `archived` 日志。
        pendingEffects.delete(key)
        continue
      }
      const existing = pendingEffects.get(key)
      if (existing === undefined) pendingEffects.set(key, { rowId: row.id, context, retries: 0 })
      else {
        // 重试预算按 occurrence 算：新一次 occurrence 覆盖旧 context，也从 0 重新计。
        existing.context = context
        existing.retries = 0
      }
    }
  }

  /** 上几个 tick 里"还不行"的效果：每个 drain 开头各试一次，重试次数用完只记 warning。 */
  const drainEffectRetries = async () => {
    for (const [key, entry] of [...pendingEffects]) {
      const outcome = await invokeEffect(entry.rowId, entry.context)
      if (outcome?.retry !== true) {
        pendingEffects.delete(key)
        continue
      }
      const retries = entry.retries + 1
      if (retries >= EFFECT_MAX_RETRIES) {
        pendingEffects.delete(key)
        warn(
          `warning: builtin ${entry.rowId} for ${entry.context.eventId ?? entry.context.event} ` +
            `is still retryable after ${EFFECT_MAX_RETRIES} retries; giving up`,
        )
        continue
      }
      entry.retries = retries
    }
  }

  const drainSpool = async () => {
    const spool = await readHookSpoolEvents(opts)
    if (spool.error !== undefined) warn(`warning: cannot read the hook spool: ${spool.error}`)
    for (const bad of spool.bad) {
      warn(`warning: ignoring hook spool ${bad.file}: ${bad.error}`)
      quarantineHookSpoolEvent(bad.file)
    }
    for (const entry of spool.events) {
      const summary = await runHooksFor(entry.event, entry.payload, {
        ...opts,
        eventId: entry.eventId,
        workspace: entry.payload?.workspace,
      })
      if (summary.error !== undefined) {
        warn(`warning: hook ${entry.event} (${entry.eventId ?? entry.file}) failed: ${summary.error}`)
      }
      await runEffectsFor(entry.event, summary.eventId ?? entry.eventId, entry.payload, summary)
      // cursor 已经认领过也算处理完：删除文件，避免崩溃/重启后无限重试同一个坏 occurrence。
      removeHookSpoolEvent(entry.file)
    }
  }

  const drainQueue = async () => {
    let root
    try {
      root = queueRootOf()
    } catch (error) {
      warn(`warning: cannot resolve the spv queue root: ${messageOf(error)}; the spool still drains`)
      return
    }
    if (root === undefined || root === null || String(root).trim() === '') return
    const events = await readQueueEvents({ root, ...opts, warn })
    for (const entry of events) {
      const summary = await runHooksFor(entry.event, entry.payload, { ...opts, eventId: entry.eventId })
      if (summary.error !== undefined) {
        warn(`warning: hook ${entry.event} (${entry.eventId}) failed: ${summary.error}`)
      }
      await runEffectsFor(entry.event, summary.eventId ?? entry.eventId, entry.payload, summary)
    }
  }

  const drainOnce = async () => {
    if (inflight !== undefined) return inflight
    inflight = (async () => {
      try {
        // 先重试上个 tick 没完成的效果，再读新事件：这样 `{ retry: true }` 至少隔一个间隔，
        // 不会在同一个 tick 里把重试次数烧光。
        await drainEffectRetries()
        await drainSpool()
        await drainQueue()
      } catch (error) {
        warn(`warning: hook drain failed: ${messageOf(error)}`)
      } finally {
        inflight = undefined
        if (stopped) finish()
      }
    })()
    return inflight
  }

  const plan = () => {
    let value
    try {
      value = Number(
        intervalSecondsOf === undefined
          ? readHooks(opts).intervalSeconds
          : intervalSecondsOf(),
      )
    } catch (error) {
      warn(`warning: cannot read hooks.intervalSeconds: ${messageOf(error)}; using ${HOOK_INTERVAL_DEFAULT}s`)
      value = HOOK_INTERVAL_DEFAULT
    }
    if (!Number.isFinite(value) || value < 0 || value * 1000 > MAX_TIMER_MS) {
      warn(`warning: invalid hooks.intervalSeconds ${JSON.stringify(value)}; using ${HOOK_INTERVAL_DEFAULT}s`)
      value = HOOK_INTERVAL_DEFAULT
    }
    // 0 是暂停：不 drain，但 ~1s 后回来看一次，改回正数不需要重启。
    return value === 0
      ? { delay: PAUSE_RECHECK_MS, paused: true }
      : { delay: value * 1000, paused: false }
  }

  const schedule = () => {
    if (stopped) {
      finish()
      return
    }
    const { delay, paused } = plan()
    if (!paused) {
      void drainOnce().finally(() => {
        if (stopped) return
        timer = setTimeout(schedule, delay)
        if (unref) timer.unref?.()
      })
      return
    }
    timer = setTimeout(schedule, delay)
    if (unref) timer.unref?.()
  }

  // 先 drain 一次：服务停着期间的事件不能等一个完整间隔。
  schedule()

  return {
    drainOnce,
    done,
    stop() {
      if (stopped) return done
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      if (inflight === undefined) finish()
      return done
    },
  }
}
