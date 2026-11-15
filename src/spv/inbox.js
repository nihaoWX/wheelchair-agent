/**
 * 审查收件箱：一个 PR 一个 JSON item，外加「整条评论 → spv 任务」的派活流程。
 *
 * 这是收件箱的**唯一**实现。CLI（`wheelchair-agent inbox watch`）与 dsh 的 webui 插件都 import 它：
 * webui 的 host 半身 import 的是 `install.sh` 从本文件复制进 profile 的副本（`lib/core/inbox.js`），
 * 所以面板和轮询器不会各写一份，也不会因为 preset 被别的 worktree 替换而失效（见 `webui/README.md`）。
 *
 * 纯 Node builtins：不 import dsh，不 `process.exit`。
 *
 * 目录布局（缺省 `<stateDir>/inbox/`）：
 *   <owner>-<name>-<number>.json   一个 PR item；评论追加到它的 `review` 数组
 *   .<id>.lock                     该 item 的跨进程写锁（watcher 与 review POST 共用）
 */
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { checkProject, checkTask, checkThread, submitTask } from './dispatch.js'
import { DEFAULT_STATE_DIR, resolveRoot } from './paths.js'
import { dirsOf } from '../shared/queue.js'

const execFileAsync = promisify(execFile)

/** 未指定时收件箱根目录（绝对路径）。 */
export const INBOX_ROOT_DEFAULT = join(DEFAULT_STATE_DIR, 'inbox')

/** 一条评论的上限：够写清一条审查意见，又不至于把任务正文推过模型的单次预算。 */
const REVIEW_LIMIT = 5000
/** item 文件名：轮询器生成的 `<owner>-<name>-<number>` 与 POST 传来的 id 共用同一套约束。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
/** `git@github.com:owner/name.git`、`https://github.com/owner/name` 都归一到 `owner/name`。 */
const GITHUB_REMOTE = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i
/** item 里 `repo` 字段的形状；`owner/name`，两段都是普通仓库名字符。 */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/** `gh pr list` 要的字段；顺序无关，但一处定义避免两个调用点漂移。 */
const GH_FIELDS = 'number,title,state,additions,deletions,changedFiles,url,body,updatedAt'
/** 这些字段变了才重写 item；`review` 与 `at` 从不参与比较。 */
const ITEM_FIELDS = ['title', 'state', 'additions', 'deletions', 'changedFiles', 'url', 'body']
/** review 请求体上限：与 dsh-host-open-in-app 的 64 KiB 约定一致。 */
const MAX_BODY_BYTES = 64 * 1024
/** 每 item 一把跨进程锁：重试间隔、持锁上限、过期判定。 */
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 30_000
/** `setTimeout` 的毫秒上限；更长的间隔会溢出成约 1ms 的忙循环。 */
const MAX_TIMER_MS = 2_147_483_647

const ITEMS_PATH = '/wheelchair-inbox/items'
const REVIEW_PATH = '/wheelchair-inbox/review'

/** `$SPV_INBOX_DIR`，否则 `<stateDir>/inbox`。 */
export function resolveInboxRoot() {
  const fromEnv = String(process.env.SPV_INBOX_DIR ?? '').trim()
  if (fromEnv) return fromEnv
  const stateDir = String(process.env.DSH_SUPERAGENT_STATE_DIR ?? '').trim() || DEFAULT_STATE_DIR
  return join(stateDir, 'inbox')
}

/** 收件箱只有一个目录；保留这个形状是为了和 `dirsOf` 的调用点一致，且将来好扩展。 */
export function inboxDirs(root) {
  return { root: String(root) }
}

/** 校验并规范化 item id：它同时是文件名与锁名，非法值会被拒绝而不是拼进路径。 */
function checkItemId(id) {
  const value = String(id ?? '')
  if (!ID_PATTERN.test(value)) {
    throw invalid(
      `invalid inbox item id ${JSON.stringify(id)}: use 1-200 characters from A-Z a-z 0-9 . _ -, starting ` +
        'with a letter or digit (the id is also the item file name).',
    )
  }
  return value
}

