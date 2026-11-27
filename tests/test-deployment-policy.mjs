#!/usr/bin/env node
/**
 * tests/test-deployment-policy.mjs — 新部署也必须能被 raw `spv_dispatch` 接纳。
 *
 * dsh-superagent 只在 `policy.sources.<source>` 已经存在时才套用 Source 的 allowed 默认值；全新部署的
 * policy 是 `{"rules":[],"sources":{}}`，于是 spv 的 trigger 会以 `not_a_member` 被静默 ignore，而
 * queue 已经写入、工具已经报成功。这里验证 wheelchair-agent 自己把缺失的设置补齐：
 *
 *   - 空 sources：写入 operator，`rules` 与其它 source 原样带回；
 *   - 已有别的身份：追加，不覆盖、不删除（包括手填的条目）；
 *   - 已经允许 operator：0 次 PUT；
 *   - 409：重新读取 revision 后再 PUT 一次；
 *   - 非 JSON / 500：throw，且真实 dispatch 路径不写任何 pending 文件；
 *   - 空 `executor.prepare`：补成 `wheelchair-agent prepare`，dispatch 因此写且只写一个任务文件；
 *     executor PUT 失败则报错点名 prepare、不落盘；自定义值一律不动、不发 PUT。
 *
 * 用法：node tests/test-deployment-policy.mjs（任一断言失败则 exit 1）
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  DEFAULT_ACTOR,
  DEFAULT_ACTOR_NAME,
  DEFAULT_PREPARE,
  allowedIds,
  ensureAllowed,
  ensureExecutorPrepare,
  readPolicy,
} from '../src/spv/deployment-policy.js'
import { defineSpvTools } from '../src/spv/tools.js'

const CLI = fileURLToPath(new URL('../bin/wheelchair-agent.mjs', import.meta.url))
const SANDBOXES = []

async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'wheelchair-agent-policy-test-'))
  SANDBOXES.push(base)
  const box = {
    base,
    home: join(base, 'home'),
    dsh: join(base, 'dsh'),
    data: join(base, 'data'),
    state: join(base, 'state'),
    queue: join(base, 'state', 'spv'),
  }
  for (const dir of [box.home, box.dsh, box.data]) await mkdir(dir, { recursive: true })
  return box
}

function envFor(box, extra = {}) {
  const env = { ...process.env }
  for (const key of ['SPV_QUEUE_DIR', 'DSH_SUPERAGENT_URL', 'DSH_SUPERAGENT_PORT', 'SPV_SUPERAGENT_URL', 'DSH_SUPERAGENT_PROFILE']) {
    delete env[key]
  }
  return {
    ...env,
    HOME: box.home,
    DSH_HOME: box.dsh,
    WHEELCHAIR_AGENT_HOME: box.data,
    DSH_SUPERAGENT_STATE_DIR: box.state,
    ...extra,
  }
}

async function cli(box, argv, extra = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...argv], {
      env: envFor(box, extra),
      encoding: 'utf8',
      cwd: box.base,
      timeout: 60_000,
    })
    return { status: 0, stdout, stderr }
  } catch (error) {
    return { status: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

async function pendingFiles(box) {
  try {
    return (await readdir(join(box.queue, 'pending'))).filter(name => name.endsWith('.json') && !name.startsWith('.'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** 让 `spv_dispatch` 从 env 找到这个沙箱的注册表与队列，结束后恢复原 env。 */
async function withStateEnv(box, work) {
  const saved = {}
  const keys = ['WHEELCHAIR_AGENT_HOME', 'DSH_SUPERAGENT_STATE_DIR', 'DSH_SUPERAGENT_URL', 'SPV_QUEUE_DIR']
  for (const key of keys) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.WHEELCHAIR_AGENT_HOME = box.data
  process.env.DSH_SUPERAGENT_STATE_DIR = box.state
  try {
    return await work()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * 只实现 settings/state 路由的假面板。`conflictOnce` 会在第一次 policy PUT 时先把 revision 加一（模拟
 * 别人刚保存过），再回 409；`putStatus` 让 policy PUT 直接失败，`executorPutStatus` 让 executor PUT 失败。
 */
async function panel({
  policy = { rules: [], sources: {} },
  prepare = '',
  revision = 5,
  executorRevision = 7,
  conflictOnce = false,
  putStatus = 0,
  executorPutStatus = 0,
  settingsText = null,
} = {}) {
  const state = {
    policy: structuredClone(policy),
    prepare,
    revision,
    executorRevision,
  }
  const calls = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push({ method: request.method, url: request.url, body })
    const json = (value, status = 200) => {
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(value))
    }
    if (request.method === 'GET' && request.url === '/orchestrator/api/settings') {
      if (settingsText !== null) {
        response.statusCode = 200
        response.setHeader('content-type', 'text/plain')
        response.end(settingsText)
        return
      }
      json({
        blocks: {
          policy: { revision: state.revision, value: state.policy },
          executor: { revision: state.executorRevision, value: { prepare: state.prepare } },
        },
        sources: [],
      })
      return
    }
    if (request.method === 'PUT' && request.url === '/orchestrator/api/settings/policy') {
      if (putStatus) {
        json({ error: `policy exploded: ${'x'.repeat(300)}` }, putStatus)
        return
      }
      if (conflictOnce) {
        conflictOnce = false
        state.revision += 1
        json({ error: 'settings changed' }, 409)
        return
      }
      state.policy = body.value
      state.revision += 1
      json({ saved: true, revision: state.revision })
      return
    }
    if (request.method === 'PUT' && request.url === '/orchestrator/api/settings/executor') {
      if (executorPutStatus) {
        json({ error: `executor exploded: ${'x'.repeat(300)}` }, executorPutStatus)
        return
      }
      state.prepare = body.value.prepare
      state.executorRevision += 1
      json({ saved: true, revision: state.executorRevision })
      return
    }
    if (request.method === 'GET' && request.url === '/orchestrator/api/state') {
      json({ setup: { accounts: { repository: 'nihaoWX/alpha' } } })
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    calls,
    state,
    close: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(resolve)
    }),
  }
}

