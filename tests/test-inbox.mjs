#!/usr/bin/env node
/**
 * tests/test-inbox.mjs：收件箱的离线可跑证据。
 *
 * 覆盖两类信件与三种审查语义：
 *   - `spv_message` 写入后按 `kind` 读回，且没有 `repo` / `pr`；
 *   - `approve` 带评论：评论进 `review`，不派任务、不发 outbox；
 *   - `approve` 不带评论：同上；
 *   - `issue` on `pr`：恰好一个 `pending/` 任务（thread `inbox-<pr>`），outbox 仍为空；
 *   - `issue` on `spv_message`：零个任务，恰好一条 `notice`，回到信件的 thread，正文带标题、id 与评论原文。
 *
 * 还覆盖 `GET /wheelchair-inbox/items` 的服务端过滤：`kind` / `repo` / `since` / `until` 单独与组合，
 * 以及没有查询参数时与 `readItems()` 完全一致。时间过滤对 PR 使用 `createdAt`（PR 的年龄），不是 watcher
 * 写入的 `at` —— 其中一个 fixture 的 `at` 很新、`createdAt` 很旧，专门证明这一点。
 *
 * 全程离线：只写 `mkdtemp` 沙箱里的文件，不发网络请求，不需要 GitHub 凭据。队列根通过
 * `$SPV_QUEUE_DIR` 指向沙箱，收件箱根由调用参数或 `$SPV_INBOX_DIR` 指定。
 *
 * 用法：node tests/test-inbox.mjs（任一断言失败则 exit 1）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appendReview, createInboxHandler, createSpvMessage, readItem, readItems, writeItem } from '../src/spv/inbox.js'
import { defineSpvTools } from '../src/spv/tools.js'

const CLI = fileURLToPath(new URL('../bin/wheelchair-agent.mjs', import.meta.url))
const SANDBOXES = []

// `appendReview` resolves the panel settings from this env var. Pin it to a fresh directory so a real
// `~/.dsh/state/superagent/panel-settings.json` (for example with custom templates) can never change the
// task/notice text these cases assert; restore it when the suite ends.
const HERMETIC_STATE = await mkdtemp(join(tmpdir(), 'wheelchair-agent-inbox-state-'))
const SAVED_STATE_DIR = process.env.DSH_SUPERAGENT_STATE_DIR
process.env.DSH_SUPERAGENT_STATE_DIR = HERMETIC_STATE

/** 一个 `mkdtemp` 沙箱；所有测试结束后统一删掉。 */
async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'wheelchair-agent-inbox-test-'))
  SANDBOXES.push(base)
  return {
    base,
    inbox: join(base, 'inbox'),
    queue: join(base, 'queue'),
  }
}

/** 把一次调用的队列根指向沙箱；`appendReview` 通过 `resolveRoot()` 读它。 */
function useQueue(dir) {
  process.env.SPV_QUEUE_DIR = dir
}

/** `pending/` 或 `outbox/` 里的 JSON 文件名；目录不存在读成空。 */
async function jsonNames(dir) {
  const names = await readdir(dir).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return names.filter(name => name.endsWith('.json') && !name.startsWith('.')).sort()
}

/** 一个 PR fixture；`at` 是 watcher 写入时刻，`createdAt` 才是 PR 自己的年龄。 */
function prItem(overrides = {}) {
  const id = overrides.id ?? 'acme-alpha-1'
  const pr = overrides.pr ?? 1
  return {
    id,
    kind: 'pr',
    repo: 'acme/alpha',
    pr,
    title: `PR ${pr}`,
    state: 'OPEN',
    additions: 1,
    deletions: 2,
    changedFiles: 3,
    url: `https://github.com/acme/alpha/pull/${pr}`,
    body: 'PR body',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
    at: '2026-11-14T12:00:00.000Z',
    review: [],
    ...overrides,
  }
}

