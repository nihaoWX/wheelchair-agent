#!/usr/bin/env node
/**
 * tests/test-settings.mjs：面板设置存储与全部后端消费方的离线可跑证据。
 *
 * 覆盖：
 *   - 默认值解析：没有文件时 revision 0、`fileState: "missing"`、八行都是内置默认、`hooks` 是内置默认；
 *   - 内置模板：`injection` / `spvObjection` 与改造前逐字节一致；`prIssue` 是新的 SPV notice 正文；
 *   - 保存：部分保存合并、revision 递增、文件只有 version/revision/values/templates、原子写不留临时文件；
 *     过期 revision 抛 SETTINGS_CONFLICT 且**磁盘一个字节都不动**；未知键/坏值整体拒绝；
 *   - 坏文件：JSON 语法错、版本不认、手改出非法值/非法预设都不抛，退回默认并给出 warning；
 *     消费方（注入器、轮询器、复查、`work gc`）照样工作；
 *   - 模板：未知占位符、缺失必填占位符（`{comment}` / `{thread}`）、超长、未知模板 id 都点名报错；
 *   - 预设：创建、切换、只切 active、删除 active 回退默认、revert 保留自定义、reset 清空、内置不可改、
 *     非法名字；
 *   - 优先级：文件 > 插件 config > 环境变量 > 默认；`rows` 的 source/overridden/env 说清楚被压住的值；
 *   - HTTP 面：GET/PUT、405 Allow、415、413、400、409、404，reset、预设 CRUD 与 `hooks` 都走同一条 PUT；
 *   - `hooks` 子块：默认值不落盘、部分保存、过期 revision 一个字节都不写、坏子块逐字段 warning、
 *     旧文件仍有效、未知事件/内建行/重复 id 被拒；
 *   - 消费方：`resolveInboxIntervalSeconds()` 的优先级与非法值、`appendReview` 用自定义模板写通知、
 *     `startResultInjector` 用自定义模板与自定义截断上限、`injection.intervalMs` 改值无需重启、
 *     轮询器 0 暂停/恢复无需重启、`merge.installRepo` 文件值压过环境变量、`work gc` 用设置的 keep 默认、
 *     挂载回收被 `work.sweepOnMount=false` 整体跳过。
 *
 * 全程离线：所有状态都在 `mkdtemp` 沙箱；git 只操作沙箱里的本地 bare 仓库；假 `gh` 只 `cat` 一份 JSON；
 * 管理 API 指向 127.0.0.1:1（必然拒绝，等于「服务没跑」），不访问任何真实服务或外网。
 *
 * 用法：node tests/test-settings.mjs（任一断言失败则 exit 1）
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  KEY_SPECS,
  SETTINGS_FILE,
  SETTINGS_PATH,
  SETTINGS_VERSION,
  TEMPLATE_IDS,
  createSettingsHandler,
  defaultSettings,
  ensureSettingsFile,
  renderTemplate,
  resolveSettings,
  saveSettings,
  settingsFile,
  validateTemplate,
} from '../src/shared/settings.js'
import { formatResult, startResultInjector } from '../src/spv/injector.js'
import { appendReview, readItem, resolveInboxIntervalSeconds, startInboxWatcher, writeItem } from '../src/spv/inbox.js'
import { reclaimAtMount } from '../src/superagent/watch.js'
import { reclaimWork } from '../src/shared/work.js'

const CLI = fileURLToPath(new URL('../bin/wheelchair-agent.mjs', import.meta.url))
const SANDBOXES = []
const ORIGINAL_ENV = { ...process.env }
const ISOLATED_STATE = join(tmpdir(), `wheelchair-agent-settings-interval-${process.pid}`)
/**
 * `defaultSettings` only needs an explicit root for its display-only file path. Pin one so this suite
 * running from a ticket clone is not mistaken for a forgotten worker clone (src/shared/home.js).
 */
const DEFAULT_SETTINGS = Object.freeze({ home: join(ISOLATED_STATE, 'defaults'), env: {} })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(5)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

function restoreEnv(saved) {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(saved)) process.env[key] = value
}

/** 一个 `mkdtemp` 沙箱；所有测试结束后统一删掉。 */
async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'wheelchair-agent-settings-test-'))
  SANDBOXES.push(base)
  const box = {
    base,
    home: join(base, 'home'),
    root: join(base, 'home', '.wheelchair-agent'),
    state: join(base, 'state'),
    queue: join(base, 'queue'),
    inbox: join(base, 'inbox'),
    projects: join(base, 'projects'),
    remotes: join(base, 'remotes'),
    bin: join(base, 'bin'),
    ghJson: join(base, 'gh.json'),
    ghLog: join(base, 'gh-calls.log'),
  }
  box.tools = join(box.projects, 'tools')
  box.work = join(box.state, 'work')
  box.gitConfig = join(base, 'gitconfig')
  for (const dir of [box.home, box.root, box.state, box.inbox, box.tools, box.remotes, box.bin, box.work]) {
    await mkdir(dir, { recursive: true })
  }
  await writeFile(
    box.gitConfig,
    ['[user]', '\tname = Test Runner', '\temail = test@example.invalid', '[init]', '\tdefaultBranch = main', ''].join('\n'),
    'utf8',
  )
  await writeFile(box.ghLog, '', 'utf8')
  return box
}

/** 沙箱里的设置文件路径（新数据根；`state` 只作为旧文件的迁移来源）。 */
function settingsPath(box) {
  return settingsFile({ home: box.root, stateDir: box.state, env: {} })
}

/** 沙箱内的 git 环境：不读操作者的全局配置，也不访问网络。 */
function gitEnv(box, extra = {}) {
  return {
    ...process.env,
    HOME: box.home,
    GIT_CONFIG_GLOBAL: box.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  }
}

function git(box, args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(box, options.env),
    ...options,
  })
}

/** 把 git 环境装进本进程（in-process 的 reclaimWork / git pull 会用到），返回恢复函数。 */
function installGitEnv(box) {
  const keys = ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT']
  const saved = {}
  for (const key of keys) {
    saved[key] = process.env[key]
    process.env[key] = gitEnv(box)[key]
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/** 一个本地 bare 远端 + 一条 main 历史；origin 用本地路径，所以 push/clone/pull 都不碰网络。 */
async function makeRemote(box, name) {
  const remote = join(box.remotes, `${name}.git`)
  await mkdir(remote, { recursive: true })
  const seed = join(box.base, 'seed', name)
  await mkdir(seed, { recursive: true })
  git(box, ['init', '-q', '--bare', '-b', 'main', remote])
  git(box, ['init', '-q', '-b', 'main', seed])
  await writeFile(join(seed, 'README.md'), `${name}\n`, 'utf8')
  git(box, ['-C', seed, 'add', '-A'])
  git(box, ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
  git(box, ['-C', seed, 'remote', 'add', 'origin', remote])
  git(box, ['-C', seed, 'push', '-q', 'origin', 'main'])
  git(box, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remote })
  return { remote, seed }
}

/** 一个可以通过 `work gc` 门禁的 ticket clone（干净、有远端、全部已推送）。 */
async function cloneTicket(box, name, hex = '0123456789ab') {
  const { remote } = await makeRemote(box, name)
  const dir = join(box.work, `${name}-${hex}`)
  git(box, ['clone', '-q', remote, dir])
  return dir
}

/** 给 seed 加一个提交并推回 bare 远端。 */
async function pushChange(box, seed, content = 'changed\n') {
  await writeFile(join(seed, 'README.md'), content, 'utf8')
  git(box, ['-C', seed, 'add', '-A'])
  git(box, ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'change'])
  git(box, ['-C', seed, 'push', '-q', 'origin', 'main'])
  return git(box, ['-C', seed, 'rev-parse', 'HEAD']).trim()
}

async function writeJson(file, value) {
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

/** 假 `gh`：记下参数，然后打印当前 fixture。 */
async function writeFakeGh(box) {
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
cat "$FAKE_GH_JSON"
`
  await writeFile(join(box.bin, 'gh'), script, 'utf8')
  await chmod(join(box.bin, 'gh'), 0o755)
  box.gh = join(box.bin, 'gh')
}

/** 在沙箱里跑一次 CLI；`work gc` 的管理 API 指向必然拒绝的 127.0.0.1:1。 */
function cli(box, args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: box.base,
    encoding: 'utf8',
    env: {
      ...gitEnv(box),
      WHEELCHAIR_AGENT_HOME: box.root,
      DSH_SUPERAGENT_STATE_DIR: box.state,
      SPV_SUPERAGENT_URL: 'http://127.0.0.1:1',
      ...(options.env ?? {}),
    },
  })
}

/** 当前 revision，然后按它保存（测试里最常用的两步）。 */
function save(box, patch = {}) {
  const revision = resolveSettings({ home: box.root, stateDir: box.state, env: {} }).revision
  return saveSettings({ home: box.root, stateDir: box.state, revision, ...patch })
}

/** 把 host 半身和它的 core/shared 副本装进一个临时包，再 import —— 与 install.sh 的布局一致。 */
async function loadHostApply(box) {
  const app = join(box.base, 'webui')
  await mkdir(join(app, 'lib', 'core'), { recursive: true })
  await mkdir(join(app, 'lib', 'shared'), { recursive: true })
  await writeFile(join(app, 'package.json'), '{"type":"module"}\n', 'utf8')
  for (const [source, target] of [
    ['src/spv/inbox.js', 'lib/core/inbox.js'],
    ['src/spv/dispatch.js', 'lib/core/dispatch.js'],
    ['src/spv/hook-runner.js', 'lib/core/hook-runner.js'],
    ['src/spv/paths.js', 'lib/core/paths.js'],
    ['src/shared/home.js', 'lib/shared/home.js'],
    ['src/shared/hook-events.js', 'lib/shared/hook-events.js'],
    ['src/shared/hooks.js', 'lib/shared/hooks.js'],
    ['src/shared/queue.js', 'lib/shared/queue.js'],
    ['src/shared/settings.js', 'lib/shared/settings.js'],
    ['webui/lib/index.js', 'lib/index.js'],
  ]) {
    await copyFile(new URL(`../${source}`, import.meta.url), join(app, target))
  }
  const { apply } = await import(pathToFileURL(join(app, 'lib', 'index.js')).href)
  return apply
}

/** 用假的 `window.__ModuleLoader__` 载入浏览器 bundle（与 test-inbox-refresh 同一手法）。 */
const CLIENT_MODULE = { current: undefined }
/**
 * A recording JSX runtime plus the React hooks the components call, so an offline test can lift the
 * component tree and assert its structure without react-dom or a browser. `useState` returns its
 * initial value once; the tests only read the first render.
 */
const RECORD_REACT = {
  Fragment: Symbol('react.fragment'),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useRef: value => ({ current: value }),
  useEffect: () => {},
  useMemo: factory => factory(),
  useCallback: fn => fn,
}
const recordJsx = (type, props, key) => ({ type, props: props ?? {}, key })
async function loadClient() {
  if (CLIENT_MODULE.current !== undefined) return CLIENT_MODULE.current
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        captured = factory(id =>
          id === 'react' ? RECORD_REACT : { jsx: recordJsx, jsxs: recordJsx },
        )
      },
    },
  }
  try {
    await import('../webui/lib/client.js')
  } finally {
    delete globalThis.window
  }
  CLIENT_MODULE.current = captured
  return captured
}

/** Visit every recorded element in a lifted component tree, depth first. */
function walkTree(node, visit) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit)
    return
  }
  if (typeof node !== 'object') return
  if (typeof node.type === 'string' || typeof node.type === 'function') visit(node)
  walkTree(node.props?.children, visit)
}

/** The class list of one recorded element, as a string. */
function classNamesOf(element) {
  const value = element.props?.className
  return Array.isArray(value) ? value.join(' ') : String(value ?? '')
}

/** Resolve the one page-width rule the way a browser would: var(--wca-content-max) -> 1200px. */
function resolveContentMax(styles) {
  const token = styles.match(/--wca-content-max:\s*([^;]+);/)?.[1]?.trim()
  const block = styles.match(/\.wca-page > \*\s*\{([^}]*)\}/)?.[1] ?? ''
  const width = block.match(/(?:^|;)\s*width:\s*([^;]+);/)?.[1]?.trim()
  const maxWidth = block.match(/(?:^|;)\s*max-width:\s*([^;]+);/)?.[1]?.trim()
  const resolved = maxWidth === 'var(--wca-content-max)' ? token : maxWidth
  return { token, width, maxWidth, resolved }
}

/** 断言一个 promise/函数以某个错误码失败，并返回错误本身。 */
async function rejectsWithCode(fn, code, pattern) {
  try {
    await fn()
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return error
  }
  assert.fail(`expected an error with code ${code}`)
}

// ------------------------------------------------------------ old output formulas

/**
 * 改造前 `formatResult()` 的公式，逐字重算。这是「默认模板字节级一致」的独立证据：
 * 期望值不是从新模板里读出来的，而是把旧实现抄了一遍。
 */
function legacyFormatResult(message, { read } = {}) {
  const thread = String(message.thread ?? message.address?.thread ?? 'main')
  const ticket = message.ticketId ? ` (ticket ${message.ticketId})` : ''
  let body = String(message.text ?? '').trim()
  const chars = Array.from(body)
  if (chars.length > 12000) {
    const where = read === undefined ? '' : `; full message: ${read}`
    body = `${chars.slice(0, 12000).join('')}\n[truncated after 12000 characters${where}]`
  }
  const header = `[spv] ${String(message.kind)} on thread "${thread}"${ticket}:`
  return `${header}\n${body === '' ? '(empty message)' : body}`
}

/** 改造前 `noticeText()` 的公式。 */
function legacyNoticeText(item, comment) {
  return [
    '审查收件箱转来一次对 SPV 自主决定的质疑，请处理。',
    '',
    `信件：${item.title ?? ''}`,
    `信件 id: ${item.id}`,
    `thread: ${item.thread || 'main'}`,
    '',
    '操作者评论（原样保留）：',
    comment,
    '',
    '这是对你在无人看管时自己作出的决定的质疑；请回顾当时的判断并处理。',
  ].join('\n')
}

/** The new default `prIssue` notice, pinned independently of the implementation. */
function defaultPrIssueNotice(item, comment) {
  return [
    '审查收件箱转来一条对 GitHub PR 的质疑，请先处理。',
    '',
    `repo: ${item.repo}`,
    `PR: #${item.pr}`,
    `title: ${item.title ?? ''}`,
    `url: ${item.url ?? ''}`,
    'kind: issue',
    '',
    '评论原文（原样保留）：',
    comment,
    '',
    '操作者认为这个 PR 有问题。请你（SPV）先结合上下文和操作者讨论怎么改，再决定是否派活。',
  ].join('\n')
}

// ------------------------------------------------------------------- fixtures

const EXPECTED_DEFAULTS = {
  'webui.style': 'fluid',
  'inbox.intervalSeconds': 60,
  'merge.installRepo': 'wheelchair-agent',
  'injection.intervalMs': 1000,
  'injection.maxBodyChars': 12000,
  'work.keep': 0,
  'work.keepDays': 0,
  'work.sweepOnMount': true,
}

function prItem(overrides = {}) {
  const pr = overrides.pr ?? 1
  return {
    id: 'acme-alpha-1',
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

async function outboxMessages(box) {
  const names = (await readdir(join(box.queue, 'outbox')).catch(() => [])).filter(name => name.endsWith('.json'))
  return Promise.all(names.map(name => readJson(join(box.queue, 'outbox', name))))
}

// ------------------------------------------------------------------- scenarios

/** 没有文件时的默认快照：八行、来源 default、模板 active=default。 */
async function testDefaults() {
  const box = await sandbox()
  const snapshot = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(snapshot.version, SETTINGS_VERSION)
  assert.equal(snapshot.revision, 0)
  assert.equal(snapshot.file, settingsPath(box))
  assert.equal(snapshot.fileState, 'missing')
  assert.equal(snapshot.warning, undefined)
  assert.deepEqual(snapshot.values, {})
  assert.deepEqual(snapshot.effective, EXPECTED_DEFAULTS)
  assert.deepEqual(snapshot.rows.map(row => row.key), Object.keys(KEY_SPECS), 'rows follow KEY_SPECS display order')
  for (const row of snapshot.rows) {
    assert.equal(row.value, EXPECTED_DEFAULTS[row.key])
    assert.equal(row.default, EXPECTED_DEFAULTS[row.key])
    assert.equal(row.source, 'default')
    assert.deepEqual(row.overridden, [])
  }
  const styleRow = snapshot.rows.find(row => row.key === 'webui.style')
  assert.equal(styleRow.value, 'fluid')
  assert.equal(styleRow.default, 'fluid')
  assert.deepEqual(styleRow.options, ['minimal', 'fluid'], 'an enum key exposes its options to the page')
  const intervalRow = snapshot.rows.find(row => row.key === 'inbox.intervalSeconds')
  assert.deepEqual(intervalRow.env, { name: 'SPV_INBOX_INTERVAL_SECONDS', present: false, value: null })
  assert.equal(snapshot.rows.find(row => row.key === 'injection.intervalMs').env, null, 'a key without an env var says null')
  assert.deepEqual(snapshot.templates.injection.placeholders, ['kind', 'thread', 'ticket', 'body'])
  assert.deepEqual(snapshot.templates.prIssue.required, ['repo', 'pr', 'comment'])
  for (const id of TEMPLATE_IDS) {
    const template = snapshot.templates[id]
    assert.equal(template.active, 'default')
    assert.equal(template.text, template.defaultText)
    assert.deepEqual(template.presets, [{ name: 'default', text: template.defaultText, builtin: true }])
    assert.equal(template.limit, 20000)
  }
  assert.deepEqual(defaultSettings(DEFAULT_SETTINGS).effective, EXPECTED_DEFAULTS, 'defaultSettings() is the same built-in layer')
  assert.equal(settingsPath(box), join(box.root, SETTINGS_FILE))
}

/** 默认模板：injection / spvObjection 保持旧输出，prIssue 是新的 SPV notice。 */
async function testDefaultTemplates() {
  const samples = [
    { kind: 'reply', thread: 't1', ticketId: 'tk-1', text: '答复正文' },
    { kind: 'notice', thread: 't9', text: '  \n' },
    { kind: 'reply', thread: 't1', text: 'x'.repeat(12050) },
    { kind: 'reply', thread: 't1', text: `${'a'.repeat(11999)}😀${'b'.repeat(10)}` },
  ]
  for (const sample of samples) {
    assert.equal(formatResult(sample, { read: '/tmp/read/x.json', settings: defaultSettings(DEFAULT_SETTINGS) }), legacyFormatResult(sample, { read: '/tmp/read/x.json' }))
  }
  assert.equal(
    formatResult({ kind: 'reply', thread: 't1', ticketId: 'tk-1', text: 'no read path' }, { settings: defaultSettings(DEFAULT_SETTINGS) }),
    legacyFormatResult({ kind: 'reply', thread: 't1', ticketId: 'tk-1', text: 'no read path' }),
  )

  const box = await sandbox()
  const saved = { ...process.env }
  try {
    process.env.WHEELCHAIR_AGENT_HOME = box.root
    process.env.DSH_SUPERAGENT_STATE_DIR = box.state
    process.env.SPV_QUEUE_DIR = box.queue
    const pr = prItem({ id: 'acme-alpha-1', pr: 1 })
    const prComment = '  这条评论的首尾空格要 trim  '
    await writeItem(box.inbox, pr)
    await appendReview(box.inbox, { id: pr.id, kind: 'issue', text: prComment })
    const messages = await outboxMessages(box)
    assert.equal(messages.length, 1, 'a PR issue writes one notice')
    assert.equal(messages[0].thread, 'inbox-1')
    assert.equal(messages[0].text, defaultPrIssueNotice(pr, prComment.trim()), 'the default prIssue template is the new SPV notice')

    const message = spvItem({ id: 'spv-ops-20261113T120000Z-abcd', thread: 'ops', title: 'Retried the deploy' })
    await writeItem(box.inbox, message)
    await appendReview(box.inbox, { id: message.id, kind: 'issue', text: 'You should have asked.' })
    const notices = await outboxMessages(box)
    assert.equal(notices.length, 2)
    const objection = notices.find(item => item.thread === 'ops')
    assert.equal(objection.text, legacyNoticeText(message, 'You should have asked.'), 'the default spvObjection template reproduces noticeText')
  } finally {
    restoreEnv(saved)
  }
}

/** 部分保存合并、revision 递增、原子写、过期 revision 不落盘、未知键/坏值拒绝。 */
async function testSaveMergeAndStaleRevision() {
  const box = await sandbox()
  const first = save(box, { values: { 'inbox.intervalSeconds': 30 } })
  assert.equal(first.revision, 1)
  assert.deepEqual(first.values, { 'inbox.intervalSeconds': 30 })
  assert.equal(first.effective['inbox.intervalSeconds'], 30)

  const stored = await readJson(settingsPath(box))
  assert.equal(stored.version, SETTINGS_VERSION)
  assert.equal(stored.revision, 1)
  assert.deepEqual(stored.values, { 'inbox.intervalSeconds': 30 })
  assert.deepEqual(stored.templates, {}, 'default templates are not written to the file')
  const names = await readdir(box.root)
  assert.ok(!names.some(name => name.startsWith(`${SETTINGS_FILE}.tmp-`)), 'the atomic write leaves no temporary file')

  const second = save(box, { values: { 'work.keep': 5 } })
  assert.equal(second.revision, 2)
  assert.deepEqual(second.values, { 'inbox.intervalSeconds': 30, 'work.keep': 5 }, 'a partial save merges')

  const before = await readFile(settingsPath(box), 'utf8')
  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: 1, values: { 'inbox.intervalSeconds': 1 } }),
    'SETTINGS_CONFLICT',
    /stale.*current revision is 2/,
  )
  assert.equal(await readFile(settingsPath(box), 'utf8'), before, 'a stale revision writes nothing')
  await rejectsWithCode(() => saveSettings({ home: box.root, stateDir: box.state, values: { 'work.keep': 1 } }), 'SETTINGS_CONFLICT')
  assert.equal(resolveSettings({ home: box.root, stateDir: box.state, env: {} }).revision, 2)

  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: 2, values: { 'inbox.intervlSeconds': 10 } }),
    'SETTINGS_INVALID',
    /unknown settings key/,
  )
  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: 2, values: { 'inbox.intervalSeconds': -1 } }),
    'SETTINGS_INVALID',
    /at least 0/,
  )
  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: 2, values: { 'work.sweepOnMount': 'true' } }),
    'SETTINGS_INVALID',
    /true or false/,
  )
  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: 2, values: { 'inbox.intervalSeconds': 10.5 } }),
    'SETTINGS_INVALID',
    /whole number/,
  )
  assert.equal(await readFile(settingsPath(box), 'utf8'), before, 'a rejected save writes nothing')
}