const putCalls = (p, suffix) => p.calls.filter(call => call.method === 'PUT' && call.url.endsWith(suffix))

async function testEmptyPolicyGetsOperatorAndPreservesEverythingElse() {
  const rules = [{ id: 'keep-this-rule', when: { project: 'tools/*' }, decision: 'accept' }]
  const github = { allowed: [{ id: 'nihaoWX', name: 'repository owner' }], admission: { observe: [] } }
  const p = await panel({ policy: { rules, sources: { github } } })
  try {
    const result = await ensureAllowed({ port: p.port })
    assert.deepEqual(result, { changed: true, allowed: [DEFAULT_ACTOR] })
    const puts = putCalls(p, '/settings/policy')
    assert.equal(puts.length, 1)
    assert.deepEqual(puts[0].body, {
      revision: 5,
      value: {
        rules,
        sources: {
          github,
          spv: { allowed: [{ id: DEFAULT_ACTOR, name: DEFAULT_ACTOR_NAME }] },
        },
      },
    })
    assert.deepEqual(p.state.policy.sources.spv.allowed, [{ id: DEFAULT_ACTOR, name: DEFAULT_ACTOR_NAME }])
    assert.deepEqual(p.state.policy.rules, rules, 'rules survive the merge')
    assert.deepEqual(p.state.policy.sources.github, github, 'the other source survives byte-for-byte')
  } finally {
    await p.close()
  }
}

async function testExistingIdentitiesAreAppendedNotReplaced() {
  const existing = [
    { id: 'alice', name: 'Alice' },
    { id: 'Bob', name: 'Bob' },
  ]
  const p = await panel({ policy: { rules: [], sources: { spv: { allowed: structuredClone(existing) } } } })
  try {
    const result = await ensureAllowed({ port: p.port })
    assert.deepEqual(result, { changed: true, allowed: ['alice', 'Bob', DEFAULT_ACTOR] })
    assert.deepEqual(p.state.policy.sources.spv.allowed, [...existing, { id: DEFAULT_ACTOR, name: DEFAULT_ACTOR_NAME }])
  } finally {
    await p.close()
  }
}

async function testAlreadyAllowedIsZeroWrites() {
  const p = await panel({
    policy: { rules: [], sources: { spv: { allowed: [{ id: 'operator', name: 'Ops' }] } } },
  })
  try {
    const result = await ensureAllowed({ port: p.port })
    assert.deepEqual(result, { changed: false, allowed: ['operator'] })
    assert.equal(putCalls(p, '/settings/policy').length, 0)
    assert.equal(p.state.policy.sources.spv.allowed[0].name, 'Ops', 'the existing display name is untouched')
  } finally {
    await p.close()
  }
}

async function testConflictReloadsRevisionAndRetriesOnce() {
  const p = await panel({ conflictOnce: true })
  try {
    const result = await ensureAllowed({ port: p.port })
    assert.deepEqual(result, { changed: true, allowed: [DEFAULT_ACTOR] })
    const puts = putCalls(p, '/settings/policy')
    assert.equal(puts.length, 2)
    assert.deepEqual(puts.map(call => call.body.revision), [5, 6], 'the retry uses the revision read after the 409')
    assert.deepEqual(p.state.policy.sources.spv.allowed, [{ id: DEFAULT_ACTOR, name: DEFAULT_ACTOR_NAME }])
  } finally {
    await p.close()
  }
}