/** item 文件路径；id 先过 `checkItemId`，避免拼出 `../` 之类的路径。 */
function itemFile(root, id) {
  return join(root, `${checkItemId(id)}.json`)
}

/** 全部 item，最新 `at` 在前；读不了或解析不了的文件跳过，不能因为一个坏文件藏起整个收件箱。 */
export async function readItems(root) {
  const names = await readdir(root).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const items = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    try {
      items.push(JSON.parse(await readFile(join(root, name), 'utf8')))
    } catch {
      // 半写或手改坏的文件跳过；写 item 用 `.tmp-` 前缀，正常不会被扫到。
    }
  }
  return items.sort((a, b) => {
    const byTime = String(b?.at ?? '').localeCompare(String(a?.at ?? ''))
    if (byTime !== 0) return byTime
    // 同一毫秒写入的两个 item 需要稳定顺序，否则列表顺序随目录读取顺序抖动。
    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  })
}

/** 读一个 item；不存在返回 undefined，存在但不是合法 JSON 时报错说明该修哪个文件。 */
export async function readItem(root, id) {
  const file = itemFile(root, id)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${file} is not valid JSON; fix or delete it, then retry.`)
  }
}

/**
 * 原子写一个 item：先写唯一的 `.tmp-*` 再 rename，读侧永远不会看到半写的文件。
 *
 * 临时名带 `randomUUID()`：同一毫秒内的两个写者（watcher 与 review POST）不会撞名，rename 也就不会
 * 互相覆盖出半截 JSON。调用方仍须持有 `withItemLock`，否则后写者会覆盖先写者的 read-modify-write。
 */
export async function writeItem(root, item) {
  const file = itemFile(root, item?.id)
  await mkdir(root, { recursive: true })
  const temporary = join(root, `.tmp-${item.id}-${randomUUID()}`)
  await writeFile(temporary, `${JSON.stringify(item, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
  // writeFile's mode is filtered by the process umask; chmod once so the item is 0644 regardless.
  await chmod(temporary, 0o644)
  await rename(temporary, file)
  return item
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 在 `<root>/.<id>.lock` 的跨进程锁内跑 `fn`。
 *
 * `open(lock, 'wx')` 的原子创建就是互斥：watcher 与 review POST 是两个进程，只有文件系统能仲裁。
 * 锁超过 30s 视为上一个进程崩掉后留下的，删掉重试；获取失败 5s 后抛 `INBOX_LOCKED`，附带可照抄的
 * `fix:`。无论 `fn` 成功还是抛错，都在 `finally` 里 close + unlink。
 */
async function withItemLock(root, id, fn) {
  const value = checkItemId(id)
  await mkdir(root, { recursive: true })
  const lock = join(root, `.${value}.lock`)
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    let handle
    try {
      handle = await open(lock, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let info
      try {
        info = await stat(lock)
      } catch (statError) {
        if (statError.code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        // Reap by atomic rename: only the rename winner can remove the abandoned lock, so we never
        // delete a fresh lock that another process acquired between stat() and unlink().
        const reaped = `${lock}.reap.${randomUUID()}`
        try {
          await rename(lock, reaped)
          await unlink(reaped).catch(() => {})
        } catch (reapError) {
          if (reapError.code !== 'ENOENT') throw reapError
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw locked(value, lock)
      }
      await delay(LOCK_RETRY_MS)
      continue
    }
    try {
      // 写入持有者信息既方便排查，也让锁文件不是空文件（stat 的 mtime 就是判定依据）。
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`)
      return await fn()
    } finally {
      await handle.close().catch(() => {})
      await unlink(lock).catch(() => {})
    }
  }
}

/** 获取锁超时：说清哪把锁、等多久、以及操作者能做什么。 */
function locked(id, lock) {
  const error = new Error(
    `could not lock inbox item ${JSON.stringify(id)} within ${LOCK_TIMEOUT_MS / 1000}s (lock file ${lock}). ` +
      'fix: another wheelchair-agent process is writing this item; retry in a moment, or delete that lock ' +
      'file if no such process is running.',
  )
  error.code = 'INBOX_LOCKED'
  return error
}

/** 校验失败用这个错误码，HTTP 层据此回 400。 */
function invalid(message) {
  const error = new Error(message)
  error.code = 'INBOX_INVALID'
  return error
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** `owner/name` → `name`；项目目录名就是仓库名。 */
function repoName(repo) {
  const value = String(repo ?? '')
  const slash = value.indexOf('/')
  return (slash === -1 ? value : value.slice(slash + 1)).trim()
}

/**
 * 一条「有问题」评论变成的任务正文：repo、PR 号、标题、URL、kind、评论原文，最后**恰好一句**指令。
 *
 * 正文把事实全带上，worker 不需要回读收件箱；最后一句是唯一的行为约束，所以它必须只有一句。
 * 「通过」（approve）不派任务，因此不经过这个函数。
 */
function taskText(item, comment) {
  return [
    '审查收件箱转来一条 GitHub PR 评论，请处理。',
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
    '操作者认为这个 PR 有问题，请按评论处理。',
  ].join('\n')
}

/**
 * 追加一条审查决定，返回 `{ item, task }`；`task` 为 `null` 表示这条决定不派活。
 *
 * 两种决定（`kind`）：
 *   - `approve`：通过，`text` 必须为空，只写 review，不派任务；
 *   - `issue`：有问题，`text` 必填，先写 review 再派 `inbox-<pr>` 任务。
 * 旧数据里的 `question` / `fix` 只在 UI 读取时归一成 `issue`，这里不再写入旧 kind。
 *
 * 整个 read → 校验 → append → write 都在该 item 的跨进程锁内；watcher 的 read-modify-write 也在同一把
 * 锁里，所以两边不会用陈旧读取覆盖对方的改动。
 *
 * 顺序是刻意的：派生字段（project/thread/任务正文）与评论先全部校验，再落盘，最后派活。派活失败时评论
 * 仍在，调用方拿到带原 item 的 502；校验失败则什么都不写，避免面板报错后重试又重复一条评论。
 */
export async function appendReview(root, { id, kind, text } = {}) {
  const itemId = checkItemId(id)
  const reviewKind = String(kind ?? '').trim()
  if (reviewKind !== 'approve' && reviewKind !== 'issue') {
    throw invalid(`kind must be "approve" or "issue", got ${JSON.stringify(kind)}.`)
  }
  const approve = reviewKind === 'approve'
  const comment = String(text ?? '').trim()
  if (approve) {
    if (comment !== '') {
      throw invalid('an approve decision takes no comment; send text as an empty string or omit it.')
    }
  } else {
    if (comment === '') throw invalid('text must contain the comment to send; it cannot be empty.')
    if (comment.length > REVIEW_LIMIT) {
      throw invalid(`text is ${comment.length} characters, over the ${REVIEW_LIMIT} limit.`)
    }
  }

  return withItemLock(root, itemId, async () => {
    const item = await readItem(root, itemId)
    if (item === undefined) throw notFound(itemId, root)
    if (item.id !== itemId) throw inconsistent(root, itemId, item)

    if (approve) {
      const review = Array.isArray(item.review) ? item.review : []
      item.review = [...review, { at: new Date().toISOString(), kind: 'approve', text: '' }]
      await writeItem(root, item)
      return { item, task: null }
    }

    if (!Number.isInteger(item.pr) || item.pr <= 0) {
      throw invalid(
        `inbox item ${JSON.stringify(itemId)} has no valid PR number (pr: ${JSON.stringify(item.pr)}). ` +
          'Nothing was saved; delete the item so the watcher recreates it, then retry.',
      )
    }
    if (typeof item.repo !== 'string' || !REPO_PATTERN.test(item.repo)) {
      throw invalid(
        `inbox item ${JSON.stringify(itemId)} has no valid repo (repo: ${JSON.stringify(item.repo)}). ` +
          'Nothing was saved; delete the item so the watcher recreates it, then retry.',
      )
    }
    // Validate everything the comment will derive BEFORE saving: a malformed repo used to save the review
    // first and answer 500, so the panel reported failure and a retry duplicated the review.
    let project
    let thread
    let task
    try {
      project = checkProject(`tools/${repoName(item.repo)}`)
      thread = checkThread(`inbox-${item.pr}`)
      task = checkTask(taskText(item, comment))
    } catch (error) {
      throw invalid(
        `inbox item ${JSON.stringify(itemId)} cannot be dispatched: ${messageOf(error)} ` +
          'Nothing was saved; fix the item\'s repo/pr fields (or delete it so the watcher recreates it), then retry.',
      )
    }

    const review = Array.isArray(item.review) ? item.review : []
    item.review = [...review, { at: new Date().toISOString(), kind: 'issue', text: comment }]
    await writeItem(root, item)

    let record
    try {
      record = await submitTask(dirsOf(resolveRoot()), { project, task, thread })
    } catch (error) {
      const failure = new Error(
        `the review was saved on "${item.id}", but could not be dispatched to the spv queue: ${messageOf(error)}. ` +
          `fix: check that the queue at ${resolveRoot()} exists (the superagent spv Source creates it) and retry; ` +
          'the saved comment is not lost.',
      )
      failure.code = 'INBOX_DISPATCH'
      failure.item = item
      throw failure
    }
    return { item, task: record }
  })
}

/** item 不存在：404，提示刷新列表。 */
function notFound(id, root) {
  const error = new Error(
    `no review inbox item ${JSON.stringify(id)} under ${root}; refresh the panel and pick an item from ` +
      'GET /wheelchair-inbox/items.',
  )
  error.code = 'INBOX_NOT_FOUND'
  return error
}

/** 文件名与内容 id 不一致：拒绝写，否则会返回 200 却把评论写进另一个 item。 */
function inconsistent(root, id, item) {
  const error = new Error(
    `inbox file ${itemFile(root, id)} declares id ${JSON.stringify(item.id)}, not ${JSON.stringify(id)}; ` +
      'refusing to write the wrong item. fix: inspect or delete that file; the watcher recreates it with the ' +
      'correct id on the next poll.',
  )
  error.code = 'INBOX_INCONSISTENT'
  return error
}

/** `$SPV_PROJECTS_ROOT`，否则 `~/bioagentforge`。 */
export function defaultProjectsRoot() {
  return String(process.env.SPV_PROJECTS_ROOT ?? '').trim() || join(homedir(), 'bioagentforge')
}

/**
 * 扫 `<projectsRoot>/tools/*`，把有 `.git` 且有 GitHub `origin` 的目录认成可轮询的仓库。
 *
 * 用同步 git 调用：19 个项目各一次 `git config` 是毫秒级，而返回一个普通数组让调用点（CLI、测试）更简单。
 */
export function discoverRepos(projectsRoot = defaultProjectsRoot()) {
  const toolsDir = join(projectsRoot, 'tools')
  let entries
  try {
    entries = readdirSync(toolsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const repos = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(toolsDir, entry.name)
    if (!existsSync(join(dir, '.git'))) continue
    let remote = ''
    try {
      remote = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      continue
    }
    const match = GITHUB_REMOTE.exec(remote)
    if (match === null) continue
    repos.push({ name: entry.name, repo: `${match[1]}/${match[2]}` })
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name))
}

/** 从 `gh` 的一行输出造 item；已有的 review 一律保留，`at` 是写入时刻。 */
function itemOf(repo, pull, existing) {
  return {
    id: `${repo.replaceAll('/', '-')}-${Number(pull.number)}`,
    kind: 'pr',
    repo,
    pr: Number(pull.number),
    title: String(pull.title ?? ''),
    state: String(pull.state ?? ''),
    additions: Number(pull.additions ?? 0),
    deletions: Number(pull.deletions ?? 0),
    changedFiles: Number(pull.changedFiles ?? 0),
    url: String(pull.url ?? ''),
    body: String(pull.body ?? ''),
    at: new Date().toISOString(),
    review: Array.isArray(existing?.review) ? existing.review : [],
  }
}

/**
 * 轮询一轮：每个仓库一次 `gh pr list`，只写新增或关键字段变化的 item。
 *
 * 单仓库失败只记 `warning:` 并继续——一个仓库的 PR 拉不到，不该让其他仓库的收件箱也空着。
 * `log` 同时用于告警与「created/updated <id>」，CLI 的 watch 靠它打印一行一个变化。
 */
export async function pollOnce({ root = resolveInboxRoot(), projectsRoot = defaultProjectsRoot(), gh, log = () => {} } = {}) {
  const binary = String(gh ?? '').trim() || String(process.env.SPV_GH ?? '').trim() || 'gh'
  const counts = { created: 0, updated: 0, failed: 0 }
  for (const { repo } of discoverRepos(projectsRoot)) {
    let pullRequests
    try {
      const { stdout } = await execFileAsync(
        binary,
        ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '200', '--json', GH_FIELDS],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      )
      pullRequests = JSON.parse(stdout)
      if (!Array.isArray(pullRequests)) throw new Error('gh returned JSON that is not an array')
    } catch (error) {
      counts.failed += 1
      log(`warning: ${repo}: ${messageOf(error)}`)
      continue
    }
    for (const pull of pullRequests) {
      const number = Number(pull?.number)
      if (!Number.isInteger(number)) {
        log(`warning: ${repo}: skipping a PR without a numeric number`)
        continue
      }
      const id = `${repo.replaceAll('/', '-')}-${number}`
      // 读→比较→写必须和 review POST 用同一把锁：否则 watcher 的陈旧读取会覆盖刚追加的评论。
      let outcome
      try {
        outcome = await withItemLock(root, id, async () => {
          let existing
          try {
            existing = await readItem(root, id)
          } catch (error) {
            log(`warning: ${id}: ${messageOf(error)}; replacing it`)
            existing = undefined
          }
          const next = itemOf(repo, pull, existing)
          if (existing === undefined) {
            await writeItem(root, next)
            return 'created'
          }
          if (ITEM_FIELDS.some(field => existing[field] !== next[field])) {
            await writeItem(root, next)
            return 'updated'
          }
          return 'unchanged'
        })
      } catch (error) {
        // 锁超时或坏文件不能拖垮其他 item：记一行、跳过，下一轮再试。
        log(`warning: ${id}: ${messageOf(error)}; skipped this item`)
        continue
      }
      if (outcome === 'created') {
        counts.created += 1
        log(`created ${id}`)
      } else if (outcome === 'updated') {
        counts.updated += 1
        log(`updated ${id}`)
      }
    }
  }
  return counts
}

/** 先立刻轮询一轮，然后按间隔循环；`once` 只跑一轮。单轮失败只记日志，循环不停。 */
export async function watch({ root = resolveInboxRoot(), projectsRoot = defaultProjectsRoot(), intervalSeconds = 60, once = false, log = () => {} } = {}) {
  const seconds = Number(intervalSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`intervalSeconds must be a positive number, got ${JSON.stringify(intervalSeconds)}.`)
  }
  if (seconds * 1000 > MAX_TIMER_MS) {
    throw new Error(
      `intervalSeconds is ${intervalSeconds}, over setTimeout's ${Math.floor(MAX_TIMER_MS / 1000)}s limit ` +
        '(larger values overflow into a ~1ms loop). Use a shorter interval.',
    )
  }
  const poll = async () => {
    try {
      await pollOnce({ root, projectsRoot, log })
    } catch (error) {
      // 夜里无人看管的轮询器不能因为一次坏数据就退出。
      log(`warning: poll failed: ${messageOf(error)}`)
    }
  }
  await poll()
  if (once) return
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, seconds * 1000))
    await poll()
  }
}

// ------------------------------------------------------------------- HTTP

function pathOf(req) {
  try {
    return new URL(String(req.url ?? '/'), 'http://inbox.local').pathname
  } catch {
    return '/'
  }
}

/** JSON 响应带 `no-store`：收件箱与派活结果都是实时事实。 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 并声明该路由唯一支持的方法。 */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** 有上限地读完请求体；超过上限时把流排空并返回 null。 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** POST /wheelchair-inbox/review：JSON `{ id, kind, text }` → 追加评论并派活。 */
async function handleReview(root, req, res) {
  if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
    return
  }
  let text
  try {
    text = await readBoundedBody(req)
  } catch {
    sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
    return
  }
  if (text === null) {
    sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
    return
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    sendJson(res, 400, { code: 'bad-request', message: 'request body must be JSON' })
    return
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof body.id !== 'string' ||
    typeof body.kind !== 'string' ||
    (body.text !== undefined && body.text !== null && typeof body.text !== 'string')
  ) {
    sendJson(res, 400, {
      code: 'bad-request',
      message: 'request body must be JSON with string "id" and "kind", plus an optional string "text"',
    })
    return
  }
  try {
    const { item, task } = await appendReview(root, {
      id: body.id,
      kind: body.kind,
      text: typeof body.text === 'string' ? body.text : '',
    })
    sendJson(res, 200, {
      ok: true,
      item,
      task: task === null ? null : { id: task.id, thread: task.thread, project: task.project },
    })
  } catch (error) {
    switch (error.code) {
      case 'INBOX_NOT_FOUND':
        sendJson(res, 404, { ok: false, code: 'not-found', message: messageOf(error) })
        return
      case 'INBOX_INVALID':
        sendJson(res, 400, { ok: false, code: 'bad-request', message: messageOf(error) })
        return
      case 'INBOX_LOCKED':
        sendJson(res, 503, { ok: false, code: 'locked', message: messageOf(error) })
        return
      case 'INBOX_INCONSISTENT':
        // The stored item is corrupt (its id disagrees with its filename), not a bad request from the
        // panel: 409 tells the operator to fix/delete the item rather than retry the same comment.
        sendJson(res, 409, { ok: false, code: 'inconsistent-item', message: messageOf(error) })
        return
      case 'INBOX_DISPATCH':
        sendJson(res, 502, { ok: false, code: 'dispatch-failed', message: messageOf(error), item: error.item })
        return
      default:
        sendJson(res, 500, { ok: false, code: 'internal-error', message: messageOf(error) })
    }
  }
}

/**
 * 收件箱的 HTTP 面：dsh 的 webserver 拥有 `/`，插件只注册两个 `/wheelchair-inbox/*` 精确路由；
 * 页面本身由 `webui/lib/client.js` 在 Client 端渲染，Host 不再发 HTML。
 */
export function createInboxHandler({ root = resolveInboxRoot() } = {}) {
  return async function handle(req, res) {
    const pathname = pathOf(req)
    const method = String(req.method ?? 'GET').toUpperCase()
    if (pathname === ITEMS_PATH) {
      if (method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      try {
        sendJson(res, 200, { items: await readItems(root) })
      } catch (error) {
        sendJson(res, 500, { code: 'internal-error', message: messageOf(error) })
      }
      return
    }
    if (pathname === REVIEW_PATH) {
      if (method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      await handleReview(root, req, res)
      return
    }
    sendJson(res, 404, { code: 'not-found', message: `no route for ${pathname}` })
  }
}