/** 坏文件：语法错、版本不认、手改出非法值；resolve 不抛，合法字段仍生效，坏字段被 warning 点名。 */
async function testCorruptAndHandEditedFiles() {
  const box = await sandbox()
  const file = settingsPath(box)

  await writeFile(file, '{ not json', 'utf8')
  const broken = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(broken.fileState, 'corrupt')
  assert.equal(broken.revision, 0)
  assert.deepEqual(broken.effective, EXPECTED_DEFAULTS)
  assert.match(broken.warning, /not valid JSON/)

  await writeJson(file, { version: 99, revision: 4, values: {} })
  const versioned = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(versioned.fileState, 'corrupt')
  assert.match(versioned.warning, /version 99/)

  await writeJson(file, { version: 1, revision: 'three', values: {} })
  assert.equal(resolveSettings({ home: box.root, stateDir: box.state, env: {} }).fileState, 'corrupt')

  // 手改文件：一个合法值、一个非法值、一个未知键、一个坏模板、一个未知顶层字段。
  await writeJson(file, {
    version: 1,
    revision: 3,
    values: { 'work.keep': 7, 'inbox.intervalSeconds': 'soon' },
    templates: {
      injection: {
        active: 'missing',
        presets: {
          'good preset': { text: '[spv] {kind}/{thread}: {body}' },
          'bad\bname': { text: 'whatever {thread} {body}' },
          typo: { text: '[spv] {commnet}' },
        },
      },
    },
    extra: true,
  })
  const edited = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(edited.fileState, 'ok')
  assert.equal(edited.revision, 3)
  assert.equal(edited.effective['work.keep'], 7, 'the valid hand-edited value still applies')
  assert.equal(edited.effective['inbox.intervalSeconds'], 60, 'the invalid value falls back to the default')
  assert.match(edited.warning, /inbox\.intervalSeconds/)
  assert.match(edited.warning, /unknown settings field "extra"/)
  assert.match(edited.warning, /unknown placeholder/)
  assert.equal(edited.templates.injection.active, 'default', 'a dangling active falls back to default')
  assert.deepEqual(edited.templates.injection.presets.map(preset => preset.name), ['default', 'good preset'])

  // 坏文件不能弄死消费方：轮询间隔、注入输出、复查都照常。
  assert.equal(resolveInboxIntervalSeconds(undefined, { home: box.root, stateDir: box.state, env: {} }), 60)
  assert.equal(formatResult({ kind: 'reply', thread: 't1', text: 'still works' }, { settings: defaultSettings(DEFAULT_SETTINGS) }), '[spv] reply on thread "t1":\nstill works')
  const saved = { ...process.env }
  try {
    process.env.WHEELCHAIR_AGENT_HOME = box.root
    process.env.DSH_SUPERAGENT_STATE_DIR = box.state
    process.env.SPV_QUEUE_DIR = box.queue
    const item = prItem({ id: 'acme-alpha-9', pr: 9 })
    await writeItem(box.inbox, item)
    const { task } = await appendReview(box.inbox, { id: item.id, kind: 'issue', text: 'still notifies' })
    assert.equal(task, null, 'a corrupt settings file does not block the notice')
    const notices = await outboxMessages(box)
    assert.equal(notices.length, 1)
    assert.equal(notices[0].thread, 'inbox-9')
    assert.ok(notices[0].text.includes('still notifies'))
  } finally {
    restoreEnv(saved)
  }
}

/** 模板校验：未知/缺失占位符、未知 id、超长都点名报错；renderTemplate 的缺值替换为空串。 */
function testTemplateValidation() {
  for (const id of TEMPLATE_IDS) {
    assert.equal(validateTemplate(id, defaultSettings(DEFAULT_SETTINGS).templates[id].text), defaultSettings(DEFAULT_SETTINGS).templates[id].text)
  }
  assert.throws(
    () => validateTemplate('prIssue', '{repo} #{pr} {commnet}'),
    /unknown placeholder "\{commnet\}"/,
  )
  assert.throws(() => validateTemplate('prIssue', '评论：{commnet}'), /unknown placeholder "\{commnet\}"/)
  assert.throws(
    () => validateTemplate('prIssue', '{repo} #{pr}\n正文里没有评论占位符'),
    /missing required placeholder \{comment\}/,
  )
  assert.throws(
    () => validateTemplate('injection', '[spv] {kind}: {body}'),
    /missing required placeholder \{thread\}/,
  )
  assert.throws(() => validateTemplate('spvObjection', '信件 {title}\n评论：{comment}'), /missing required placeholder \{thread\}/)
  assert.throws(() => validateTemplate('nope', '{body}'), /unknown template id/)
  assert.throws(() => validateTemplate('injection', 'x'.repeat(20001)), /over the 20000 limit/)
  assert.throws(() => validateTemplate('injection', '{kind} {thread} {ticket} {body} {}'), /unknown placeholder/)

  assert.equal(
    renderTemplate('injection', '[spv] {kind} on "{thread}"{ticket}: {body}', { kind: 'reply', thread: 't1', body: 'x' }),
    '[spv] reply on "t1": x',
    'a missing value becomes the empty string',
  )
  assert.equal(renderTemplate('injection', defaultSettings(DEFAULT_SETTINGS).templates.injection.text, {
    kind: 'notice',
    thread: 'ops',
    ticket: ' (ticket tk-1)',
    body: 'body',
  }), '[spv] notice on thread "ops" (ticket tk-1):\nbody')
}

/** 预设的创建/切换/删除回退/revert/reset，以及内置预设不可改、非法名字被拒。 */
async function testPresetCrudAndReset() {
  const box = await sandbox()
  const custom = {
    injection: {
      active: 'terse',
      presets: {
        terse: { text: '[spv] {kind} {thread}: {body}' },
        verbose: { text: '[spv] {kind} on thread "{thread}"{ticket}:\n{body}\n（详细模式）' },
      },
    },
  }
  const created = save(box, { templates: custom })
  assert.equal(created.revision, 1)
  assert.equal(created.templates.injection.active, 'terse')
  assert.equal(created.templates.injection.text, '[spv] {kind} {thread}: {body}')
  assert.deepEqual(created.templates.injection.presets.map(preset => preset.name), ['default', 'terse', 'verbose'])
  assert.deepEqual(created.templates.injection.presets.map(preset => preset.builtin), [true, false, false])
  const stored = await readJson(settingsPath(box))
  assert.equal(stored.templates.injection.active, 'terse')
  assert.deepEqual(Object.keys(stored.templates.injection.presets).sort(), ['terse', 'verbose'], 'only custom presets are persisted')
  assert.equal(stored.templates.injection.presets.default, undefined, 'the built-in text is not copied into the file')
  assert.equal(stored.templates.injection.presets.terse.text, '[spv] {kind} {thread}: {body}')

  // 只切 active：presets 省略时自定义预设保留。
  const switched = save(box, { templates: { injection: { active: 'verbose' } } })
  assert.equal(switched.templates.injection.active, 'verbose')
  assert.equal(switched.templates.injection.presets.length, 3)

  // 删除 active（新预设全集里没有 verbose）：回退到内置 default，且剩下的自定义预设仍然保存。
  const deleted = save(box, { templates: { injection: { presets: { terse: custom.injection.presets.terse } } } })
  assert.equal(deleted.templates.injection.active, 'default')
  assert.equal(deleted.templates.injection.text, deleted.templates.injection.defaultText)
  assert.deepEqual(deleted.templates.injection.presets.map(preset => preset.name), ['default', 'terse'])

  // revert to default：保留自定义预设。
  const reverted = save(box, { templates: { injection: { active: 'default' } } })
  assert.equal(reverted.templates.injection.active, 'default')
  assert.deepEqual(reverted.templates.injection.presets.map(preset => preset.name), ['default', 'terse'])

  // reset templates：删掉全部自定义预设并回默认。
  const resetOne = save(box, { reset: { templates: ['injection'] } })
  assert.deepEqual(resetOne.templates.injection.presets.map(preset => preset.name), ['default'])
  assert.equal(resetOne.templates.injection.active, 'default')

  // 内置预设不可改；未知 id、非法名字、未知字段都拒绝。
  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: resetOne.revision, templates: { injection: { presets: { default: { text: '{body}' } } } } }),
    'SETTINGS_INVALID',
    /built-in preset/,
  )
  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: resetOne.revision, templates: { nope: { active: 'default' } } }),
    'SETTINGS_INVALID',
    /unknown template id/,
  )
  for (const name of ['', '   ', 'a'.repeat(65), 'bad\u0007name']) {
    await rejectsWithCode(
      () => saveSettings({ home: box.root, stateDir: box.state, revision: resetOne.revision, templates: { injection: { presets: { [name]: { text: '[spv] {kind} {thread} {body}' } } } } }),
      'SETTINGS_INVALID',
    )
  }
  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: resetOne.revision, templates: { injection: { active: 'nope' } } }),
    'SETTINGS_INVALID',
    /not a preset/,
  )
  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: resetOne.revision, templates: { injection: { text: 'x' } } }),
    'SETTINGS_INVALID',
    /unknown field "text"/,
  )
  // 同一请求里 reset 先执行，随后显式值生效。
  const combined = save(box, {
    values: { 'inbox.intervalSeconds': 5 },
    reset: { values: true },
  })
  assert.deepEqual(combined.values, { 'inbox.intervalSeconds': 5 })
  const cleared = save(box, { reset: { values: true } })
  assert.deepEqual(cleared.values, {})
  assert.equal(cleared.effective['inbox.intervalSeconds'], 60)
}