/** 一个 SPV 决策信 fixture；直接写盘，方便固定 `at` 测时间过滤。 */
function spvItem(overrides = {}) {
  return {
    id: 'spv-main-20261113T120000Z-abcd',
    kind: 'spv_message',
    title: 'Decided to retry the deploy',
    body: '**Why:** the first attempt timed out.',
    thread: 'main',
    at: '2026-11-13T12:00:00.000Z',
    review: [],
    ...overrides,
  }
}

/** 调 `GET /wheelchair-inbox/items`；返回 `{status, body}`，不启动监听端口。 */
async function getItems(root, query = '') {
  const handler = createInboxHandler({ root })
  const res = {
    statusCode: 0,
    headers: {},
    text: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined) this.text += String(chunk)
    },
  }
  await handler({ url: `/wheelchair-inbox/items${query}`, method: 'GET' }, res)
  return { status: res.statusCode, body: JSON.parse(res.text) }
}

/** `items` 响应里的 id 列表，保持顺序。 */
const idsOf = payload => payload.items.map(item => item.id)

// ---------------------------------------------------------------- scenarios

/** 写入即按 `kind: "spv_message"` 读回，且没有 PR 字段。 */
async function testWriteSpvMessage() {
  const box = await sandbox()
  const item = await createSpvMessage(box.inbox, {
    title: 'Rolled back the migration',
    body: 'The new index locked the table; I rolled back and will retry after the backup.',
    thread: 'ops',
  })
  assert.equal(item.kind, 'spv_message')
  assert.equal(item.thread, 'ops')
  assert.match(item.id, /^spv-ops-\d{8}T\d{6}Z-[A-Za-z0-9]{4}$/, 'the id is thread + UTC stamp + 4 random chars')
  assert.deepEqual(item.review, [])

  const read = await readItem(box.inbox, item.id)
  assert.equal(read.kind, 'spv_message')
  assert.equal(read.title, 'Rolled back the migration')
  assert.ok(read.body.includes('rolled back'))
  assert.ok(!Object.hasOwn(read, 'repo'), 'an spv_message has no repo')
  assert.ok(!Object.hasOwn(read, 'pr'), 'an spv_message has no pr')
  assert.deepEqual(await jsonNames(box.inbox), [`${item.id}.json`])
}

/** CLI 与工具共用 `createSpvMessage()`：两条入口写出的字段一致。 */
async function testTwoWriterEntryPoints() {
  const box = await sandbox()
  const bodyFile = join(box.base, 'body.md')
  await writeFile(bodyFile, '## Decision\n\n- retried\n- kept the old config\n', 'utf8')
  const state = join(box.base, 'state')
  const env = { ...process.env, DSH_SUPERAGENT_STATE_DIR: state }
  delete env.SPV_INBOX_DIR
  delete env.SPV_QUEUE_DIR
  const stdout = execFileSync(
    process.execPath,
    [CLI, 'inbox', 'add', '--title', 'CLI decision', '--body', `@${bodyFile}`, '--thread', 'cli'],
    { encoding: 'utf8', env },
  )
  const id = stdout.trim()
  const inboxRoot = join(state, 'inbox')
  const written = await readItem(inboxRoot, id)
  assert.equal(written.kind, 'spv_message')
  assert.equal(written.title, 'CLI decision')
  assert.equal(written.thread, 'cli')
  assert.ok(written.body.includes('- retried'), 'the @file body is read verbatim')
  const defaultStdout = execFileSync(
    process.execPath,
    [CLI, 'inbox', 'add', '--title', 'CLI default thread', '--body', 'No --thread passed.'],
    { encoding: 'utf8', env },
  )
  const defaultWritten = await readItem(inboxRoot, defaultStdout.trim())
  assert.equal(defaultWritten.thread, 'main', 'inbox add defaults to the main thread')

  process.env.SPV_INBOX_DIR = join(box.base, 'tool-inbox')
  try {
    const tools = defineSpvTools(box.queue, { agent: undefined })
    const notify = tools.find(tool => tool.name === 'spv_notify')
    assert.ok(notify !== undefined, 'the spv-tools plugin exposes spv_notify')
    assert.match(notify.description, /autonomous decision/i, 'the tool says it records an autonomous decision')
    assert.match(notify.description, /human review inbox/i, 'the tool says where the decision goes')
    const value = await notify.execute({ title: 'Tool decision', body: 'A tool wrote this.', thread: 'ops' })
    assert.equal(value.thread, 'ops')
    const fromTool = await readItem(process.env.SPV_INBOX_DIR, value.id)
    assert.equal(fromTool.kind, 'spv_message')
    assert.equal(fromTool.title, 'Tool decision')
    assert.equal(fromTool.thread, 'ops')
    const defaulted = await notify.execute({ title: 'Default thread', body: 'No thread was passed.' })
    assert.equal(defaulted.thread, 'main', 'spv_notify defaults to the main thread')
  } finally {
    delete process.env.SPV_INBOX_DIR
  }
}

