/**
 * 多部署结果回收与 status 的测试（#42 收尾）。
 *
 * 覆盖的不变量：
 *   - 两份部署各放一条回信，两条都被注入，各一次，顺序按项目稳定；
 *   - 两个部署里出现同名消息文件、同名 thread，也不会互相压掉（去重身份带队列根）；
 *   - 某份部署的队列目录不存在时不抛错、不刷日志，别的部署照常；
 *   - `$SPV_QUEUE_DIR` 仍然只监听那一条，注册表不参与；
 *   - 会话运行期间新 `deployment add` 的部署会被接上，且第一次看到时取自己的基线（不重放积压）；
 *   - `spv_status` 注册表存在时按部署分组，`--project` 只报一份，条目缺失时报可执行的下一步；
 *   - 注册表不存在时 `spv_status` 输出与旧版逐字节相同（没有 `deployments` 字段）。
 *
 * 全部在 mkdtemp 沙箱里跑：`WHEELCHAIR_AGENT_HOME` / `DSH_SUPERAGENT_STATE_DIR` / `HOME` 都指到临时目录，
 * 不碰真实 `~/.wheelchair-agent`，也不碰正在运行的服务。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startResultInjector } from '../src/spv/injector.js'
import { resolveRoots } from '../src/spv/paths.js'
import { defineSpvTools } from '../src/spv/tools.js'
import { dirsOf } from '../src/shared/queue.js'

const ENV_KEYS = ['WHEELCHAIR_AGENT_HOME', 'DSH_SUPERAGENT_STATE_DIR', 'SPV_QUEUE_DIR', 'HOME', 'DSH_HOME']

let PASS = 0

function ok(name) {
  PASS += 1
  console.log(`PASS ${name}`)
}

async function test(name, fn) {
  try {
    await fn()
    ok(name)
  } catch (error) {
    console.error(`FAIL ${name}`)
    console.error(error?.stack ?? error)
    process.exitCode = 1
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(check, label, timeout = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await check()) return
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const base = await mkdtemp(join(tmpdir(), 'spv-deployment-inject-'))
const box = {
  base,
  home: join(base, 'home'),
  dsh: join(base, 'dsh'),
  data: join(base, 'data'),
  state: join(base, 'dsh', 'state', 'superagent'),
  queueA: join(base, 'queues', 'alpha', 'spv'),
  queueB: join(base, 'queues', 'beta', 'spv'),
  queueOverride: join(base, 'queues', 'override'),
  queueMissing: join(base, 'queues', 'missing', 'spv'),
}
for (const dir of [box.home, box.dsh, box.data, box.state]) await mkdir(dir, { recursive: true })

const saved = {}
for (const key of ENV_KEYS) saved[key] = process.env[key]
process.env.HOME = box.home
process.env.DSH_HOME = box.dsh
process.env.WHEELCHAIR_AGENT_HOME = box.data
process.env.DSH_SUPERAGENT_STATE_DIR = box.state
delete process.env.SPV_QUEUE_DIR

function entry(project, queueDir) {
  return {
    project,
    profile: 'superagent',
    stateDir: dirname(queueDir),
    queueDir,
    port: null,
    installedSha: null,
  }
}

async function writeRegistry(entries) {
  await mkdir(box.data, { recursive: true })
  await writeFile(join(box.data, 'deployments.json'), JSON.stringify({ version: 1, deployments: entries }, null, 2))
}

/** 建一条队列的固定目录；outbox/read 由读者自己建，这里不碰。 */
async function ensureQueue(root) {
  const dirs = dirsOf(root)
  for (const dir of [dirs.pending, dirs.done, dirs.outbox]) await mkdir(dir, { recursive: true })
  return dirs
}

async function put(file, message) {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify(message))
}

async function reply(dirs, name, message) {
  await put(join(dirs.outbox, name), message)
}

/** 生产用法：每轮经 `resolveRoots` 重新解析注册表。 */
function startInjector({ injected, warnings, agent = { followup() {} } }) {
  return startResultInjector({
    queuesOf: () => resolveRoots({}).map(item => ({ project: item.project, root: item.root })),
    getAgent: () => agent,
    inject: (_agent, text, message) => injected.push({ text, id: message.id, file: message.file }),
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    intervalMs: 25,
  })
}

function statusTool() {
  const tools = defineSpvTools(box.state, {}, {})
  const tool = tools.find(item => item.name === 'spv_status')
  assert.ok(tool, 'spv_status is registered')
  return tool
}