/** 优先级与 rows：文件 > config > env > 默认，被压住的值写在 overridden 里。 */
async function testPrecedence() {
  const box = await sandbox()
  const env = { SPV_INBOX_INTERVAL_SECONDS: '20', SPV_INSTALL_REPO: 'env/repo' }
  const config = { 'inbox.intervalSeconds': 10, 'merge.installRepo': 'config/repo' }
  save(box, {
    values: { 'inbox.intervalSeconds': 30, 'merge.installRepo': 'file/repo' },
  })
  const withFile = resolveSettings({ home: box.root, stateDir: box.state, env, config })
  assert.equal(withFile.effective['inbox.intervalSeconds'], 30)
  assert.equal(withFile.effective['merge.installRepo'], 'file/repo')
  const intervalRow = withFile.rows.find(row => row.key === 'inbox.intervalSeconds')
  assert.equal(intervalRow.source, 'file')
  assert.deepEqual(intervalRow.overridden, [
    { source: 'config', value: 10 },
    { source: 'env', value: 20 },
  ], 'the file row names the values it overrides')
  assert.deepEqual(intervalRow.env, { name: 'SPV_INBOX_INTERVAL_SECONDS', present: true, value: '20' })

  const clear = await sandbox()
  const configOnly = resolveSettings({ home: clear.root, stateDir: clear.state, env, config })
  assert.equal(configOnly.effective['inbox.intervalSeconds'], 10)
  assert.equal(configOnly.rows.find(row => row.key === 'inbox.intervalSeconds').source, 'config')
  assert.deepEqual(configOnly.rows.find(row => row.key === 'inbox.intervalSeconds').overridden, [{ source: 'env', value: 20 }])

  const envOnly = resolveSettings({ home: clear.root, stateDir: clear.state, env })
  assert.equal(envOnly.effective['inbox.intervalSeconds'], 20)
  assert.equal(envOnly.rows.find(row => row.key === 'inbox.intervalSeconds').source, 'env')
  assert.equal(envOnly.rows.find(row => row.key === 'inbox.intervalSeconds').overridden.length, 0)

  const none = resolveSettings({ home: clear.root, stateDir: clear.state, env: {} })
  assert.equal(none.effective['inbox.intervalSeconds'], 60)

  // 旧 host 半身的 config 别名 `intervalSeconds`，以及 0.02 这种分数（老 config 就写过）。
  const legacyConfig = resolveSettings({ home: clear.root, stateDir: clear.state, env: {}, config: { intervalSeconds: 0.02 } })
  assert.equal(legacyConfig.effective['inbox.intervalSeconds'], 0.02)
  assert.equal(legacyConfig.rows.find(row => row.key === 'inbox.intervalSeconds').source, 'config')

  // 坏 env 被忽略并落到下一层，而不是抛错。
  const badEnv = resolveSettings({ home: clear.root, stateDir: clear.state, env: { SPV_INBOX_INTERVAL_SECONDS: 'soon' } })
  assert.equal(badEnv.effective['inbox.intervalSeconds'], 60)
  assert.match(badEnv.warning, /SPV_INBOX_INTERVAL_SECONDS/)

  // 文件里的坏值落到 env。
  await writeJson(settingsPath(clear), { version: 1, revision: 2, values: { 'inbox.intervalSeconds': 'soon' } })
  const fallThrough = resolveSettings({ home: clear.root, stateDir: clear.state, env })
  assert.equal(fallThrough.effective['inbox.intervalSeconds'], 20)
  assert.equal(fallThrough.rows.find(row => row.key === 'inbox.intervalSeconds').source, 'env')
}

// ------------------------------------------------------------------- HTTP handler

/** 直接调 handler，不监听端口；请求体通过 async iterator 提供。 */
async function call(handler, { method = 'GET', url = SETTINGS_PATH, contentType = 'application/json', body, forbidden = false } = {}) {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  const req = {
    method,
    url,
    forbidden,
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield Buffer.from(payload)
    },
    resume() {},
  }
  const res = {
    statusCode: 0,
    headers: {},
    text: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(chunk) { if (chunk !== undefined) this.text += String(chunk) },
  }
  await handler(req, res)
  let parsed
  try { parsed = JSON.parse(res.text) } catch { parsed = undefined }
  return { status: res.statusCode, headers: res.headers, text: res.text, body: parsed }
}