/** `approve` 带评论：评论记录，不派任务，不发 outbox。 */
async function testApproveWithComment() {
  const box = await sandbox()
  useQueue(box.queue)
  const item = prItem({ id: 'acme-alpha-2', pr: 2 })
  await writeItem(box.inbox, item)

  const { item: updated, task } = await appendReview(box.inbox, {
    id: item.id,
    kind: 'approve',
    text: 'Looks right; ship it.',
  })
  assert.equal(task, null)
  assert.equal(updated.review.length, 1)
  assert.equal(updated.review[0].kind, 'approve')
  assert.equal(updated.review[0].text, 'Looks right; ship it.')
  assert.deepEqual(await jsonNames(join(box.queue, 'pending')), [], 'approve never queues a task')
  assert.deepEqual(await jsonNames(join(box.queue, 'outbox')), [], 'approve never writes an outbox message')
}

/** `approve` 带评论同样适用于决策信：评论记录，不派任务，不发 outbox。 */
async function testApproveOnSpvMessage() {
  const box = await sandbox()
  useQueue(box.queue)
  const item = spvItem({ id: 'spv-main-20261113T130000Z-beef' })
  await writeItem(box.inbox, item)

  const { item: updated, task } = await appendReview(box.inbox, {
    id: item.id,
    kind: 'approve',
    text: 'Accepted; the retry was reasonable.',
  })
  assert.equal(task, null)
  assert.equal(updated.review[0].kind, 'approve')
  assert.equal(updated.review[0].text, 'Accepted; the retry was reasonable.')
  assert.deepEqual(await jsonNames(join(box.queue, 'pending')), [])
  assert.deepEqual(await jsonNames(join(box.queue, 'outbox')), [])
}

/** `approve` 不带评论：同样的零副作用。 */
async function testApproveWithoutComment() {
  const box = await sandbox()
  useQueue(box.queue)
  const item = prItem({ id: 'acme-alpha-3', pr: 3 })
  await writeItem(box.inbox, item)

  const { item: updated, task } = await appendReview(box.inbox, { id: item.id, kind: 'approve' })
  assert.equal(task, null)
  assert.equal(updated.review.length, 1)
  assert.equal(updated.review[0].kind, 'approve')
  assert.equal(updated.review[0].text, '')
  assert.deepEqual(await jsonNames(join(box.queue, 'pending')), [])
  assert.deepEqual(await jsonNames(join(box.queue, 'outbox')), [])
}

