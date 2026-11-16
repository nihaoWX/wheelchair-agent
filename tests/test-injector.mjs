#!/usr/bin/env node
/**
 * tests/test-injector.mjs：后台结果注入器的可跑证据。
 *
 * 假依赖部分（`fakeQueue`）覆盖：
 *   - 挂载时已在 outbox 里的旧结果既不消费也不注入（新会话不重放积压）；
 *   - 还没有 agent 时什么都不消费，agent 出现后补投；
 *   - reply / notice 注入一次，acknowledgement 永不消费；同一 tick 的两条结果都投递；
 *   - 先消费、再注入的顺序，以及「消费失败一次后下一轮仍能投递」；
 *   - 两个注入器抢同一批文件时每条只注入一次（靠 consumeMessage 的返回值去重）；
 *   - 同一个 `id` 被重发时只消费、不重复注入；
 *   - stop() 之后不再消费，包括停在一个已经读了一半的 tick 上。
 *
 * 真文件系统部分（`testRealFilesystem`）用 `src/shared/queue.js` 的 `writeMessage` 与
 * `src/spv/outbox.js` 的 `unreadMessages` / `consumeMessage` 走一遍：挂载前的旧消息留在 outbox/，
 * 挂载后的新消息被搬进 outbox/read/ 并注入一次。
 *
 * 负断言不用固定 sleep 等「什么都没发生」，而是等注入器真的又跑过一轮（tick / read 计数），
 * 所以空转的注入器不会让断言假通过。
 *
 * 用法：node tests/test-injector.mjs（任一断言失败则 exit 1）
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { dirsOf, ensureDirs, writeMessage } from '../src/shared/queue.js'
import { consumeMessage, unreadMessages } from '../src/spv/outbox.js'
import { MAX_BODY_CHARS, formatResult, startResultInjector } from '../src/spv/injector.js'

/** 测试用的 tick 间隔：足够快，又能让「多跑几轮」的等待保持在毫秒级。 */
const INTERVAL_MS = 20
const TIMEOUT_MS = 2000

// The injector re-reads the panel settings (default state dir) on every tick. Pin that directory to a
// fresh one, so a real `~/.dsh/state/superagent/panel-settings.json` with custom templates/limits can
// never change the injected text these cases assert; restore it when the suite ends.
const HERMETIC_STATE = await mkdtemp(join(tmpdir(), 'wheelchair-agent-injector-state-'))
const SAVED_STATE_DIR = process.env.DSH_SUPERAGENT_STATE_DIR
process.env.DSH_SUPERAGENT_STATE_DIR = HERMETIC_STATE
// Same for our own data root: settings live there now, and the legacy state dir is only a fallback.
const SAVED_HOME = process.env.WHEELCHAIR_AGENT_HOME
process.env.WHEELCHAIR_AGENT_HOME = join(HERMETIC_STATE, 'data')

/**
 * 一套假依赖：outbox 是可变数组，`unread` 记读取次数（证明「真的又跑了一轮」），`consume` 按
 * consumeMessage 的新契约返回 id 或 undefined，`inject` 记录目标 / 文本 / 消息，`events` 记调用顺序。
 *
 * `state.gate` 可以卡住下一次 `unread`：读计数先增加，然后等 gate resolve 才返回列表，用来构造
 * 「tick 已经读到一半」的时序（停掉注入器、或让两条结果落在同一批里）。
 */