/** GET/PUT、405/415/413/400/409/404，reset 与预设 CRUD 都走同一条 PUT。 */
async function testHttpHandler() {
  const box = await sandbox()
  const handler = createSettingsHandler({ home: box.root, stateDir: box.state, env: {} })

  const get = await call(handler)
  assert.equal(get.status, 200)
  assert.equal(get.headers['cache-control'], 'no-store')
  assert.equal(get.body.revision, 0)
  assert.equal(get.body.fileState, 'missing')
  assert.equal(get.body.templates.injection.active, 'default')

  const notFound = await call(handler, { url: '/wheelchair-settings/extra' })
  assert.equal(notFound.status, 404)

  const method = await call(handler, { method: 'POST', body: {} })
  assert.equal(method.status, 405)
  assert.equal(method.headers.allow, 'GET, PUT')

  const mediaType = await call(handler, { method: 'PUT', contentType: 'text/plain', body: '{}' })
  assert.equal(mediaType.status, 415)

  const tooLarge = await call(handler, { method: 'PUT', body: 'x'.repeat(64 * 1024 + 1) })
  assert.equal(tooLarge.status, 413)

  const badJson = await call(handler, { method: 'PUT', body: '{ not json' })
  assert.equal(badJson.status, 400)
  assert.equal(badJson.body.code, 'SETTINGS_INVALID')

  const unknownField = await call(handler, { method: 'PUT', body: { revision: 0, nope: 1 } })
  assert.equal(unknownField.status, 400)
  assert.match(unknownField.body.message, /unknown request field "nope"/)

  const missingRevision = await call(handler, { method: 'PUT', body: { values: {} } })
  assert.equal(missingRevision.status, 409)
  assert.equal(missingRevision.body.code, 'conflict')
  assert.equal(missingRevision.body.revision, 0)

  const saved = await call(handler, { method: 'PUT', body: { revision: 0, values: { 'inbox.intervalSeconds': 30 } } })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.revision, 1)
  assert.equal(saved.body.effective['inbox.intervalSeconds'], 30)
  const onDisk = await readFile(settingsPath(box), 'utf8')

  const stale = await call(handler, { method: 'PUT', body: { revision: 0, values: { 'work.keep': 9 } } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'conflict')
  assert.equal(stale.body.revision, 1)
  assert.equal(await readFile(settingsPath(box), 'utf8'), onDisk, 'a stale PUT writes nothing')

  const badValue = await call(handler, { method: 'PUT', body: { revision: 1, values: { 'work.keep': -2 } } })
  assert.equal(badValue.status, 400)
  assert.equal(badValue.body.code, 'SETTINGS_INVALID')
  assert.equal(await readFile(settingsPath(box), 'utf8'), onDisk)

  const reset = await call(handler, { method: 'PUT', body: { revision: 1, reset: { values: ['inbox.intervalSeconds'] } } })
  assert.equal(reset.status, 200)
  assert.deepEqual(reset.body.values, {})
  assert.equal(reset.body.effective['inbox.intervalSeconds'], 60)

  const created = await call(handler, {
    method: 'PUT',
    body: {
      revision: 2,
      templates: { prIssue: { active: 'short', presets: { short: { text: '{repo} #{pr}\n{comment}' } } } },
    },
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.templates.prIssue.active, 'short')
  assert.equal(created.body.templates.prIssue.text, '{repo} #{pr}\n{comment}')

  const invalidTemplate = await call(handler, {
    method: 'PUT',
    body: { revision: 3, templates: { prIssue: { presets: { bad: { text: 'no comment {oops}' } } } } },
  })
  assert.equal(invalidTemplate.status, 400)
  assert.match(invalidTemplate.body.message, /unknown placeholder/)
  assert.equal(resolveSettings({ home: box.root, stateDir: box.state, env: {} }).revision, 3)

  const resetTemplates = await call(handler, { method: 'PUT', body: { revision: 3, reset: { templates: true } } })
  assert.equal(resetTemplates.status, 200)
  assert.deepEqual(resetTemplates.body.templates.prIssue.presets.map(preset => preset.name), ['default'])
  assert.equal(resetTemplates.body.templates.prIssue.active, 'default')
}

// ---------------------------------------------------------------- client + host wiring

/** 浏览器 bundle 里的纯设置助手：active 预设回退与占位符提取。 */
async function testClientSettingsHelpers() {
  const client = await loadClient()
  assert.ok(client?.__test?.activePreset, 'the client bundle exposes activePreset')
  assert.ok(client.__test.placeholderTokens, 'the client bundle exposes placeholderTokens')
  assert.ok(client.__test.statusOf, 'the existing inbox helpers stay exported')
  assert.equal(typeof client.__test.stagedChanges, 'function', 'the client bundle exposes stagedChanges')
  assert.equal(typeof client.__test.templateDraftsOf, 'function', 'the client bundle exposes templateDraftsOf')
  assert.equal(typeof client.__test.presetNameError, 'function', 'the client bundle exposes presetNameError')
  const { activePreset, placeholderTokens, presetNameError } = client.__test

  const builtin = { name: 'default', text: 'DEFAULT', builtin: true }
  const custom = { name: 'custom', text: 'CUSTOM', builtin: false }
  assert.deepEqual(activePreset({ active: 'custom', presets: [builtin, custom], defaultText: 'DEFAULT' }), custom)
  assert.deepEqual(
    activePreset({ active: 'missing', presets: [builtin, custom], defaultText: 'DEFAULT' }),
    builtin,
    'a dangling active preset falls back to the built-in default',
  )
  assert.deepEqual(
    activePreset({ active: 'default', presets: [custom], defaultText: 'DEFAULT' }),
    { name: 'default', text: 'DEFAULT', builtin: true },
    'a missing built-in preset is synthesized from defaultText',
  )
  assert.deepEqual(activePreset({ active: 'gone' }), { name: 'default', text: '', builtin: true }, 'an empty template still falls back')

  assert.deepEqual(
    placeholderTokens('{repo} #{pr}\n{comment} {comment} {oops}'),
    ['{repo}', '{pr}', '{comment}', '{comment}', '{oops}'],
    'tokens keep their order and duplicates',
  )
  assert.deepEqual(placeholderTokens('no tokens'), [])
  assert.deepEqual(placeholderTokens('{a{b}'), ['{b}'], 'the tokenizer does not accept nested braces')
  assert.deepEqual(placeholderTokens(undefined), [])

  // Prototype keys are refused loudly before the page can stage a preset the server must reject.
  for (const reserved of ['__proto__', 'prototype', 'constructor']) {
    assert.equal(
      presetNameError(reserved, {}, key => key),
      'settings.template.error.nameReserved',
      `${reserved} is refused as a preset name`,
    )
  }
  assert.equal(presetNameError('default', {}, key => key), 'settings.template.error.nameDefault')
  assert.equal(presetNameError('mine', { mine: 'x' }, key => key), 'settings.template.error.nameExists')
  assert.equal(presetNameError('mine', {}, key => key), '', 'an ordinary new name passes')
}

/**
 * 页面 staging 出来的模板 PUT 体必须能被真实 `saveSettings`/handler 接受。
 *
 * 这条回归对应一个真实事故：`stagedChanges()` 曾把预设发成 `{ name: "<text>" }`，而服务端要求
 * `{ name: { text } }`，于是所有新建/切换/删除/还原预设都 400。用例先证明旧形状被拒，再把客户端为
 * 四种动作生成的 body 原样喂给 handler，断言 200 与 active/presets。
 */
async function testClientTemplateStaging() {
  const box = await sandbox()
  const client = await loadClient()
  const { stagedChanges, templateDraftsOf, valueDraftsOf } = client?.__test ?? {}
  assert.equal(typeof stagedChanges, 'function', 'the client bundle exposes stagedChanges for the offline regression test')
  assert.equal(typeof templateDraftsOf, 'function', 'the client bundle exposes templateDraftsOf')
  assert.equal(typeof valueDraftsOf, 'function', 'the client bundle exposes valueDraftsOf')
  const t = key => key
  const handler = createSettingsHandler({ home: box.root, stateDir: box.state, env: {} })

  const mine = 'MINE {repo} {pr} {comment}'
  const extra = 'EXTRA {repo} {pr}\n{comment}'
  saveSettings({
    home: box.root, stateDir: box.state,
    revision: 0,
    templates: { prIssue: { active: 'default', presets: { mine: { text: mine } } } },
  })
  let snapshot = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  let drafts = valueDraftsOf(snapshot)
  let templateDrafts = templateDraftsOf(snapshot)
  const defaultText = snapshot.templates.prIssue.defaultText

  // The pre-fix payload: string-valued presets. It must be refused, which is what was happening in the page.
  const legacy = await call(handler, {
    method: 'PUT',
    body: { revision: snapshot.revision, templates: { prIssue: { active: 'mine2', presets: { mine2: extra } } } },
  })
  assert.equal(legacy.status, 400, 'the old string-preset payload is refused')
  assert.match(legacy.body.message, /preset "mine2" must be an object with a string "text"/)

  // (a) "new preset from this": active changes and the custom set gains a member.
  const created = stagedChanges(
    snapshot,
    drafts,
    {
      ...templateDrafts,
      prIssue: { active: 'mine2', presets: { ...templateDrafts.prIssue.presets, mine2: extra } }
    },
    new Set(),
    t,
  )
  assert.deepEqual(created.templateErrors, {}, created.templateErrors.prIssue)
  assert.deepEqual(created.templates, {
    prIssue: {
      active: 'mine2',
      presets: { mine: { text: mine }, mine2: { text: extra } },
    },
  })
  const createdPut = await call(handler, { method: 'PUT', body: { revision: snapshot.revision, templates: created.templates } })
  assert.equal(createdPut.status, 200, createdPut.body.message)
  assert.equal(createdPut.body.templates.prIssue.active, 'mine2')
  assert.equal(createdPut.body.templates.prIssue.text, extra)
  assert.deepEqual(
    createdPut.body.templates.prIssue.presets.map(preset => preset.name),
    ['default', 'mine', 'mine2'],
  )
  assert.equal(createdPut.body.templates.prIssue.presets[0].text, defaultText, 'the built-in preset is preserved')
  assert.equal(createdPut.body.templates.prIssue.presets[0].builtin, true)

  // (b) activate-only: `presets` is omitted, so the server keeps the stored custom set.
  snapshot = createdPut.body
  drafts = valueDraftsOf(snapshot)
  templateDrafts = templateDraftsOf(snapshot)
  const activated = stagedChanges(
    snapshot,
    drafts,
    { ...templateDrafts, prIssue: { active: 'mine', presets: { ...templateDrafts.prIssue.presets } } },
    new Set(),
    t,
  )
  assert.deepEqual(activated.templates, { prIssue: { active: 'mine' } })
  assert.equal(Object.hasOwn(activated.templates.prIssue, 'presets'), false)
  const activatedPut = await call(handler, { method: 'PUT', body: { revision: snapshot.revision, templates: activated.templates } })
  assert.equal(activatedPut.status, 200, activatedPut.body.message)
  assert.equal(activatedPut.body.templates.prIssue.active, 'mine')
  assert.equal(activatedPut.body.templates.prIssue.text, mine)
  assert.deepEqual(
    activatedPut.body.templates.prIssue.presets.map(preset => preset.name),
    ['default', 'mine', 'mine2'],
    'activate-only keeps every custom preset',
  )

  // (c) delete the active preset: the draft falls back to default and sends the smaller custom set.
  snapshot = activatedPut.body
  drafts = valueDraftsOf(snapshot)
  templateDrafts = templateDraftsOf(snapshot)
  const deleted = stagedChanges(
    snapshot,
    drafts,
    { ...templateDrafts, prIssue: { active: 'default', presets: { mine2: extra } } },
    new Set(),
    t,
  )
  assert.deepEqual(deleted.templates, {
    prIssue: { active: 'default', presets: { mine2: { text: extra } } },
  })
  const deletedPut = await call(handler, { method: 'PUT', body: { revision: snapshot.revision, templates: deleted.templates } })
  assert.equal(deletedPut.status, 200, deletedPut.body.message)
  assert.equal(deletedPut.body.templates.prIssue.active, 'default')
  assert.deepEqual(
    deletedPut.body.templates.prIssue.presets.map(preset => preset.name),
    ['default', 'mine2'],
  )

  // (d) revert to default: activate-only again, and the custom presets stay stored.
  saveSettings({ home: box.root, stateDir: box.state, revision: deletedPut.body.revision, templates: { prIssue: { active: 'mine2' } } })
  snapshot = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  drafts = valueDraftsOf(snapshot)
  templateDrafts = templateDraftsOf(snapshot)
  assert.equal(snapshot.templates.prIssue.active, 'mine2')
  const reverted = stagedChanges(
    snapshot,
    drafts,
    { ...templateDrafts, prIssue: { active: 'default', presets: { ...templateDrafts.prIssue.presets } } },
    new Set(),
    t,
  )
  assert.deepEqual(reverted.templates, { prIssue: { active: 'default' } })
  assert.equal(Object.hasOwn(reverted.templates.prIssue, 'presets'), false)
  const revertedPut = await call(handler, { method: 'PUT', body: { revision: snapshot.revision, templates: reverted.templates } })
  assert.equal(revertedPut.status, 200, revertedPut.body.message)
  assert.equal(revertedPut.body.templates.prIssue.active, 'default')
  assert.equal(revertedPut.body.templates.prIssue.text, defaultText)
  assert.deepEqual(
    revertedPut.body.templates.prIssue.presets.map(preset => preset.name),
    ['default', 'mine2'],
    'revert to default keeps the custom presets stored',
  )
}

/** host 半身：注册 SETTINGS_PATH、同一道 fence、GET 的 config 来源、PUT 的 409 与成功。 */
/** Stage 3: a rename PUT must carry every existing label, and empty/default restores one. */
async function testClientHookHelpers() {
  const client = await loadClient()
  const { nextHookLabels, hookLabelError, hookStatusText } = client.__test
  assert.equal(typeof nextHookLabels, 'function', 'the client exposes nextHookLabels')
  const t = key => key
  assert.deepEqual(
    nextHookLabels({ labels: { 'builtin:injection': 'A' } }, { id: 'builtin:injection', defaultLabel: 'D' }, 'B'),
    { 'builtin:injection': 'B' },
  )
  assert.deepEqual(
    nextHookLabels(
      { labels: { 'builtin:injection': 'A', 'builtin:prIssue': 'P' } },
      { id: 'builtin:injection', defaultLabel: 'D' },
      '',
    ),
    { 'builtin:prIssue': 'P' },
    'clearing one label keeps the other overrides',
  )
  assert.deepEqual(
    nextHookLabels({ labels: { 'builtin:injection': 'A' } }, { id: 'builtin:injection', defaultLabel: 'D' }, 'D'),
    {},
    'typing the default name removes the override',
  )
  assert.equal(hookLabelError('x'.repeat(121), t), 'hooks.rename.error.long')
  assert.equal(hookLabelError('bad\u0007name', t), 'hooks.rename.error.control')
  assert.equal(hookLabelError('ok', t), '')
  assert.equal(hookStatusText(t, 'timeout'), 'hooks.run.timeout')
  assert.equal(hookStatusText(t, 'nope'), 'hooks.run.failed', 'an unknown status falls back to failed, never a raw key')
}

async function testHostSettingsRoute() {
  const box = await sandbox()
  const apply = await loadHostApply(box)
  const saved = { ...process.env }
  try {
    process.env.WHEELCHAIR_AGENT_HOME = box.root
    process.env.DSH_SUPERAGENT_STATE_DIR = box.state
    process.env.SPV_INBOX_DIR = box.inbox
    process.env.SPV_PROJECTS_ROOT = box.projects
    delete process.env.SPV_INBOX_INTERVAL_SECONDS
    const effects = []
    const routes = []
    const rejected = []
    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      connection: {
        requestRejection: req => {
          rejected.push(req)
          return req.forbidden === true ? 403 : undefined
        },
      },
      webServer: {
        register: ({ kind, path, handler }) => {
          routes.push({ kind, path, handler })
          return () => {}
        },
      },
      effect: (fn, label) => { effects.push({ fn, label }) },
    }
    apply(ctx, { intervalSeconds: 0.02 })
    // The web host runs each non-poller effect on mount; that is what registers the routes.
    for (const effect of effects.filter(item => !item.label.includes('poller'))) effect.fn()

    const route = routes.find(item => item.path === SETTINGS_PATH)
    assert.ok(route, 'the host registers /wheelchair-settings')
    assert.equal(route.kind, 'exact', 'the settings route is an exact route')
    assert.ok(routes.some(item => item.path === '/wheelchair-inbox/items'), 'the inbox routes stay registered')
    assert.ok(effects.some(item => item.label.includes('inbox poller')), 'the host still registers the inbox poller')

    // The host mount ships the empty-but-valid settings file; a stale/rejected PUT must not touch it.
    const mounted = await readFile(settingsPath(box), 'utf8')
    assert.deepEqual(JSON.parse(mounted), { version: SETTINGS_VERSION, revision: 0, values: {}, templates: {} })
    const get = await call(route.handler)
    assert.equal(get.status, 200)
    assert.equal(get.headers['cache-control'], 'no-store')
    const intervalRow = get.body.rows.find(item => item.key === 'inbox.intervalSeconds')
    assert.equal(intervalRow.source, 'config', 'the plugin config is the source when the file has no override')
    assert.equal(intervalRow.value, 0.02, 'the legacy fractional plugin config is accepted')
    assert.equal(get.body.templates.injection.active, 'default')
    assert.ok(get.body.hookView, 'the snapshot carries the stage-3 hook view')
    assert.equal(get.body.hookView.events.length, 9, 'the view renders all nine events')
    assert.equal(get.body.hookView.events[0].id, 'ticket.started', 'events keep the table order')
    assert.equal(typeof get.body.hookView.events[0].prompt, 'string', 'each event carries its generated prompt')

    const stale = await call(route.handler, { method: 'PUT', body: { revision: 5, values: { 'work.keep': 2 } } })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'conflict')
    assert.equal(stale.body.revision, 0)
    assert.equal(await readFile(settingsPath(box), 'utf8'), mounted, 'a stale PUT writes nothing')

    const denied = await call(route.handler, {
      method: 'PUT',
      forbidden: true,
      body: { revision: 0, values: { 'work.keep': 2 } },
    })
    assert.equal(denied.status, 403, 'the connection fence answers before the settings handler')
    assert.equal(denied.text, '', 'a rejected request gets no handler body')
    assert.equal(await readFile(settingsPath(box), 'utf8'), mounted, 'a rejected PUT has no side effect')
    assert.equal(rejected.at(-1)?.forbidden, true, 'the settings route asks the connection fence before the handler')

    for (const candidate of routes.filter(item => item.path.startsWith('/wheelchair-inbox/'))) {
      const forbidden = await call(candidate.handler, { forbidden: true, url: candidate.path })
      assert.equal(forbidden.status, 403, `${candidate.path} is behind the same fence`)
    }

    const savedPut = await call(route.handler, { method: 'PUT', body: { revision: 0, values: { 'work.keep': 2 } } })
    assert.equal(savedPut.status, 200)
    assert.equal(savedPut.body.revision, 1)
    const after = await call(route.handler)
    assert.equal(after.body.effective['work.keep'], 2)
    assert.equal(after.body.rows.find(item => item.key === 'work.keep').source, 'file')
  } finally {
    restoreEnv(saved)
  }
}

/**
 * `hooks` 子块（插口引擎的设置面）：默认值、部分保存、整体替换、revision 冲突、坏子块、旧文件、HTTP PUT。
 *
 * 这些都是设置存储的既有不变量在新字段上的复述：默认值不落盘、过期 revision 一个字节都不写、坏字段
 * warning 后跳过。执行语义（脚本、记录、cursor）在 `tests/test-hooks.mjs`。
 */
