/**
 * 后台结果注入器：已删除的阻塞式结果工具的非阻塞替代品。
 *
 * 为什么不是工具：阻塞式工具把「等 worker」变成模型的一次工具调用，于是它必须选一个超时、在超时后猜是
 * 「没跑完」还是「失败了」，而 worker 的耗时本来就没有上限。改成注入后没有超时、没有轮询、也没有需要模型
 * 主动调用的读取动作：结果到了就作为一条新消息推进对话，没到就不占回合。
 *
 * 数据来源：superagent 的 `spv` Channel 把回信一条一个 `.json` 写在 `<queue>/outbox/`。本文件只做四件事：
 *   1. 挂载时取基线：此刻已在 outbox 里的消息属于更早的会话，永远跳过、也永远不消费（它们仍能在
 *      `spv_status` 里看到），否则新会话一开就会重放一堆积压结果；
 *   2. 每个 tick 读一次 outbox，只认 `reply` / `notice`；`acknowledgement` 只是「接单了」，不是结果；
 *   3. 先用 `consumeMessage` 把消息 rename 进 `outbox/read/`，**再**注入。消费标记就是那次原子 rename：只有
 *      真正搬走文件的那次调用拿到 id，被别的读者抢先的调用拿到 undefined 并跳过；同一个 id 被重发时
 *      `outbox/read/` 里已有上次投递的副本，消费掉但不再注入，所以同一条结果不可能被注入两次，跨进程也成立；
 *   4. 正文超过 `MAX_BODY_CHARS` 时截断，并在注入文本末尾给出 `outbox/read/` 里那条消息的完整文件路径。
 *
 * 没有超时：插件挂着就一直等，只有插件卸载（会话关闭）才停。定时器归插件 fiber 所有——`apply` 用
 * `ctx.effect` 拿到这里返回的 stop 函数，卸载时清掉 interval；`unref()` 让一个还在等的注入器不阻止进程退出。
 *
 * stop() 之后不再开始新的消费；已经消费掉的那条仍会投递（否则结果就无处可寻）。
 *
 * 一条消息消费失败只记一条 warn 并继续下一条；注入失败同样只记 warn；读 outbox 失败也如此，下一轮重试。
 */
import { access } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
 * 依赖全部可注入（`unread` / `consume` / `inject` / `logger`），所以 `tests/test-injector.mjs` 不需要真队列。
 * `getAgent()` 返回 undefined 时**不消费**任何消息：会话还没接受过任务，此时消费等于把结果丢在没有读者的地方。
 *
 * 每次 tick 都重读面板设置（`stateDir` 可指定；`settingsOf` 是测试缝），所以改 `injection.intervalMs`、
 * 模板或正文上限都**不需要重启会话**。调度用自排的 `setTimeout` 而不是固定 `setInterval`：间隔是每轮重新
 * 取的，改小改大下一轮就生效。坏设置文件由 `resolveSettings` 自己退回默认，这里只记一条 warn。
 */
export function startResultInjector({
  dirs,
  getAgent,
  inject,
  logger = console,
  intervalMs = INJECT_INTERVAL_MS,
  settingsOf,
  stateDir,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) },
  unread = unreadMessages,
  consume = consumeMessage,
}) {
  if (typeof getAgent !== 'function') throw new Error('the spv result injector needs getAgent()')
  if (typeof inject !== 'function') throw new Error('the spv result injector needs inject(agent, text, message)')

  // 基线只在第一次**成功**读到 outbox 时确定：读失败就留给下一个 tick 重试，绝不把「读失败」当成「没有旧结果」，
  // 否则一次瞬时错误就会把整批积压结果灌进新会话。
  let baseline
  let reading
  function baselineNames() {
    if (baseline !== undefined) return Promise.resolve(baseline)
    reading ??= unread(dirs)
      .then(messages => {
        baseline = new Set(messages.map(nameOf))
        return baseline
      })
      .finally(() => { reading = undefined })
    return reading
  }
  // 挂载即取基线。失败由第一个 tick 报告并重试，这里只避免留下一个未处理的 rejection。
  baselineNames().catch(() => {})

  let busy = false
  let stopped = false
  let timer
  let lastWarning

  /** 本轮要用的设置快照：坏文件/坏注入器失败都退回内置默认，且只 warn 一次同一条原因。 */
  function currentSettings() {
    try {
      const snapshot =
        typeof settingsOf === 'function' ? settingsOf() : resolveSettings(stateDir === undefined ? {} : { stateDir })
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

  async function tick() {
    // 上一轮还没读完就不叠一轮：两个 tick 同时 rename 同一个文件只会互相添乱。
    if (busy) return
    busy = true
    try {
      const skip = await baselineNames()
      // 卸载发生在基线读取期间：不再开始任何消费。
      if (stopped) return
      // 每轮都读：模板/截断上限来自这一份快照，同一轮里所有消息用同一版本，改设置下一轮生效。
      const settings = currentSettings()
      const agent = getAgent()
      if (agent === undefined || agent === null) return
      for (const message of await unread(dirs)) {
        if (stopped) return
        if (skip.has(nameOf(message))) continue
        if (!RESULT_KINDS.has(String(message.kind))) continue
        // 同一个 id 可能被重发：outbox/ 里又出现同名文件时，`outbox/read/` 里已经有上次投递的副本。
        // 在消费之前探一下（`access` 只读，不是消费），消费后据它决定要不要再注入。
        const target = join(dirs.read, basename(String(message.file ?? '')))
        const deliveredBefore = await fileExists(target)
        let consumed
        try {
          // 先消费再注入：注入失败（会话刚好关闭）也不能让这条结果在下一轮被重新注入。
          consumed = await consume(dirs, message)
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
