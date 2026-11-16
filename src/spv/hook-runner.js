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
 * 纯 Node builtins：不 import dsh，不 `process.exit`。
 */
import { dirsOf } from '../shared/queue.js'
import {
  HOOK_INTERVAL_DEFAULT,
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
 * - `drainOnce()`：spool 先、队列后，串行执行；任何一条失败只记日志，不影响下一条。
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
    }
  }

  const drainOnce = async () => {
    if (inflight !== undefined) return inflight
    inflight = (async () => {
      try {
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