async function testHooksBlock() {
  const box = await sandbox()
  const EMPTY = { enabled: true, scriptTimeoutMs: 10000, intervalSeconds: 15, items: [], labels: {} }
  const read = () => resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  const item = {
    id: 'hook-ticket-delivered-abcd12',
    event: 'ticket.delivered',
    name: 'notify',
    enabled: true,
    script: 'printf "%s\\n" "$WCA_EVENT"',
    timeoutMs: 2500,
  }

  const initial = read()
  assert.deepEqual(initial.hooks, EMPTY, 'no file means the built-in hooks defaults')
  assert.deepEqual(defaultSettings(DEFAULT_SETTINGS).hooks, EMPTY, 'defaultSettings() carries the same defaults')
  assert.equal(settingsPath(box).endsWith(`${SETTINGS_FILE}`), true)

  // A values-only save must not create (or disturb) a hooks block.
  const valued = save(box, { values: { 'work.keep': 1 } })
  assert.deepEqual(valued.hooks, EMPTY)
  assert.equal((await readJson(settingsPath(box))).hooks, undefined, 'default hooks are not written to the file')

  // Adding a row, then changing only labels: each provided field replaces itself, omitted fields stay.
  const added = save(box, { hooks: { items: [item] } })
  assert.deepEqual(added.hooks.items, [item])
  assert.deepEqual(added.hooks, { ...EMPTY, items: [item] })
  assert.deepEqual((await readJson(settingsPath(box))).hooks, { items: [item] }, 'only non-default hooks fields are stored')

  const relabelled = save(box, { hooks: { labels: { 'builtin:injection': '我的注入' } } })
  assert.equal(relabelled.hooks.labels['builtin:injection'], '我的注入')
  assert.deepEqual(relabelled.hooks.items, [item], 'a labels-only write keeps the rows')
  assert.equal(relabelled.hooks.enabled, true)
  assert.equal(relabelled.hooks.scriptTimeoutMs, 10000)

  // A save that only touches `values` / `templates` must preserve the hooks block.
  const stillThere = save(box, { values: { 'work.keep': 2 } })
  assert.deepEqual(stillThere.hooks, relabelled.hooks, 'a values-only save preserves hooks')
  assert.deepEqual((await readJson(settingsPath(box))).hooks.items, [item])

  // The master switch, a valid timeout, and a disabled row.
  const paused = save(box, { hooks: { enabled: false, scriptTimeoutMs: 5000, items: [{ ...item, enabled: false }] } })
  assert.equal(paused.hooks.enabled, false)
  assert.equal(paused.hooks.scriptTimeoutMs, 5000)
  assert.equal(paused.hooks.items[0].enabled, false)

  // An empty label is how the operator resets a builtin row to its default label.
  const resetLabel = save(box, { hooks: { labels: { 'builtin:injection': '' } } })
  assert.deepEqual(resetLabel.hooks.labels, {})

  // A stale revision is a 409 and nothing is written; the hooks block is part of that same write.
  const before = await readFile(settingsPath(box), 'utf8')
  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: resetLabel.revision - 1, hooks: { enabled: true } }),
    'SETTINGS_CONFLICT',
    /stale.*current revision/,
  )
  assert.equal(await readFile(settingsPath(box), 'utf8'), before, 'a stale hooks write changes not one byte')

  // Invalid hooks payloads are refused as a whole (nothing written), and each names the problem.
  const revision = resetLabel.revision
  const bad = [
    [{ items: [{ ...item, event: 'ticket.nope' }] }, /not a known event/],
    [{ items: [{ ...item, id: 'builtin:injection' }] }, /must look like "hook-<slug>"/],
    [{ items: [{ ...item, id: `hook-${'a'.repeat(76)}` }] }, /at most 80 characters/],
    [{ items: [{ ...item, extra: true }] }, /unknown field "extra"/],
    [{ items: [item, { ...item }] }, /duplicate id/],
    [{ items: [{ ...item, timeoutMs: 0 }] }, /at least 1 millisecond/],
    [{ items: [{ ...item, timeoutMs: 300001 }] }, /at most 300000/],
    [{ scriptTimeoutMs: 300001 }, /at most 300000/],
    [{ intervalSeconds: -1 }, /zero .*or more seconds/],
    [{ intervalSeconds: 1.5 }, /whole number/],
    [{ intervalSeconds: 86401 }, /at most 86400/],
    [{ items: [{ ...item, name: 'bad\u0001name' }] }, /control character/],
    [{ labels: { 'builtin:injection': 'x'.repeat(121) } }, /over the 120 limit/],
    [{ items: 'nope' }, /must be an array/],
    [{ enabled: 'yes' }, /must be true or false/],
    [{ scriptTimeoutMs: 1.5 }, /whole number/],
    [{ labels: { 'builtin:nope': 'x' } }, /not a builtin row/],
    [{ labels: { 'builtin:injection': 5 } }, /must be a string/],
    [{ nope: true }, /unknown field "nope" in hooks/],
  ]
  for (const [hooks, pattern] of bad) {
    await rejectsWithCode(
      () => saveSettings({ home: box.root, stateDir: box.state, revision, hooks }),
      'SETTINGS_INVALID',
      pattern,
    )
  }
  assert.equal(await readFile(settingsPath(box), 'utf8'), before, 'a rejected hooks write changes not one byte')

  // The HTTP face carries the block: GET returns it, PUT writes it through the same revision check.
  const handler = createSettingsHandler({ home: box.root, stateDir: box.state, env: {} })
  const get = await call(handler)
  assert.equal(get.status, 200)
  assert.deepEqual(get.body.hooks, resetLabel.hooks)
  const put = await call(handler, { method: 'PUT', body: { revision: get.body.revision, hooks: { enabled: true } } })
  assert.equal(put.status, 200)
  assert.equal(put.body.hooks.enabled, true)
  assert.deepEqual(put.body.hooks.items, resetLabel.hooks.items, 'a partial PUT keeps the untouched hooks fields')
  const stalePut = await call(handler, { method: 'PUT', body: { revision: get.body.revision, hooks: { enabled: false } } })
  assert.equal(stalePut.status, 409)
  assert.equal(stalePut.body.code, 'conflict')
  const invalidPut = await call(handler, {
    method: 'PUT',
    body: { revision: put.body.revision, hooks: { items: [{ ...item, event: 'nope' }] } },
  })
  assert.equal(invalidPut.status, 400)
  assert.match(invalidPut.body.message, /not a known event/)
  assert.equal(read().revision, put.body.revision, 'a rejected PUT is not a write')

  const intervalPut = await call(handler, {
    method: 'PUT',
    body: { revision: put.body.revision, hooks: { intervalSeconds: 0 } },
  })
  assert.equal(intervalPut.status, 200)
  assert.equal(intervalPut.body.hooks.intervalSeconds, 0)
  assert.equal((await readJson(settingsPath(box))).hooks.intervalSeconds, 0)

  // A file that predates the block is still valid, and gets the defaults.
  await writeJson(settingsPath(box), { version: 1, revision: 9, values: {}, templates: {} })
  const old = read()
  assert.equal(old.fileState, 'ok')
  assert.equal(old.revision, 9)
  assert.deepEqual(old.hooks, EMPTY)

  // A malformed sub-block is warned about field by field; the good parts still work.
  await writeJson(settingsPath(box), {
    version: 1,
    revision: 10,
    values: {},
    hooks: {
      enabled: false,
      scriptTimeoutMs: 'soon',
      items: [item, { ...item, id: 'not-a-hook-id' }],
      labels: { 'builtin:injection': 'X', 'builtin:nope': 'Y' },
      extra: 1,
    },
  })
  const edited = read()
  assert.equal(edited.fileState, 'ok')
  assert.equal(edited.hooks.enabled, false)
  assert.equal(edited.hooks.scriptTimeoutMs, 10000, 'a bad timeout falls back to the default')
  assert.deepEqual(edited.hooks.items, [item], 'the good row survives, the bad one is skipped')
  assert.deepEqual(edited.hooks.labels, { 'builtin:injection': 'X' }, 'an unknown builtin id is skipped')
  assert.match(edited.warning, /hooks\.scriptTimeoutMs/)
  assert.match(edited.warning, /"extra"/)
  assert.match(edited.warning, /"not-a-hook-id"/)
  assert.match(edited.warning, /unknown builtin row "builtin:nope"/)

  // A non-object hooks block is warned about on read and dropped by a non-hooks save (the documented
  // behaviour: only a well-formed JSON object is preserved verbatim).
  await writeJson(settingsPath(box), { version: 1, revision: 12, values: {}, hooks: 'nope' })
  const nonObject = read()
  assert.equal(nonObject.fileState, 'ok')
  assert.match(nonObject.warning, /ignoring "hooks"/)
  assert.deepEqual(nonObject.hooks, EMPTY)
  const rescued = saveSettings({ home: box.root, stateDir: box.state, revision: 12, values: { 'work.keep': 3 } })
  assert.equal(rescued.revision, 13)
  assert.equal(
    (await readJson(settingsPath(box))).hooks,
    undefined,
    'a non-object hooks block is dropped on a values-only save',
  )
  assert.deepEqual(read().hooks, EMPTY)

  // A corrupt file still yields the defaults; a bad hooks value does not corrupt the whole file.
  await writeFile(settingsPath(box), '{ not json', 'utf8')
  const corrupt = read()
  assert.equal(corrupt.fileState, 'corrupt')
  assert.deepEqual(corrupt.hooks, EMPTY)
}

/**
 * 超限 timeout 的完整语义：**读**时夹到硬上限并 warning，**写**时拒绝且一个字节都不动；
 * 一次只改 `values` / `templates` 的保存把磁盘上的 hooks 块原样放回（不夹、不丢字段）。
 */
async function testHookTimeoutsAndRawPreservation() {
  const box = await sandbox()
  const item = {
    id: 'hook-ticket-delivered-abcd12',
    event: 'ticket.delivered',
    name: 'raw',
    enabled: true,
    script: 'true',
    timeoutMs: 800000,
  }
  await writeJson(settingsPath(box), {
    version: 1,
    revision: 3,
    values: {},
    hooks: { enabled: true, scriptTimeoutMs: 900000, items: [item], labels: { 'builtin:injection': 'X' } },
  })

  const read = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(read.fileState, 'ok')
  assert.equal(read.hooks.scriptTimeoutMs, 300000, 'reading clamps hooks.scriptTimeoutMs')
  assert.equal(read.hooks.items[0].timeoutMs, 300000, 'reading clamps items[].timeoutMs too')
  assert.match(read.warning, /hooks\.scriptTimeoutMs is over the 300000 ms cap/)
  assert.match(read.warning, /hooks\.items\[0\]\.timeoutMs is over the 300000 ms cap/)

  // A values-only save must not rewrite the block with the clamped value.
  const valued = saveSettings({ home: box.root, stateDir: box.state, revision: 3, values: { 'work.keep': 4 } })
  assert.equal(valued.revision, 4)
  let stored = await readJson(settingsPath(box))
  assert.equal(stored.hooks.scriptTimeoutMs, 900000, 'values-only save preserves the raw over-cap value')
  assert.equal(stored.hooks.items[0].timeoutMs, 800000, 'values-only save preserves the raw per-item value')
  assert.deepEqual(stored.hooks.labels, { 'builtin:injection': 'X' })

  // A templates-only save does the same.
  const templated = saveSettings({
    home: box.root,
    stateDir: box.state,
    revision: 4,
    templates: { injection: { active: 'default' } },
  })
  assert.equal(templated.revision, 5)
  stored = await readJson(settingsPath(box))
  assert.equal(stored.hooks.scriptTimeoutMs, 900000, 'templates-only save preserves the raw hooks block')

  // Explicit over-cap writes are refused as a whole, and nothing is written.
  const before = await readFile(settingsPath(box), 'utf8')
  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: 5, hooks: { scriptTimeoutMs: 300001 } }),
    'SETTINGS_INVALID',
    /at most 300000/,
  )
  await rejectsWithCode(
    () => saveSettings({ home: box.root, stateDir: box.state, revision: 5, hooks: { items: [{ ...item }] } }),
    'SETTINGS_INVALID',
    /at most 300000/,
  )
  assert.equal(await readFile(settingsPath(box), 'utf8'), before, 'a rejected over-cap write changes nothing')

  // A valid hooks write replaces the block, so the clamped values are gone for good.
  const fixed = saveSettings({
    home: box.root,
    stateDir: box.state,
    revision: 5,
    hooks: { scriptTimeoutMs: 10000, items: [{ ...item, timeoutMs: 2500 }] },
  })
  assert.equal(fixed.hooks.scriptTimeoutMs, 10000)
  assert.equal(fixed.hooks.items[0].timeoutMs, 2500)
  stored = await readJson(settingsPath(box))
  assert.equal(stored.hooks.scriptTimeoutMs, undefined, 'the built-in default is not persisted')
  assert.equal(stored.hooks.items[0].timeoutMs, 2500)
  assert.equal(resolveSettings({ home: box.root, stateDir: box.state, env: {} }).hooks.scriptTimeoutMs, 10000)
}

// --------------------------------------------------------------- consumers

/** 自定义 prIssue / spvObjection 模板真的进了 outbox notice。 */
async function testAppendReviewUsesTemplates() {
  const box = await sandbox()
  save(box, {
    templates: {
      prIssue: {
        active: 'custom',
        presets: {
          custom: { text: 'CUSTOM PR NOTICE {repo} #{pr} {title} {url}\nCOMMENT: {comment}' },
        },
      },
      spvObjection: {
        active: 'custom',
        presets: {
          custom: { text: 'CUSTOM NOTICE {title} / {id} / {thread}\nCOMMENT: {comment}' },
        },
      },
    },
  })
  const saved = { ...process.env }
  try {
    process.env.WHEELCHAIR_AGENT_HOME = box.root
    process.env.DSH_SUPERAGENT_STATE_DIR = box.state
    process.env.SPV_QUEUE_DIR = box.queue
    const pr = prItem({ id: 'acme-alpha-2', pr: 2, title: 'Fix the thing' })
    await writeItem(box.inbox, pr)
    const { task } = await appendReview(box.inbox, { id: pr.id, kind: 'issue', text: 'please fix' })
    assert.equal(task, null)
    const prNotice = (await outboxMessages(box)).find(message => message.thread === 'inbox-2')
    assert.equal(
      prNotice.text,
      `CUSTOM PR NOTICE acme/alpha #2 Fix the thing https://github.com/acme/alpha/pull/2\nCOMMENT: please fix`,
    )

    const message = spvItem({ id: 'spv-ops-20261113T120000Z-beef', thread: 'ops', title: 'Retried' })
    await writeItem(box.inbox, message)
    await appendReview(box.inbox, { id: message.id, kind: 'issue', text: 'why?' })
    const notices = await outboxMessages(box)
    assert.equal(notices.length, 2)
    const objection = notices.find(item => item.thread === 'ops')
    assert.equal(objection.text, `CUSTOM NOTICE Retried / ${message.id} / ops\nCOMMENT: why?`)
  } finally {
    restoreEnv(saved)
  }
}

/** formatResult 用 active 模板与自定义正文上限；坏设置不抛。 */
async function testFormatResultUsesSettings() {
  const box = await sandbox()
  save(box, {
    values: { 'injection.maxBodyChars': 100 },
    templates: { injection: { active: 'custom', presets: { custom: { text: 'CUSTOM {kind}|{thread}|{ticket}|{body}' } } } },
  })
  const settings = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  const long = 'x'.repeat(150)
  const rendered = formatResult({ kind: 'reply', thread: 't1', ticketId: 'tk-9', text: long }, { settings })
  assert.ok(rendered.startsWith('CUSTOM reply|t1| (ticket tk-9)|'), 'the active injection template is used')
  assert.ok(rendered.includes(`${'x'.repeat(100)}\n[truncated after 100 characters`), 'the custom body limit truncates')

  const empty = formatResult({ kind: 'notice', thread: 't2', text: '   ' }, { settings })
  assert.ok(empty.includes('|(empty message)'), 'an empty body is still marked')
  assert.ok(!empty.includes('ticket'), 'no ticket means an empty ticket placeholder')
}

/** startResultInjector 用设置里的模板/截断上限，并且改设置不需要重启。 */
async function testInjectorUsesSettings() {
  const box = await sandbox()
  save(box, {
    values: { 'injection.maxBodyChars': 100 },
    templates: { injection: { active: 'custom', presets: { custom: { text: 'TICK {kind}/{thread}: {body}' } } } },
  })
  const state = { messages: [], injected: [], warnings: [], agentChecks: 0 }
  const dirs = { root: '/fake', pending: '/fake/pending', done: '/fake/done', outbox: '/fake/outbox', read: '/fake/outbox/read' }
  const unread = async () => {
    state.agentChecks += 1
    return state.messages.map(message => ({ ...message }))
  }
  const consume = async (_dirs, message) => {
    const index = state.messages.findIndex(item => item.file === message.file)
    if (index === -1) return undefined
    state.messages.splice(index, 1)
    return message.id
  }
  const inject = (_agent, text, message) => state.injected.push({ text, message })
  let stop
  try {
    stop = startResultInjector({
      dirs,
      getAgent: () => ({ id: 'agent' }),
      inject,
      logger: { warn: (...args) => state.warnings.push(args.join(' ')) },
      intervalMs: 20,
      home: box.root, stateDir: box.state,
      unread,
      consume,
    })
    await waitFor(() => state.agentChecks >= 1, 'the injector to tick')
    state.messages = [{ id: 'r1', file: join(dirs.outbox, 'r1.json'), kind: 'reply', thread: 't1', text: 'y'.repeat(140) }]
    await waitFor(() => state.injected.length === 1, 'the custom-template injection')
    assert.ok(state.injected[0].text.startsWith('TICK reply/t1: '), 'the active template is used')
    assert.ok(state.injected[0].text.includes('[truncated after 100 characters'))

    // 改文件（不重启）：下一条消息必须用新模板。
    save(box, {
      templates: { injection: { active: 'custom', presets: { custom: { text: 'NEW {kind}/{thread}: {body}' } } } },
    })
    state.messages = [{ id: 'r2', file: join(dirs.outbox, 'r2.json'), kind: 'notice', thread: 't2', text: 'second' }]
    await waitFor(() => state.injected.length === 2, 'the second injection')
    assert.equal(state.injected[1].text, 'NEW notice/t2: second', 'a settings change applies without a restart')
    assert.deepEqual(state.warnings, [], 'a healthy settings file logs no warning')
  } finally {
    stop?.()
  }
}

/** `injection.intervalMs` 在两次调度之间被重新读取（假定时器，结果确定）。 */
function testInjectorIntervalReread() {
  const settingsRef = { interval: 50 }
  const calls = []
  const timers = {
    setTimeout: (fn, ms) => {
      const entry = { fn, ms, cleared: false }
      calls.push(entry)
      return entry
    },
    clearTimeout: entry => { entry.cleared = true },
  }
  const state = { warnings: [] }
  const stop = startResultInjector({
    dirs: { root: '/fake', outbox: '/fake/outbox', read: '/fake/outbox/read' },
    getAgent: () => undefined,
    inject: () => {},
    logger: { warn: (...args) => state.warnings.push(args.join(' ')) },
    settingsOf: () => ({
      effective: { 'injection.intervalMs': settingsRef.interval },
      templates: defaultSettings(DEFAULT_SETTINGS).templates,
      warning: undefined,
    }),
    timers,
    unread: async () => [],
    consume: async () => undefined,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].ms, 50, 'the first schedule uses the settings interval')
  calls[0].fn()
  return waitFor(() => calls.length >= 2, 'the next schedule')
    .then(() => {
      settingsRef.interval = 250
      calls[1].fn()
      return waitFor(() => calls.length >= 3, 'the schedule after the change')
    })
    .then(() => {
      assert.equal(calls[2].ms, 250, 'the changed interval is picked up without a restart')
      stop()
      assert.equal(calls[2].cleared, true, 'stop clears the pending timer')
    })
}