function fakeQueue() {
  const dirs = {
    root: '/fake/spv',
    pending: '/fake/spv/pending',
    done: '/fake/spv/done',
    outbox: '/fake/spv/outbox',
    read: '/fake/spv/outbox/read',
  }
  const state = {
    messages: [],
    agent: undefined,
    consumed: [],
    injected: [],
    warnings: [],
    events: [],
    reads: 0,
    agentChecks: 0,
    gate: undefined,
  }

  const unread = async () => {
    state.reads += 1
    if (state.gate !== undefined) {
      const release = state.gate
      state.gate = undefined
      await release
    }
    return state.messages.map(message => ({ ...message }))
  }

  const consume = async (_dirs, message) => {
    // 与 consumeMessage 的新契约一致：只有真正搬走文件的那次调用返回 id。
    if (!state.messages.some(item => item.file === message.file)) return undefined
    state.messages = state.messages.filter(item => item.file !== message.file)
    state.consumed.push(message.file)
    state.events.push(`consume:${message.file}`)
    return message.id
  }

  const inject = (agent, text, message) => {
    state.injected.push({ agent, text, message })
    state.events.push(`inject:${message.file}`)
  }

  // 没有 agent 的 tick 不读 outbox，所以 getAgent 被调用就是「tick 真的跑过」的信号。
  const getAgent = () => {
    state.agentChecks += 1
    return state.agent
  }

  const logger = { warn: (...args) => state.warnings.push(args.join(' ')) }

  const start = (extra = {}) =>
    startResultInjector({ dirs, getAgent, inject, logger, intervalMs: INTERVAL_MS, unread, consume, ...extra })

  return { dirs, state, unread, consume, inject, getAgent, logger, start }
}

/** 一条假 outbox 消息；`file` 与真实队列里的路径形状一致。 */
function outboxMessage(name, kind, text, extra = {}) {
  return { id: name.replace(/\.json$/, ''), file: join('/fake/spv/outbox', name), kind, text, thread: 't1', ...extra }
}

