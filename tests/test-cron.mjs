#!/usr/bin/env node
/**
 * tests/test-cron.mjs：`/spv-cron` 到点时的钩子事件与注入顺序。
 *
 * 覆盖：
 *   - `cron.spv_cron` 在事件表里，payload 至少要能给出 sessionId / minutes / at / injected；
 *   - 有启用的 hook 行时，一次到点恰好一条记录，`eventId` 是 `cron.spv_cron:<at>`，脚本 stdin 收到完整负载；
 *   - 没有 hook 行时零记录、不报错；
 *   - hook 同步抛错或脚本非零退出都不影响简报注入（注入先发生，hook 只是附带副作用）；
 *   - `quiet` 与 `attention` 都注入，`injected` 如实为 true，差别在 `verdict`。
 *
 * 全程离线：数据根/状态目录/HOME 都是 `mkdtemp` 沙箱，不碰操作者的真实目录，不启动服务。
 *
 * 用法：node tests/test-cron.mjs（任一断言失败则 exit 1）
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HOOK_EVENT, runOnce } from '../src/spv/cron.js'
import { fireHook } from '../src/spv/cron-plugin.js'
import { eventById } from '../src/shared/hook-events.js'
import { HOOKS_RECORD_FILE } from '../src/shared/hooks.js'
import { saveSettings } from '../src/shared/settings.js'

const SANDBOXES = []
const ORIGINAL_ENV = { ...process.env }
const AT = '2026-11-24T07:30:00.000Z'
const NOW = Date.parse(AT)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(10)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

function restoreEnv(saved) {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(saved)) process.env[key] = value
}

/** A temp data root + state dir; the hook engine resolves both from the environment. */
async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'wheelchair-agent-cron-test-'))
  SANDBOXES.push(base)
  const box = {
    base,
    root: join(base, 'data'),
    state: join(base, 'state'),
    home: join(base, 'home'),
    ledger: join(base, 'ledger.jsonl'),
    payload: join(base, 'payload.json'),
    eventIdFile: join(base, 'event-id.txt'),
    records: join(base, 'data', 'records', HOOKS_RECORD_FILE),
  }
  for (const dir of [box.root, box.state, box.home]) await mkdir(dir, { recursive: true })
  box.env = {
    ...process.env,
    HOME: box.home,
    WHEELCHAIR_AGENT_HOME: box.root,
    DSH_SUPERAGENT_STATE_DIR: box.state,
  }
  return box
}

function withEnv(box) {
  for (const [key, value] of Object.entries(box.env)) process.env[key] = value
}

async function addHook(box, script) {
  const { resolveSettings } = await import('../src/shared/settings.js')
  const snapshot = resolveSettings({ env: box.env })
  saveSettings({
    env: box.env,
    revision: snapshot.revision,
    hooks: { items: [{ id: 'hook-cron-0001', event: HOOK_EVENT, name: 'cron probe', enabled: true, script }] },
  })
}