/** 注入器遇到坏设置文件：默认模板 + 一条 warning，不抛、不停。 */
async function testInjectorSurvivesCorruptSettings() {
  const box = await sandbox()
  await writeFile(settingsPath(box), '{ broken', 'utf8')
  const state = { messages: [], injected: [], warnings: [], reads: 0 }
  const dirs = { root: '/fake', pending: '/fake/pending', done: '/fake/done', outbox: '/fake/outbox', read: '/fake/outbox/read' }
  const unread = async () => {
    state.reads += 1
    return state.messages.map(message => ({ ...message }))
  }
  const consume = async (_dirs, message) => {
    const index = state.messages.findIndex(item => item.file === message.file)
    if (index === -1) return undefined
    state.messages.splice(index, 1)
    return message.id
  }
  let stop
  try {
    stop = startResultInjector({
      dirs,
      getAgent: () => ({ id: 'agent' }),
      inject: (_agent, text) => state.injected.push(text),
      logger: { warn: (...args) => state.warnings.push(args.join(' ')) },
      intervalMs: 20,
      home: box.root, stateDir: box.state,
      unread,
      consume,
    })
    await waitFor(() => state.reads >= 1, 'the injector to tick')
    state.messages = [{ id: 'r1', file: join(dirs.outbox, 'r1.json'), kind: 'reply', thread: 't1', text: 'ok' }]
    await waitFor(() => state.injected.length === 1, 'a default-template injection')
    assert.equal(state.injected[0], '[spv] reply on thread "t1":\nok')
    assert.ok(state.warnings.some(line => line.includes('panel settings ignored')), 'the corrupt file is warned about')
  } finally {
    stop?.()
  }
}

/** resolveInboxIntervalSeconds：文件 > configured > env > 60；非法 configured/env 仍然抛错。 */
async function testIntervalPrecedence() {
  const box = await sandbox()
  save(box, { values: { 'inbox.intervalSeconds': 30 } })
  assert.equal(resolveInboxIntervalSeconds(undefined, { home: box.root, stateDir: box.state, env: {} }), 30)
  assert.equal(resolveInboxIntervalSeconds(10, { home: box.root, stateDir: box.state, env: {} }), 30, 'the file wins over configured')
  assert.equal(
    resolveInboxIntervalSeconds(10, { home: box.root, stateDir: box.state, env: { SPV_INBOX_INTERVAL_SECONDS: '20' } }),
    30,
    'the file wins over the environment too',
  )
  // A valid saved value must never be broken by a typo in a lower layer: that is the
  // "looks applied but is not" failure mode this function has to avoid.
  assert.equal(
    resolveInboxIntervalSeconds(undefined, { home: box.root, stateDir: box.state, env: { SPV_INBOX_INTERVAL_SECONDS: 'soon' } }),
    30,
    'a valid file value wins without validating a broken environment variable',
  )
  assert.equal(
    resolveInboxIntervalSeconds('soon', { home: box.root, stateDir: box.state, env: {} }),
    30,
    'a valid file value wins without validating a broken plugin config',
  )
  assert.equal(
    resolveInboxIntervalSeconds('soon', { home: box.root, stateDir: box.state, env: { SPV_INBOX_INTERVAL_SECONDS: 'soon' } }),
    30,
    'a valid file value wins even when both lower layers are broken',
  )

  const empty = await sandbox()
  assert.equal(resolveInboxIntervalSeconds(undefined, { home: empty.root, stateDir: empty.state, env: {} }), 60)
  assert.equal(resolveInboxIntervalSeconds(undefined, { home: empty.root, stateDir: empty.state, env: { SPV_INBOX_INTERVAL_SECONDS: '20' } }), 20)
  assert.equal(
    resolveInboxIntervalSeconds(10, { home: empty.root, stateDir: empty.state, env: { SPV_INBOX_INTERVAL_SECONDS: '20' } }),
    10,
    'configured wins over the environment',
  )
  assert.equal(resolveInboxIntervalSeconds(0, { home: empty.root, stateDir: empty.state, env: {} }), 0, '0 still disables')
  assert.equal(resolveInboxIntervalSeconds(0.02, { home: empty.root, stateDir: empty.state, env: {} }), 0.02, 'a fractional configured value is kept')
  assert.throws(() => resolveInboxIntervalSeconds(-1, { home: empty.root, stateDir: empty.state, env: {} }), /non-negative/)
  assert.throws(
    () => resolveInboxIntervalSeconds('soon', { home: empty.root, stateDir: empty.state, env: {} }),
    /non-negative/,
    'an invalid configured value still throws when there is no file value',
  )
  assert.throws(
    () => resolveInboxIntervalSeconds(undefined, { home: empty.root, stateDir: empty.state, env: { SPV_INBOX_INTERVAL_SECONDS: 'soon' } }),
    /non-negative/,
    'an invalid environment variable still throws when there is no file value',
  )

  // A corrupt file has no usable override, so the old loud behaviour is preserved.
  await writeFile(settingsPath(empty), 'not json', 'utf8')
  assert.equal(resolveInboxIntervalSeconds(undefined, { home: empty.root, stateDir: empty.state, env: {} }), 60, 'a corrupt file falls back to 60')
  assert.throws(
    () => resolveInboxIntervalSeconds(undefined, { home: empty.root, stateDir: empty.state, env: { SPV_INBOX_INTERVAL_SECONDS: 'soon' } }),
    /non-negative/,
    'a corrupt file does not swallow an invalid environment variable',
  )
  assert.throws(
    () => resolveInboxIntervalSeconds('soon', { home: empty.root, stateDir: empty.state, env: {} }),
    /non-negative/,
    'a corrupt file does not swallow an invalid configured value',
  )

  // An invalid *file* value is ignored like a missing one: it falls through to configured / env / default.
  await writeJson(settingsPath(empty), { version: 1, revision: 1, values: { 'inbox.intervalSeconds': 'soon' } })
  assert.equal(resolveInboxIntervalSeconds(undefined, { home: empty.root, stateDir: empty.state, env: { SPV_INBOX_INTERVAL_SECONDS: '20' } }), 20)
  assert.throws(
    () => resolveInboxIntervalSeconds(undefined, { home: empty.root, stateDir: empty.state, env: { SPV_INBOX_INTERVAL_SECONDS: 'soon' } }),
    /non-negative/,
    'an invalid file value still falls through to the existing env validation',
  )
  assert.throws(
    () => resolveInboxIntervalSeconds('soon', { home: empty.root, stateDir: empty.state, env: {} }),
    /non-negative/,
    'an invalid file value still falls through to the existing configured validation',
  )
}

