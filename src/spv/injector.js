/**
 * 后台结果注入器：已删除的阻塞式结果工具的非阻塞替代品。
 *
 * 为什么不是工具：阻塞式工具把「等 worker」变成模型的一次工具调用，于是它必须选一个超时、在超时后猜是
 * 「没跑完」还是「失败了」，而 worker 的耗时本来就没有上限。改成注入后没有超时、没有轮询、也没有需要模型
 * 主动调用的读取动作：结果到了就作为一条新消息推进对话，没到就不占回合。
 *
 * 数据来源：superagent 的 `spv` Channel 把回信一条一个 `.json` 写在 `<queue>/outbox/`。「一仓一部署」之后
 * 会话可能同时要收多份部署的回信，所以 `queuesOf()` 每轮返回**所有**要监听的队列（注册表里每份部署的
 * `queueDir`，外加旧规则那个 `<stateDir>/spv`；见 `src/spv/paths.js` 的 `resolveRoots`）。本文件只做五件事：
 *   1. 挂载时取基线：每个根里此刻已在 outbox 的消息属于更早的会话，永远跳过、也永远不消费（它们仍能在
 *      `spv_status` 里看到），否则新会话一开就会重放一堆积压结果；基线按根分开记，一个根读失败只影响它自己；
 *   2. 每个 tick 读每个根的 outbox，只认 `reply` / `notice`；`acknowledgement` 只是「接单了」，不是结果；
 *   3. 先用 `consumeMessage` 把消息 rename 进那个根的 `outbox/read/`，**再**注入。消费标记就是那次原子
 *      rename：只有真正搬走文件的那次调用拿到 id，被别的读者抢先的调用拿到 undefined 并跳过；同一个 id 被
 *      重发时 `outbox/read/` 里已有上次投递的副本，消费掉但不再注入，所以同一条结果不可能被注入两次，跨进程也成立；
 *   4. 去重身份是「队列根 + 消息文件名 + thread」，不是目录、也不是单独的 thread：两个部署里同名的消息文件
 *      （甚至同名 thread）各自都是独立结果，谁也不能压掉谁；同一个根里重发的同名文件仍由上面的 read/ 检查拦住；
 *   5. 正文超过 `MAX_BODY_CHARS` 时截断，并在注入文本末尾给出 `outbox/read/` 里那条消息的完整文件路径。
 *
 * 某个根暂时不存在（那份部署还没启动）时 `unreadMessages` 读成空列表，于是直接跳过、不报错、不刷日志；
 * 每轮重新解析 `queuesOf()`，所以会话运行期间新 `deployment add` 的部署也会被接上——它第一次出现时取自己的
 * 基线，之前积压的消息不会被重放。
 *
 * 没有超时：插件挂着就一直等，只有插件卸载（会话关闭）才停。定时器归插件 fiber 所有——`apply` 用
 * `ctx.effect` 拿到这里返回的 stop 函数，卸载时清掉 interval；`unref()` 让一个还在等的注入器不阻止进程退出。
 *
 * stop() 之后不再开始新的消费；已经消费掉的那条仍会投递（否则结果就无处可寻）。
 *
 * 一条消息消费失败只记一条 warn 并继续下一条；注入失败同样只记 warn；读某个根的 outbox 失败也只记 warn 并
 * 继续别的根，下一轮重试。注册表坏掉时 `queuesOf()` 会抛错：这里保留上一轮已知的队列并只 warn 一次，绝不
 * 因为一次坏读就把所有部署的结果静默丢掉。
 */
