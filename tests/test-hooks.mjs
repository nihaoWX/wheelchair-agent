#!/usr/bin/env node
/**
 * tests/test-hooks.mjs：插口（hook）引擎的离线证据。
 *
 * 覆盖（对应 `ARCHITECTURE/hooks.md` 的每一条承诺）：
 *   - 事件表：8 个事件、7 个内建行、六个 `builtin:*` id 逐字存在、`builtin:prepare` 是指针、
 *     内建行全部 `cancellable: false`，且没有 `ticket.ended`；
 *   - 执行契约：stdin 是事件负载的 JSON、`WCA_*` 环境变量、`ticket.*` 的 cwd 用 workspace / 其它事件用
 *     opts.cwd；顺序执行；exit 1 / 超时 / 输出洪水都只记录、不抛、不影响下一个 hook；
 *   - 环境是白名单：PATH/HOME/LANG/LC_* 在，`GITHUB_TOKEN` / `MY_SECRET` / `SOME_KEY` / `DSH_*` 不在；
 *   - 记录：`<root>/records/hooks.jsonl` 每次运行一行，字段齐全，stdout 只留最后 8 KiB；
 *   - 总开关：`hooks.enabled: false` 一个脚本都不跑，每次 occurrence 只写一条 `paused` 记录；
 *     空 `items` 与全部 disabled 是纯 no-op（连记录都没有）；
 *   - cursor：同一个 eventId 跑一次；重启（新进程）不重跑；看不到 id 的 occurrence 不去重；
 *   - 队列原语：`outbox/` + `outbox/read/` 都读、按消息 id 去重、按时间排序、cursor 过滤、
 *     **不 rename、不消费**；`outbox/read/` 里 cursor 之前的消息恰好重放一次；
 *   - 设置往返：add / rename / disable / rm、过期 revision 409 且不落盘、坏文件回默认、旧文件仍有效；
 *   - CLI：`hook events`（全表）、`add`（打印 id）、`list`、`enable/disable`、`rm`、`rename`（只限内建）、
 *     `test`（示例负载、不写记录）、`log`、`prompt`（事件 id + 说明 + `hook add` 形状）、`--help` 与退出码；
 *   - 超时解析：行内 → hooks 默认 → 10000，夹到 300000。
 *
 * 全程离线：所有状态都在 `mkdtemp` 沙箱；`WHEELCHAIR_AGENT_HOME`、`SPV_QUEUE_DIR`、
 * `DSH_SUPERAGENT_STATE_DIR`、`HOME` 全部指向沙箱，绝不碰操作者的真实数据根；
 * 脚本只写沙箱里的文件。没有任何网络访问。
 *
 * 用法：node tests/test-hooks.mjs（任一断言失败则 exit 1）
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  BUILTIN_ROWS,
  EVENTS,
  HOOK_PANEL_RUN_LIMIT,
  HOOKS_RECORD_FILE,
  QUEUE_EVENT_KINDS,
  buildHookPanel,
  buildHookPrompt,
  describeHookRun,
  latestHookRuns,
  claimEvent,
  eventIdFor,
  eventsCursorPath,
  hasEvent,
  hookCwd,
  hookSpoolDir,
  readCursor,
  readHookRecords,
  readHooks,
  readQueueEvents,
  resolveHookTimeout,
  runHooksFor,
  runOneHook,
  samplePayload,
  writeHookSpoolEvent,
} from '../src/shared/hooks.js'
import { appendReview, writeItem } from '../src/spv/inbox.js'
import { startHookRunner } from '../src/spv/hook-runner.js'
import { submitTask } from '../src/spv/dispatch.js'
import { dirsOf, writeMessage } from '../src/shared/queue.js'
import { SETTINGS_FILE, resolveSettings, saveSettings } from '../src/shared/settings.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const CLI = fileURLToPath(new URL('../bin/wheelchair-agent.mjs', import.meta.url))
const HOOKS_MODULE = pathToFileURL(fileURLToPath(new URL('../src/shared/hooks.js', import.meta.url))).href
const SANDBOXES = []
const ORIGINAL_ENV = { ...process.env }

/** 一个 `mkdtemp` 沙箱；所有测试结束后统一删掉。 */
async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'wheelchair-agent-hooks-test-'))
  SANDBOXES.push(base)
  const box = {
    base,
    root: join(base, 'data'),
    state: join(base, 'state'),
    queue: join(base, 'state', 'spv'),
    inbox: join(base, 'data', 'inbox'),
    workspace: join(base, 'workspace'),
    checkout: join(base, 'checkout'),
    home: join(base, 'home'),
  }
  for (const dir of [box.root, box.state, box.queue, box.inbox, box.workspace, box.checkout, box.home]) {
    await mkdir(dir, { recursive: true })
  }
  box.env = {
    ...process.env,
    HOME: box.home,
    WHEELCHAIR_AGENT_HOME: box.root,
    DSH_SUPERAGENT_STATE_DIR: box.state,
    SPV_QUEUE_DIR: box.queue,
  }
  box.records = join(box.root, 'records', HOOKS_RECORD_FILE)
  box.cursor = join(box.root, 'records', 'events-cursor.json')
  box.settings = join(box.root, SETTINGS_FILE)
  return box
}

/** 用沙箱环境跑一次 CLI。 */
function cli(box, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: box.checkout,
    encoding: 'utf8',
    env: { ...box.env, ...extraEnv },
  })
}

/** 读设置快照（沙箱根）。 */
function snapshot(box) {
  return resolveSettings({ env: box.env })
}

/** 往沙箱里加一个自定义 hook（绕过 CLI，测执行器时更直接）。 */
let counter = 0
function addHook(box, options) {
  counter += 1
  const event = options.event
  const item = {
    id: options.id ?? `hook-${event.replace(/[^A-Za-z0-9]+/g, '-')}-${String(counter).padStart(4, '0')}`,
    event,
    name: options.name ?? 'test hook',
    enabled: options.enabled ?? true,
    script: options.script,
  }
  if (options.timeoutMs !== undefined) item.timeoutMs = options.timeoutMs
  const current = snapshot(box)
  saveSettings({
    env: box.env,
    revision: current.revision,
    hooks: { items: [...current.hooks.items, item] },
  })
  return item
}

/** 设置 hooks 子块的某个字段（保留其它字段）。 */
function setHooks(box, patch) {
  const current = snapshot(box)
  return saveSettings({
    env: box.env,
    revision: current.revision,
    hooks: { ...current.hooks, ...patch },
  })
}