/** 动态间隔：0 暂停（一个 gh 都不跑），改回 0.02 后无需重启就恢复。 */
async function testPollerDynamicInterval() {
  const box = await sandbox()
  await writeFakeGh(box)
  const repo = join(box.tools, 'demo')
  await mkdir(repo, { recursive: true })
  git(box, ['init', '-q', '-b', 'main', repo])
  await writeFile(join(repo, 'file.txt'), 'x\n', 'utf8')
  git(box, ['-C', repo, 'add', '-A'])
  git(box, ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
  git(box, ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
  await writeJson(box.ghJson, [{
    number: 1,
    title: 'first',
    state: 'OPEN',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    url: 'https://github.com/acme/demo/pull/1',
    body: 'body',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
    mergedAt: '',
    mergeCommit: null,
  }])
  const saved = { ...process.env }
  const settable = { seconds: 0 }
  try {
    process.env.PATH = `${box.bin}:${process.env.PATH}`
    process.env.FAKE_GH_JSON = box.ghJson
    process.env.FAKE_GH_LOG = box.ghLog
    delete process.env.SPV_INBOX_INTERVAL_SECONDS
    // pollOnce() reads the settings for merge.installRepo; keep that read out of the operator's state dir.
    process.env.WHEELCHAIR_AGENT_HOME = join(ISOLATED_STATE, 'data')
    process.env.DSH_SUPERAGENT_STATE_DIR = ISOLATED_STATE
    const watcher = startInboxWatcher({
      root: box.inbox,
      projectsRoot: box.projects,
      intervalSecondsOf: () => settable.seconds,
      gh: box.gh,
      log: () => {},
      unref: true,
    })
    try {
      // 0 = 暂停：第一轮都不会跑 gh。
      await sleep(300)
      assert.equal((await readFile(box.ghLog, 'utf8')).trim(), '', 'a paused poller runs no gh call')

      settable.seconds = 0.02
      await waitFor(async () => (await readItem(box.inbox, 'acme-demo-1'))?.title === 'first', 'the resumed poll', 5000)

      settable.seconds = 0
      await sleep(1300) // let the in-flight poll finish and the paused re-check happen
      const pausedCalls = (await readFile(box.ghLog, 'utf8')).split('\n').filter(Boolean).length
      await sleep(700)
      const laterCalls = (await readFile(box.ghLog, 'utf8')).split('\n').filter(Boolean).length
      assert.equal(laterCalls, pausedCalls, 'a paused poller stops polling without a restart')
    } finally {
      watcher.stop()
    }
    await watcher.done
  } finally {
    restoreEnv(saved)
  }
}

/** `merge.installRepo` 的设置文件值压过环境变量：合并该仓库时写一条冷安装 notice。 */
async function testMergeRepoFromSettings() {
  const box = await sandbox()
  await writeFakeGh(box)
  // A clone whose origin is a GitHub URL but pulls through the sandbox bare repository.
  const { remote, seed } = await makeRemote(box, 'demo')
  const local = join(box.tools, 'demo')
  git(box, ['clone', '-q', remote, local])
  git(box, ['-C', local, 'remote', 'set-url', 'origin', 'https://github.com/acme/demo.git'])
  await writeFile(
    box.gitConfig,
    [
      '[user]',
      '\tname = Test Runner',
      '\temail = test@example.invalid',
      '[url "file://' + box.remotes + '/"]',
      '\tinsteadOf = https://github.com/acme/',
      '',
    ].join('\n'),
    'utf8',
  )
  const mergedSha = await pushChange(box, seed)
  await writeJson(box.ghJson, [{
    number: 3,
    title: 'merged',
    state: 'OPEN',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    url: 'https://github.com/acme/demo/pull/3',
    body: 'body',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
    mergedAt: '',
    mergeCommit: null,
  }])
  save(box, { values: { 'merge.installRepo': 'acme/demo' } })
  const saved = { ...process.env }
  const restoreGit = installGitEnv(box)
  try {
    process.env.PATH = `${box.bin}:${process.env.PATH}`
    process.env.FAKE_GH_JSON = box.ghJson
    process.env.FAKE_GH_LOG = box.ghLog
    process.env.WHEELCHAIR_AGENT_HOME = box.root
    process.env.DSH_SUPERAGENT_STATE_DIR = box.state
    process.env.SPV_QUEUE_DIR = box.queue
    process.env.SPV_INSTALL_REPO = 'someone/else'
    const watcher = startInboxWatcher({
      root: box.inbox,
      projectsRoot: box.projects,
      intervalSeconds: 0.02,
      gh: box.gh,
      log: () => {},
      unref: true,
    })
    try {
      await waitFor(async () => (await readItem(box.inbox, 'acme-demo-3'))?.state === 'OPEN', 'the open item')
      await writeJson(box.ghJson, [{
        number: 3,
        title: 'merged',
        state: 'MERGED',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        url: 'https://github.com/acme/demo/pull/3',
        body: 'body',
        createdAt: '2026-11-10T00:00:00.000Z',
        updatedAt: '2026-11-15T00:00:00.000Z',
        mergedAt: '2026-11-15T00:00:00.000Z',
        mergeCommit: { oid: mergedSha },
      }])
      await waitFor(async () => (await readItem(box.inbox, 'acme-demo-3'))?.pulledSha === mergedSha, 'the merged pull')
      await waitFor(async () => (await outboxMessages(box)).length === 1, 'the cold-install notice')
      const [notice] = await outboxMessages(box)
      assert.ok(notice.text.includes('PR #3 merged in acme/demo'), 'the settings file selected the install repo')
      assert.ok(notice.text.includes('cold install is now pending'))
    } finally {
      watcher.stop()
    }
    await watcher.done
  } finally {
    restoreGit()
    restoreEnv(saved)
  }
}

/** `work gc` 的默认保留策略来自设置文件；显式的 --keep/--keep-days 仍然优先；坏文件退回 0。 */
async function testWorkGcDefaults() {
  const box = await sandbox()
  await cloneTicket(box, 'alpha')
  await cloneTicket(box, 'beta')
  save(box, { values: { 'work.keep': 1 } })

  const defaulted = cli(box, ['work', 'gc', '--dry-run'])
  assert.equal(defaulted.status, 0, defaulted.stderr || defaulted.stdout)
  assert.match(defaulted.stdout, /would reclaim 1, kept 1/, 'work.keep=1 from the settings file is the default')
  assert.match(defaulted.stdout, /keep\s+[\d.]+ [KMG]?B\s+\w+-0123456789ab \(among the newest 1 directories \(--keep\)\)/)

  const explicit = cli(box, ['work', 'gc', '--dry-run', '--keep', '0'])
  assert.equal(explicit.status, 0)
  assert.match(explicit.stdout, /would reclaim 2, kept 0/, 'an explicit --keep wins over the settings file')

  const explicitDays = cli(box, ['work', 'gc', '--dry-run', '--keep-days', '0'])
  assert.equal(explicitDays.status, 0)
  assert.match(explicitDays.stdout, /would reclaim 1, kept 1/, 'an explicit --keep-days keeps the settings work.keep default')

  await writeFile(settingsPath(box), '{ broken', 'utf8')
  const corrupt = cli(box, ['work', 'gc', '--dry-run'])
  assert.equal(corrupt.status, 0, 'a corrupt settings file never fails work gc')
  assert.match(corrupt.stdout, /would reclaim 2, kept 0/, 'a corrupt file falls back to the built-in defaults')
}

/** 挂载回收：`work.sweepOnMount=false` 整体跳过；开着时 `work.keep` 生效。 */
async function testMountSweepSetting() {
  const box = await sandbox()
  const keep = await cloneTicket(box, 'alpha')
  save(box, { values: { 'work.sweepOnMount': false } })
  const lines = []
  const ctx = {
    orchestrator: {
      machine: { stateDir: box.state },
      settings: { current: () => ({ executor: { directory: box.work } }) },
    },
    logger: { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) },
  }
  await reclaimAtMount(ctx, {
    home: box.root,
    openTickets: async () => ({ tickets: [] }),
    workspaceRegistry: { list: () => [], delete: async () => true },
  })
  assert.ok(lines.some(line => line.includes('skipped; work.sweepOnMount is false')), 'the skip is logged')
  assert.ok((await readFile(join(keep, '.git', 'HEAD'), 'utf8')).length > 0, 'nothing is reclaimed when the sweep is off')

  // Turn it back on with a keep floor: the two clones are both protected by work.keep=2.
  const second = await cloneTicket(box, 'beta')
  save(box, { values: { 'work.sweepOnMount': true, 'work.keep': 2 } })
  const lines2 = []
  const ctx2 = {
    orchestrator: {
      machine: { stateDir: box.state },
      settings: { current: () => ({ executor: { directory: box.work } }) },
    },
    logger: { info: line => lines2.push(String(line)), warn: line => lines2.push(String(line)) },
  }
  await reclaimAtMount(ctx2, {
    home: box.root,
    openTickets: async () => ({ tickets: [] }),
    workspaceRegistry: { list: () => [], delete: async () => true },
  })
  assert.ok(lines2.some(line => /reclaimed 0 clones/.test(line)), 'work.keep=2 protects both clones')
  assert.ok((await readFile(join(keep, '.git', 'HEAD'), 'utf8')).length > 0)
  assert.ok((await readFile(join(second, '.git', 'HEAD'), 'utf8')).length > 0)

  // A direct reclaim with the same keep floor agrees (the mount pass passes it through, not a hard-coded 0).
  const summary = await reclaimWork({ root: box.work, home: box.root, stateDir: box.state, keep: 2, keepDays: 0 })
  assert.equal(summary.reclaimed, 0)
}


/** A PUT response must carry the same precedence snapshot as GET for rows the PUT did not touch. */
async function testPutSnapshotKeepsPrecedence() {
  const box = await sandbox()
  const rowOf = snapshot => snapshot.rows.find(row => row.key === 'inbox.intervalSeconds')
  const handler = createSettingsHandler({
    home: box.root, stateDir: box.state,
    env: { SPV_INBOX_INTERVAL_SECONDS: '20' },
    config: { 'inbox.intervalSeconds': 0.02 },
  })
  const get = await call(handler)
  assert.equal(rowOf(get.body).source, 'config')
  assert.equal(rowOf(get.body).value, 0.02)
  const put = await call(handler, { method: 'PUT', body: { revision: get.body.revision, values: { 'work.keep': 2 } } })
  assert.equal(put.status, 200)
  assert.equal(rowOf(put.body).source, 'config', 'the PUT snapshot keeps the config layer for an untouched row')
  assert.equal(rowOf(put.body).value, 0.02)
  assert.deepEqual(rowOf(put.body).overridden, [{ source: 'env', value: 20 }])
  const again = await call(handler)
  assert.deepEqual(rowOf(again.body), rowOf(put.body), 'the PUT response and the next GET agree')

  // An env-sourced untouched row survives too.
  const envBox = await sandbox()
  const envHandler = createSettingsHandler({ home: envBox.root, stateDir: envBox.state, env: { SPV_INBOX_INTERVAL_SECONDS: '33' } })
  const envGet = await call(envHandler)
  assert.equal(rowOf(envGet.body).source, 'env')
  assert.equal(rowOf(envGet.body).value, 33)
  const envPut = await call(envHandler, {
    method: 'PUT',
    body: { revision: envGet.body.revision, values: { 'work.keep': 1 } },
  })
  assert.equal(rowOf(envPut.body).source, 'env', 'the PUT snapshot keeps the env layer for an untouched row')
  assert.equal(rowOf(envPut.body).value, 33)

  // The handler's own env must be forwarded; process.env must not leak into the PUT response.
  const savedEnv = process.env.SPV_INBOX_INTERVAL_SECONDS
  process.env.SPV_INBOX_INTERVAL_SECONDS = '99'
  try {
    const isolatedBox = await sandbox()
    const isolated = createSettingsHandler({ home: isolatedBox.root, stateDir: isolatedBox.state, env: {} })
    const isolatedGet = await call(isolated)
    const isolatedPut = await call(isolated, {
      method: 'PUT',
      body: { revision: isolatedGet.body.revision, values: { 'work.keep': 1 } },
    })
    assert.equal(rowOf(isolatedGet.body).source, 'default')
    assert.equal(rowOf(isolatedPut.body).source, 'default', 'the handler env, not process.env, reaches the PUT snapshot')
    assert.equal(rowOf(isolatedPut.body).value, 60)
  } finally {
    if (savedEnv === undefined) delete process.env.SPV_INBOX_INTERVAL_SECONDS
    else process.env.SPV_INBOX_INTERVAL_SECONDS = savedEnv
  }

  // The library call forwards them too (the handler is not the only caller).
  const directBox = await sandbox()
  const direct = saveSettings({
    home: directBox.root, stateDir: directBox.state,
    revision: 0,
    values: { 'work.keep': 1 },
    config: { 'inbox.intervalSeconds': 0.02 },
  })
  assert.equal(rowOf(direct).source, 'config')
  assert.equal(rowOf(direct).value, 0.02)
}

/** Prototype-named settings keys / template ids / presets are refused loudly, never silently accepted. */
async function testPrototypeNamesAndIds() {
  const box = await sandbox()
  const handler = createSettingsHandler({ home: box.root, stateDir: box.state, env: {} })
  const snapshot = () => resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  const revision = snapshot().revision

  for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
    const answer = await call(handler, { method: 'PUT', body: { revision, values: { [key]: 5 } } })
    assert.equal(answer.status, 400, `the settings key ${JSON.stringify(key)} is refused`)
    assert.equal(answer.body.code, 'SETTINGS_INVALID')
    assert.match(answer.body.message, /unknown settings key/)
  }
  assert.equal(snapshot().revision, revision, 'no prototype-named key writes anything')

  for (const id of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
    const answer = await call(handler, { method: 'PUT', body: { revision, templates: { [id]: { active: 'default' } } } })
    assert.equal(answer.status, 400, `the template id ${JSON.stringify(id)} is refused`)
    assert.equal(answer.body.code, 'SETTINGS_INVALID')
  }

  let answer = await call(handler, { method: 'PUT', body: { revision, reset: { templates: ['__proto__'] } } })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.code, 'SETTINGS_INVALID')
  answer = await call(handler, { method: 'PUT', body: { revision, reset: { templates: ['constructor'] } } })
  assert.equal(answer.status, 400)
  answer = await call(handler, { method: 'PUT', body: { revision, reset: { values: ['constructor'] } } })
  assert.equal(answer.status, 400)

  for (const name of ['__proto__', 'prototype', 'constructor']) {
    answer = await call(handler, {
      method: 'PUT',
      body: { revision, templates: { prIssue: { presets: { [name]: { text: '{repo} {pr}\n{comment}' } } } } },
    })
    assert.equal(answer.status, 400, `the preset name ${JSON.stringify(name)} is refused`)
    assert.equal(answer.body.code, 'SETTINGS_INVALID')
    assert.match(answer.body.message, /reserved/)
  }
  assert.throws(() => validateTemplate('constructor', '{comment}'), error => error.code === 'SETTINGS_INVALID')
  assert.throws(() => validateTemplate('__proto__', '{comment}'), error => error.code === 'SETTINGS_INVALID')

  // A non-reserved prototype-ish name still works: the internal maps are null-prototype + own-checked.
  answer = await call(handler, {
    method: 'PUT',
    body: { revision, templates: { prIssue: { presets: { toString: { text: '{repo} {pr}\n{comment}' } } } } },
  })
  assert.equal(answer.status, 200)
  assert.ok(answer.body.templates.prIssue.presets.some(preset => preset.name === 'toString'))
  const roundTrip = snapshot()
  assert.ok(roundTrip.templates.prIssue.presets.some(preset => preset.name === 'toString'), 'a toString preset persists and resolves')
  const stored = await readJson(settingsPath(box))
  assert.ok(Object.hasOwn(stored.templates.prIssue.presets, 'toString'))

  // A hand-edited file with prototype-named ids/keys is ignored with a warning, never thrown.
  await writeJson(settingsPath(box), {
    version: 1,
    revision: 4,
    values: { constructor: 5 },
    templates: { constructor: { active: 'default' } },
  })
  const edited = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(edited.fileState, 'ok')
  assert.equal(edited.revision, 4)
  assert.deepEqual(edited.values, {})
  assert.match(edited.warning, /unknown settings key "constructor"/)
  assert.match(edited.warning, /unknown template "constructor"/)
  assert.equal(edited.templates.injection.active, 'default', 'the prototype-named template did not replace a real one')
}

/** N6: the stored file carries only custom presets; a stored built-in copy is advisory and never warns. */
async function testStoredTemplatesOmitBuiltinText() {
  const box = await sandbox()
  save(box, {
    templates: { injection: { active: 'custom', presets: { custom: { text: '[spv] {kind} {thread}: {body}' } } } },
  })
  const stored = await readJson(settingsPath(box))
  assert.deepEqual(Object.keys(stored.templates.injection.presets), ['custom'], 'only custom presets are written')
  assert.equal(stored.templates.injection.presets.default, undefined, 'the built-in text is not copied into the file')

  // An old file with a stored default equal to the current builtin stays warning-free.
  await writeJson(settingsPath(box), {
    version: 1,
    revision: 5,
    values: {},
    templates: {
      injection: {
        active: 'custom',
        presets: {
          default: { text: defaultSettings(DEFAULT_SETTINGS).templates.injection.defaultText, builtin: true },
          custom: { text: '[spv] {kind} {thread}: {body}' },
        },
      },
    },
  })
  const old = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(old.warning, undefined, 'a stored built-in copy is advisory and does not warn')
  assert.equal(old.templates.injection.active, 'custom')
  assert.equal(old.templates.injection.text, '[spv] {kind} {thread}: {body}')

  // A stale stored default (an older builtin text) is ignored silently as well.
  const stale = await readJson(settingsPath(box))
  stale.templates.injection.presets.default.text = 'STALE BUILTIN {kind} {thread} {body}'
  await writeJson(settingsPath(box), stale)
  const after = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(after.warning, undefined, 'a stale stored built-in copy is ignored silently')
  assert.equal(after.templates.injection.defaultText, defaultSettings(DEFAULT_SETTINGS).templates.injection.defaultText)
  assert.equal(after.templates.injection.text, '[spv] {kind} {thread}: {body}')
}

/** The style setting is a normal enum key: validates, round-trips, refuses an unknown value. */
async function testStyleSetting() {
  const box = await sandbox()
  const snapshot = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(snapshot.effective['webui.style'], 'fluid', 'fluid is the shipped default')
  assert.deepEqual(
    saveSettings({ home: box.root, stateDir: box.state, env: {}, revision: 0, values: { 'webui.style': 'minimal' } })
      .effective['webui.style'],
    'minimal',
    'minimal survives a save',
  )
  assert.throws(
    () => saveSettings({ home: box.root, stateDir: box.state, env: {}, revision: 1, values: { 'webui.style': 'arcade' } }),
    /webui\.style must be one of "minimal", "fluid"/,
  )
  assert.equal(resolveSettings({ home: box.root, stateDir: box.state, env: {} }).revision, 1, 'a refused value writes nothing')

  const persisted = JSON.parse(await readFile(settingsPath(box), 'utf8'))
  assert.deepEqual(persisted.values, { 'webui.style': 'minimal' }, 'the style key round-trips through the store file')

  const handler = createSettingsHandler({ home: box.root, stateDir: box.state, env: {} })
  const put = await call(handler, { method: 'PUT', body: { revision: 1, values: { 'webui.style': 'fluid' } } })
  assert.equal(put.status, 200)
  assert.equal(put.body.effective['webui.style'], 'fluid')
  assert.deepEqual(put.body.values, { 'webui.style': 'fluid' })
  assert.equal(put.body.rows.find(row => row.key === 'webui.style').source, 'file')
  assert.equal(put.body.rows.find(row => row.key === 'webui.style').default, 'fluid')
  assert.deepEqual(put.body.rows.find(row => row.key === 'webui.style').options, ['minimal', 'fluid'])

  const reset = save(box, { reset: { values: ['webui.style'] } })
  assert.deepEqual(reset.values, {}, 'resetting the style removes the stored override')
  assert.equal(reset.effective['webui.style'], 'fluid', 'reset falls back to the fluid default')
}