import { access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { dirsOf } from '../shared/queue.js'
import { KEY_SPECS, defaultSettings, renderTemplate, resolveSettings } from '../shared/settings.js'
import { RESULT_KINDS, consumeMessage, threadOf, unreadMessages } from './outbox.js'

/**
 * 轮询间隔（毫秒）。outbox 是本地目录，1s 足够；结果不是实时数据，再快也没有收益。
 * 默认值来自 `src/shared/settings.js` 的 `KEY_SPECS`，面板默认值与消费者不再各写一份。
 */
export const INJECT_INTERVAL_MS = KEY_SPECS['injection.intervalMs'].default

/** 注入正文的上限：再长的答复会挤占会话上下文，完整内容留在 outbox/read/ 的文件里（来源同上）。 */
export const MAX_BODY_CHARS = KEY_SPECS['injection.maxBodyChars'].default

/** 面板设置里 `injection.intervalMs` 的下限（`setTimeout` 再快只会空转）。 */
const MIN_INTERVAL_MS = 50

/** 设置快照里的注入间隔；坏值退回今天的 1s，绝不把轮询停掉。 */
function intervalOf(settings, fallback = INJECT_INTERVAL_MS) {
  const value = Number(settings?.effective?.['injection.intervalMs'])
  return Number.isFinite(value) && value >= MIN_INTERVAL_MS ? value : fallback
}

/** 设置快照里的正文上限；坏值退回今天的 12000。 */
function bodyLimitOf(settings) {
  const value = Number(settings?.effective?.['injection.maxBodyChars'])
  return Number.isInteger(value) && value >= 1 ? value : MAX_BODY_CHARS
}

/**
 * 一条结果在会话里的样子：线程、种类、正文，有工单号时带上它。
 *
 * 文本由面板设置里的 `injection` 模板渲染；不传 `settings` 时用内置默认，所以老调用点（与老测试）的输出
 * 逐字节不变。`reply` 与 `notice` 的正文都跟在下一行。`notice` 现在也承载操作者对 SPV 决策的质疑，所以
 * 头部只报种类与线程，不再断言原因（那会对一半的消息说错）。正文为空时明写 `(empty message)`，否则一条
 * 空消息看起来像注入器自己出了故障。正文超过 `injection.maxBodyChars` 时截断，`options.read` 是已消费
 * 消息的文件路径，截断标记会指向它（完整内容就在那里）。
 */
export function formatResult(message, { read, settings } = {}) {
  const snapshot = settings ?? defaultSettings()
  const limit = bodyLimitOf(snapshot)
  const thread = threadOf(message)
  const ticket = message.ticketId ? ` (ticket ${message.ticketId})` : ''
  let body = String(message.text ?? '').trim()
  // 按 Unicode 码点计数再截断：`slice` 按 UTF-16 码元切，正好落在 emoji 的代理对中间会留下孤立代理项。
  const chars = Array.from(body)
  if (chars.length > limit) {
    const where = read === undefined ? '' : `; full message: ${read}`
    body = `${chars.slice(0, limit).join('')}\n[truncated after ${limit} characters${where}]`
  }
  const template = snapshot?.templates?.injection?.text ?? defaultSettings().templates.injection.text
  return renderTemplate('injection', template, {
    kind: String(message.kind),
    thread,
    ticket,
    body: body === '' ? '(empty message)' : body,
  })
}

/** 消息文件的 basename：基线按文件名记，`id` 只作兜底（真实消息两者都有）。 */
function nameOf(message) {
  return basename(String(message?.file ?? message?.id ?? ''))
}

/**
 * 一条消息的去重身份：队列根 + 文件名 + thread。
 *
 * 必须带根：两个部署里各有一条 `outbox/same.json`（甚至同一个 thread 名）是两条独立结果，只按目录或只按
 * thread 去重会让后一条永远收不到。同一个根里的重复投递仍由 `outbox/read/` 的同名副本拦住。
 */
function identityOf(queue, message) {
  return [queue.root || queue.dirs.outbox, nameOf(message), threadOf(message)].join('\u0000')
}

/** `outbox/read/` 里已有这个文件吗？`access` 失败（通常是 ENOENT）一律当不存在。 */
async function fileExists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/**
 * 启动注入器，返回 stop 函数（由插件 fiber 持有）。
 *
 * `queues` / `dirs` 是固定监听目标；`queuesOf()` 则每轮重新解析（生产用法），这样会话运行期间新增的部署也会
 * 被接上。依赖全部可注入（`unread` / `consume` / `inject` / `logger`），所以测试不需要真队列。
 * `getAgent()` 返回 undefined 时**不消费**任何消息：会话还没接受过任务，此时消费等于把结果丢在没有读者的地方。
 *
 * 每次 tick 都重读面板设置（`home` / `stateDir` 可指定；`settingsOf` 是测试缝），所以改 `injection.intervalMs`、
 * 模板或正文上限都**不需要重启会话**。调度用自排的 `setTimeout` 而不是固定 `setInterval`：间隔是每轮重新
 * 取的，改小改大下一轮就生效。坏设置文件由 `resolveSettings` 自己退回默认，这里只记一条 warn。
 */
export function startResultInjector({
  dirs,
  queues,
  queuesOf,
  getAgent,
  inject,
  logger = console,
  intervalMs = INJECT_INTERVAL_MS,
  settingsOf,
  home,
  stateDir,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) },
  unread = unreadMessages,
  consume = consumeMessage,
}) {
  if (typeof getAgent !== 'function') throw new Error('the spv result injector needs getAgent()')
  if (typeof inject !== 'function') throw new Error('the spv result injector needs inject(agent, text, message)')

  /** 一个监听目标：`root` 参与去重身份，`dirs` 是那根队列的固定布局。 */
  function targetOf(item) {
    if (item?.dirs !== undefined) {
      return {
        project: item.project ?? null,
        root: String(item.root ?? item.dirs.root ?? item.dirs.outbox ?? ''),
        dirs: item.dirs,
      }
    }
    const root = String(item?.root ?? '')
    if (root === '') throw new Error('the spv result injector needs { root } or { dirs } for every queue')
    return { project: item.project ?? null, root, dirs: dirsOf(root) }
  }

  const fixed =
    queues !== undefined
      ? queues.map(targetOf)
      : dirs !== undefined
        ? [targetOf({ dirs })]
        : undefined
  if (fixed === undefined && typeof queuesOf !== 'function') {
    throw new Error('the spv result injector needs dirs, queues or queuesOf()')
  }

  let known = fixed ?? []
  let refreshWarning

  /** 每轮重新问一次要监听哪些根；注册表坏掉时保留上一轮，只 warn 一次同一条原因。 */
  function refreshQueues() {
    if (fixed !== undefined) return fixed
    try {
      known = queuesOf().map(targetOf)
    } catch (error) {
      const message = `[spv] the result injector could not resolve deployment queues: ${error?.message ?? error}`
      if (message !== refreshWarning) {
        refreshWarning = message
        logger?.warn?.(message)
      }
    }
    return known
  }

  // 每个根各自的基线：`Map<root, { skip, reading }>`。分开记，一个根的新消息不会因为另一个根读过而被跳过。
  const baselines = new Map()

  function baselineNames(queue) {
    const key = queue.root || queue.dirs.outbox
    let slot = baselines.get(key)
    if (slot === undefined) {
      slot = { skip: undefined, reading: undefined }
      baselines.set(key, slot)
    }
    if (slot.skip !== undefined) return Promise.resolve(slot.skip)
    slot.reading ??= unread(queue.dirs)
      .then(messages => {
        slot.skip = new Set(messages.map(message => identityOf(queue, message)))
        return slot.skip
      })
      .finally(() => { slot.reading = undefined })
    return slot.reading
  }

  // 挂载即取基线。失败由第一个 tick 报告并重试，这里只避免留下一个未处理的 rejection。
  for (const queue of known) baselineNames(queue).catch(() => {})

  let busy = false
  let stopped = false
  let timer
  let lastWarning

  /** 本轮要用的设置快照：坏文件/坏注入器失败都退回内置默认，且只 warn 一次同一条原因。 */
  function currentSettings() {
    try {
      const snapshot =
        typeof settingsOf === 'function' ? settingsOf() : resolveSettings({ home, stateDir })
      if (snapshot?.warning !== undefined && snapshot.warning !== lastWarning) {
        lastWarning = snapshot.warning
        logger?.warn?.(`[spv] panel settings ignored: ${snapshot.warning}`)
      }
      return snapshot
    } catch (error) {
      const message = `[spv] panel settings could not be read: ${error?.message ?? error}`
      if (message !== lastWarning) {
        lastWarning = message
        logger?.warn?.(message)
      }
      return defaultSettings()
    }
  }

  /** 读一个根的 outbox；失败只影响这个根，别的部署的回信照常处理。 */
  async function readQueue(queue) {
    try {
      return await unread(queue.dirs)
    } catch (error) {
      logger?.warn?.(
        `[spv] the result injector could not read the outbox at ${queue.root}: ${error?.message ?? error}`,
      )
      return undefined
    }
  }

  async function tick() {
    // 上一轮还没读完就不叠一轮：两个 tick 同时 rename 同一个文件只会互相添乱。
    if (busy) return
    busy = true
    try {
      const queues = refreshQueues()
      // 先把每个根的基线填上：新出现的部署从它第一次被看到的那一刻开始算新消息，不重放积压结果。
      const skipByQueue = new Map()
      await Promise.all(
        queues.map(async queue => {
          try {
            skipByQueue.set(queue, await baselineNames(queue))
          } catch (error) {
            logger?.warn?.(
              `[spv] the result injector could not read the outbox at ${queue.root}: ${error?.message ?? error}`,
            )
          }
        }),
      )
      // 卸载发生在基线读取期间：不再开始任何消费。
      if (stopped) return
      // 每轮都读：模板/截断上限来自这一份快照，同一轮里所有消息用同一版本，改设置下一轮生效。
      const settings = currentSettings()
      const agent = getAgent()
      if (agent === undefined || agent === null) return
      for (const queue of queues) {
        if (stopped) return
        const skip = skipByQueue.get(queue)
        // 这个根的基线没读到（权限错误等）：本轮跳过它，下一轮重试，别的根继续。
        if (skip === undefined) continue
        const messages = await readQueue(queue)
        if (messages === undefined) continue
        for (const message of messages) {
          if (stopped) return
          if (skip.has(identityOf(queue, message))) continue
          if (!RESULT_KINDS.has(String(message.kind))) continue
          // 同一个 id 可能被重发：outbox/ 里又出现同名文件时，`outbox/read/` 里已经有上次投递的副本。
          // 在消费之前探一下（`access` 只读，不是消费），消费后据它决定要不要再注入。
          const target = join(queue.dirs.read, basename(String(message.file ?? '')))
          const deliveredBefore = await fileExists(target)
          let consumed
          try {
            // 先消费再注入：注入失败（会话刚好关闭）也不能让这条结果在下一轮被重新注入。
            consumed = await consume(queue.dirs, message)
          } catch (error) {
            // 一个坏文件不能饿死后面的结果：记一条 warn，继续处理下一条。
            logger?.warn?.(`[spv] could not consume ${nameOf(message)}: ${error?.message ?? error}`)
            continue
          }
          // 另一个读者先搬走了它：这不是本次消费，绝不能再注入第二次。
          if (consumed === undefined) continue
          // 同名副本已经投递过（同一个 id 的重发）：消费掉，但不再注入。
          if (deliveredBefore) continue
          try {
            inject(agent, formatResult(message, { read: target, settings }), message)
          } catch (error) {
            logger?.warn?.(`[spv] the result injector could not hand over ${nameOf(message)}: ${error?.message ?? error}`)
          }
        }
      }
    } catch (error) {
      logger?.warn?.(`[spv] the result injector could not read the outbox: ${error?.message ?? error}`)
    } finally {
      busy = false
    }
  }

  // 自排定时器：每一轮结束后重新取间隔，所以面板改 injection.intervalMs 无需重启。
  //
  // 显式传入非默认的 `intervalMs` 是旧调用点的测试缝（老测试用它把间隔压到 20ms），优先级最高；生产调用
  // 不传，间隔就完全由设置快照决定。
  const explicit = Number(intervalMs)
  const legacyInterval =
    Number.isFinite(explicit) && explicit >= 1 && explicit !== INJECT_INTERVAL_MS ? explicit : undefined
  const schedule = () => {
    if (stopped) return
    const delay = legacyInterval ?? intervalOf(currentSettings())
    timer = timers.setTimeout(() => {
      void tick().finally(schedule)
    }, delay)
    timer?.unref?.()
  }
  schedule()

  return () => {
    stopped = true
    if (timer !== undefined) timers.clearTimeout(timer)
  }
}