/** 记录文件里的全部 JSON 行。 */
async function records(box) {
  let text
  try {
    text = await readFile(box.records, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

/** 一个 shell 单引号字符串（路径进脚本时用）。 */
function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 在**新进程**里跑一次 runHooksFor：证明 cursor 跨重启生效，而不是靠进程内状态。 */
function runInFreshProcess(box, { event, payload, eventId }) {
  const code = [
    `import { runHooksFor } from ${JSON.stringify(HOOKS_MODULE)}`,
    `const result = await runHooksFor(${JSON.stringify(event)}, ${JSON.stringify(payload)}, {`,
    '  env: process.env,',
    eventId === undefined ? '' : `  eventId: ${JSON.stringify(eventId)},`,
    '})',
    'process.stdout.write(JSON.stringify(result))',
  ].join('\n')
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: box.checkout,
    encoding: 'utf8',
    env: box.env,
  })
}

// ----------------------------------------------------------------- scenarios

/** 事件表与内建行：id、触发性、可取消性、行数。 */
async function testTableView() {
  const box = await sandbox()
  const model = readHooks({ env: box.env })
  assert.equal(model.enabled, true)
  assert.equal(model.scriptTimeoutMs, 10000)
  assert.equal(model.timeoutCap, 300000)
  assert.deepEqual(model.items, [])
  assert.deepEqual(model.labels, {})
  assert.equal(model.events.length, 8, 'the table has the eight contract events')
  assert.deepEqual(
    model.events.map(entry => entry.id),
    [
      'ticket.started',
      'ticket.acknowledged',
      'ticket.delivered',
      'ticket.attention',
      'inbox.approved',
      'inbox.issue',
      'inbox.merged',
      'spv.dispatch',
    ],
  )
  assert.ok(!model.events.some(entry => entry.id === 'ticket.ended'), 'there is deliberately no ticket.ended')
  assert.equal(model.builtin.length, 7)
  // 精确契约：每个事件的内建行 id 顺序 + 是否可取消。不是 typeof 检查。
  const contract = {
    'ticket.started': { cancellable: false, rows: ['builtin:prepare'] },
    'ticket.acknowledged': { cancellable: true, rows: [] },
    'ticket.delivered': { cancellable: false, rows: ['builtin:injection'] },
    'ticket.attention': { cancellable: false, rows: ['builtin:injection'] },
    'inbox.approved': { cancellable: false, rows: ['builtin:reviewRecord'] },
    'inbox.issue': { cancellable: false, rows: ['builtin:prIssue', 'builtin:spvObjection'] },
    'inbox.merged': { cancellable: false, rows: ['builtin:mergePull', 'builtin:coldInstallNotice'] },
    'spv.dispatch': { cancellable: true, rows: [] },
  }
  for (const [eventId, expected] of Object.entries(contract)) {
    const entry = model.events.find(candidate => candidate.id === eventId)
    assert.deepEqual(entry.rows.map(row => row.id), expected.rows, `${eventId} lists exactly its builtin rows`)
    assert.equal(entry.cancellable, expected.cancellable, `${eventId} cancellable is ${expected.cancellable}`)
  }
  for (const entry of model.events) {
    assert.equal(typeof entry.title, 'string')
    assert.ok(entry.explanation.length > 40, `${entry.id} has a one-paragraph explanation`)
    assert.ok(entry.when.length > 10, `${entry.id} says when it fires`)
    assert.equal(typeof entry.repeatable, 'boolean')
    assert.ok(entry.repeatNote.length > 5, `${entry.id} explains repeatability`)
    assert.equal(typeof entry.cancellable, 'boolean')
    assert.equal(entry.rowCount, entry.rows.length + entry.customCount)
    assert.ok(Array.isArray(entry.payload) && entry.payload.length > 0)
  }
  const ids = model.builtin.map(row => row.id)
  for (const id of [
    'builtin:injection',
    'builtin:prIssue',
    'builtin:spvObjection',
    'builtin:reviewRecord',
    'builtin:mergePull',
    'builtin:coldInstallNotice',
  ]) {
    assert.ok(ids.includes(id), `${id} exists verbatim`)
  }
  assert.ok(ids.includes('builtin:prepare'), 'the prepare pointer row exists')
  for (const row of model.builtin) {
    assert.equal(row.cancellable, false, `${row.id} is core path`)
    assert.equal(row.label, row.defaultLabel)
    assert.equal(typeof row.description, 'string')
    assert.ok(row.description.length > 10)
  }
  const prepare = model.builtin.find(row => row.id === 'builtin:prepare')
  assert.deepEqual(prepare.events, ['ticket.started'])
  assert.equal(prepare.pointer, 'executor.prepare', 'prepare is a pointer into superagent settings, not a copy')
  assert.equal(prepare.editableText, false)
  const injection = model.builtin.find(row => row.id === 'builtin:injection')
  assert.deepEqual(injection.events, ['ticket.delivered', 'ticket.attention'], 'one injection row serves both queue kinds')
  assert.equal(injection.template, 'injection', 'editable text points at the existing template')
  assert.equal(injection.editableText, true)
  assert.equal(model.builtin.find(row => row.id === 'builtin:prIssue').template, 'prIssue')
  assert.equal(model.builtin.find(row => row.id === 'builtin:spvObjection').template, 'spvObjection')
  assert.equal(model.builtin.find(row => row.id === 'builtin:mergePull').template, undefined)
  assert.equal(model.builtin.find(row => row.id === 'builtin:mergePull').editableText, false)
  // 冷安装挂在 merged 一侧，不挂在 delivered 一侧。
  assert.deepEqual(
    model.events.find(entry => entry.id === 'inbox.merged').rows.map(row => row.id),
    ['builtin:mergePull', 'builtin:coldInstallNotice'],
  )
  assert.deepEqual(model.events.find(entry => entry.id === 'ticket.delivered').rows.map(row => row.id), ['builtin:injection'])
  assert.deepEqual(
    model.events.find(entry => entry.id === 'ticket.attention').rows.map(row => row.id),
    ['builtin:injection'],
    'notice injection is core path too',
  )

  // 派生 eventId：每个事件用事实字段，都有稳定答案。
  assert.equal(eventIdFor('ticket.delivered', { messageId: 'm-1' }), 'm-1')
  assert.equal(eventIdFor('inbox.issue', { itemId: 'i-1', reviewIndex: 2 }), 'inbox.issue:i-1:2')
  assert.equal(
    eventIdFor('inbox.issue', { itemId: 'i-1', reviewIndex: 2, messageId: 'n-1' }),
    'inbox.issue:i-1:2',
    'the notice message id is not the inbox occurrence id',
  )
  assert.notEqual(
    eventIdFor('inbox.issue', { itemId: 'i-1', reviewIndex: 2, messageId: 'n-1' }),
    eventIdFor('ticket.attention', { messageId: 'n-1' }),
    'inbox.issue and ticket.attention use different cursor ids',
  )
  assert.equal(eventIdFor('inbox.merged', { itemId: 'i-1', pulledSha: 'abc' }), 'merge:i-1:abc')
  assert.equal(eventIdFor('ticket.started', { ticketId: 't-1', at: 'now' }), 't-1:now')
  assert.equal(eventIdFor('ticket.started', { ticketId: 't-1' }), undefined, 'no at means no stable occurrence')
  assert.equal(eventIdFor('spv.dispatch', { taskId: 'x-1' }), 'dispatch:x-1')
  assert.equal(eventIdFor('ticket.delivered', { eventId: 'explicit' }), 'explicit')

  // 坏数据根不抛：readHooks 退回默认 + warning。
  const broken = readHooks({ env: { WHEELCHAIR_AGENT_HOME: 'relative/root' } })
  assert.equal(broken.enabled, true)
  assert.match(broken.warning, /absolute path/)
}

/** 负载进 stdin、环境变量、ticket.* 与其它事件的 cwd 差别。 */
async function testPayloadEnvAndCwd() {
  const box = await sandbox()
  const stdinA = join(box.base, 'stdin-a.json')
  const envA = join(box.base, 'env-a.txt')
  const envB = join(box.base, 'env-b.txt')
  addHook(box, {
    event: 'ticket.delivered',
    name: 'capture ticket payload',
    script: [
      `cat > ${q(stdinA)}`,
      `{ echo "$WCA_EVENT"; echo "$WCA_EVENT_ID"; echo "$WCA_EVENT_AT"; echo "$WCA_HOME"; echo "$WCA_TICKET"; echo "$WCA_CWD"; pwd -P; } > ${q(envA)}`,
    ].join('\n'),
  })
  addHook(box, {
    event: 'spv.dispatch',
    name: 'capture dispatch cwd',
    script: `pwd -P > ${q(envB)}`,
  })
  const payload = {
    messageId: 'm-a1',
    ticketId: 'tk-9',
    thread: 't1',
    kind: 'reply',
    text: 'hello',
    at: '2026-11-16T00:00:00.000Z',
  }
  const summary = await runHooksFor('ticket.delivered', payload, {
    env: box.env,
    cwd: box.checkout,
    workspace: box.workspace,
    eventId: 'm-a1',
  })
  assert.equal(summary.ran, 1)
  assert.equal(summary.skipped, undefined)
  assert.equal(summary.records[0].exit, 0)
  assert.equal(summary.records[0].eventId, 'm-a1')
  assert.deepEqual(await readJson(stdinA), payload, 'stdin is the payload as valid JSON')
  const lines = (await readFile(envA, 'utf8')).trimEnd().split('\n')
  assert.equal(lines[0], 'ticket.delivered')
  assert.equal(lines[1], 'm-a1')
  assert.equal(lines[2], '2026-11-16T00:00:00.000Z')
  assert.equal(lines[3], box.root, 'WCA_HOME is the data root')
  assert.equal(lines[4], 'tk-9')
  assert.equal(lines[5], realpathSync(box.workspace))
  assert.equal(lines[6], realpathSync(box.workspace), 'a ticket.* hook runs in its workspace')

  const dispatch = await runHooksFor(
    'spv.dispatch',
    { taskId: 'task-1', thread: 't2', project: 'tools/demo', text: 'do it', at: '2026-11-16T00:00:00.000Z' },
    { env: box.env, cwd: box.checkout, workspace: box.workspace, eventId: 'task-1' },
  )
  assert.equal(dispatch.ran, 1)
  assert.equal((await readFile(envB, 'utf8')).trim(), realpathSync(box.checkout), 'a non-ticket hook runs in opts.cwd')

  // cwd 优先级单独断言：workspace 选项 > payload.workspace > opts.cwd。
  assert.equal(hookCwd('ticket.delivered', { workspace: '/from/payload' }, { cwd: '/from/opts', workspace: '/from/opts' }), '/from/opts')
  assert.equal(hookCwd('ticket.delivered', { workspace: '/from/payload' }, { cwd: '/from/opts' }), '/from/payload')
  assert.equal(hookCwd('ticket.delivered', {}, { cwd: '/from/opts' }), '/from/opts')
  assert.equal(hookCwd('inbox.approved', { workspace: '/from/payload' }, { cwd: '/from/opts', workspace: '/from/opts' }), '/from/opts')

  const written = await records(box)
  assert.equal(written.length, 2)
  for (const record of written) {
    assert.equal(typeof record.ts, 'string')
    assert.equal(typeof record.durationMs, 'number')
    assert.ok('exit' in record && 'signal' in record && 'timedOut' in record)
    assert.deepEqual(record.truncated, { stdout: false, stderr: false })
  }
}

/** exit 1 / 超时 / 输出洪水：都记录、都不抛、都不阻止下一个 hook。 */
async function testFailureIsolation() {
  const box = await sandbox()
  const marker = join(box.base, 'order.txt')
  addHook(box, { event: 'spv.dispatch', name: 'fails', script: `echo one >> ${q(marker)}; exit 7` })
  addHook(box, { event: 'spv.dispatch', name: 'hangs', script: 'sleep 5', timeoutMs: 150 })
  addHook(box, {
    event: 'spv.dispatch',
    name: 'floods',
    script:
      'i=0; while [ "$i" -lt 3000 ]; do echo "START-$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; i=$((i+1)); done; echo END',
  })
  addHook(box, { event: 'spv.dispatch', name: 'still runs', script: `echo four >> ${q(marker)}` })

  const summary = await runHooksFor(
    'spv.dispatch',
    { taskId: 'task-bad', thread: 't', project: 'tools/demo', text: 'x', at: '2026-11-16T00:00:00.000Z' },
    { env: box.env, cwd: box.checkout, eventId: 'task-bad' },
  )
  assert.equal(summary.error, undefined, 'runHooksFor never rejects')
  assert.equal(summary.ran, 4)
  const [fails, hangs, floods, last] = summary.records
  assert.equal(fails.exit, 7)
  assert.equal(fails.timedOut, false)
  assert.equal(hangs.timedOut, true)
  assert.equal(hangs.exit, null, 'a killed child has no exit code')
  assert.ok(['SIGTERM', 'SIGKILL'].includes(hangs.signal), `the timeout signals the child (got ${hangs.signal})`)
  assert.ok(hangs.durationMs >= 150 && hangs.durationMs < 5000, 'the timeout bounds the run')
  assert.equal(floods.exit, 0)
  assert.equal(floods.truncated.stdout, true)
  assert.ok(floods.stdout.length <= 8 * 1024, `only the last 8 KiB are kept (got ${floods.stdout.length})`)
  assert.ok(floods.stdout.endsWith('END\n'), 'the tail keeps the end of the output')
  assert.ok(!floods.stdout.includes('START-0-'), 'the head of a flood is dropped')
  assert.equal(last.exit, 0)
  assert.equal((await readFile(marker, 'utf8')).trim(), 'one\nfour', 'hooks run in item order and a failure does not stop the next')

  const written = await records(box)
  assert.equal(written.length, 4, 'every run is recorded, including the failures')
  assert.equal(written[1].timedOut, true)
  assert.ok(written[2].truncated.stdout === true)
}

/** 环境是白名单：凭证样子的变量一个都进不去。 */
async function testSecretEnvIsStripped() {
  const box = await sandbox()
  const out = join(box.base, 'env-all.txt')
  addHook(box, { event: 'spv.dispatch', name: 'dump env', script: `env | sort > ${q(out)}` })
  const env = {
    ...box.env,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: box.home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    TERM: 'dumb',
    TMPDIR: box.base,
    GITHUB_TOKEN: 'gh-secret-value',
    GH_HOST: 'github.example.invalid',
    MY_SECRET: 'secret-value',
    SOME_KEY: 'key-value',
    CREDENTIAL_X: 'credential-value',
    DSH_SUPERAGENT_STATE_DIR: box.state,
    DSH_HOME: '/nope',
  }
  const summary = await runHooksFor(
    'spv.dispatch',
    { taskId: 'task-env', thread: 't', project: 'tools/demo', text: 'x', at: '2026-11-16T00:00:00.000Z' },
    { env, cwd: box.checkout, eventId: 'task-env' },
  )
  assert.equal(summary.ran, 1)
  const text = await readFile(out, 'utf8')
  for (const expected of ['PATH=', 'HOME=', 'LANG=', 'LC_ALL=', 'TMPDIR=', 'WCA_EVENT=', 'WCA_EVENT_ID=', 'WCA_HOME=', 'WCA_CWD=']) {
    assert.ok(text.includes(`${expected}`), `${expected} reaches the hook`)
  }
  for (const secret of ['gh-secret-value', 'github.example.invalid', 'secret-value', 'key-value', 'credential-value', 'DSH_HOME=', 'GITHUB_TOKEN=', 'MY_SECRET=', 'SOME_KEY=', 'CREDENTIAL_X=']) {
    assert.ok(!text.includes(secret), `${secret} is not in the hook environment`)
  }
}

/** 总开关关着：一个脚本都不跑，每次 occurrence 只写一条 paused 记录。 */
async function testPausedAndEmpty() {
  const box = await sandbox()
  const marker = join(box.base, 'ran.txt')
  addHook(box, { event: 'ticket.attention', name: 'marker', script: `echo ran >> ${q(marker)}` })
  setHooks(box, { enabled: false })
  const paused = await runHooksFor(
    'ticket.attention',
    { messageId: 'msg-1', ticketId: 'tk-1', thread: 't', kind: 'notice', text: 'x', at: '2026-11-16T00:00:00.000Z' },
    { env: box.env, cwd: box.checkout, eventId: 'msg-1' },
  )
  assert.equal(paused.paused, true)
  assert.equal(paused.ran, 0)
  assert.equal(paused.skipped, 'paused')
  let written = await records(box)
  assert.equal(written.length, 1, 'exactly one paused marker per event occurrence')
  assert.deepEqual(written[0].skipped, 'paused')
  assert.equal(written[0].event, 'ticket.attention')
  await assert.rejects(readFile(marker, 'utf8'), error => error.code === 'ENOENT', 'nothing ran while paused')

  // 同一次 occurrence 再调用一次：cursor 已认领，连 paused 记录也不再写。
  const again = await runHooksFor('ticket.attention', { messageId: 'msg-1' }, { env: box.env, cwd: box.checkout, eventId: 'msg-1' })
  assert.equal(again.skipped, 'cursor')
  assert.equal((await records(box)).length, 1)

  // 打开之后，同一个 occurrence 不补跑（暂停期间的旧消息不重放）。
  setHooks(box, { enabled: true })
  const afterResume = await runHooksFor('ticket.attention', { messageId: 'msg-1' }, { env: box.env, cwd: box.checkout, eventId: 'msg-1' })
  assert.equal(afterResume.skipped, 'cursor')
  await assert.rejects(readFile(marker, 'utf8'), error => error.code === 'ENOENT')

  // 空 items 与"全部 disabled"：不跑脚本、不写记录，但 occurrence 会被静默认领，避免以后加了第一个
  // hook 时把 outbox/read/ 的历史消息全部补跑一遍。
  const emptyBox = await sandbox()
  const emptyPayload = { itemId: 'i-1', reviewIndex: 0 }
  const emptyRun = await runHooksFor('inbox.approved', emptyPayload, { env: emptyBox.env, cwd: emptyBox.checkout })
  assert.equal(emptyRun.skipped, 'empty')
  assert.equal(emptyRun.ran, 0)
  assert.equal(emptyRun.eventId, 'inbox.approved:i-1:0')
  await assert.rejects(readFile(emptyBox.records, 'utf8'), error => error.code === 'ENOENT', 'empty items write no record')
  assert.equal(hasEvent('inbox.approved:i-1:0', { env: emptyBox.env }), true, 'an empty occurrence is still claimed')
  // 同一个 occurrence 再来一次：cursor 命中，不再触发任何东西。
  assert.equal(
    (await runHooksFor('inbox.approved', emptyPayload, { env: emptyBox.env, cwd: emptyBox.checkout })).skipped,
    'cursor',
  )
  // 现在才加第一个 hook：历史 occurrence 不会被补跑。
  const lateMarker = join(emptyBox.base, 'late.txt')
  addHook(emptyBox, { event: 'inbox.approved', name: 'late', script: `echo ran >> ${q(lateMarker)}` })
  const lateRun = await runHooksFor('inbox.approved', emptyPayload, { env: emptyBox.env, cwd: emptyBox.checkout })
  assert.equal(lateRun.skipped, 'cursor')
  await assert.rejects(readFile(lateMarker, 'utf8'), error => error.code === 'ENOENT', 'history is not replayed')

  const disabledBox = await sandbox()
  addHook(disabledBox, { event: 'inbox.approved', name: 'off', enabled: false, script: 'echo nope' })
  const disabledRun = await runHooksFor('inbox.approved', emptyPayload, { env: disabledBox.env, cwd: disabledBox.checkout })
  assert.equal(disabledRun.skipped, 'empty')
  await assert.rejects(readFile(disabledBox.records, 'utf8'), error => error.code === 'ENOENT', 'a disabled row writes nothing')
  assert.equal(hasEvent('inbox.approved:i-1:0', { env: disabledBox.env }), true, 'an all-disabled occurrence is claimed too')
}

/** cursor：同一个 id 只跑一次，跨进程（重启）成立。 */
async function testCursorAcrossRestart() {
  const box = await sandbox()
  const marker = join(box.base, 'occ.txt')
  addHook(box, {
    event: 'ticket.delivered',
    name: 'append occurrence',
    script: `printf '%s\\n' "$WCA_EVENT_ID" >> ${q(marker)}`,
  })
  const payload = {
    messageId: 'occ-1',
    ticketId: 'tk-1',
    thread: 't',
    kind: 'reply',
    text: 'x',
    at: '2026-11-16T00:00:00.000Z',
  }
  const first = await runHooksFor('ticket.delivered', payload, { env: box.env, cwd: box.checkout, eventId: 'occ-1' })
  assert.equal(first.ran, 1)
  assert.equal(first.derived, false)
  const second = await runHooksFor('ticket.delivered', payload, { env: box.env, cwd: box.checkout, eventId: 'occ-1' })
  assert.equal(second.skipped, 'cursor')
  assert.equal(second.ran, 0)
  assert.equal((await readFile(marker, 'utf8')).trim(), 'occ-1')

  // 重启 = 新进程读同一个 cursor 文件：不重跑。
  const restart = runInFreshProcess(box, { event: 'ticket.delivered', payload, eventId: 'occ-1' })
  assert.equal(restart.status, 0, restart.stderr)
  assert.equal(JSON.parse(restart.stdout).skipped, 'cursor')
  assert.equal((await readFile(marker, 'utf8')).trim(), 'occ-1', 'a fresh process does not re-run a claimed id')

  // 新的 id 在新进程里照常跑。
  const nextPayload = { ...payload, messageId: 'occ-2' }
  const next = runInFreshProcess(box, { event: 'ticket.delivered', payload: nextPayload, eventId: 'occ-2' })
  assert.equal(next.status, 0, next.stderr)
  assert.equal(JSON.parse(next.stdout).ran, 1)
  assert.deepEqual((await readFile(marker, 'utf8')).trim().split('\n'), ['occ-1', 'occ-2'])

  const cursor = readCursor({ env: box.env })
  assert.equal(cursor.version, 1)
  assert.ok(Object.hasOwn(cursor.ids, 'occ-1'))
  assert.ok(Object.hasOwn(cursor.ids, 'occ-2'))
  assert.equal(typeof cursor.updatedAt, 'string')
  assert.equal(hasEvent('occ-1', { env: box.env }), true)
  assert.equal(hasEvent('occ-3', { env: box.env }), false)
  assert.equal(claimEvent('occ-3', { env: box.env }), true)
  assert.equal(claimEvent('occ-3', { env: box.env }), false, 'claiming is atomic')
  assert.equal(eventsCursorPath({ env: box.env }), box.cursor)
  // Atomic write, sticky 0644, no temporary file left behind.
  assert.equal((await stat(box.cursor)).mode & 0o777, 0o644)
  assert.deepEqual(
    (await readdir(join(box.root, 'records'))).filter(name => name.includes('.tmp-')),
    [],
    'the cursor write leaves no temporary file',
  )

  // 没有可派生 id 的 occurrence 不写 cursor，也不会被去重。
  const unkeyedMarker = join(box.base, 'unkeyed.txt')
  addHook(box, { event: 'spv.dispatch', name: 'unkeyed', script: `echo ran >> ${q(unkeyedMarker)}` })
  const unkeyed = { taskId: undefined }
  assert.equal(eventIdFor('spv.dispatch', unkeyed), undefined)
  const runA = await runHooksFor('spv.dispatch', { thread: 't', text: 'x' }, { env: box.env, cwd: box.checkout })
  const runB = await runHooksFor('spv.dispatch', { thread: 't', text: 'x' }, { env: box.env, cwd: box.checkout })
  assert.equal(runA.ran, 1)
  assert.equal(runB.ran, 1, 'an occurrence with no stable id is not deduplicated')
  assert.equal((await readFile(unkeyedMarker, 'utf8')).trim().split('\n').length, 2)
}

/** 队列原语：读两个目录、去重、排序、cursor 过滤、绝不消费。 */
async function testQueuePrimitives() {
  const box = await sandbox()
  const dirs = dirsOf(box.queue)
  await mkdir(dirs.outbox, { recursive: true })
  await mkdir(dirs.read, { recursive: true })
  await writeMessage(dirs, {
    id: 'm-ack',
    source: 'spv',
    thread: 'inbox-1',
    kind: 'acknowledgement',
    text: '收到',
    at: '2026-11-16T00:00:01.000Z',
    ticketId: 'tk-1',
  })
  await writeMessage(dirs, {
    id: 'm-reply',
    source: 'spv',
    thread: 'inbox-1',
    kind: 'reply',
    text: '做完了',
    at: '2026-11-16T00:00:02.000Z',
    ticketId: 'tk-1',
  })
  await writeMessage(dirs, {
    id: 'm-notice',
    source: 'spv',
    thread: 'inbox-2',
    kind: 'notice',
    text: '停下来了',
    at: '2026-11-16T00:00:03.000Z',
  })
  await writeMessage(dirs, { id: 'm-mystery', source: 'spv', thread: 't', kind: 'mystery', text: '?', at: '2026-11-16T00:00:04.000Z' })
  // A duplicate copy of one message in the archive: dedupe must keep exactly one.
  await copyFile(join(dirs.outbox, 'm-notice.json'), join(dirs.read, 'm-notice.json'))
  // The injector consumed m-reply before any hook ran: archive-only, must still be replayed once.
  await rename(join(dirs.outbox, 'm-reply.json'), join(dirs.read, 'm-reply.json'))
  const before = {
    outbox: (await readdir(dirs.outbox)).sort(),
    read: (await readdir(dirs.read)).sort(),
  }

  const events = await readQueueEvents({ env: box.env })
  assert.deepEqual(events.map(entry => entry.eventId), ['m-ack', 'm-reply', 'm-notice'], 'oldest first, deduped, kinds mapped')
  assert.deepEqual(events.map(entry => entry.event), [
    'ticket.acknowledged',
    'ticket.delivered',
    'ticket.attention',
  ])
  assert.deepEqual(events[1].payload, {
    messageId: 'm-reply',
    kind: 'reply',
    text: '做完了',
    thread: 'inbox-1',
    file: join(dirs.read, 'm-reply.json'),
    at: '2026-11-16T00:00:02.000Z',
    ticketId: 'tk-1',
  })
  assert.equal(events[2].payload.thread, 'inbox-2')
  assert.equal(events[2].payload.ticketId, undefined, 'a notice without a ticket has no ticketId field')
  const after = {
    outbox: (await readdir(dirs.outbox)).sort(),
    read: (await readdir(dirs.read)).sort(),
  }
  assert.deepEqual(after, before, 'the reader never renames or consumes a message')

  // 跑掉 reply：cursor 认领之后它不再出现；archive 里的旧消息重放恰好一次。
  const marker = join(box.base, 'delivered.txt')
  addHook(box, { event: 'ticket.delivered', name: 'count', script: `echo "$WCA_EVENT_ID" >> ${q(marker)}` })
  const delivered = events.find(entry => entry.event === 'ticket.delivered')
  const run = await runHooksFor(delivered.event, delivered.payload, {
    env: box.env,
    cwd: box.checkout,
    eventId: delivered.eventId,
  })
  assert.equal(run.ran, 1)
  const afterRun = await readQueueEvents({ env: box.env })
  assert.deepEqual(afterRun.map(entry => entry.eventId), ['m-ack', 'm-notice'])
  assert.deepEqual((await readFile(marker, 'utf8')).trim().split('\n'), ['m-reply'])
  const again = await readQueueEvents({ env: box.env })
  assert.deepEqual(again.map(entry => entry.eventId), ['m-ack', 'm-notice'], 'read-only re-reads do not consume')

  // 通过 dirs 传入（stage 2 可以从 src/spv/paths.js 解析根）：结果一致。
  const viaDirs = await readQueueEvents({ dirs, env: box.env })
  assert.deepEqual(viaDirs.map(entry => entry.eventId), ['m-ack', 'm-notice'])
  assert.deepEqual(QUEUE_EVENT_KINDS, {
    acknowledgement: 'ticket.acknowledged',
    reply: 'ticket.delivered',
    notice: 'ticket.attention',
  })
}

/** 设置往返：add / rename / disable / rm、409、坏文件、旧文件。 */
async function testSettingsRoundTrip() {
  const box = await sandbox()
  const item = addHook(box, {
    event: 'inbox.issue',
    name: 'forward',
    script: 'echo issue',
    timeoutMs: 1500,
  })
  let model = readHooks({ env: box.env })
  assert.deepEqual(model.items, [item])
  assert.equal(model.revision, 1)
  assert.equal(model.items[0].timeoutMs, 1500)

  const renamed = saveSettings({
    env: box.env,
    revision: model.revision,
    hooks: { labels: { 'builtin:prIssue': 'PR 质疑（我改的）' } },
  })
  model = readHooks({ env: box.env })
  assert.equal(model.labels['builtin:prIssue'], 'PR 质疑（我改的）')
  assert.equal(renamed.hooks.items.length, 1, 'a labels-only write keeps the rows')
  const row = model.events.find(entry => entry.id === 'inbox.issue').rows.find(candidate => candidate.id === 'builtin:prIssue')
  assert.equal(row.label, 'PR 质疑（我改的）')
  assert.equal(row.defaultLabel, 'PR「有问题」转给 SPV')
  assert.equal(row.renamed, true)

  saveSettings({ env: box.env, revision: model.revision, hooks: { items: [{ ...item, enabled: false }] } })
  assert.equal(readHooks({ env: box.env }).items[0].enabled, false)

  model = readHooks({ env: box.env })
  saveSettings({ env: box.env, revision: model.revision, hooks: { items: [] } })
  assert.deepEqual(readHooks({ env: box.env }).items, [])
  assert.deepEqual(readHooks({ env: box.env }).labels, { 'builtin:prIssue': 'PR 质疑（我改的）' }, 'deleting a row keeps labels')

  // 过期 revision：409，磁盘一个字节都不动。
  model = readHooks({ env: box.env })
  const before = await readFile(box.settings, 'utf8')
  assert.throws(
    () => saveSettings({ env: box.env, revision: model.revision - 1, hooks: { enabled: false } }),
    error => error.code === 'SETTINGS_CONFLICT',
  )
  assert.equal(await readFile(box.settings, 'utf8'), before)
  assert.equal(readHooks({ env: box.env }).enabled, true)
  assert.equal(readHooks({ env: box.env }).revision, model.revision)

  // 被拒绝的 hooks 写入同样一个字节都不动。
  assert.throws(
    () => saveSettings({ env: box.env, revision: model.revision, hooks: { items: [{ ...item, event: 'nope' }] } }),
    error => error.code === 'SETTINGS_INVALID',
  )
  assert.equal(await readFile(box.settings, 'utf8'), before)

  // 旧文件（没有 hooks 块）仍然有效；坏 JSON 退回默认并给 warning。
  await writeFile(box.settings, `${JSON.stringify({ version: 1, revision: 4, values: {}, templates: {} })}\n`, 'utf8')
  const old = readHooks({ env: box.env })
  assert.equal(old.fileState, 'ok')
  assert.equal(old.revision, 4)
  assert.deepEqual(old.items, [])
  assert.equal(old.enabled, true)

  await writeFile(box.settings, '{ not json', 'utf8')
  const corrupt = readHooks({ env: box.env })
  assert.equal(corrupt.fileState, 'corrupt')
  assert.equal(corrupt.enabled, true)
  assert.equal(corrupt.scriptTimeoutMs, 10000)
  assert.match(corrupt.warning, /not valid JSON/)
  // 坏文件下 runHooksFor 仍然不抛：没有可用的行，就是 no-op。
  const noop = await runHooksFor('spv.dispatch', { taskId: 'x' }, { env: box.env, cwd: box.checkout })
  assert.equal(noop.skipped, 'empty')
}

/** `hook test` 的单个 hook 原语：record:false 不写记录、不认领 cursor。 */
async function testRunOneHookWithoutRecording() {
  const box = await sandbox()
  const item = addHook(box, { event: 'inbox.approved', name: 'echo', script: 'echo single' })
  const record = await runOneHook(item, 'inbox.approved', { itemId: 'i-1', reviewIndex: 0 }, {
    env: box.env,
    cwd: box.checkout,
    record: false,
    eventId: 'test-only',
  })
  assert.equal(record.exit, 0)
  assert.equal(record.stdout, 'single\n')
  await assert.rejects(readFile(box.records, 'utf8'), error => error.code === 'ENOENT', 'record:false writes nothing')
  await assert.rejects(readFile(box.cursor, 'utf8'), error => error.code === 'ENOENT', 'record:false claims no cursor')
}

/** `hook` 子命令：表、增删改、试跑、日志、提示词、退出码。 */
async function testCli() {
  const box = await sandbox()

  const events = cli(box, ['hook', 'events'])
  assert.equal(events.status, 0, events.stderr)
  for (const entry of EVENTS) assert.ok(events.stdout.includes(entry.id), `hook events prints ${entry.id}`)
  assert.match(events.stdout, /cancellable:/)
  assert.match(events.stdout, /rows:/)
  assert.match(events.stdout, /when:/)
  const help = cli(box, ['hook', '--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /usage: wheelchair-agent hook <command>/)
  assert.equal(cli(box, ['hook', 'nope']).status, 2, 'an unknown subcommand is a usage error')
  // 每个子命令都有自己的 --help，而且退出码是 0。
  for (const sub of ['events', 'list', 'add', 'enable', 'disable', 'rm', 'rename', 'test', 'log', 'prompt']) {
    const helped = cli(box, ['hook', sub, '--help'])
    assert.equal(helped.status, 0, `hook ${sub} --help exits 0`)
    assert.ok(
      helped.stdout.includes(`usage: wheelchair-agent hook ${sub}`),
      `hook ${sub} --help prints its own usage`,
    )
  }

  const added = cli(box, [
    'hook',
    'add',
    '--event',
    'ticket.delivered',
    '--name',
    'notify',
    '--script',
    'echo "$WCA_EVENT"; echo "$WCA_EVENT_ID"',
    '--timeout',
    '2500',
  ])
  assert.equal(added.status, 0, added.stderr)
  const id = added.stdout.trim()
  assert.match(id, /^hook-ticket-delivered-[0-9a-f]{6}$/)
  const model = readHooks({ env: box.env })
  assert.equal(model.items.length, 1)
  assert.equal(model.items[0].id, id)
  assert.equal(model.items[0].timeoutMs, 2500)
  assert.equal(model.items[0].enabled, true)

  assert.equal(cli(box, ['hook', 'add', '--event', 'nope', '--name', 'x', '--script', 'true']).status, 2, 'unknown event is a usage error')
  assert.equal(cli(box, ['hook', 'add', '--event', 'ticket.delivered', '--name', 'x']).status, 2, 'missing --script is a usage error')
  assert.equal(
    cli(box, ['hook', 'add', '--event', 'ticket.delivered', '--name', 'x', '--script', 'true', '--timeout', '300001']).status,
    2,
    'a timeout over the hard cap is refused at the CLI',
  )
  assert.equal(
    cli(box, ['hook', 'add', '--event', 'ticket.delivered', '--name', 'bad\u0001name', '--script', 'true']).status,
    2,
    'a control character in --name is a usage error',
  )
  assert.equal(
    cli(box, ['hook', 'add', '--event', 'ticket.delivered', '--name', 'x'.repeat(121), '--script', 'true']).status,
    2,
    'an over-long --name is a usage error',
  )

  const listed = cli(box, ['hook', 'list'])
  assert.equal(listed.status, 0, listed.stderr)
  assert.ok(listed.stdout.includes(id))
  assert.ok(listed.stdout.includes('enabled'))
  assert.ok(listed.stdout.includes('builtin:prepare'))
  assert.ok(listed.stdout.includes('[core]'))

  assert.equal(cli(box, ['hook', 'disable', id]).status, 0)
  assert.equal(readHooks({ env: box.env }).items[0].enabled, false)
  assert.equal(cli(box, ['hook', 'enable', id]).status, 0)
  assert.equal(readHooks({ env: box.env }).items[0].enabled, true)

  const builtinToggle = cli(box, ['hook', 'disable', 'builtin:injection'])
  assert.equal(builtinToggle.status, 1, 'a builtin row cannot be disabled')
  assert.match(builtinToggle.stderr, /core path/)
  const builtinRm = cli(box, ['hook', 'rm', 'builtin:reviewRecord'])
  assert.equal(builtinRm.status, 1)
  assert.match(builtinRm.stderr, /core path/)

  const rename = cli(box, ['hook', 'rename', 'builtin:injection', '我的注入'])
  assert.equal(rename.status, 0, rename.stderr)
  assert.equal(readHooks({ env: box.env }).labels['builtin:injection'], '我的注入')
  const reset = cli(box, ['hook', 'rename', 'builtin:injection', ''])
  assert.equal(reset.status, 0)
  assert.deepEqual(readHooks({ env: box.env }).labels, {})
  assert.equal(cli(box, ['hook', 'rename', id, 'nope']).status, 2, 'rename only accepts builtin ids')
  assert.equal(
    cli(box, ['hook', 'rename', 'builtin:injection', 'x'.repeat(121)]).status,
    2,
    'an invalid label is a usage error, not a runtime failure',
  )
  assert.equal(
    cli(box, ['hook', 'rename', 'builtin:injection', 'bad\u0001label']).status,
    2,
    'a control character in a label is a usage error',
  )

  // hook test：示例负载、不写记录、不认领 cursor；退出码反映脚本结果。
  assert.equal(cli(box, ['hook', 'test', id]).status, 0)
  const tested = cli(box, ['hook', 'test', id])
  assert.equal(tested.status, 0, tested.stderr)
  assert.match(tested.stdout, /test only/)
  assert.match(tested.stdout, /exit: 0/)
  assert.ok(tested.stdout.includes('ticket.delivered'))
  await assert.rejects(readFile(box.records, 'utf8'), error => error.code === 'ENOENT', 'hook test writes no record')
  await assert.rejects(readFile(box.cursor, 'utf8'), error => error.code === 'ENOENT', 'hook test claims no cursor')

  const overridden = cli(box, ['hook', 'test', id, '--event', 'inbox.issue', '--payload', '{"itemId":"i-1","comment":"why","reviewIndex":3}'])
  assert.equal(overridden.status, 0, overridden.stderr)
  assert.match(overridden.stdout, /inbox\.issue/)
  assert.match(overridden.stdout, /"reviewIndex":3/)
  assert.equal(cli(box, ['hook', 'test', id, '--payload', '{not json']).status, 2, 'invalid JSON is a usage error')
  assert.equal(cli(box, ['hook', 'test', 'builtin:injection']).status, 1, 'a builtin row has no script to test')
  assert.equal(cli(box, ['hook', 'test', 'hook-nope-000000']).status, 1)

  // 真跑一次（库调用），再让 hook log 读它。
  const run = await runHooksFor(
    'ticket.delivered',
    { messageId: 'm-log', ticketId: 'tk', thread: 't', kind: 'reply', text: 'x', at: '2026-11-16T00:00:00.000Z' },
    { env: box.env, cwd: box.checkout, eventId: 'm-log' },
  )
  assert.equal(run.ran, 1)
  const log = cli(box, ['hook', 'log', '--tail', '5', '--event', 'ticket.delivered'])
  assert.equal(log.status, 0, log.stderr)
  assert.match(log.stdout, /ticket\.delivered/)
  assert.match(log.stdout, /exit=0/)
  assert.ok(log.stdout.includes(id))
  assert.equal(cli(box, ['hook', 'log', '--tail', '0']).status, 2)
  assert.equal(cli(box, ['hook', 'log', '--event', 'nope']).status, 2)
  const emptyLog = cli(box, ['hook', 'log', '--event', 'inbox.merged'])
  assert.equal(emptyLog.status, 0)
  assert.match(emptyLog.stdout, /no hook records for inbox\.merged/)

  // prompt：事件 id、说明、payload/env、以及要写出来的 hook add 形状。
  const prompt = cli(box, ['hook', 'prompt', 'ticket.delivered'])
  assert.equal(prompt.status, 0, prompt.stderr)
  assert.ok(prompt.stdout.includes('ticket.delivered'))
  assert.ok(prompt.stdout.includes('不是终态'), 'the prompt explains what the event means')
  assert.ok(prompt.stdout.includes('WCA_EVENT_ID'))
  assert.ok(prompt.stdout.includes('wheelchair-agent hook add --event ticket.delivered'))
  assert.ok(prompt.stdout.includes('不要手改 settings.json') || prompt.stdout.includes('不要编辑器手改'))
  assert.ok(prompt.stdout.includes('builtin:injection'))
  assert.equal(cli(box, ['hook', 'prompt', 'ticket.nope']).status, 2)

  const removed = cli(box, ['hook', 'rm', id])
  assert.equal(removed.status, 0, removed.stderr)
  assert.deepEqual(readHooks({ env: box.env }).items, [])
}

/** 超时解析与 sample payload。 */
async function testTimeoutAndSamples() {
  assert.equal(resolveHookTimeout({}, {}), 10000, 'the built-in default')
  assert.equal(resolveHookTimeout({}, { scriptTimeoutMs: 2500 }), 2500, 'hooks.scriptTimeoutMs is the fallback')
  assert.equal(resolveHookTimeout({ timeoutMs: 750 }, { scriptTimeoutMs: 2500 }), 750, 'a per-row timeout wins')
  assert.equal(resolveHookTimeout({ timeoutMs: 999999 }, { scriptTimeoutMs: 2500 }), 300000, 'the hard cap applies')
  assert.equal(resolveHookTimeout({ timeoutMs: 0 }, { scriptTimeoutMs: 2500 }), 2500, 'an invalid row timeout falls back')
  assert.equal(resolveHookTimeout({ timeoutMs: -5 }, { scriptTimeoutMs: 0 }), 10000, 'invalid values fall through to 10000')

  const payload = samplePayload('inbox.issue')
  assert.equal(payload.itemId, 'acme-demo-1')
  assert.equal(payload.thread, 'inbox-1')
  assert.equal(payload.reviewIndex, 0)
  const stamped = samplePayload('ticket.delivered', { now: '2026-02-02T00:00:00.000Z' })
  assert.equal(stamped.at, '2026-02-02T00:00:00.000Z')
  assert.throws(() => samplePayload('nope'), error => error.code === 'UNKNOWN_EVENT')

  // 行内 timeout 真的生效：hooks 默认 5 s，这一行 150 ms。
  const box = await sandbox()
  setHooks(box, { scriptTimeoutMs: 5000 })
  addHook(box, { event: 'spv.dispatch', name: 'short', script: 'sleep 5', timeoutMs: 150 })
  const summary = await runHooksFor(
    'spv.dispatch',
    { taskId: 'task-timeout', at: '2026-11-16T00:00:00.000Z' },
    { env: box.env, cwd: box.checkout, eventId: 'task-timeout' },
  )
  assert.equal(summary.records[0].timedOut, true)
  assert.ok(summary.records[0].durationMs < 5000)
}

/** `buildHookPrompt` 是给面板的同一段文字：不读设置也不抛。 */
async function testPromptIsGeneratedFromTheTable() {
  // `buildHookPrompt` reads the settings model (for the "N custom rows" line), so point it at a
  // sandbox: a test must never resolve the operator's live data root, not even for a read.
  const box = await sandbox()
  for (const entry of EVENTS) {
    const prompt = buildHookPrompt(entry.id, { env: box.env })
    assert.ok(prompt.includes(entry.id))
    assert.ok(prompt.includes(entry.title))
    assert.ok(prompt.includes(entry.explanation.slice(0, 30)))
    assert.ok(prompt.includes(entry.when))
    assert.ok(prompt.includes(`wheelchair-agent hook add --event ${entry.id}`))
    assert.ok(prompt.includes('WCA_EVENT_ID'))
    assert.ok(prompt.includes('core path'))
  }
  const withRows = buildHookPrompt('inbox.issue', { env: box.env })
  assert.ok(withRows.includes('builtin:prIssue'))
  assert.ok(withRows.includes('builtin:spvObjection'))
  const withoutRows = buildHookPrompt('ticket.acknowledged', { env: box.env })
  assert.ok(withoutRows.includes('没有内建行'))
  const attention = buildHookPrompt('ticket.attention', { env: box.env })
  assert.ok(attention.includes('builtin:injection'), 'notice injection is shown on ticket.attention too')
}

/**
 * Stage 3 view: every event rendered from EVENTS, built-ins cannot be toggled, a rename goes through
 * the revision-checked store, prompts are the CLI's prompt byte-for-byte, and the last five runs are
 * newest-first with a trimmed stderr tail.
 */
async function testPanelView() {
  const box = await sandbox()
  const custom = addHook(box, {
    event: 'ticket.delivered',
    name: '我的手机通知',
    script: 'echo "$WCA_EVENT_ID"',
    timeoutMs: 2500,
  })
  const base = snapshot(box)
  const renamed = saveSettings({
    env: box.env,
    revision: base.revision,
    hooks: { labels: { ...base.hooks.labels, 'builtin:injection': '推进 SPV 会话（我改的）' } },
  })
  const panel = buildHookPanel({ env: box.env, settings: renamed, records: [] })

  assert.deepEqual(panel.events.map(event => event.id), EVENTS.map(event => event.id), 'every event, in table order')
  for (const [index, entry] of EVENTS.entries()) {
    const event = panel.events[index]
    assert.equal(event.title, entry.title, `title for ${entry.id}`)
    assert.equal(event.explanation, entry.explanation, `explanation for ${entry.id}`)
    assert.equal(event.when, entry.when, `when for ${entry.id}`)
    assert.equal(event.repeatNote, entry.repeatNote, `repeat note for ${entry.id}`)
    assert.deepEqual(event.payload, entry.payload, `payload for ${entry.id}`)
    assert.equal(event.prompt, buildHookPrompt(entry.id, { env: box.env }), `prompt for ${entry.id} is generated`)
    const cliPrompt = cli(box, ['hook', 'prompt', entry.id])
    assert.equal(cliPrompt.status, 0, `hook prompt ${entry.id} exits 0`)
    assert.equal(event.prompt, cliPrompt.stdout.trim(), `panel prompt equals CLI output for ${entry.id}`)
  }

  const delivered = panel.events.find(event => event.id === 'ticket.delivered')
  const injection = delivered.rows.find(row => row.id === 'builtin:injection')
  assert.equal(injection.label, '推进 SPV 会话（我改的）', 'the built-in label is renamed in the view')
  assert.equal(injection.renamed, true)
  assert.equal(injection.cancellable, false)
  assert.deepEqual(injection.actions, { rename: true, toggle: false, remove: false }, 'a built-in row can only be renamed')
  assert.equal(delivered.customRows.length, 1)
  assert.equal(delivered.customRows[0].id, custom.id)
  assert.equal(delivered.customRows[0].enabled, true)
  assert.equal(delivered.customRows[0].timeoutMs, 2500)
  assert.deepEqual(delivered.customRows[0].actions, { rename: false, toggle: false, remove: false })

  // A stale rename is a 409-class conflict and leaves the stored labels untouched.
  const beforeStale = resolveSettings({ env: box.env })
  assert.throws(
    () =>
      saveSettings({
        env: box.env,
        revision: base.revision,
        hooks: { labels: { 'builtin:injection': 'stale write must lose' } },
      }),
    error => error?.code === 'SETTINGS_CONFLICT',
  )
  const afterStale = resolveSettings({ env: box.env })
  assert.equal(afterStale.revision, beforeStale.revision, 'a rejected rename does not bump the revision')
  assert.equal(afterStale.hooks.labels['builtin:injection'], '推进 SPV 会话（我改的）', 'a rejected rename writes nothing')

  // Six records for the event: only the newest five survive, newest first.
  const now = Date.now()
  const record = (offset, fields) => ({
    ts: new Date(now + offset).toISOString(),
    event: 'ticket.delivered',
    eventId: `occ-${offset}`,
    hookId: custom.id,
    name: '我的手机通知',
    exit: 0,
    durationMs: Math.abs(offset),
    stdout: '',
    stderr: '',
    timedOut: false,
    ...fields,
  })
  const history = [
    record(-5000, { name: 'oldest', exit: 1, stderr: 'old failure' }),
    record(-4000, { exit: 0 }),
    record(-3000, { timedOut: true, exit: null, stderr: 'killed' }),
    record(-2000, { exit: 1, stderr: '\n  boom: details  \n\n', durationMs: 17 }),
    { ts: new Date(now - 1000).toISOString(), event: 'ticket.delivered', eventId: 'occ-paused', skipped: 'paused' },
    record(0, { exit: 0, durationMs: 3 }),
    { ts: new Date(now - 10).toISOString(), event: 'ticket.acknowledged', eventId: 'other', hookId: 'hook-other', name: 'other', exit: 0 },
  ]
  const view = buildHookPanel({ env: box.env, settings: afterStale, records: history })
  const runs = view.events.find(event => event.id === 'ticket.delivered').lastRuns
  assert.equal(runs.length, HOOK_PANEL_RUN_LIMIT, 'the view caps at the last five runs')
  assert.equal(runs[0].durationMs, 3, 'newest run first')
  assert.equal(runs[0].status, 'ok')
  assert.equal(runs[1].status, 'paused', 'the paused occurrence is a run with no row name')
  assert.equal(runs[1].name, null)
  assert.equal(runs[2].status, 'failed')
  assert.equal(runs[2].stderrTail, 'boom: details', 'stderr is trimmed for display')
  assert.equal(runs[3].status, 'timeout')
  assert.equal(runs[4].status, 'ok')
  assert.ok(!runs.some(run => run.name === 'oldest'), 'the sixth-oldest run is dropped')
  assert.equal(view.events.find(event => event.id === 'ticket.acknowledged').lastRuns.length, 1, 'runs stay per event')

  assert.deepEqual(describeHookRun({ skipped: 'paused' }), {
    at: null,
    event: null,
    eventId: null,
    hookId: null,
    name: null,
    status: 'paused',
    durationMs: null,
    exit: null,
    signal: null,
    stderrTail: '',
    error: null,
  })
  assert.deepEqual(latestHookRuns(history, 'ticket.delivered', 1).map(run => run.status), ['ok'])
}

/** cursor 永不裁剪：5100 条历史 id 仍然挡住旧 id，新认领不挤掉任何旧 id。 */
async function testCursorIsDurable() {
  const box = await sandbox()
  await mkdir(join(box.root, 'records'), { recursive: true })
  const ids = {}
  for (let index = 0; index < 5100; index += 1) {
    ids[`old-${String(index).padStart(4, '0')}`] = new Date(1_700_000_000_000 + index).toISOString()
  }
  await writeFile(box.cursor, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), ids })}\n`, 'utf8')
  const marker = join(box.base, 'durable.txt')
  addHook(box, { event: 'ticket.delivered', name: 'durable', script: `echo "$WCA_EVENT_ID" >> ${q(marker)}` })

  assert.equal(Object.keys(readCursor({ env: box.env }).ids).length, 5100, 'reading never prunes')
  assert.equal(hasEvent('old-0000', { env: box.env }), true)
  const replay = await runHooksFor('ticket.delivered', { messageId: 'old-0000' }, { env: box.env, cwd: box.checkout, eventId: 'old-0000' })
  assert.equal(replay.skipped, 'cursor', 'an old claimed id is still skipped')
  await assert.rejects(readFile(marker, 'utf8'), error => error.code === 'ENOENT')

  assert.equal(claimEvent('fresh-id', { env: box.env }), true)
  const after = readCursor({ env: box.env })
  assert.equal(Object.keys(after.ids).length, 5101, 'a new claim preserves every old id')
  assert.ok(Object.hasOwn(after.ids, 'old-0000'))
  assert.ok(Object.hasOwn(after.ids, 'old-5099'))
  assert.ok(Object.hasOwn(after.ids, 'fresh-id'))
  // A brand-new, unclaimed occurrence still runs after the large cursor write.
  const fresh = await runHooksFor('ticket.delivered', { messageId: 'fresh-run' }, { env: box.env, cwd: box.checkout, eventId: 'fresh-run' })
  assert.equal(fresh.ran, 1)
  assert.equal(Object.keys(readCursor({ env: box.env }).ids).length, 5102, 'the new run appends without dropping ids')
}

/** 忽略 SIGTERM 的脚本必须被 SIGKILL 结束（超时升级路径）。 */
async function testSigkillEscalation() {
  const box = await sandbox()
  addHook(box, {
    event: 'spv.dispatch',
    name: 'ignores TERM',
    script: "trap '' TERM; while :; do :; done",
    timeoutMs: 100,
  })
  const summary = await runHooksFor(
    'spv.dispatch',
    { taskId: 'task-kill', thread: 't', project: 'tools/demo', text: 'x', at: '2026-11-16T00:00:00.000Z' },
    { env: box.env, cwd: box.checkout, eventId: 'task-kill' },
  )
  const record = summary.records[0]
  assert.equal(record.timedOut, true)
  assert.equal(record.signal, 'SIGKILL', 'SIGTERM was ignored, so the engine escalated to SIGKILL')
  assert.ok(record.durationMs < 5000, 'the escalation is bounded')
}

/** 坏 cursor：warning + 重放一次，而不是永远卡住；下一次认领修复它。 */
async function testCorruptCursor() {
  const box = await sandbox()
  await mkdir(join(box.root, 'records'), { recursive: true })
  await writeFile(box.cursor, '{ not json', 'utf8')
  const warnings = []
  assert.deepEqual(Object.keys(readCursor({ env: box.env, warn: line => warnings.push(line) }).ids), [])
  assert.match(warnings.join('\n'), /not valid JSON/)

  await writeFile(box.cursor, JSON.stringify({ version: 99, updatedAt: 'x', ids: { a: 'x' } }), 'utf8')
  const versionWarnings = []
  assert.deepEqual(Object.keys(readCursor({ env: box.env, warn: line => versionWarnings.push(line) }).ids), [])
  assert.match(versionWarnings.join('\n'), /unsupported shape/)

  assert.equal(claimEvent('repaired', { env: box.env, warn: () => {} }), true)
  assert.equal(hasEvent('repaired', { env: box.env }), true)
  const repaired = JSON.parse(await readFile(box.cursor, 'utf8'))
  assert.equal(repaired.version, 1)
  assert.ok(Object.hasOwn(repaired.ids, 'repaired'))

  // `runHooksFor` wires its warn sink into the claim: a corrupt cursor warns, and the run still happens.
  const runBox = await sandbox()
  await mkdir(join(runBox.root, 'records'), { recursive: true })
  await writeFile(runBox.cursor, '{ bad', 'utf8')
  const marker = join(runBox.base, 'ran.txt')
  addHook(runBox, { event: 'ticket.delivered', name: 'warn', script: `echo ran >> ${q(marker)}` })
  const runWarnings = []
  const summary = await runHooksFor(
    'ticket.delivered',
    { messageId: 'warn-1' },
    { env: runBox.env, cwd: runBox.checkout, eventId: 'warn-1', warn: line => runWarnings.push(line) },
  )
  assert.equal(summary.ran, 1, 'a corrupt cursor replays once instead of getting stuck')
  assert.match(runWarnings.join('\n'), /not valid JSON/)
  assert.equal((await readFile(marker, 'utf8')).trim(), 'ran')
  assert.equal((await stat(runBox.records)).mode & 0o777, 0o644, 'the record file is 0644')
  assert.equal((await stat(runBox.cursor)).mode & 0o777, 0o644, 'the repaired cursor is 0644')

  // The queue reader forwards the same sink.
  await writeFile(runBox.cursor, '{ bad', 'utf8')
  const readWarnings = []
  assert.deepEqual(await readQueueEvents({ env: runBox.env, warn: line => readWarnings.push(line) }), [])
  assert.match(readWarnings.join('\n'), /not valid JSON/)
}

/** 读不动的记录文件：警告 + 当作空，`hook log` 仍然 exit 0。 */
async function testUnreadableRecords() {
  const box = await sandbox()
  await mkdir(join(box.root, 'records'), { recursive: true })
  await mkdir(box.records) // a directory where hooks.jsonl should be
  const warnings = []
  assert.deepEqual(readHookRecords({ env: box.env, warn: line => warnings.push(line) }), [])
  assert.match(warnings.join('\n'), /cannot read the hook record/)
  const log = cli(box, ['hook', 'log'])
  assert.equal(log.status, 0, log.stderr)
  assert.match(log.stdout, /no hook records yet/)
}

/** 负载边界：大负载完整进 stdin、非对象负载也只是普通 JSON、不抛。 */
async function testPayloadEdges() {
  const box = await sandbox()
  const out = join(box.base, 'stdin-edge.json')
  const item = addHook(box, { event: 'spv.dispatch', name: 'stdin', script: `cat > ${q(out)}` })
  const big = {
    taskId: 'task-big',
    thread: 't',
    project: 'tools/demo',
    text: 'x'.repeat(200_000),
    at: '2026-11-16T00:00:00.000Z',
  }
  const summary = await runHooksFor('spv.dispatch', big, { env: box.env, cwd: box.checkout, eventId: 'task-big' })
  assert.equal(summary.ran, 1)
  assert.deepEqual(await readJson(out), big, 'a large payload reaches stdin whole')

  // Control characters are JSON-escaped on stdin, so the script still receives valid JSON.
  const withControl = {
    taskId: 'task-ctrl',
    thread: 't',
    project: 'tools/demo',
    text: 'a\u0001b\u007fc',
    at: '2026-11-16T00:00:00.000Z',
  }
  const control = await runHooksFor('spv.dispatch', withControl, {
    env: box.env,
    cwd: box.checkout,
    eventId: 'task-ctrl',
  })
  assert.equal(control.ran, 1)
  assert.deepEqual(await readJson(out), withControl, 'a payload with control characters survives as JSON')

  const plain = await runOneHook(item, 'spv.dispatch', 'not-an-object', {
    env: box.env,
    cwd: box.checkout,
    record: false,
    eventId: 'edge-1',
  })
  assert.equal(plain.error, undefined)
  assert.equal(plain.exit, 0)
  assert.equal((await readFile(out, 'utf8')).trim(), '"not-an-object"', 'a non-object payload is still valid JSON')
}

/** 队列排序：缺失/写坏的 `at` 用 mtime 派生的 ISO，不会排到所有日期之前。 */
async function testQueueSortFallback() {
  const box = await sandbox()
  const dirs = dirsOf(box.queue)
  await mkdir(dirs.outbox, { recursive: true })
  // Everything is relative to `now`, and the mtimes are set explicitly, so the expected order cannot
  // depend on the wall clock being after a hard-coded date or on the filesystem's write order.
  const now = Date.now()
  const datedAt = new Date(now - 60_000).toISOString()
  const noAtMtime = new Date(now - 30_000)
  const badAtMtime = new Date(now - 20_000)
  await writeMessage(dirs, { id: 'dated', source: 'spv', thread: 't', kind: 'reply', text: 'dated', at: datedAt })
  await writeMessage(dirs, { id: 'no-at', source: 'spv', thread: 't', kind: 'reply', text: 'no at' })
  await writeMessage(dirs, { id: 'bad-at', source: 'spv', thread: 't', kind: 'reply', text: 'bad', at: 'not-a-date' })
  await utimes(join(dirs.outbox, 'no-at.json'), noAtMtime, noAtMtime)
  await utimes(join(dirs.outbox, 'bad-at.json'), badAtMtime, badAtMtime)

  const events = await readQueueEvents({ env: box.env })
  assert.equal(events.length, 3)
  assert.deepEqual(
    events.map(entry => entry.eventId),
    ['dated', 'no-at', 'bad-at'],
    'a dated message sorts before missing/invalid at, which fall back to their mtimes',
  )
  assert.equal(events[1].payload.at, noAtMtime.toISOString(), 'a missing at becomes its mtime as ISO')
  assert.equal(events[2].payload.at, badAtMtime.toISOString(), 'an invalid at becomes its mtime as ISO')
}

/** 显式 `hook test` 总是会跑：disabled 行与总开关关闭都不阻止它，只各加一条 note。 */
async function testExplicitTestRunsAnyway() {
  const box = await sandbox()
  const added = cli(box, ['hook', 'add', '--event', 'ticket.attention', '--name', 'off', '--script', 'echo explicit'])
  assert.equal(added.status, 0, added.stderr)
  const id = added.stdout.trim()
  assert.equal(cli(box, ['hook', 'disable', id]).status, 0)

  const disabledRow = cli(box, ['hook', 'test', id])
  assert.equal(disabledRow.status, 0, disabledRow.stderr)
  assert.match(disabledRow.stdout, /this row is disabled; hook test runs it anyway/)
  assert.match(disabledRow.stdout, /explicit/)

  setHooks(box, { enabled: false })
  const pausedEngine = cli(box, ['hook', 'test', id])
  assert.equal(pausedEngine.status, 0, pausedEngine.stderr)
  assert.match(pausedEngine.stdout, /hooks\.enabled is false; hook test runs it anyway/)
  assert.match(pausedEngine.stdout, /explicit/)
  // still no real occurrence
  await assert.rejects(readFile(box.records, 'utf8'), error => error.code === 'ENOENT')
  await assert.rejects(readFile(box.cursor, 'utf8'), error => error.code === 'ENOENT')

  // ticket.started's documented sample used to point at /home/operator/...; the test must use a real cwd.
  const started = cli(box, ['hook', 'add', '--event', 'ticket.started', '--name', 'started', '--script', 'printf started'])
  assert.equal(started.status, 0, started.stderr)
  const startedTest = cli(box, ['hook', 'test', started.stdout.trim()])
  assert.equal(startedTest.status, 0, startedTest.stderr)
  assert.match(startedTest.stdout, /cwd: /)
}

/** 队列根的 ticket-clone 守卫：默认根从 clone 里必须拒绝，显式覆盖照旧。 */
async function testQueueRootCloneGuard() {
  const box = await sandbox()
  const tree = join(box.state, 'work', 'ticket-0123456789ab')
  await cp(join(REPO, 'src'), join(tree, 'src'), { recursive: true })
  const cloned = await import(pathToFileURL(join(tree, 'src', 'shared', 'hooks.js')).href)
  const env = { HOME: box.home, DSH_SUPERAGENT_STATE_DIR: box.state }

  assert.throws(
    () => cloned.resolveQueueRoot({ env }),
    error => error.code === 'TICKET_CLONE' && /default spv queue root/.test(error.message),
    'the default queue root is refused from a ticket clone',
  )
  await assert.rejects(
    () => cloned.readQueueEvents({ env }),
    error => error.code === 'TICKET_CLONE' && /default spv queue root/.test(error.message),
    'readQueueEvents({}) refuses the default queue root from a clone instead of reading live state',
  )
  // Explicit overrides win: $SPV_QUEUE_DIR, root and dirs are all honoured.
  assert.equal(cloned.resolveQueueRoot({ env: { ...env, SPV_QUEUE_DIR: box.queue } }), box.queue)
  assert.deepEqual(await cloned.readQueueEvents({ env: { ...env, SPV_QUEUE_DIR: box.queue } }), [])
  assert.deepEqual(await cloned.readQueueEvents({ env, root: box.queue }), [])
  assert.deepEqual(await cloned.readQueueEvents({ env, dirs: dirsOf(box.queue) }), [])
}

// ------------------------------------------------------------ stage-2 wiring

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(10)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

async function waitForText(file, label, timeoutMs = 8000) {
  await waitFor(async () => {
    try {
      await stat(file)
      return true
    } catch {
      return false
    }
  }, label, timeoutMs)
  return readFile(file, 'utf8')
}

/** Wait until the hook wrote a complete JSON payload (the marker file appears before `cat` finishes). */
/** Wait until hooks.jsonl contains every expected record; the marker may appear before the record append. */
async function waitForRecords(box, predicate, label, timeoutMs = 12000) {
  let found = []
  await waitFor(async () => {
    found = await readHookRecords({ env: box.env })
    return predicate(found)
  }, label, timeoutMs)
  return found
}

async function waitForJson(file, label, timeoutMs = 8000) {
  let value
  await waitFor(async () => {
    try {
      value = JSON.parse(await readFile(file, 'utf8'))
      return true
    } catch {
      return false
    }
  }, label, timeoutMs)
  return value
}

function startTestRunner(box, { intervalSecondsOf = () => 0, log = () => {} } = {}) {
  return startHookRunner({
    env: box.env,
    home: box.root,
    stateDir: box.state,
    queueRootOf: () => box.queue,
    intervalSecondsOf,
    log,
    unref: true,
  })
}

/** The inbox/dispatch wiring reads process.env directly; pin it to the sandbox for the duration. */
async function withSandboxEnv(box, fn) {
  const saved = { ...process.env }
  for (const key of Object.keys(process.env)) {
    if (!(key in box.env)) delete process.env[key]
  }
  Object.assign(process.env, box.env)
  try {
    return await fn()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key]
    }
    Object.assign(process.env, saved)
  }
}

/** `hooks.intervalSeconds`: default 15, 0 pauses, invalid rejected, over-cap read clamps with a warning. */
async function testStage2IntervalSetting() {
  const box = await sandbox()
  assert.equal(snapshot(box).hooks.intervalSeconds, 15, 'the default runner interval is 15s')
  const off = setHooks(box, { intervalSeconds: 0 })
  assert.equal(off.hooks.intervalSeconds, 0)
  assert.equal(readHooks({ env: box.env }).intervalSeconds, 0)
  assert.deepEqual((await readJson(box.settings)).hooks, { intervalSeconds: 0 }, '0 is persisted, the 15 default is not')
  assert.throws(() => setHooks(box, { intervalSeconds: -1 }), /zero .*or more seconds/)
  assert.throws(() => setHooks(box, { intervalSeconds: 1.5 }), /whole number/)
  assert.throws(() => setHooks(box, { intervalSeconds: 86401 }), /at most 86400/)
  const raw = await readJson(box.settings)
  raw.hooks = { ...(raw.hooks ?? {}), intervalSeconds: 900000 }
  await writeFile(box.settings, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  const clamped = readHooks({ env: box.env })
  assert.equal(clamped.intervalSeconds, 86400, 'a hand-edited over-cap interval clamps on read')
  assert.match(clamped.warning, /over the 86400s cap/)
}

/** The runner reads the spool and the queue, maps the three ticket events, and is exactly-once. */
async function testStage2RunnerAndSpool() {
  const box = await sandbox()
  const markers = join(box.base, 'markers')
  await mkdir(markers, { recursive: true })
  const marker = name => join(markers, `${name}.json`)
  const add = (event, name, script = `cat > ${q(marker(name))}`) => addHook(box, { event, name, script })
  await add('ticket.acknowledged', 'ack')
  await add('ticket.started', 'started')
  await add('spv.dispatch', 'dispatch')
  await add(
    'ticket.delivered',
    'delivered',
    `cat > ${q(marker('delivered'))}; printf 'x\n' >> ${q(join(markers, 'delivered.count'))}`,
  )
  await add(
    'ticket.attention',
    'attention',
    `cat > ${q(marker('attention'))}; printf 'x\n' >> ${q(join(markers, 'attention.count'))}`,
  )

  const runner = startTestRunner(box)
  try {
    await writeMessage(dirsOf(box.queue), {
      id: 'm-ack',
      source: 'spv',
      thread: 'main',
      kind: 'acknowledgement',
      text: 'ok',
      at: '2026-11-16T00:00:01.000Z',
    })
    await runner.drainOnce()
    const ack = await waitForJson(marker('ack'), 'the acknowledgement payload')
    assert.equal(ack.messageId, 'm-ack')
    assert.equal(ack.kind, 'acknowledgement')
    assert.equal(ack.thread, 'main')
    assert.equal(ack.file, join(box.queue, 'outbox', 'm-ack.json'))
    assert.equal(ack.text, 'ok')

    // A reply already consumed into outbox/read is replayed by the archive reader exactly once.
    await mkdir(join(box.queue, 'outbox', 'read'), { recursive: true })
    await writeMessage(dirsOf(box.queue), {
      id: 'm-reply',
      source: 'spv',
      thread: 'main',
      kind: 'reply',
      text: 'done',
      at: '2026-11-16T00:00:01.500Z',
    })
    await rename(join(box.queue, 'outbox', 'm-reply.json'), join(box.queue, 'outbox', 'read', 'm-reply.json'))
    await runner.drainOnce()
    await runner.drainOnce()
    const delivered = await waitForJson(marker('delivered'), 'the delivered payload')
    assert.equal(delivered.messageId, 'm-reply')
    assert.equal(delivered.kind, 'reply')
    assert.equal(delivered.text, 'done')
    assert.equal(delivered.file, join(box.queue, 'outbox', 'read', 'm-reply.json'))
    assert.equal(
      (await readFile(join(markers, 'delivered.count'), 'utf8')).trim().split('\n').length,
      1,
      'an archived message runs exactly once',
    )

    const startedPayload = {
      ticketId: 'tk-1',
      name: 'n1',
      project: 'tools/demo',
      workspace: box.workspace,
      at: '2026-11-16T00:00:02.000Z',
    }
    const spoolFile = writeHookSpoolEvent('ticket.started', startedPayload, {
      eventId: 'tk-1:at-1',
      env: box.env,
    })
    assert.ok(spoolFile, 'the spool writer returns the file')
    await runner.drainOnce()
    assert.deepEqual(await waitForJson(marker('started'), 'the ticket.started payload'), startedPayload)
    await waitFor(async () => {
      try {
        await stat(spoolFile)
        return false
      } catch {
        return true
      }
    }, 'the spool file to be removed after the run')

    await withSandboxEnv(box, async () => {
      await submitTask(dirsOf(box.queue), { project: 'tools/demo', task: 'do it', thread: 'main' })
    })
    await runner.drainOnce()
    const dispatched = await waitForJson(marker('dispatch'), 'the spv.dispatch payload')
    assert.equal(dispatched.project, 'tools/demo')
    assert.equal(dispatched.thread, 'main')
    assert.equal(dispatched.text, 'do it')
    assert.match(dispatched.taskId, /^[0-9a-f]{32}$/)

    // Exactly-once: one occurrence, two ticks, a fresh runner reading the same cursor.
    await writeMessage(dirsOf(box.queue), {
      id: 'm-notice',
      source: 'spv',
      thread: 'main',
      kind: 'notice',
      text: 'look',
      at: '2026-11-16T00:00:03.000Z',
    })
    await runner.drainOnce()
    await runner.drainOnce()
    const attention = await waitForJson(marker('attention'), 'the attention payload')
    assert.equal(attention.messageId, 'm-notice')
    assert.equal(attention.kind, 'notice')
    assert.equal(attention.text, 'look')
    const countOf = async () => (await readFile(join(markers, 'attention.count'), 'utf8')).trim().split('\n').length
    assert.equal(await countOf(), 1, 'two ticks, one occurrence, one run')
    const fresh = startTestRunner(box)
    await fresh.drainOnce()
    fresh.stop()
    await fresh.done
    assert.equal(await countOf(), 1, 'a fresh runner (restart) does not re-run the occurrence')

    // A malformed spool file is quarantined, not retried forever.
    const spoolDir = hookSpoolDir({ env: box.env })
    const bad = join(spoolDir, 'bad.json')
    await writeFile(bad, '{not json', 'utf8')
    await runner.drainOnce()
    await waitFor(async () => {
      try {
        await stat(`${bad}.bad`)
        return true
      } catch {
        return false
      }
    }, 'the bad spool file to be quarantined')

    // A very long queue body is truncated and points at the file with the full text.
    const long = 'x'.repeat(13000)
    await writeMessage(dirsOf(box.queue), {
      id: 'm-long',
      source: 'spv',
      thread: 'main',
      kind: 'reply',
      text: long,
      at: '2026-11-16T00:00:04.000Z',
    })
    const events = await readQueueEvents({ env: box.env })
    const longEvent = events.find(entry => entry.eventId === 'm-long')
    assert.ok(longEvent, 'the long message is offered')
    assert.equal(longEvent.payload.text.length, 12000)
    assert.equal(longEvent.payload.textTruncated, true)
    assert.equal(longEvent.payload.file, join(box.queue, 'outbox', 'm-long.json'))
  } finally {
    runner.stop()
    await runner.done
  }

  // `hooks.intervalSeconds: 0` pauses the runner: no reads, no runs.
  const pausedBox = await sandbox()
  const pausedMarker = join(pausedBox.base, 'paused.marker')
  await addHook(pausedBox, {
    event: 'ticket.acknowledged',
    name: 'paused',
    script: `touch ${q(pausedMarker)}`,
  })
  await writeMessage(dirsOf(pausedBox.queue), {
    id: 'm-paused',
    source: 'spv',
    thread: 'main',
    kind: 'acknowledgement',
    text: 'x',
    at: '2026-11-16T00:00:05.000Z',
  })
  const paused = startTestRunner(pausedBox, { intervalSecondsOf: () => 0 })
  await sleep(1200)
  await assert.rejects(() => stat(pausedMarker), 'interval 0 runs nothing')
  paused.stop()
  await paused.done
}

/** approve / issue fire after the core write, and a failing or hanging hook cannot undo it. */
async function testStage2InboxWiring() {
  const box = await sandbox()
  const marker = join(box.base, 'approved.json')
  await addHook(box, { event: 'inbox.approved', name: 'approved', script: `cat > ${q(marker)}` })
  const item = {
    id: 'acme-demo-1',
    kind: 'pr',
    pr: 1,
    repo: 'acme/demo',
    title: 'demo',
    url: 'https://github.com/acme/demo/pull/1',
    state: 'OPEN',
    body: '',
    at: new Date().toISOString(),
    review: [],
  }
  await writeItem(box.inbox, item)

  await withSandboxEnv(box, async () => {
    await appendReview(box.inbox, { id: item.id, kind: 'approve', text: 'ok' })
  })
  const approved = await waitForJson(marker, 'the inbox.approved payload')
  assert.equal(approved.itemId, item.id)
  assert.equal(approved.kind, 'pr')
  assert.equal(approved.pr, 1)
  assert.equal(approved.repo, 'acme/demo')
  assert.equal(approved.reviewIndex, 0)
  assert.equal(approved.comment, 'ok')
  assert.equal((await readJson(join(box.inbox, `${item.id}.json`))).review.length, 1, 'the review is persisted')

  const issueMarker = join(box.base, 'issue.json')
  await addHook(box, { event: 'inbox.issue', name: 'issue', script: `cat > ${q(issueMarker)}` })
  await withSandboxEnv(box, async () => {
    await appendReview(box.inbox, { id: item.id, kind: 'issue', text: 'bad' })
  })
  const issue = await waitForJson(issueMarker, 'the inbox.issue payload')
  assert.equal(issue.itemId, item.id)
  assert.equal(issue.kind, 'pr')
  assert.equal(issue.pr, 1)
  assert.equal(issue.reviewIndex, 1)
  assert.equal(issue.comment, 'bad')
  assert.equal(issue.messageId, 'inbox-acme-demo-1-review-1')
  assert.equal(issue.thread, 'inbox-1')
  assert.ok((await readdir(join(box.queue, 'outbox'))).includes('inbox-acme-demo-1-review-1.json'), 'the notice is queued')

  // Regression: the inbox.issue occurrence must not claim the notice's message id, or the queue reader's
  // ticket.attention occurrence (same notice id) would be swallowed by the global cursor.
  const attentionMarker = join(box.base, 'attention-after-issue.json')
  await addHook(box, {
    event: 'ticket.attention',
    name: 'attention-after-issue',
    script: `cat > ${q(attentionMarker)}`,
  })
  const attentionRunner = startTestRunner(box)
  try {
    await attentionRunner.drainOnce()
  } finally {
    attentionRunner.stop()
    await attentionRunner.done
  }
  const attentionPayload = await waitForJson(attentionMarker, 'ticket.attention for the same notice')
  assert.equal(attentionPayload.messageId, 'inbox-acme-demo-1-review-1')
  assert.equal(attentionPayload.kind, 'notice')

  // Failing + hanging hooks are recorded; the next hook still runs and the approve is still persisted.
  const isoMarker = join(box.base, 'after-failure.json')
  const failing = await addHook(box, { event: 'inbox.approved', name: 'fail', script: 'exit 1' })
  const hanging = await addHook(box, { event: 'inbox.approved', name: 'hang', script: 'sleep 5', timeoutMs: 100 })
  const after = await addHook(box, {
    event: 'inbox.approved',
    name: 'after',
    script: `printf 'noise\\n' >&2; cat > ${q(isoMarker)}`,
  })
  await withSandboxEnv(box, async () => {
    await appendReview(box.inbox, { id: item.id, kind: 'approve', text: 'again' })
  })
  await waitForText(isoMarker, 'the hook after the failing and timing-out ones')
  const stored = await readJson(join(box.inbox, `${item.id}.json`))
  assert.equal(stored.review.length, 3, 'the approve review is still persisted after the hook failures')
  const records = await waitForRecords(
    box,
    list =>
      list.some(record => record.hookId === failing.id && record.exit === 1) &&
      list.some(record => record.hookId === hanging.id && record.timedOut === true) &&
      list.some(record => record.hookId === after.id && record.exit === 0) &&
      list.some(record => record.hookId === after.id && String(record.stderr).includes('noise')),
    'the failing, timing-out and following inbox.approved records',
  )
  assert.ok(records.some(record => record.hookId === failing.id && record.exit === 1), 'the exit-1 hook is recorded')
  assert.ok(records.some(record => record.hookId === hanging.id && record.timedOut === true), 'the timeout is recorded')
  assert.ok(records.some(record => record.hookId === after.id && record.exit === 0), 'the next hook ran')
  assert.ok(
    records.some(record => record.hookId === after.id && String(record.stderr).includes('noise')),
    'a hook that writes to stderr still runs and is recorded',
  )

  // inbox.issue fires for a letter (spv_message) too; no repo/pr, the letter's own thread.
  const letterMarker = join(box.base, 'letter-issue.json')
  await addHook(box, { event: 'inbox.issue', name: 'letter', script: `cat > ${q(letterMarker)}` })
  const letter = {
    id: 'spv-main-20260101-0001',
    kind: 'spv_message',
    thread: 'main',
    title: 'decision',
    body: 'body',
    at: new Date().toISOString(),
    review: [],
  }
  await writeItem(box.inbox, letter)
  await withSandboxEnv(box, async () => {
    await appendReview(box.inbox, { id: letter.id, kind: 'issue', text: 'object' })
  })
  const letterPayload = await waitForJson(letterMarker, 'the letter inbox.issue payload')
  assert.equal(letterPayload.itemId, letter.id)
  assert.equal(letterPayload.kind, 'spv_message')
  assert.equal(letterPayload.pr, undefined)
  assert.equal(letterPayload.repo, undefined)
  assert.equal(letterPayload.thread, 'main')
  assert.equal(letterPayload.reviewIndex, 0)
  assert.equal(letterPayload.messageId, `inbox-${letter.id}-review-0`)
}


try {
  await testStage2IntervalSetting()
  await testStage2RunnerAndSpool()
  await testStage2InboxWiring()
  await testTableView()
  await testPayloadEnvAndCwd()
  await testFailureIsolation()
  await testSecretEnvIsStripped()
  await testPausedAndEmpty()
  await testCursorAcrossRestart()
  await testCursorIsDurable()
  await testSigkillEscalation()
  await testCorruptCursor()
  await testUnreadableRecords()
  await testPayloadEdges()
  await testQueueSortFallback()
  await testQueueRootCloneGuard()
  await testQueuePrimitives()
  await testSettingsRoundTrip()
  await testRunOneHookWithoutRecording()
  await testCli()
  await testTimeoutAndSamples()
  await testExplicitTestRunsAnyway()
  await testPromptIsGeneratedFromTheTable()
  await testPanelView()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) process.env[key] = value
}