/** Install/first run ships the empty-but-valid settings file; it never overwrites or pins defaults. */
async function testEnsureSettingsFile() {
  const box = await sandbox()
  const first = ensureSettingsFile({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(first.created, true, 'a missing file is created')
  assert.deepEqual(
    JSON.parse(await readFile(first.file, 'utf8')),
    { version: SETTINGS_VERSION, revision: 0, values: {}, templates: {} },
    'the file is empty-but-valid, with no resolved defaults written into it',
  )
  const snapshot = resolveSettings({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(snapshot.fileState, 'ok')
  assert.equal(snapshot.revision, 0)
  assert.deepEqual(snapshot.effective, EXPECTED_DEFAULTS, 'empty values still yield the built-in defaults')

  await writeJson(settingsPath(box), { version: 1, revision: 7, values: { 'webui.style': 'minimal' }, templates: {} })
  const before = await readFile(settingsPath(box), 'utf8')
  const second = ensureSettingsFile({ home: box.root, stateDir: box.state, env: {} })
  assert.equal(second.created, false, 'an existing file is not replaced')
  assert.equal(await readFile(settingsPath(box), 'utf8'), before)
  assert.equal(resolveSettings({ home: box.root, stateDir: box.state, env: {} }).effective['webui.style'], 'minimal')

  // A legacy file is migrated first; the shipped empty file cannot shadow real old values.
  const legacyBox = await sandbox()
  await writeJson(join(legacyBox.state, 'panel-settings.json'), { version: 1, revision: 3, values: { 'webui.style': 'minimal' } })
  const migrated = ensureSettingsFile({ home: legacyBox.root, stateDir: legacyBox.state, env: {} })
  assert.equal(migrated.created, false)
  assert.equal(resolveSettings({ home: legacyBox.root, stateDir: legacyBox.state, env: {} }).effective['webui.style'], 'minimal')
}

/** CSS gates: token-only colour, reduced-motion guards, no linear easing, one root style attribute. */
async function testClientStyleAndDraftHelpers() {
  const client = await loadClient()
  const { STYLES, styleOf, itemDraftKey, createDraftStore, restoreSettingsDrafts, sourceSummary, stagedChanges, freshItemIndices, INBOX_REFRESH_MS } = client.__test
  const source = await readFile(fileURLToPath(new URL('../webui/lib/client.js', import.meta.url)), 'utf8')
  assert.equal(typeof STYLES, 'string', 'the client exposes its stylesheet for the offline CSS checks')
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b/i, 'no hardcoded hex anywhere in the bundle')
  assert.doesNotMatch(STYLES, /radial-gradient/, 'the fluid style ships no dot/paper texture')
  assert.doesNotMatch(STYLES, /\.wca-day::before/, 'day groups are separated by cards and spacing, never a rail rule')
  assert.doesNotMatch(STYLES, /inset 0 1px 0/, 'letter cards have no inset seam rule')
  assert.doesNotMatch(STYLES, /\.wca-review\s*\{[^}]*border-left/, 'review records have no divider rule inside the card')
  assert.doesNotMatch(STYLES, /wca-day-rail|wca-day-label|wca-day-sentinel/, 'the inbox no longer renders a date rail')
  assert.doesNotMatch(STYLES, /backdrop-filter/, 'no backdrop blur: over the opaque page it would render as nothing')
  assert.match(STYLES, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?animation: none !important;[\s\S]*?transition: none !important;/, 'reduced motion disables every animation and transition')
  assert.equal((STYLES.match(/@keyframes/g) ?? []).length, 3, 'the fluid style introduces exactly three keyframes')
  assert.doesNotMatch(STYLES, /(?:transition|animation):[^;]*\blinear\b/, 'linear easing is banned')
  assert.match(STYLES, /\[data-wca-style="fluid"\]/, 'a variant is scoped by one root attribute')
  assert.doesNotMatch(STYLES, /^\s*\.(?!wca-)/m, 'every CSS rule is wca- prefixed')
  assert.match(STYLES, /\[data-wca-style="minimal"\] \.wca-letter/, 'the minimal variant keeps the same cards')
  // The width knob: one property, resolved by both the inbox and the settings page (both are page children).
  assert.deepEqual(
    resolveContentMax(STYLES),
    { token: '1200px', width: '100%', maxWidth: 'var(--wca-content-max)', resolved: '1200px' },
    'both sections resolve through one 1200px property',
  )
  assert.doesNotMatch(STYLES, /max-width:\s*960px/, 'the old 960 frame is gone')
  // Fluid material is perceivable without a hover: a tinted wash, a tinted hairline and two shadow layers.
  assert.match(STYLES, /\.wca-page\[data-wca-style="fluid"\] \.wca-letter,[^{}]*\{[^}]*color-mix\(in oklab, var\(--wca-wash\) 18%, var\(--dsw-alias-bg-layer-1\)\)/, 'fluid letter cards carry a visible tonal wash')
  assert.match(STYLES, /\.wca-page\[data-wca-style="fluid"\] \.wca-letter\[data-draft="true"\] \{[^}]*--dsw-alias-state-warn-primary/, 'a draft keeps its warning border on top of the fluid material')
  assert.match(STYLES, /box-shadow: var\(--wca-shadow-contact\), var\(--wca-shadow-ambient\)/, 'fluid cards keep the two-layer shadow')
  assert.match(STYLES, /\.wca-letter:hover,[\s\S]*?transform: translateY\(-2px\)/, 'hover lifts the card two pixels')
  assert.match(STYLES, /\.wca-letter:hover,[\s\S]*?var\(--wca-shadow-hover\)/, 'hover deepens the ambient shadow')
  assert.match(STYLES, /\[data-wca-style="minimal"\][\s\S]*?animation: none/, 'minimal stays strictly static')
  // The motion contract: enter/exit curves, press, expand, wipe, approve settle, and the 30ms arrival stagger.
  assert.match(STYLES, /--wca-ease-enter: cubic-bezier\(\.22, 1, \.36, 1\)/)
  assert.match(STYLES, /--wca-ease-exit: cubic-bezier\(\.4, 0, \.2, 1\)/)
  assert.match(STYLES, /\.wca-btn:active[^{]*\{[^}]*transform: scale\(\.985\)/)
  assert.match(STYLES, /grid-template-rows 240ms/)
  assert.match(STYLES, /opacity 160ms var\(--wca-ease-enter\) 40ms/)
  assert.match(STYLES, /wca-wipe 200ms/)
  assert.match(STYLES, /animation-delay: calc\(var\(--wca-new-index, 0\) \* 30ms\)/)
  assert.match(STYLES, /\[data-wca-style="fluid"\] \.wca-letter\[data-arriving="true"\] \{\s*animation: wca-arrive 280ms var\(--wca-ease-enter\) backwards;/, 'every letter animates on an ordinary mount, not only data-new items')
  assert.doesNotMatch(STYLES, /data-new="true"\]/, 'the arrival animation is no longer gated on the new-item marker')
  // The two letter kinds differ by exactly the documented dimension set.
  assert.match(STYLES, /\.wca-letter \{[^}]*border-radius: 8px;[^}]*\}/)
  assert.match(STYLES, /\.wca-letter::before \{[^}]*width: 4px;[^}]*\}/)
  assert.match(STYLES, /\.wca-letter\[data-kind="spv_message"\] \{[^}]*border-radius: 14px;[^}]*padding-inline: 22px 20px;[^}]*\}/)
  assert.match(STYLES, /\.wca-letter\[data-kind="spv_message"\]::before \{[^}]*width: 5px;[^}]*\}/)
  assert.match(STYLES, /\.wca-letter\[data-kind="pr"\] \{ --wca-tint: var\(--dsw-alias-button-primary-fill\); \}/)
  assert.match(STYLES, /\.wca-letter\[data-kind="spv_message"\] \{\s*--wca-tint: var\(--dsw-alias-state-business-primary\);/)

  assert.equal(styleOf({ effective: { 'webui.style': 'minimal' } }), 'minimal')
  assert.equal(styleOf({ values: { 'webui.style': 'fluid' } }), 'fluid')
  assert.equal(styleOf({}), 'fluid', 'the default is fluid')
  assert.equal(styleOf({ effective: { 'webui.style': 'future' } }), 'future', 'a third style needs only its CSS block')
  const stagedStyle = stagedChanges(
    { rows: [{ key: 'webui.style', value: 'fluid', default: 'fluid', options: ['minimal', 'fluid'] }], templates: {} },
    { 'webui.style': 'minimal' },
    {},
    new Set(),
    key => key,
  )
  assert.deepEqual(stagedStyle.values, { 'webui.style': 'minimal' }, 'the enum row stages through the real save path')
  assert.deepEqual(stagedStyle.valueErrors, {})

  // A ~60s refresh exists and the fresh-id marker still tracks which ids a response added.
  assert.equal(INBOX_REFRESH_MS, 60000)
  assert.match(source, /setInterval\(\(\) => \{[\s\S]*?\}, INBOX_REFRESH_MS\)/, 'the panel polls the inbox on a timer')
  assert.equal(freshItemIndices(null, [{ id: 'a' }]).size, 0, 'the first response has no fresh-id marker')
  assert.deepEqual(
    [...freshItemIndices(new Set(['a']), [{ id: 'a' }, { id: 'b' }, { id: 'c' }])],
    [['b', 0], ['c', 1]],
    'only added ids animate, staggered by their order',
  )

  const data = new Map()
  const storage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  }
  assert.equal(itemDraftKey({ id: 'spv-thread-1' }), 'spv-thread-1')
  const first = createDraftStore(storage, 'inbox')
  first.set('spv-thread-1', { mode: 'issue', text: 'needs a second look' })
  // A new store instance stands in for a re-render / a remount after switching sections.
  const second = createDraftStore(storage, 'inbox')
  assert.deepEqual(second.get('spv-thread-1'), { mode: 'issue', text: 'needs a second look' })
  second.clear('spv-thread-1')
  assert.equal(createDraftStore(storage, 'inbox').get('spv-thread-1'), undefined, 'submit clears the draft')

  const settingsSnapshot = {
    revision: 2,
    rows: [{ key: 'webui.style' }],
    templates: { injection: { active: 'default' } },
  }
  const restored = restoreSettingsDrafts(settingsSnapshot, {
    revision: 2,
    valueDrafts: { 'webui.style': 'minimal', gone: 'x' },
    templateDrafts: { injection: { active: 'mine', presets: { mine: 'TEXT' } }, gone: { active: 'default', presets: {} } },
    resets: ['webui.style', 'gone'],
  })
  assert.deepEqual(restored.valueDrafts, { 'webui.style': 'minimal' })
  assert.deepEqual(restored.templateDrafts, { injection: { active: 'mine', presets: { mine: 'TEXT' } } })
  assert.deepEqual([...restored.resets], ['webui.style'])
  const stale = restoreSettingsDrafts(settingsSnapshot, {
    revision: 1,
    valueDrafts: { 'webui.style': 'minimal' },
    templateDrafts: {},
    resets: [],
  })
  assert.deepEqual(stale, { valueDrafts: {}, templateDrafts: {}, resets: new Set() }, 'a stale revision drops its draft')

  assert.deepEqual(
    sourceSummary({ rows: [{ source: 'file' }, { source: 'file' }, { source: 'env' }, { source: 'default' }] }),
    { file: 2, config: 0, env: 1, default: 1 },
  )
}

/**
 * The inbox structure and the shared width, lifted from the client's own exports: no rail/column in
 * the markup, a timestamp inside every letter, and both feature pages resolving through one knob.
 */
async function testInboxMarkupAndWidth() {
  const client = await loadClient()
  const { STYLES, InboxItem, DayGroup, letterTimeOf, clearsArrival } = client.__test
  assert.equal(typeof InboxItem, 'function', 'the client exposes the letter component to the offline test')
  assert.equal(typeof DayGroup, 'function', 'the client exposes the day group to the offline test')
  assert.equal(typeof letterTimeOf, 'function', 'the timestamp helper is testable without a browser')
  assert.equal(typeof clearsArrival, 'function', 'the arrival-end guard is testable without a browser')

  assert.deepEqual(
    resolveContentMax(STYLES),
    { token: '1200px', width: '100%', maxWidth: 'var(--wca-content-max)', resolved: '1200px' },
    'the inbox and the settings page resolve to the same 1200px frame',
  )
  assert.doesNotMatch(STYLES, /\.wca-(?:inbox|settings|feature)[^{]*\{[^}]*max-width/, 'neither feature adds its own width')

  const t = key => key
  const items = [
    {
      id: 'acme-alpha-42',
      kind: 'pr',
      repo: 'acme/alpha',
      pr: 42,
      title: 'A PR letter',
      state: 'OPEN',
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      at: '2026-11-16T02:04:00.000Z',
    },
    {
      id: 'spv-main-1',
      kind: 'spv_message',
      title: 'A decision letter',
      thread: 'main',
      at: '2026-11-16T03:05:00.000Z',
    },
  ]
  const group = DayGroup({
    day: '2026-11-16',
    label: 'Nov 16, 2026',
    items,
    startIndex: 0,
    t,
    drafts: {},
    newIds: new Map(),
    onDraft: () => {},
    onSubmitted: () => {},
  })
  const sectionElements = []
  walkTree(group, element => sectionElements.push(element))
  const section = sectionElements.find(element => element.type === 'section')
  assert.ok(section, 'the day group is still a section')
  assert.equal(section.props['aria-label'], 'Nov 16, 2026', 'the day keeps its accessible name')
  assert.equal(section.props['data-day'], '2026-11-16')
  const paintedClasses = sectionElements.map(classNamesOf)
  assert.equal(
    paintedClasses.some(name => /wca-day-(?:rail|label|sentinel)/.test(name)),
    false,
    'no date rail, sticky label or sentinel is rendered',
  )
  assert.deepEqual(
    sectionElements.filter(element => classNamesOf(element) === 'wca-cards').length,
    1,
    'the section holds only the card column, with no empty rail column',
  )

  for (const [index, item] of items.entries()) {
    const card = InboxItem({
      item,
      t,
      draft: undefined,
      isNew: false,
      arrivalIndex: index,
      onDraft: () => {},
      onSubmitted: () => {},
    })
    const cardElements = []
    walkTree(card, element => cardElements.push(element))
    const meta = cardElements.find(element => classNamesOf(element) === 'wca-meta')
    const time = cardElements.find(element => classNamesOf(element) === 'wca-letter-time')
    assert.ok(meta, `letter ${item.id} has a meta row`)
    assert.ok(time, `letter ${item.id} carries its own timestamp`)
    let insideMeta = false
    walkTree(meta, element => {
      if (element === time) insideMeta = true
    })
    assert.ok(insideMeta, `letter ${item.id} puts its timestamp in the meta row, clear of the chips`)
    const stamp = letterTimeOf(item)
    assert.equal(time.type, 'time')
    assert.equal(time.props.children, stamp.label)
    assert.match(String(time.props.children), /\d{1,2}:\d{2}/, 'the label includes the time of day')
    assert.equal(time.props.dateTime, stamp.datetime)
    assert.equal(time.props.title, stamp.title)
    assert.match(String(time.props.dateTime), /^2026-11-16T\d{2}:/)
    assert.equal(card.props.style['--wca-new-index'], String(index), 'each card gets its stagger index')
    assert.equal(card.props['data-arriving'], 'true', 'every card mounts with the arrival animation enabled')
    assert.equal(typeof card.props.onAnimationEnd, 'function', 'the arrival marker has a clearing handler')
    assert.equal(card.props['data-new'], undefined, 'an ordinary card is no longer marked new to animate')
  }

  // Only the card's own arrival ends the entry state; a child animation or the approve settle must not.
  assert.equal(clearsArrival({ target: 'card', currentTarget: 'card', animationName: 'wca-arrive' }), true)
  assert.equal(clearsArrival({ target: 'card', currentTarget: 'card', animationName: 'wca-settle' }), false)
  assert.equal(clearsArrival({ target: 'child', currentTarget: 'card', animationName: 'wca-arrive' }), false)

  // A letter with no parseable timestamp still renders a visible, localized placeholder.
  const missing = InboxItem({
    item: { id: 'spv-main-2', kind: 'spv_message', title: 'No date' },
    t,
    draft: undefined,
    isNew: false,
    arrivalIndex: 0,
    onDraft: () => {},
    onSubmitted: () => {},
  })
  const missingElements = []
  walkTree(missing, element => missingElements.push(element))
  const missingTime = missingElements.find(element => classNamesOf(element) === 'wca-letter-time')
  assert.ok(missingTime, 'a dateless letter still has its timestamp node')
  assert.equal(missingTime.props.children, 'day.unknown')
  assert.equal(missingTime.props.title, 'day.unknown')
  assert.equal(missingTime.props.dateTime, undefined)

  // An unparseable value still yields the node, with the raw value as its label.
  const broken = letterTimeOf({ at: 'not-a-date' })
  assert.equal(broken.label, 'not-a-date')
  assert.equal(broken.datetime, undefined)
}

// --------------------------------------------------------------------- main

try {
  await testDefaults()
  await testDefaultTemplates()
  await testStyleSetting()
  await testEnsureSettingsFile()
  await testSaveMergeAndStaleRevision()
  await testCorruptAndHandEditedFiles()
  testTemplateValidation()
  await testPresetCrudAndReset()
  await testPrecedence()
  await testHttpHandler()
  await testPutSnapshotKeepsPrecedence()
  await testPrototypeNamesAndIds()
  await testStoredTemplatesOmitBuiltinText()
  await testClientSettingsHelpers()
  await testClientStyleAndDraftHelpers()
  await testInboxMarkupAndWidth()
  await testClientTemplateStaging()
  await testClientHookHelpers()
  await testHostSettingsRoute()
  await testHooksBlock()
  await testHookTimeoutsAndRawPreservation()
  await testAppendReviewUsesTemplates()
  await testFormatResultUsesSettings()
  await testInjectorUsesSettings()
  await testInjectorIntervalReread()
  await testInjectorSurvivesCorruptSettings()
  await testIntervalPrecedence()
  await testPollerDynamicInterval()
  await testMergeRepoFromSettings()
  await testWorkGcDefaults()
  await testMountSweepSetting()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true })
  restoreEnv(ORIGINAL_ENV)
}