async function testNonJsonAnd500Throw() {
  const plain = await panel({ settingsText: 'this is not json' })
  try {
    await assert.rejects(() => readPolicy({ port: plain.port }), /not JSON/i)
  } finally {
    await plain.close()
  }

  const broken = await panel({ putStatus: 500 })
  try {
    await assert.rejects(
      () => ensureAllowed({ port: broken.port }),
      error => error.status === 500 && /policy exploded/.test(error.message),
    )
  } finally {
    await broken.close()
  }
}

async function testPrepareIsFilledOnlyWhenEmpty() {
  const p = await panel({ prepare: '' })
  try {
    const first = await ensureExecutorPrepare({ port: p.port })
    assert.deepEqual(first, { changed: true, prepare: DEFAULT_PREPARE })
    const puts = putCalls(p, '/settings/executor')
    assert.equal(puts.length, 1)
    assert.deepEqual(puts[0].body, { revision: 7, value: { prepare: DEFAULT_PREPARE } })

    const second = await ensureExecutorPrepare({ port: p.port })
    assert.deepEqual(second, { changed: false, prepare: DEFAULT_PREPARE })
    assert.equal(putCalls(p, '/settings/executor').length, 1, 'the second ensure sends no PUT')
  } finally {
    await p.close()
  }

  const custom = await panel({ prepare: 'my own prepare' })
  try {
    const kept = await ensureExecutorPrepare({ port: custom.port })
    assert.deepEqual(kept, { changed: false, prepare: 'my own prepare' })
    assert.equal(putCalls(custom, '/settings/executor').length, 0)
  } finally {
    await custom.close()
  }
}

async function testFailedAdmissionWritesNoQueueFile() {
  const box = await sandbox()
  const p = await panel({ putStatus: 500 })
  try {
    const added = await cli(box, [
      'deployment', 'add', 'tools/alpha', '--repo', 'nihaoWX/alpha', '--state-dir', box.state, '--queue-dir', box.queue, '--port', String(p.port),
    ])
    assert.equal(added.status, 0, added.stderr)

    const sent = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'must not land'])
    assert.equal(sent.status, 1)
    assert.match(sent.stderr, /could not let "operator" dispatch into tools\/alpha \(port \d+\)/)
    assert.match(sent.stderr, /Nothing was queued/)
    assert.deepEqual(await pendingFiles(box), [], 'the CLI writes nothing when admission fails')

    // 工具走同一个 ensureDispatchAllowed：失败同样不能落盘。
    await withStateEnv(box, async () => {
      const tools = defineSpvTools(join(box.state, 'spv'), {}, {})
      const dispatch = tools.find(tool => tool.name === 'spv_dispatch')
      assert.ok(dispatch)
      await assert.rejects(
        () => dispatch.execute({ project: 'tools/alpha', task: 'must not land either' }, {}),
        error => /could not let "operator" dispatch into tools\/alpha/.test(error.message) && /Nothing was queued/.test(error.message),
      )
      assert.deepEqual(await pendingFiles(box), [], 'the tool writes nothing when admission fails')
    })
  } finally {
    await p.close()
  }
}

async function testDispatchFillsPrepareBeforeWritingTheTask() {
  const box = await sandbox()
  // 已经允许 operator、只缺 prepare：dispatch 只需补 executor.prepare，然后写一个任务文件。
  const p = await panel({ policy: { rules: [], sources: { spv: { allowed: [{ id: 'operator', name: 'Ops' }] } } } })
  try {
    const added = await cli(box, [
      'deployment', 'add', 'tools/alpha', '--repo', 'nihaoWX/alpha', '--state-dir', box.state, '--queue-dir', box.queue, '--port', String(p.port),
    ])
    assert.equal(added.status, 0, added.stderr)

    const sent = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'fills prepare first'])
    assert.equal(sent.status, 0, sent.stderr)
    assert.match(sent.stdout, /note: filled the empty executor\.prepare/)
    const puts = putCalls(p, '/settings/executor')
    assert.equal(puts.length, 1, 'the dispatch fills the empty prepare exactly once')
    assert.deepEqual(puts[0].body, { revision: 7, value: { prepare: DEFAULT_PREPARE } })
    assert.equal(p.state.prepare, DEFAULT_PREPARE)
    assert.equal(putCalls(p, '/settings/policy').length, 0, 'an already-allowed source needs no policy write')
    assert.deepEqual((await pendingFiles(box)).length, 1, 'exactly one task file is queued after admission')
  } finally {
    await p.close()
  }

  // spv_dispatch 工具走同一个 ensureDispatchAllowed：成功时同样先补 prepare 再落盘。
  const toolBox = await sandbox()
  const toolPanel = await panel({ policy: { rules: [], sources: { spv: { allowed: [{ id: 'operator', name: 'Ops' }] } } } })
  try {
    const added = await cli(toolBox, [
      'deployment', 'add', 'tools/beta', '--repo', 'nihaoWX/beta', '--state-dir', toolBox.state, '--queue-dir', toolBox.queue, '--port', String(toolPanel.port),
    ])
    assert.equal(added.status, 0, added.stderr)
    await withStateEnv(toolBox, async () => {
      const tools = defineSpvTools(join(toolBox.state, 'spv'), {}, {})
      const dispatch = tools.find(tool => tool.name === 'spv_dispatch')
      const result = await dispatch.execute({ project: 'tools/beta', task: 'the tool fills prepare first' }, {})
      assert.match(result.note, /filled the empty executor\.prepare/)
      assert.equal(putCalls(toolPanel, '/settings/executor').length, 1)
      assert.equal(toolPanel.state.prepare, DEFAULT_PREPARE)
      assert.equal((await pendingFiles(toolBox)).length, 1)
    })
  } finally {
    await toolPanel.close()
  }
}