async function readRecords(box) {
  try {
    const text = await readFile(box.records, 'utf8')
    return text
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/** Run one check with the real production hook bridge and an injected agent. */
function runCheck(box, { fireHook: hook = fireHook, agent = {}, ledger } = {}) {
  const injected = []
  const session = { session: { id: 'sess-cron-test' }, ...agent }
  const result = runOnce({
    agent: session,
    ledgerPath: ledger ?? box.ledger,
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    isActive: () => 'inactive',
    inject: (_agent, text) => injected.push(text),
    fireHook: hook,
    minutes: 60,
    now: NOW,
  })
  return { result, injected }
}


async function testEventTable() {
  const entry = eventById(HOOK_EVENT)
  assert.ok(entry, 'cron.spv_cron is a known hook event')
  assert.equal(entry.id, 'cron.spv_cron')
  for (const field of ['sessionId', 'minutes', 'at', 'injected', 'verdict']) {
    assert.ok(entry.payload.some(item => item.name === field), `the event documents the ${field} field`)
  }
  assert.ok(entry.explanation.length > 40)
  assert.equal(entry.builtin.length, 0, 'the cron event is operator-owned: no builtin row')
}

async function testHookRowFiresOnce() {
  const box = await sandbox()
  withEnv(box)
  const script = `cat > '${box.payload}'; printf '%s' "$WCA_EVENT_ID" > '${box.eventIdFile}'`
  await addHook(box, script)

  const { result, injected } = runCheck(box)
  assert.equal(injected.length, 1)
  assert.match(injected[0], /^\[spv-cron\] routine check:/, 'a quiet tick still injects the routine nudge')
  assert.equal(result.payload.sessionId, 'sess-cron-test')
  assert.equal(result.payload.minutes, 60)
  assert.equal(result.payload.at, AT)
  assert.equal(result.payload.injected, true)
  assert.equal(result.payload.verdict, 'quiet')
  assert.deepEqual(result.brief.verdict, 'quiet')

  await waitFor(() => existsSync(box.payload), 'the hook script to write its payload')
  await waitFor(async () => (await readRecords(box)).length === 1, 'one hook record')
  const payload = JSON.parse(await readFile(box.payload, 'utf8'))
  assert.deepEqual(payload, result.payload, 'the script receives exactly the emitted payload')
  assert.equal(await readFile(box.eventIdFile, 'utf8'), `cron.spv_cron:${AT}`)
  const records = await readRecords(box)
  assert.equal(records.length, 1, 'one occurrence produces exactly one record')
  assert.equal(records[0].event, 'cron.spv_cron')
  assert.equal(records[0].eventId, `cron.spv_cron:${AT}`)
  assert.equal(records[0].exit, 0)
  assert.equal(records[0].name, 'cron probe')
}

async function testNoHookRowWritesNothing() {
  const box = await sandbox()
  withEnv(box)
  const { injected } = runCheck(box)
  assert.equal(injected.length, 1, 'the brief is independent of hook configuration')
  await sleep(200)
  assert.equal(existsSync(join(box.root, 'records')), false, 'no hook row leaves no records directory at all')
}

async function testHookFailureDoesNotBlockInjection() {
  const box = await sandbox()
  withEnv(box)
  const failing = () => {
    throw new Error('hook exploded')
  }
  const direct = runCheck(box, { fireHook: failing })
  assert.equal(direct.injected.length, 1, 'a synchronously throwing hook cannot suppress the brief')
  assert.equal(direct.result.payload.injected, true)

  const box2 = await sandbox()
  withEnv(box2)
  await addHook(box2, 'exit 3')
  const { injected } = runCheck(box2)
  assert.equal(injected.length, 1, 'a non-zero hook still cannot suppress the brief')
  await waitFor(async () => (await readRecords(box2)).length === 1, 'the failing hook record')
  const [record] = await readRecords(box2)
  assert.equal(record.exit, 3)
}

async function testAttentionVerdict() {
  const box = await sandbox()
  withEnv(box)
  await writeFile(box.ledger, `${JSON.stringify({ event: 'submit', unit: 'demo.service', at: '2026-11-24T06:00:00.000Z' })}\n`)
  const injected = []
  const result = runOnce({
    agent: { session: { id: 'sess-attention' } },
    ledgerPath: box.ledger,
    readFileSync,
    isActive: () => 'failed',
    inject: (_agent, text) => injected.push(text),
    fireHook: () => {},
    minutes: 30,
    now: NOW,
  })
  assert.equal(result.payload.verdict, 'attention')
  assert.equal(result.payload.injected, true)
  assert.match(injected[0], /long-job check found something to look at/)
}

async function testNoAgentMeansNoInjectionOrEvent() {
  let fired = 0
  const result = runOnce({
    agent: undefined,
    ledgerPath: '/nonexistent',
    readFileSync,
    isActive: () => 'inactive',
    inject: () => assert.fail('must not inject without an agent'),
    fireHook: () => {
      fired += 1
    },
    minutes: 60,
    now: NOW,
  })
  assert.equal(result, undefined)
  assert.equal(fired, 0)
}

try {
  await testEventTable()
  await testHookRowFiresOnce()
  await testNoHookRowWritesNothing()
  await testHookFailureDoesNotBlockInjection()
  await testAttentionVerdict()
  await testNoAgentMeansNoInjectionOrEvent()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true })
  restoreEnv(ORIGINAL_ENV)
}