/** `issue` on a PR：一个 pending 任务，thread 为 `inbox-<pr>`，没有 outbox 消息。 */
async function testIssueOnPr() {
  const box = await sandbox()
  useQueue(box.queue)
  const item = prItem({ id: 'acme-alpha-4', pr: 4 })
  await writeItem(box.inbox, item)

  const { item: updated, task } = await appendReview(box.inbox, {
    id: item.id,
    kind: 'issue',
    text: 'The migration is missing its down path.',
  })
  assert.ok(task !== null)
  assert.equal(updated.review[0].kind, 'issue')
  const pending = await jsonNames(join(box.queue, 'pending'))
  assert.equal(pending.length, 1, 'exactly one task is queued')
  const record = JSON.parse(await readFile(join(box.queue, 'pending', pending[0]), 'utf8'))
  assert.equal(record.thread, 'inbox-4')
  assert.equal(record.project, 'tools/alpha')
  assert.ok(record.text.includes('The migration is missing its down path.'))
  assert.deepEqual(await jsonNames(join(box.queue, 'outbox')), [], 'a PR issue does not message SPV')
}

/** 旧磁盘记录没有 `kind`：按 PR 处理，`issue` 仍然派任务。 */
async function testLegacyPrWithoutKind() {
  const box = await sandbox()
  useQueue(box.queue)
  const item = prItem({ id: 'acme-alpha-5', pr: 5 })
  delete item.kind
  await writeItem(box.inbox, item)

  const { item: updated, task } = await appendReview(box.inbox, {
    id: item.id,
    kind: 'issue',
    text: 'Legacy item still needs a worker.',
  })
  assert.ok(task !== null)
  assert.equal(updated.review[0].kind, 'issue')
  const pending = await jsonNames(join(box.queue, 'pending'))
  assert.equal(pending.length, 1)
  const record = JSON.parse(await readFile(join(box.queue, 'pending', pending[0]), 'utf8'))
  assert.equal(record.thread, 'inbox-5')
}

/** `issue` on an spv_message：零任务，恰好一条 notice，回到信件的 thread。 */
async function testIssueOnSpvMessage() {
  const box = await sandbox()
  useQueue(box.queue)
  const item = spvItem({ id: 'spv-ops-20261113T120000Z-abcd', thread: 'ops', title: 'Retried the deploy' })
  await writeItem(box.inbox, item)

  const { item: updated, task } = await appendReview(box.inbox, {
    id: item.id,
    kind: 'issue',
    text: 'You should have asked before retrying.',
  })
  assert.equal(task, null)
  assert.equal(updated.review[0].kind, 'issue')
  assert.deepEqual(await jsonNames(join(box.queue, 'pending')), [], 'an spv_message issue dispatches no worker')

  const outbox = await jsonNames(join(box.queue, 'outbox'))
  assert.equal(outbox.length, 1, 'exactly one outbox message is written')
  const message = JSON.parse(await readFile(join(box.queue, 'outbox', outbox[0]), 'utf8'))
  assert.equal(message.kind, 'notice')
  assert.equal(message.thread, 'ops')
  assert.equal(message.id, `inbox-${item.id}-review-0`)
  assert.ok(message.text.includes('Retried the deploy'), 'the notice names the letter title')
  assert.ok(message.text.includes(item.id), 'the notice names the letter id')
  assert.ok(message.text.includes('You should have asked before retrying.'), 'the notice quotes the comment verbatim')
}

/** 审查写入沿用 per-item 锁与原子写：过期的锁会被回收，临时文件不会留在目录里。 */
async function testStaleLockAndAtomicWrite() {
  const box = await sandbox()
  useQueue(box.queue)
  const item = prItem({ id: 'acme-alpha-6', pr: 6 })
  await writeItem(box.inbox, item)
  assert.ok(!(await readdir(box.inbox)).some(name => name.startsWith('.tmp-')), 'writeItem leaves no temporary file')

  const lock = join(box.inbox, `.${item.id}.lock`)
  await writeFile(lock, 'stale lock\n', 'utf8')
  const old = new Date(Date.now() - 60_000)
  await utimes(lock, old, old)
  const { item: updated, task } = await appendReview(box.inbox, { id: item.id, kind: 'approve', text: 'after stale lock' })
  assert.equal(task, null)
  assert.equal(updated.review[0].text, 'after stale lock')
  const names = await readdir(box.inbox)
  assert.ok(!names.includes(`.${item.id}.lock`), 'the reaped lock is removed when the write finishes')
  assert.ok(!names.some(name => name.startsWith('.tmp-')), 'the atomic write leaves no temporary file')
}