/** 轮询等待一个条件成立；超时即断言失败。 */
async function waitFor(predicate, label, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** 等注入器真的又跑过 n 个 tick（没有 agent 时唯一可观察的「tick 发生过」信号）。 */
async function waitForTicks(state, count) {
  const target = state.agentChecks + count
  await waitFor(() => state.agentChecks >= target, `${count} more injector tick(s)`)
}

/** 等注入器真的又多读了 n 次 outbox（有 agent 时用来证明「又跑了一轮，仍什么都没发生」）。 */
async function waitForReads(state, count) {
  const target = state.reads + count
  await waitFor(() => state.reads >= target, `${count} more outbox read(s)`)
}

/** 同 `waitFor`，但谓词可以 await（例如要 readdir 一次真实目录）。 */
async function waitForAsync(predicate, label, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** 给「停止后不再发生任何事」用：停掉的注入器按设计不再产生可观察信号，只能等一小段时间。 */
const settle = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------- scenarios

/** (a)(b)(c)(f)：基线、没有 agent 时不消费、之后补投、后续 tick 不重复。 */
async function testBaselineAndNoAgent() {
  const q = fakeQueue()
  const existing = outboxMessage('a-existing.json', 'reply', '旧结果，属于更早的会话', { ticketId: 'tk-old' })
  q.state.messages = [existing]
  let stop
  try {
    stop = q.start()
    const early = outboxMessage('b-early.json', 'reply', '还没有会话时到达的答复', { ticketId: 'tk-1' })
    q.state.messages = [existing, early]

    // 没有 agent：等注入器真的跑过三轮，仍然什么都不该发生。
    await waitForTicks(q.state, 3)
    assert.deepEqual(q.state.consumed, [], 'nothing may be consumed while no agent exists')
    assert.deepEqual(q.state.injected, [], 'nothing may be injected while no agent exists')
    assert.ok(q.state.messages.some(item => item.file === existing.file), 'the pre-existing result stays in the outbox')

    q.state.agent = { id: 'fake-agent' }
    await waitFor(() => q.state.injected.length === 1, 'the post-mount reply to be injected once')
    assert.deepEqual(q.state.consumed, [early.file], 'only the message newer than the baseline is consumed')
    assert.equal(q.state.injected[0].agent, q.state.agent, 'the result is handed to the session agent')
    assert.match(
      q.state.injected[0].text,
      /^\[spv\] reply on thread "t1" \(ticket tk-1\):$/m,
      'the injected text names the kind, the thread and the ticket',
    )
    assert.ok(q.state.injected[0].text.includes('还没有会话时到达的答复'), 'the injected text carries the body')

    // 挂载前的旧结果既没被消费，也没被注入，还留在 outbox 里。
    assert.ok(!q.state.consumed.includes(existing.file), 'a result that pre-dates the mount is never consumed')
    assert.ok(!q.state.injected.some(item => item.message.file === existing.file), 'a result that pre-dates the mount is never injected')

    // 后续 tick 不重复注入同一条。
    await waitForReads(q.state, 2)
    assert.equal(q.state.injected.length, 1, 'a later tick must not inject the same result again')
    assert.equal(q.state.consumed.length, 1)
  } finally {
    stop?.()
  }
}

/** (d)(e)：notice 也注入，acknowledgement 永不消费。 */
async function testNoticeAndAcknowledgement() {
  const q = fakeQueue()
  q.state.agent = { id: 'fake-agent' }
  let stop
  try {
    stop = q.start()
    await waitForTicks(q.state, 1)

    const notice = outboxMessage('n-notice.json', 'notice', '需要操作者决定用哪个端口', { ticketId: 'tk-2' })
    q.state.messages = [notice]
    await waitFor(() => q.state.injected.length === 1, 'the notice to be injected')
    assert.match(
      q.state.injected[0].text,
      /^\[spv\] notice on thread "t1" \(ticket tk-2\):$/m,
      'a notice header names the kind and thread, not a cause',
    )
    assert.ok(q.state.injected[0].text.includes('需要操作者决定用哪个端口'), 'a notice carries the body too')

    const ack = outboxMessage('k-ack.json', 'acknowledgement', '接单了', { ticketId: 'tk-3' })
    q.state.messages = [ack]
    await waitForReads(q.state, 2)
    assert.equal(q.state.injected.length, 1, 'an acknowledgement is not a result')
    assert.ok(!q.state.consumed.includes(ack.file), 'an acknowledgement is never consumed')
    assert.ok(q.state.messages.some(item => item.file === ack.file), 'the acknowledgement stays in the outbox')
    assert.deepEqual(q.state.warnings, [], 'a healthy run logs no warning')
  } finally {
    stop?.()
  }
}

/** 同一 tick 里的 reply + notice 都要投递。 */
async function testTwoResultsInOneTick() {
  const q = fakeQueue()
  q.state.agent = { id: 'fake-agent' }
  let stop
  try {
    stop = q.start()
    await waitForTicks(q.state, 1)

    // 卡住下一次读取，确保两条消息出现在注入器读到的同一批里。
    let release
    q.state.gate = new Promise(resolve => { release = resolve })
    const reply = outboxMessage('r-one.json', 'reply', '第一条答复')
    const notice = outboxMessage('n-two.json', 'notice', '第二条需要决策')
    q.state.messages = [reply, notice]
    await waitForReads(q.state, 1) // 这一轮已经进入 unread 并卡在 gate 上
    release()

    await waitFor(() => q.state.injected.length === 2, 'both results from one tick')
    assert.deepEqual(q.state.consumed.sort(), [notice.file, reply.file].sort(), 'both results are consumed')
    assert.equal(q.state.injected.length, 2, 'both results are injected')
  } finally {
    stop?.()
  }
}

/** 必须先消费、再注入。 */
async function testConsumeBeforeInject() {
  const q = fakeQueue()
  q.state.agent = { id: 'fake-agent' }
  let stop
  try {
    stop = q.start()
    await waitForTicks(q.state, 1)
    const reply = outboxMessage('o-order.json', 'reply', '顺序')
    q.state.messages = [reply]
    await waitFor(() => q.state.injected.length === 1, 'the ordered reply')
    assert.deepEqual(
      q.state.events,
      [`consume:${reply.file}`, `inject:${reply.file}`],
      'consume must happen before inject',
    )
  } finally {
    stop?.()
  }
}

/** 一次消费失败只影响那一条：记 warn，继续处理下一条，下一轮再试失败的那条。 */
async function testConsumeFailureRecovers() {
  const q = fakeQueue()
  let failOnce = true
  const flakyConsume = async (dirs, message) => {
    if (failOnce) {
      failOnce = false
      throw new Error('simulated rename failure')
    }
    return q.consume(dirs, message)
  }
  q.state.agent = { id: 'fake-agent' }
  let stop
  try {
    stop = q.start({ consume: flakyConsume })
    await waitForTicks(q.state, 1)
    const reply = outboxMessage('f-flaky.json', 'reply', '一次消费失败后仍要投递')
    const later = outboxMessage('g-later.json', 'reply', '后面的结果不能被前面卡死')
    q.state.messages = [reply, later]

    await waitFor(() => q.state.injected.length === 2, 'both results after a transient consume failure')
    assert.ok(
      q.state.warnings.some(line => line.includes(`could not consume ${basename(reply.file)}`)),
      'the consume failure is logged with the message name',
    )
    assert.deepEqual(q.state.consumed.sort(), [later.file, reply.file].sort(), 'the failed message is retried on a later tick')
    assert.equal(q.state.injected.length, 2)
  } finally {
    stop?.()
  }
}

/** stop() 停在一个已经读到一半的 tick 上：不再消费，也不再注入。 */
async function testStopWithInFlightTick() {
  const q = fakeQueue()
  q.state.agent = { id: 'fake-agent' }
  let stop
  try {
    stop = q.start()
    await waitForTicks(q.state, 1)

    let release
    q.state.gate = new Promise(resolve => { release = resolve })
    const reply = outboxMessage('i-inflight.json', 'reply', '停掉时正在读的消息')
    q.state.messages = [reply]
    await waitForReads(q.state, 1) // 这一轮已经进入 unread，卡在 gate 上
    stop()
    stop = undefined
    release()

    await settle()
    assert.deepEqual(q.state.consumed, [], 'a stopped injector must not consume')
    assert.deepEqual(q.state.injected, [], 'a stopped injector must not inject')
    assert.ok(q.state.messages.some(item => item.file === reply.file), 'the message is left in the outbox')
  } finally {
    stop?.()
  }
}

/** 两个注入器抢同一批文件：每条结果总共只注入一次。 */
async function testTwoConsumers() {
  const q = fakeQueue()
  q.state.agent = { id: 'fake-agent' }
  const first = []
  const second = []
  let stopFirst
  let stopSecond
  try {
    const startWith = sink =>
      q.start({
        inject: (agent, text, message) => { sink.push({ agent, text, message }) },
      })
    stopFirst = startWith(first)
    stopSecond = startWith(second)
    // 两个基线都在挂载时取过（列表为空）；再放两条结果让两个注入器去抢。
    await waitFor(() => q.state.agentChecks >= 2, 'both injectors to have ticked once')
    const reply = outboxMessage('m-reply.json', 'reply', '只能投递一次的答复')
    const notice = outboxMessage('n-notice.json', 'notice', '只能投递一次的通知')
    q.state.messages = [reply, notice]

    await waitFor(() => first.length + second.length === 2, 'the two results to be injected exactly once in total')
    await waitForReads(q.state, 2)
    assert.equal(first.length + second.length, 2, 'each result is injected once in total, not once per consumer')
    assert.deepEqual(
      [...first, ...second].map(item => item.message.file).sort(),
      [reply.file, notice.file].sort(),
      'both results were delivered',
    )
    assert.equal(q.state.consumed.length, 2, 'each result was consumed exactly once')
  } finally {
    stopFirst?.()
    stopSecond?.()
  }
}

/** 真文件系统：挂载前的消息留在 outbox/，挂载后的消息进 outbox/read/ 并注入一次。 */
async function testRealFilesystem() {
  const root = await mkdtemp(join(tmpdir(), 'wheelchair-agent-injector-'))
  const dirs = dirsOf(root)
  const injected = []
  const state = { ticks: 0 }
  let stop
  try {
    await ensureDirs(dirs)
    await writeMessage(dirs, { id: 'old-reply', thread: 't1', kind: 'reply', text: '旧结果', ticketId: 'tk-old' })
    await writeMessage(dirs, { id: 'old-ack', thread: 't1', kind: 'acknowledgement', text: '接单了' })

    stop = startResultInjector({
      dirs,
      getAgent: () => {
        state.ticks += 1
        return { id: 'real-agent' }
      },
      inject: (agent, text, message) => injected.push({ agent, text, message }),
      logger: { warn: () => {} },
      intervalMs: INTERVAL_MS,
    })
    // 等第一个 tick 真的跑过：能走到 getAgent，说明挂载时的真实 readdir 基线已经读完。
    // 用 tick 计数而不是固定 sleep，顺序才是可证明的。
    await waitFor(() => state.ticks >= 1, 'the injector to take its baseline')
    assert.deepEqual(await readdir(dirs.read).catch(() => []), [], 'the baseline consumes nothing')
    assert.deepEqual((await readdir(dirs.outbox)).sort(), ['old-ack.json', 'old-reply.json'], 'the baseline leaves both old messages in outbox/')

    await writeMessage(dirs, { id: 'fresh-reply', thread: 't1', kind: 'reply', text: '新结果正文', ticketId: 'tk-1' })

    await waitFor(() => injected.length === 1, 'the fresh reply to be injected')
    const outboxNames = await readdir(dirs.outbox)
    assert.ok(outboxNames.includes('old-reply.json'), 'the pre-mount reply stays in outbox/')
    assert.ok(outboxNames.includes('old-ack.json'), 'the acknowledgement stays in outbox/')
    assert.ok(!outboxNames.includes('fresh-reply.json'), 'the fresh reply left outbox/')
    assert.deepEqual(await readdir(dirs.read), ['fresh-reply.json'], 'only the fresh reply was consumed')
    assert.match(injected[0].text, /^\[spv\] reply on thread "t1" \(ticket tk-1\):$/m)
    assert.ok(injected[0].text.includes('新结果正文'), 'the injected text carries the body')

    // 直接验证消费原语的新契约：第一次返回 id，第二次返回 undefined（另一个读者抢先）。
    stop()
    stop = undefined
    const remaining = await unreadMessages(dirs)
    const old = remaining.find(message => message.id === 'old-reply')
    assert.ok(old !== undefined, 'the pre-mount reply is still unread')
    assert.equal(await consumeMessage(dirs, old), 'old-reply', 'the first consumer gets the id')
    assert.equal(await consumeMessage(dirs, old), undefined, 'a second consumer gets undefined')
  } finally {
    stop?.()
    await rm(root, { recursive: true, force: true })
  }
}

/** 同一个 id 被重发：消费掉它，但 `outbox/read/` 里已有同名副本，所以不再注入。 */
async function testDuplicateRedelivery() {
  const root = await mkdtemp(join(tmpdir(), 'wheelchair-agent-injector-dup-'))
  const dirs = dirsOf(root)
  const injected = []
  const state = { ticks: 0 }
  let stop
  try {
    await ensureDirs(dirs)
    stop = startResultInjector({
      dirs,
      getAgent: () => {
        state.ticks += 1
        return { id: 'real-agent' }
      },
      inject: (agent, text, message) => injected.push({ agent, text, message }),
      logger: { warn: () => {} },
      intervalMs: INTERVAL_MS,
    })
    await waitFor(() => state.ticks >= 1, 'the injector to take its baseline')

    const result = { id: 'repeat-reply', thread: 't1', kind: 'reply', text: '第一次投递', ticketId: 'tk-1' }
    await writeMessage(dirs, result)
    await waitFor(() => injected.length === 1, 'the first delivery')
    assert.deepEqual(await readdir(dirs.read), ['repeat-reply.json'], 'the first delivery is consumed')

    // 服务重发同一个 id：outbox/repeat-reply.json 又出现，outbox/read/ 里已经有上次投递的副本。
    await writeMessage(dirs, { ...result, text: '同一个 id 的重发' })
    // 只看待处理的 .json：outbox/read/ 是消费后总会留下的子目录。
    const pendingNames = async () => (await readdir(dirs.outbox)).filter(name => name.endsWith('.json'))
    await waitForAsync(async () => (await pendingNames()).length === 0, 'the duplicate to be consumed')
    assert.deepEqual(await pendingNames(), [], 'the duplicate is consumed and leaves nothing pending')
    assert.equal(injected.length, 1, 'a same-id redelivery must not be injected twice')
    assert.deepEqual(await readdir(dirs.read), ['repeat-reply.json'], 'the duplicate is consumed, not piled up')
  } finally {
    stop?.()
    await rm(root, { recursive: true, force: true })
  }
}

/** (g)：空正文标记、工单号、超长正文截断与完整文件指针。 */
function testFormatResult() {
  const empty = formatResult({ kind: 'reply', thread: 't9', ticketId: 'tk-9', text: '   \n' })
  assert.ok(empty.includes('(ticket tk-9)'), 'formatResult includes the ticket when present')
  assert.ok(empty.endsWith('(empty message)'), 'formatResult marks an empty body')

  const noticeNoTicket = formatResult({ kind: 'notice', thread: 't9', text: '停了' })
  assert.ok(!noticeNoTicket.includes('ticket'), 'formatResult omits the ticket parenthetical when absent')
  assert.match(noticeNoTicket, /^\[spv\] notice on thread "t9":$/m)

  const long = 'x'.repeat(MAX_BODY_CHARS + 50)
  const truncated = formatResult({ kind: 'reply', thread: 't9', text: long }, { read: '/tmp/spv/outbox/read/big.json' })
  assert.ok(
    truncated.includes(`[truncated after ${MAX_BODY_CHARS} characters; full message: /tmp/spv/outbox/read/big.json]`),
    'a long body is truncated and points at the consumed file',
  )
  assert.ok(!truncated.includes(long), 'the full body does not reach the session')

  // 截断按码点计算：正好跨在边界上的 emoji 必须完整保留，不能留下孤立代理项。
  const emoji = '😀'
  const straddling = `${'a'.repeat(MAX_BODY_CHARS - 1)}${emoji}${'b'.repeat(10)}`
  const cut = formatResult({ kind: 'reply', thread: 't9', text: straddling }, { read: '/tmp/spv/outbox/read/emoji.json' })
  assert.ok(
    cut.includes(`[truncated after ${MAX_BODY_CHARS} characters; full message: /tmp/spv/outbox/read/emoji.json]`),
    'the code-point truncation keeps the marker and pointer',
  )
  assert.ok(cut.includes(`${'a'.repeat(MAX_BODY_CHARS - 1)}${emoji}`), 'an emoji straddling the boundary survives intact')
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), 'truncation leaves no lone high surrogate')
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), 'truncation leaves no lone low surrogate')
}