await test('two deployments inject both results once, in project order', async () => {
  await writeRegistry([entry('tools/alpha', box.queueA), entry('tools/beta', box.queueB)])
  const alpha = await ensureQueue(box.queueA)
  const beta = await ensureQueue(box.queueB)
  const injected = []
  const warnings = []
  const stop = startInjector({ injected, warnings })
  try {
    await sleep(150)
    // 同名文件、同名 thread：去重身份必须带队列根，否则后一条会被前一条压掉。
    await reply(alpha, 'same.json', { id: 'alpha-1', thread: 'main', kind: 'reply', text: 'alpha reply' })
    await reply(beta, 'same.json', { id: 'beta-1', thread: 'main', kind: 'reply', text: 'beta reply' })
    await waitFor(() => injected.length >= 2, 'both deployments to inject')
    await sleep(150)
    assert.equal(injected.length, 2, 'each result is injected exactly once')
    assert.deepEqual(injected.map(item => item.id), ['alpha-1', 'beta-1'], 'project order is stable')
    assert.match(injected[0].text, /alpha reply/)
    assert.match(injected[1].text, /beta reply/)
    assert.deepEqual(warnings, [])
    assert.deepEqual((await readdir(join(alpha.outbox, 'read'))).sort(), ['same.json'])
    assert.deepEqual((await readdir(join(beta.outbox, 'read'))).sort(), ['same.json'])
  } finally {
    stop()
  }
})

await test('a deployment whose queue does not exist is skipped without error spam', async () => {
  await writeRegistry([
    entry('tools/alpha', box.queueA),
    entry('tools/gamma', box.queueMissing),
  ])
  const alpha = await ensureQueue(box.queueA)
  const injected = []
  const warnings = []
  const stop = startInjector({ injected, warnings })
  try {
    await sleep(150)
    await reply(alpha, 'a.json', { id: 'alpha-2', kind: 'reply', text: 'still alive' })
    await waitFor(() => injected.length >= 1, 'the healthy deployment to inject')
    await sleep(150)
    assert.equal(injected.length, 1)
    assert.equal(injected[0].id, 'alpha-2')
    assert.deepEqual(warnings, [], 'a missing queue is not an error')
  } finally {
    stop()
  }
})

await test('$SPV_QUEUE_DIR still watches exactly one queue and ignores the registry', async () => {
  await writeRegistry([entry('tools/alpha', box.queueA)])
  const alpha = await ensureQueue(box.queueA)
  const override = await ensureQueue(box.queueOverride)
  await reply(alpha, 'alpha.json', { id: 'alpha-3', kind: 'reply', text: 'not watched' })
  process.env.SPV_QUEUE_DIR = box.queueOverride
  const injected = []
  const warnings = []
  const stop = startInjector({ injected, warnings })
  try {
    await sleep(150)
    assert.deepEqual(resolveRoots({}).map(item => item.root), [box.queueOverride])
    await reply(override, 'override.json', { id: 'override-1', kind: 'reply', text: 'watched override' })
    await waitFor(() => injected.length >= 1, 'the override queue to inject')
    await sleep(150)
    assert.equal(injected.length, 1)
    assert.equal(injected[0].id, 'override-1')
    assert.deepEqual((await readdir(alpha.outbox)).filter(name => name.endsWith('.json')), ['alpha.json'])
    assert.deepEqual(warnings, [])
  } finally {
    stop()
    delete process.env.SPV_QUEUE_DIR
  }
})

await test('a deployment added while the session runs is picked up without replaying backlog', async () => {
  await writeRegistry([entry('tools/alpha', box.queueA)])
  const alpha = await ensureQueue(box.queueA)
  const beta = await ensureQueue(box.queueB)
  const injected = []
  const warnings = []
  const stop = startInjector({ injected, warnings })
  try {
    await sleep(150)
    await writeRegistry([entry('tools/alpha', box.queueA), entry('tools/beta', box.queueB)])
    // 给新部署一轮时间取基线，再写结果：之前积压的消息不会被重放。
    await sleep(150)
    await reply(beta, 'b.json', { id: 'beta-2', kind: 'reply', text: 'fresh deployment reply' })
    await waitFor(() => injected.length >= 1, 'the newly registered deployment to inject')
    assert.equal(injected[0].id, 'beta-2')
    assert.deepEqual(warnings, [])
    // alpha 没有新结果：不该凭空多注入一条；它自己那条旧消息也仍在原处（早已被基线跳过）。
    await sleep(150)
    assert.equal(injected.length, 1)
    assert.deepEqual(
      (await readdir(join(alpha.outbox)).catch(() => [])).filter(name => name.endsWith('.json')),
      ['alpha.json'],
    )
  } finally {
    stop()
  }
})