/** 校验失败时什么都不写；PR 与决策信各测一条关键路径。 */
async function testValidationBeforeWrite() {
  const box = await sandbox()
  useQueue(box.queue)

  const message = spvItem({ id: 'spv-main-20261113T140000Z-cafe', thread: 'not a thread' })
  await writeItem(box.inbox, message)
  await assert.rejects(
    appendReview(box.inbox, { id: message.id, kind: 'issue', text: 'bad thread' }),
    error => error.code === 'INBOX_INVALID',
  )
  const messageAfter = await readItem(box.inbox, message.id)
  assert.deepEqual(messageAfter.review, [], 'a rejected decision is not saved')
  assert.deepEqual(await jsonNames(join(box.queue, 'outbox')), [], 'a rejected decision sends nothing')

  const pr = prItem({ id: 'acme-alpha-7', pr: 7, repo: 'not a repo' })
  await writeItem(box.inbox, pr)
  await assert.rejects(
    appendReview(box.inbox, { id: pr.id, kind: 'issue', text: 'bad repo' }),
    error => error.code === 'INBOX_INVALID',
  )
  const prAfter = await readItem(box.inbox, pr.id)
  assert.deepEqual(prAfter.review, [], 'a PR that cannot be dispatched saves no review')
  assert.deepEqual(await jsonNames(join(box.queue, 'pending')), [], 'a PR that cannot be dispatched queues no task')
}

/** 发消息/派活失败：评论已经落盘，错误码是 INBOX_DISPATCH（HTTP 层回 502）。 */
async function testDispatchFailureKeepsReview() {
  const box = await sandbox()
  const queueFile = join(box.base, 'queue-is-a-file')
  await writeFile(queueFile, 'not a directory', 'utf8')
  process.env.SPV_QUEUE_DIR = queueFile
  const message = spvItem({ id: 'spv-main-20261113T150000Z-feed' })
  await writeItem(box.inbox, message)

  await assert.rejects(
    appendReview(box.inbox, { id: message.id, kind: 'issue', text: 'the outbox is unavailable' }),
    error => error.code === 'INBOX_DISPATCH' && error.item?.id === message.id,
  )
  const saved = await readItem(box.inbox, message.id)
  assert.equal(saved.review.length, 1, 'the review survives a failed outbox write')
  assert.equal(saved.review[0].text, 'the outbox is unavailable')
}

/** 旧 PR item 没有 `createdAt`：时间筛选不能拿 watcher 的 `at` 冒充年龄。 */
async function testLegacyPrTimeFilter() {
  const box = await sandbox()
  const legacy = prItem({ id: 'acme-alpha-9', pr: 9, at: '2026-11-14T23:00:00.000Z' })
  delete legacy.createdAt
  await writeItem(box.inbox, legacy)

  const all = await getItems(box.inbox)
  assert.deepEqual(idsOf(all.body), ['acme-alpha-9'], 'without a time filter the legacy item is still listed')
  const recent = await getItems(box.inbox, '?since=2026-11-14T00:00:00.000Z')
  assert.deepEqual(idsOf(recent.body), [], 'a missing createdAt is not replaced by the watcher at')
}