async function testDispatchKeepsCustomPrepare() {
  const box = await sandbox()
  const custom = 'my own prepare --project tools/alpha'
  const p = await panel({
    policy: { rules: [], sources: { spv: { allowed: [{ id: 'operator', name: 'Ops' }] } } },
    prepare: custom,
  })
  try {
    const added = await cli(box, [
      'deployment', 'add', 'tools/alpha', '--repo', 'nihaoWX/alpha', '--state-dir', box.state, '--queue-dir', box.queue, '--port', String(p.port),
    ])
    assert.equal(added.status, 0, added.stderr)

    const sent = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'keep my prepare'])
    assert.equal(sent.status, 0, sent.stderr)
    assert.doesNotMatch(sent.stdout, /note:/, 'no note when both settings were already configured')
    assert.equal(putCalls(p, '/settings/executor').length, 0, 'a custom prepare is never overwritten')
    assert.equal(p.state.prepare, custom)
    assert.equal((await pendingFiles(box)).length, 1)
  } finally {
    await p.close()
  }
}

async function testFailedPrepareAdmissionWritesNoQueueFile() {
  const box = await sandbox()
  const p = await panel({
    policy: { rules: [], sources: { spv: { allowed: [{ id: 'operator', name: 'Ops' }] } } },
    executorPutStatus: 500,
  })
  try {
    const added = await cli(box, [
      'deployment', 'add', 'tools/alpha', '--repo', 'nihaoWX/alpha', '--state-dir', box.state, '--queue-dir', box.queue, '--port', String(p.port),
    ])
    assert.equal(added.status, 0, added.stderr)

    const sent = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'must not land'])
    assert.equal(sent.status, 1)
    assert.match(sent.stderr, /could not let "operator" dispatch into tools\/alpha \(port \d+\)/)
    assert.match(sent.stderr, /executor\.prepare could not be filled/)
    assert.match(sent.stderr, /executor exploded/)
    assert.match(sent.stderr, /Nothing was queued/)
    assert.deepEqual(await pendingFiles(box), [], 'the CLI writes nothing when prepare admission fails')

    // 工具走同一个 ensureDispatchAllowed：失败同样不落盘，且错误点名 prepare。
    await withStateEnv(box, async () => {
      const tools = defineSpvTools(join(box.state, 'spv'), {}, {})
      const dispatch = tools.find(tool => tool.name === 'spv_dispatch')
      await assert.rejects(
        () => dispatch.execute({ project: 'tools/alpha', task: 'must not land either' }, {}),
        error => /executor\.prepare could not be filled/.test(error.message) &&
          /executor exploded/.test(error.message) &&
          /Nothing was queued/.test(error.message),
      )
      assert.deepEqual(await pendingFiles(box), [], 'the tool writes nothing when prepare admission fails')
    })
  } finally {
    await p.close()
  }
}

async function testAllowedIdsReadsOnlyTheNamedSource() {
  const value = {
    rules: [],
    sources: {
      spv: { allowed: [{ id: 'alice' }, { id: 'operator' }] },
      github: { allowed: [{ id: 'nihaoWX' }] },
    },
  }
  assert.deepEqual(allowedIds(value), ['alice', 'operator'])
  assert.deepEqual(allowedIds({ rules: [], sources: {} }), [])
}

try {
  await testEmptyPolicyGetsOperatorAndPreservesEverythingElse()
  await testExistingIdentitiesAreAppendedNotReplaced()
  await testAlreadyAllowedIsZeroWrites()
  await testConflictReloadsRevisionAndRetriesOnce()
  await testNonJsonAnd500Throw()
  await testPrepareIsFilledOnlyWhenEmpty()
  await testFailedAdmissionWritesNoQueueFile()
  await testDispatchFillsPrepareBeforeWritingTheTask()
  await testDispatchKeepsCustomPrepare()
  await testFailedPrepareAdmissionWritesNoQueueFile()
  await testAllowedIdsReadsOnlyTheNamedSource()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true }).catch(() => {})
}