await test('spv_status groups by deployment and --project filters to one', async () => {
  await writeRegistry([
    entry('tools/alpha', box.queueA),
    entry('tools/beta', box.queueB),
    entry('tools/gamma', box.queueMissing),
  ])
  const alpha = await ensureQueue(box.queueA)
  const beta = await ensureQueue(box.queueB)
  // 前面的用例在两条队列里留过回信：先清空，只让本用例布置的内容被统计。
  for (const dirs of [alpha, beta]) {
    await rm(dirs.outbox, { recursive: true, force: true })
    await mkdir(dirs.outbox, { recursive: true })
    await rm(dirs.read, { recursive: true, force: true })
    await rm(dirs.pending, { recursive: true, force: true })
    await mkdir(dirs.pending, { recursive: true })
  }
  await put(join(alpha.pending, 'task.json'), {
    id: 'alpha-task',
    thread: 'main',
    project: 'tools/alpha',
    text: 'alpha task',
    at: '2026-01-01T00:00:00.000Z',
  })
  await reply(beta, 'beta.json', { id: 'beta-3', kind: 'reply', thread: 'main', text: 'beta reply' })

  const status = statusTool()
  const all = await status.execute({})
  assert.ok(Array.isArray(all.deployments), 'grouped output has a deployments array')
  assert.deepEqual(all.deployments.map(item => item.project), ['tools/alpha', 'tools/beta', 'tools/gamma', null])
  const alphaGroup = all.deployments.find(item => item.project === 'tools/alpha')
  const betaGroup = all.deployments.find(item => item.project === 'tools/beta')
  const gammaGroup = all.deployments.find(item => item.project === 'tools/gamma')
  assert.equal(alphaGroup.queueDir, box.queueA)
  assert.equal(alphaGroup.pending, 1)
  assert.equal(betaGroup.unread, 1)
  assert.equal(gammaGroup.pending, 0)
  assert.equal(gammaGroup.unread, 0)
  assert.ok(all.deployments.some(item => item.project === null), 'the legacy queue is reported too')
  const text = status.output.render({}, all)[0].text
  assert.match(text, /tools\/alpha \(.*\): 1 waiting, 0 unread/)
  assert.match(text, /tools\/gamma \(.*\): 0 waiting, 0 unread/)
  assert.match(text, /alpha-task main tools\/alpha: alpha task/)

  const only = await status.execute({ project: 'tools/beta' })
  assert.equal(only.deployments.length, 1)
  assert.equal(only.deployments[0].project, 'tools/beta')
  assert.equal(only.pending.length, 0)
  assert.equal(only.unread.length, 1)

  await assert.rejects(() => status.execute({ project: 'tools/nope' }), /deployment add tools\/nope/)
})

await test('without a registry spv_status is the same single-queue report as before', async () => {
  await rm(join(box.data, 'deployments.json'), { force: true })
  const legacy = await ensureQueue(box.state)
  await rm(join(legacy.outbox, 'read'), { recursive: true, force: true })
  await put(join(legacy.pending, 'legacy-task.json'), {
    id: 'legacy-task',
    thread: 'main',
    project: 'tools/legacy',
    text: 'legacy task',
    at: '2026-01-01T00:00:00.000Z',
  })
  await reply(legacy, 'legacy-reply.json', {
    id: 'legacy-reply',
    thread: 'main',
    kind: 'reply',
    text: 'legacy reply',
  })

  const status = statusTool()
  const value = await status.execute({})
  assert.equal('deployments' in value, false, 'no grouped field when the registry does not exist')
  assert.equal(value.pending.length, 1)
  assert.equal(value.unread.length, 1)
  assert.equal(
    status.output.render({}, value)[0].text,
    [
      'waiting for pickup: 1',
      '  legacy-task main tools/legacy: legacy task',
      'unread messages: 1',
      '  legacy-reply [reply] main: legacy reply',
    ].join('\n'),
  )
})

for (const key of ENV_KEYS) {
  if (saved[key] === undefined) delete process.env[key]
  else process.env[key] = saved[key]
}
await rm(base, { recursive: true, force: true })

if (process.exitCode) {
  console.error(`${PASS} passed`)
  process.exit(1)
}
console.log(`ok (${PASS} passed)`)