/** 服务端过滤：单独、组合，以及无参数等于 `readItems()`。 */
async function testFilters() {
  const box = await sandbox()
  await writeItem(box.inbox, prItem({
    id: 'acme-alpha-1',
    pr: 1,
    repo: 'acme/alpha',
    createdAt: '2026-11-10T00:00:00.000Z',
    at: '2026-11-14T12:00:00.000Z',
  }))
  await writeItem(box.inbox, prItem({
    id: 'acme-beta-2',
    pr: 2,
    repo: 'acme/beta',
    createdAt: '2026-11-01T00:00:00.000Z',
    // watcher 很晚才发现这个三个月前开的 PR：时间过滤必须用 createdAt，而不是 at。
    at: '2026-11-14T12:00:00.000Z',
  }))
  await writeItem(box.inbox, spvItem())

  const all = await getItems(box.inbox)
  assert.equal(all.status, 200)
  assert.deepEqual(Object.keys(all.body), ['items'], 'the body shape stays {items}')
  assert.deepEqual(idsOf(all.body), (await readItems(box.inbox)).map(item => item.id), 'no query parameters is today\'s response')
  assert.equal(all.body.items.length, 3)
  const emptyQuery = await getItems(box.inbox, '?kind=&repo=&since=&until=')
  assert.deepEqual(idsOf(emptyQuery.body), idsOf(all.body), 'empty values mean no filter')
  const explicitAll = await getItems(box.inbox, '?kind=all')
  assert.deepEqual(idsOf(explicitAll.body), idsOf(all.body), 'kind=all means no kind filter')

  const prs = await getItems(box.inbox, '?kind=pr')
  assert.deepEqual(idsOf(prs.body).sort(), ['acme-alpha-1', 'acme-beta-2'])
  const spv = await getItems(box.inbox, '?kind=spv_message')
  assert.deepEqual(idsOf(spv.body), ['spv-main-20261113T120000Z-abcd'])
  const repo = await getItems(box.inbox, '?repo=acme%2Falpha')
  assert.deepEqual(idsOf(repo.body), ['acme-alpha-1'])
  const combined = await getItems(box.inbox, '?kind=pr&repo=acme%2Falpha')
  assert.deepEqual(idsOf(combined.body), ['acme-alpha-1'])

  const since = await getItems(box.inbox, '?since=2026-11-05T00:00:00.000Z')
  assert.deepEqual(idsOf(since.body).sort(), ['acme-alpha-1', 'spv-main-20261113T120000Z-abcd'], 'the old PR is excluded by its createdAt, not its watcher at')
  const until = await getItems(box.inbox, '?until=2026-11-05T00:00:00.000Z')
  assert.deepEqual(idsOf(until.body), ['acme-beta-2'])
  const range = await getItems(box.inbox, '?since=2026-11-02T00:00:00.000Z&until=2026-11-12T00:00:00.000Z')
  assert.deepEqual(idsOf(range.body), ['acme-alpha-1'])
  const rangeKind = await getItems(box.inbox, '?kind=pr&repo=acme%2Falpha&since=2026-11-05T00:00:00.000Z')
  assert.deepEqual(idsOf(rangeKind.body), ['acme-alpha-1'])

  const badKind = await getItems(box.inbox, '?kind=letter')
  assert.equal(badKind.status, 400)
  assert.equal(badKind.body.code, 'bad-request')
  const badSince = await getItems(box.inbox, '?since=not-a-date')
  assert.equal(badSince.status, 400)
  assert.equal(badSince.body.code, 'bad-request')
}

// ------------------------------------------------------------------- main

try {
  await testWriteSpvMessage()
  await testTwoWriterEntryPoints()
  await testApproveWithComment()
  await testApproveOnSpvMessage()
  await testApproveWithoutComment()
  await testStaleLockAndAtomicWrite()
  await testValidationBeforeWrite()
  await testDispatchFailureKeepsReview()
  await testIssueOnPr()
  await testLegacyPrWithoutKind()
  await testIssueOnSpvMessage()
  await testLegacyPrTimeFilter()
  await testFilters()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true })
  if (SAVED_STATE_DIR === undefined) delete process.env.DSH_SUPERAGENT_STATE_DIR
  else process.env.DSH_SUPERAGENT_STATE_DIR = SAVED_STATE_DIR
  await rm(HERMETIC_STATE, { recursive: true, force: true })
}