/** stop() 之后不再消费、不再注入。 */
async function testStop() {
  const q = fakeQueue()
  q.state.agent = { id: 'fake-agent' }
  let stop
  try {
    stop = q.start()
    await waitForTicks(q.state, 2)
    stop()
    stop = undefined
    const reply = outboxMessage('s-after-stop.json', 'reply', '停止后的答复')
    q.state.messages = [reply]
    await settle()
    assert.deepEqual(q.state.consumed, [], 'a stopped injector consumes nothing')
    assert.deepEqual(q.state.injected, [], 'a stopped injector injects nothing')
  } finally {
    stop?.()
  }
}

// ------------------------------------------------------------------- main

try {
  await testBaselineAndNoAgent()
  await testNoticeAndAcknowledgement()
  await testTwoResultsInOneTick()
  await testConsumeBeforeInject()
  await testConsumeFailureRecovers()
  await testStopWithInFlightTick()
  await testTwoConsumers()
  await testRealFilesystem()
  await testDuplicateRedelivery()
  testFormatResult()
  await testStop()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.message ?? error}\n`)
  process.exitCode = 1
} finally {
  if (SAVED_STATE_DIR === undefined) delete process.env.DSH_SUPERAGENT_STATE_DIR
  else process.env.DSH_SUPERAGENT_STATE_DIR = SAVED_STATE_DIR
  if (SAVED_HOME === undefined) delete process.env.WHEELCHAIR_AGENT_HOME
  else process.env.WHEELCHAIR_AGENT_HOME = SAVED_HOME
  await rm(HERMETIC_STATE, { recursive: true, force: true })
}
