/**
 * 审查收件箱：操作者的通用复查入口，一个 item 一个 JSON 文件。
 *
 * 两种信件（`item.kind`）：
 *   pr           一个 GitHub PR；watcher 轮询 `gh pr list` 写入
 *   spv_message  一次 SPV 在无人看管时自己做出的决定；CLI 的 `inbox add` 或 `spv_notify` 工具写入
 *
 * 这是收件箱的**唯一**实现。CLI（`wheelchair-agent inbox ...`）与 dsh 的 webui 插件都 import 它：
 * webui 的 host 半身 import 的是 `install.sh` 从本文件复制进 profile 的副本（`lib/core/inbox.js`），
 * 所以面板和轮询器不会各写一份，也不会因为 preset 被别的 worktree 替换而失效（见 `ARCHITECTURE/webui/index.md`）。
 *
 * 纯 Node builtins：不 import dsh，不 `process.exit`。
 *
 * 目录布局（缺省 `<root>/inbox/`，root 默认 `~/.wheelchair-agent`，`$WHEELCHAIR_AGENT_HOME` 可覆盖；
 * `$SPV_INBOX_DIR` 仍是显式覆盖）：
 *   <owner>-<name>-<number>.json   一个 PR item
 *   spv-<thread>-<UTC>-<rand>.json 一个 SPV 决策信
 *   .<id>.lock                     该 item 的跨进程写锁（watcher 与 review POST 共用）
 * 每条审查决定追加到 item 的 `review` 数组；`issue`（无论 PR 还是决策信）只写一条 notice 给 SPV 入口会话，
 * 不再派 worker 任务。
 */
import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { checkThread } from './dispatch.js'
import { ownDeployment, projectForRepo } from './ownership.js'
import { resolveRoot } from './paths.js'
import { HOME_DIR_NAME, INBOX_DIR, INBOX_ENV, resolveData } from '../shared/home.js'
import { INSTALL_STAMP_FILE, compareFingerprints, readStamp } from '../shared/install-stamp.js'
import { runHooksFor } from '../shared/hooks.js'
import { dirsOf, writeMessage } from '../shared/queue.js'
import { KEY_SPECS, defaultSettings, renderTemplate, resolveSettings } from '../shared/settings.js'

const execFileAsync = promisify(execFile)

/** Review messages forwarded to another deployment use this kind; the injector treats it as a result. */
const FORWARD_REVIEW_KIND = 'review'

/** 未指定时收件箱根目录的默认值（只是文档/诊断用；真正的解析在 `resolveInboxRoot()`）。 */
export const INBOX_ROOT_DEFAULT = join(homedir(), HOME_DIR_NAME, INBOX_DIR)

/** 一条评论的上限：够写清一条审查意见，又不至于把通知正文推过模型的单次预算。 */
const REVIEW_LIMIT = 5000
/** 决策信的标题与正文上限；正文够放一段完整的判断依据，又不会撑爆面板与工具输出。 */
const TITLE_LIMIT = 500
const MESSAGE_BODY_LIMIT = 20000
/** 两种 item 的 `kind`；旧磁盘记录没有这个字段，读取时按 `pr` 处理。 */
const KINDS = new Set(['pr', 'spv_message'])
/** item 文件名：轮询器生成的 `<owner>-<name>-<number>`、`spv-…` 与 POST 传来的 id 共用同一套约束。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
/** `git@github.com:owner/name.git`、`https://github.com/owner/name` 都归一到 `owner/name`。 */
const GITHUB_REMOTE = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i
/** item 里 `repo` 字段的形状；`owner/name`，两段都是普通仓库名字符。 */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/** `gh pr list` 要的字段；顺序无关，但一处定义避免两个调用点漂移。 */
const GH_FIELDS = 'number,title,state,additions,deletions,changedFiles,url,body,createdAt,updatedAt,mergedAt,mergeCommit'
/** 这些字段变了才重写 item；`review` 与 `at` 从不参与比较。 */
const ITEM_FIELDS = ['kind', 'title', 'state', 'additions', 'deletions', 'changedFiles', 'url', 'body', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit']
/** review 请求体上限：与 dsh-host-open-in-app 的 64 KiB 约定一致。 */
const MAX_BODY_BYTES = 64 * 1024
/** 每 item 一把跨进程锁：重试间隔、持锁上限、过期判定。 */
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 30_000
/** `setTimeout` 的毫秒上限；更长的间隔会溢出成约 1ms 的忙循环。 */
const MAX_TIMER_MS = 2_147_483_647
/**
 * 自动轮询的默认间隔（秒）；与 CLI 的 `inbox watch` 相同。
 * 单一来源是 `src/shared/settings.js` 的 `KEY_SPECS`，避免面板默认值与消费者各改一份后漂移。
 */
export const INBOX_INTERVAL_DEFAULT = KEY_SPECS['inbox.intervalSeconds'].default
/** 本仓库自己的目录名：它的合并需要一次冷安装，而不是普通 pull（来源同上）。 */
const INSTALL_REPO_DEFAULT = KEY_SPECS['merge.installRepo'].default

const ITEMS_PATH = '/wheelchair-inbox/items'
const REVIEW_PATH = '/wheelchair-inbox/review'

/**
 * 收件箱根目录：`$SPV_INBOX_DIR`（显式覆盖，原样使用），否则数据根的 `<root>/inbox`
 * （默认 `~/.wheelchair-agent/inbox`，`$WHEELCHAIR_AGENT_HOME` 可覆盖）。
 *
 * 旧位置 `<stateDir>/inbox` 会在这次解析时搬到新位置；搬不动就回退到旧目录继续用。
 *
 * An explicit `$SPV_INBOX_DIR` wins outright and never migrates, so resolving the default inbox must not
 * drag in the rest of the data layout (a warning-free inbox-only sandbox); a write that also reads panel
 * settings still needs the data root sandboxed, and the guard says so.
 */
export function resolveInboxRoot({ env = process.env, home, stateDir } = {}) {
  const override = String(env?.[INBOX_ENV] ?? '').trim()
  if (override !== '') return override
  return resolveData({ env, home, stateDir }).inbox
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

/** item 的种类；旧记录没有 `kind`，一律按 `pr` 处理，升级磁盘记录不是读取的前提。 */
function kindOf(item) {
  return item?.kind === 'spv_message' ? 'spv_message' : 'pr'
}

/**
 * 时间筛选用的时刻：PR 用它自己的创建时间（"年龄"），SPV 决策信没有 PR，用写入时刻。
 *
 * 旧版本写的 PR item 没有 `createdAt`，这里**不**回退到 watcher 的 `at`：那会把三个月前开的 PR 伪装成
 * 今天的新信。没有创建时间的 item 在时间筛选下直接排除，等下一次 `inbox watch` 轮询补齐字段后再出现。
 */
function itemTime(item) {
  if (kindOf(item) === 'pr') return String(item?.createdAt ?? '').trim()
  return String(item?.at ?? '')
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

/**
 * 写入一封 SPV 决策信（`kind: "spv_message"`），返回落盘的 item。
 *
 * 这是 `wheelchair-agent inbox add` 与 `spv_notify` 工具共用的唯一代码路径。id 由 thread、UTC 秒级时间戳
 * 与 4 个随机字符组成：同一秒内写两封也不会撞名，且仍满足 `ID_PATTERN`（id 同时是文件名）。
 *
 * 标题与正文先全部校验，然后才写文件；`thread` 复用队列线程的校验规则（缺省 `main`），因为 `issue` 的
 * 通知会回到这个线程。
 */
export async function createSpvMessage(root, { title, body, thread } = {}) {
  const heading = String(title ?? '').trim()
  if (heading === '') {
    throw invalid('title is required: it is the one line the operator sees first in the review inbox.')
  }
  if (heading.length > TITLE_LIMIT) {
    throw invalid(`title is ${heading.length} characters, over the ${TITLE_LIMIT} limit.`)
  }
  const text = String(body ?? '')
  if (text.trim() === '') {
    throw invalid('body is required: record what was decided and why, in Markdown.')
  }
  if (text.length > MESSAGE_BODY_LIMIT) {
    throw invalid(`body is ${text.length} characters, over the ${MESSAGE_BODY_LIMIT} limit.`)
  }
  let name
  try {
    name = checkThread(thread)
  } catch (error) {
    throw invalid(`cannot use this thread for the decision letter: ${messageOf(error)}`)
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const id = `spv-${name}-${stamp}-${randomUUID().slice(0, 4)}`
  const item = {
    id,
    kind: 'spv_message',
    title: heading,
    body: text,
    thread: name,
    at: new Date().toISOString(),
    review: [],
  }
  await writeItem(root, item)
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
 * The deployment that owns an item's repo, when that is a different deployment than this one.
 *
 * `null` means "keep the old path": no registry, this process cannot identify its own queue, the repo is
 * not under any registered project, or the repo is this deployment's own. The local checkout decides the
 * project; the repo-name leaf is the documented fallback for a project whose checkout is absent.
 */
function forwardTarget(item) {
  if (kindOf(item) !== 'pr' || typeof item.repo !== 'string') return null
  const own = ownDeployment()
  if (own.entry === null || own.registry === null) return null
  const project = projectForRepo(item.repo, {
    projectsRoot: defaultProjectsRoot(),
    deployments: own.registry.deployments,
  })
  if (project === null || project === own.entry.project) return null
  return { project, from: own.entry.project, queueDir: own.registry.deployments.find(d => d.project === project)?.queueDir }
}

/** The body the owning deployment's injector shows when a review was forwarded from another deployment. */
function forwardedReviewText({ from, project, item, verdict, comment, reviewedAt }) {
  return [
    `This review result was forwarded from another deployment (这是另一份部署转来的审查结论).`,
    `kind: review`,
    `from deployment: ${from}`,
    `deployment: ${project}`,
    `repo: ${item.repo}`,
    `PR: #${item.pr} ${item.url ?? ''}`.trimEnd(),
    `verdict: ${verdict}`,
    `reviewedAt: ${reviewedAt}`,
    '',
    `comment:`,
    comment === '' ? '(no comment)' : comment,
  ].join('\n')
}

/** Stable id: a retry of the same verdict and comment overwrites one queue file, never stacks two. */
function forwardedReviewId(item, verdict, comment) {
  const digest = createHash('sha256').update(`${item.id}\u0000${verdict}\u0000${comment}`).digest('hex').slice(0, 16)
  return `review-${item.id}-${digest}`
}

/** Write the review into the owning deployment's pending queue; returns the message id. */
async function forwardReview({ target, item, verdict, comment, reviewedAt }) {
  const id = forwardedReviewId(item, verdict, comment)
  // `$SPV_QUEUE_DIR` is this instance's runtime override, not the target's queue: when it is set,
  // resolveRoot({ project }) would still return it. Read the target's registered queue instead.
  const queue = String(process.env.SPV_QUEUE_DIR ?? '').trim() === ''
    ? resolveRoot({}, { project: target.project })
    : target.queueDir
  const pending = join(queue, 'pending')
  await mkdir(pending, { recursive: true })
  const file = join(pending, `${id}.json`)
  const temporary = `${file}.tmp.${process.pid}`
  await writeFile(temporary, `${JSON.stringify({
    id,
    source: 'spv',
    thread: checkThread(`inbox-${item.pr}`),
    kind: FORWARD_REVIEW_KIND,
    text: forwardedReviewText({ ...target, item, verdict, comment, reviewedAt }),
    at: reviewedAt,
    project: target.project,
    actor: 'operator',
    repo: item.repo,
    number: item.pr,
    url: item.url ?? '',
    verdict,
    comment,
    reviewedAt,
  }, null, 2)}\n`, { mode: 0o644 })
  await rename(temporary, file)
  return id
}

/** Forward, or turn a queue failure into the same actionable error for both verdicts. */
async function forwardOrFail({ target, item, verdict, comment, reviewedAt }) {
  try {
    return await forwardReview({ target, item, verdict, comment, reviewedAt })
  } catch (error) {
    const failure = new Error(
      `the review was saved on "${item.id}", but could not be forwarded to the deployment that owns ` +
        `${item.repo}: ${messageOf(error)}. fix: check that the queue at ` +
        `${target.queueDir} exists and retry; the saved review is not lost.`,
    )
    failure.code = 'INBOX_DISPATCH'
    failure.item = item
    throw failure
  }
}

/**
 * 一条「有问题」评论变成发给 SPV 的 notice 正文：repo、PR 号、标题、URL、kind、评论原文。
 *
 * 正文把事实全带上，SPV 不需要回读收件箱；最后一句要求 SPV 先结合上下文处理，不再声称派给 worker。
 * 文本来自面板设置的 `prIssue` 模板；未传 `settings` 时用内置默认。
 * 「通过」（approve）不发通知，因此不经过这个函数。
 */
function prIssueText(item, comment, settings) {
  const snapshot = settings ?? defaultSettings()
  return renderTemplate('prIssue', snapshot.templates.prIssue.text, {
    repo: item.repo,
    pr: item.pr,
    title: item.title ?? '',
    url: item.url ?? '',
    comment,
  })
}

/**
 * 一条对 SPV 决策信的质疑：写进 outbox 的 `notice` 正文。
 *
 * 它必须让 SPV 知道被质疑的是**哪一封**信（标题 + id + thread），并原样保留操作者的评论；
 * 最后一句只说清楚要它回顾这次决定。这里不派任务，所以没有 `project`。文本来自 `spvObjection` 模板，
 * 未传 `settings` 时与改造前逐字节一致。
 */
function noticeText(item, comment, settings) {
  const snapshot = settings ?? defaultSettings()
  return renderTemplate('spvObjection', snapshot.templates.spvObjection.text, {
    title: item.title ?? '',
    id: item.id,
    thread: item.thread || 'main',
    comment,
  })
}

/**
 * 读一次面板设置。`resolveSettings` 按设计不因坏文件抛错，这里的 catch 只防「读盘本身出了意外」
 * （权限、路径已不是目录等）：评审仍然要能落盘，不能因为一个坏设置文件把收件箱拖死。
 */
function readPanelSettings() {
  try {
    return resolveSettings()
  } catch {
    return defaultSettings()
  }
}

/**
 * hook 引擎的数据根（settings / records / cursor）。与收件箱共用同一份设置；解析失败时交给引擎自己
 * 按默认根再解析一次（此时它在 clone 里会拒绝，但 core path 不受影响）。
 */
function hookHome() {
  try {
    return resolveData({ migrate: false }).root
  } catch {
    return undefined
  }
}

/**
 * 跑一个 hook 事件：**fire-and-forget**。
 *
 * 调用点都在 core path 完成之后（review 已写、notice 已发、pull 已跑、冷安装提醒已排队），这里绝不
 * await、绝不把失败抛回去；脚本失败/超时/输出洪水只进记录。`eventId` 显式给出，保证 HTTP 重试与
 * 重复的 issue 评论按同一个 occurrence 去重。
 */
function fireHook(event, payload, eventId) {
  const home = hookHome()
  // Snapshot the environment: the core path may return and a caller may restore process.env before the
  // async engine reads it. The snapshot keeps the hook pinned to the data root/settings of this call.
  const env = { ...process.env }
  try {
    void runHooksFor(event, payload, {
      ...(home === undefined ? {} : { home }),
      env,
      eventId,
    }).catch(() => {})
  } catch {
    // runHooksFor 的契约是永不 reject；再兜一层，core path 绝不会因为 hook 而失败。
  }
}

/**
 * 追加一条审查决定，返回 `{ item, task }`；`task` 恒为 `null`（保留字段以兼容旧调用方）。
 *
 * 两种决定（`kind`）：
 *   - `approve`：通过，评论**可选**，只写 review，不发消息；评论是操作者接受的理由，留给以后看。
 *   - `issue`：有问题，评论必填，写 review 后发**恰好一条** `notice` 到 spv outbox，交给 SPV 入口会话：
 *       pr          → thread `inbox-<pr>`，正文来自 `prIssue` 模板；
 *       spv_message → thread 是信件自己的 thread，正文来自 `spvObjection` 模板。
 *     两条路径都不派 worker 任务；SPV 收到后自己决定讨论还是派活。
 * 旧数据里的 `question` / `fix` 只在 UI 读取时归一成 `issue`，这里不再写入旧 kind。
 *
 * 同一个 item 上重复提交完全相同的 issue 评论时，复用最后一条 review 的 index 与 notice id，只覆盖
 * 那一个 outbox 文件，不再追加第二条 review/notice；这既让 HTTP 重试幂等，也让「review 已落盘但通知
 * 写失败」之后的重试仍能把通知补上。
 *
 * 整个 read → 校验 → append → write 都在该 item 的跨进程锁内；watcher 的 read-modify-write 也在同一把
 * 锁里，所以两边不会用陈旧读取覆盖对方的改动。
 *
 * 顺序是刻意的：thread、通知正文与评论先全部校验，再落盘，最后发消息。发消息失败时评论仍在，调用方
 * 拿到带原 item 的 502；校验失败则什么都不写，避免面板报错后重试又重复一条评论。
 */
export async function appendReview(root, { id, kind, text } = {}) {
  const itemId = checkItemId(id)
  const reviewKind = String(kind ?? '').trim()
  if (reviewKind !== 'approve' && reviewKind !== 'issue') {
    throw invalid(`kind must be "approve" or "issue", got ${JSON.stringify(kind)}.`)
  }
  const approve = reviewKind === 'approve'
  const comment = String(text ?? '').trim()
  if (!approve && comment === '') throw invalid('text must contain the comment to send; it cannot be empty.')
  if (comment.length > REVIEW_LIMIT) {
    throw invalid(`text is ${comment.length} characters, over the ${REVIEW_LIMIT} limit.`)
  }
  // 一次调用只解析一次设置：同一份评论派生出的通知正文用同一版模板，坏文件也只影响这一次读取。
  const settings = readPanelSettings()

  return withItemLock(root, itemId, async () => {
    const item = await readItem(root, itemId)
    if (item === undefined) throw notFound(itemId, root)
    if (item.id !== itemId) throw inconsistent(root, itemId, item)

    const review = Array.isArray(item.review) ? item.review : []
    if (approve) {
      // 评论只记录：它不会发通知。空评论与旧行为一致，仍然允许。
      const at = new Date().toISOString()
      const reviewIndex = review.length
      item.review = [...review, { at, kind: 'approve', text: comment }]
      await writeItem(root, item)
      const target = forwardTarget(item)
      if (target !== null) await forwardOrFail({ target, item, verdict: 'approve', comment, reviewedAt: at })
      fireHook(
        'inbox.approved',
        {
          itemId: item.id,
          kind: kindOf(item),
          ...(Number.isInteger(item.pr) ? { pr: item.pr } : {}),
          ...(typeof item.repo === 'string' ? { repo: item.repo } : {}),
          reviewIndex,
          comment,
          at,
        },
        `inbox.approved:${item.id}:${reviewIndex}`,
      )
      return { item, task: null }
    }

    // A PR owned by another deployment: forward the verdict into that deployment's queue instead of
    // notifying this one. The owning side injects it as a result, so the review lands on the right ticket.
    const target = forwardTarget(item)
    if (target !== null) {
      const last = review[review.length - 1]
      const lastKind = String(last?.kind ?? '').trim().toLowerCase()
      const repeated = last !== undefined && lastKind !== 'approve' && String(last?.text ?? '') === comment
      const reviewIndex = repeated ? review.length - 1 : review.length
      if (!repeated) {
        item.review = [...review, { at: new Date().toISOString(), kind: 'issue', text: comment }]
        await writeItem(root, item)
      }
      const reviewedAt = new Date().toISOString()
      const messageId = await forwardOrFail({ target, item, verdict: 'issue', comment, reviewedAt })
      fireHook(
        'inbox.issue',
        {
          itemId: item.id,
          kind: kindOf(item),
          pr: item.pr,
          repo: item.repo,
          reviewIndex,
          comment,
          messageId,
          thread: checkThread(`inbox-${item.pr}`),
          at: reviewedAt,
        },
        `inbox.issue:${item.id}:${reviewIndex}`,
      )
      return { item, task: null }
    }

    let thread
    let notice
    if (kindOf(item) === 'spv_message') {
      try {
        thread = checkThread(item.thread)
      } catch (error) {
        throw invalid(
          `inbox item ${JSON.stringify(itemId)} has no valid thread (thread: ${JSON.stringify(item.thread)}). ` +
            `Cannot notify SPV: ${messageOf(error)} Nothing was saved.`,
        )
      }
      notice = noticeText(item, comment, settings)
    } else {
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
      try {
        thread = checkThread(`inbox-${item.pr}`)
      } catch (error) {
        throw invalid(
          `inbox item ${JSON.stringify(itemId)} cannot notify SPV: ${messageOf(error)} Nothing was saved.`,
        )
      }
      notice = prIssueText(item, comment, settings)
    }
    if (String(notice).trim() === '') {
      throw invalid(`inbox item ${JSON.stringify(itemId)} rendered an empty notice; nothing was saved.`)
    }

    const last = review[review.length - 1]
    const lastKind = String(last?.kind ?? '').trim().toLowerCase()
    const repeated = last !== undefined && lastKind !== 'approve' && String(last?.text ?? '') === comment
    const reviewIndex = repeated ? review.length - 1 : review.length
    const messageId = `inbox-${itemId}-review-${reviewIndex}`
    if (!repeated) {
      item.review = [...review, { at: new Date().toISOString(), kind: 'issue', text: comment }]
      await writeItem(root, item)
    }

    const noticeAt = new Date().toISOString()
    try {
      await writeMessage(dirsOf(resolveRoot()), {
        id: messageId,
        source: 'spv',
        thread,
        kind: 'notice',
        text: notice,
        at: noticeAt,
      })
    } catch (error) {
      const failure = new Error(
        `the review was saved on "${item.id}", but could not be sent to the spv outbox: ${messageOf(error)}. ` +
          `fix: check that the queue at ${resolveRoot()} exists (the superagent spv Source creates it) and retry; ` +
          'the saved comment is not lost.',
      )
      failure.code = 'INBOX_DISPATCH'
      failure.item = item
      throw failure
    }
    fireHook(
      'inbox.issue',
      {
        itemId: item.id,
        kind: kindOf(item),
        ...(Number.isInteger(item.pr) ? { pr: item.pr } : {}),
        ...(typeof item.repo === 'string' ? { repo: item.repo } : {}),
        reviewIndex,
        comment,
        messageId,
        thread,
        at: noticeAt,
      },
      // Namespaced by event, NOT the notice's message id: the queue reader maps that same message to
      // ticket.attention and the cursor is global, so using it here would swallow the queue occurrence.
      `inbox.issue:${item.id}:${reviewIndex}`,
    )
    return { item, task: null }
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

/** `gh --json mergeCommit` 返回对象（`{oid}`）；也接受一个裸 SHA 字符串。 */
function mergeCommitOf(value) {
  return typeof value === 'string' ? value : String(value?.oid ?? '')
}

/** 从 `gh` 的一行输出造 item；已有的 review 与合并处理记录一律保留，`at` 是写入时刻。 */
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
    // PR 自己的时间：时间筛选按 createdAt（PR 的年龄）走，而不是 watcher 碰巧发现它的时刻。
    createdAt: String(pull.createdAt ?? ''),
    updatedAt: String(pull.updatedAt ?? ''),
    mergedAt: String(pull.mergedAt ?? '') || String(existing?.mergedAt ?? ''),
    mergeCommit: mergeCommitOf(pull.mergeCommit) || String(existing?.mergeCommit ?? ''),
    // 合并只处理一次：这些字段由 handleMergedPull() 写入，轮询不得用新 item 覆盖掉。
    mergeObservedAt: existing?.mergeObservedAt,
    mergeHandledAt: existing?.mergeHandledAt,
    pullAt: existing?.pullAt,
    pulledSha: existing?.pulledSha,
    pullError: existing?.pullError,
    noticeAt: existing?.noticeAt,
    noticeError: existing?.noticeError,
    at: new Date().toISOString(),
    review: Array.isArray(existing?.review) ? existing.review : [],
  }
}

/** Shell-quote one path for the notice text; install paths may contain spaces. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** `execFile` failure detail: git's stderr is what names a dirty tree or a divergence. */
function commandFailure(error) {
  return String(error?.stderr ?? '').trim() || messageOf(error)
}

/**
 * Is this local clone the checkout whose files `install.sh` installs?
 *
 * The panel settings file (`merge.installRepo`) wins over `SPV_INSTALL_REPO`; both accept either the
 * directory name (`wheelchair-agent`) or `owner/name` — the latter is what a person naturally copies from
 * the notice, so accepting only the basename would silently disable the cold-install notice.
 */
function isInstallTargetRepo(name, repo, settings) {
  const snapshot = settings ?? readPanelSettings()
  const configured =
    String(snapshot?.effective?.['merge.installRepo'] ?? '').trim() ||
    String(process.env.SPV_INSTALL_REPO ?? '').trim()
  const expected = configured || INSTALL_REPO_DEFAULT
  const expectedName = repoName(expected)
  return name === expected || name === expectedName || repo === expected || repoName(repo) === expectedName
}

/** One human-readable clause per changed component, file names capped at three. */
function describeInstallChanges(pending) {
  const parts = []
  if (pending?.versionMismatch) {
    parts.push('the installed fingerprint format (reinstall once to refresh it)')
  }
  for (const change of pending?.changes ?? []) {
    const names = [...change.changed, ...change.added, ...change.removed]
    const sample = names.slice(0, 3).join(', ')
    const more = names.length > 3 ? `, +${names.length - 3} more` : ''
    const noun = change.count === 1 ? 'file' : 'files'
    parts.push(`${change.component} (${change.count} ${noun}: ${sample}${more})`)
  }
  return parts.join('; ')
}

/**
 * Is the running install stale relative to this checkout?
 *
 * The stamp records the component digests the last successful install placed. `install.sh --fingerprint`
 * renders what this checkout would place now (in a temporary directory, read-only) and the shared
 * fingerprint normalizes YAML comments, so a comment-only merge compares `same`.
 *
 * Never throws: a missing stamp, a spawn failure, a non-zero exit or unparsable output all degrade to
 * the old unconditional notice (`no-stamp` / `unknown`) rather than breaking the merge flow.
 */
export async function detectInstallPending({ localPath, dataRoot } = {}) {
  try {
    const stampFile = join(dataRoot ?? resolveData().root, INSTALL_STAMP_FILE)
    const stamp = await readStamp(stampFile)
    if (!stamp) return { kind: 'no-stamp' }
    const args = [join(localPath, 'install.sh'), '--fingerprint']
    const presetDir = stamp.targets?.presetDir
    if (typeof presetDir === 'string' && presetDir !== '') args.push('--preset-dir', presetDir)
    const { stdout } = await execFileAsync('bash', args, {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const current = JSON.parse(stdout)
    if (
      current === null ||
      typeof current !== 'object' ||
      typeof current.version !== 'number' ||
      current.components === null ||
      typeof current.components !== 'object'
    ) {
      throw new Error('install.sh --fingerprint printed an invalid fingerprint')
    }
    const comparison = compareFingerprints(stamp, current)
    if (comparison.same) return { kind: 'same' }
    return { kind: 'stale', changes: comparison.changes, versionMismatch: comparison.versionMismatch }
  } catch (error) {
    return { kind: 'unknown', reason: commandFailure(error) }
  }
}

/**
 * The one notice an install-repo merge queues: facts, the pending cold install, and the exact commands.
 *
 * `same` means the installed copy already matches this checkout (comment-only merge): the caller must not
 * write anything, so this returns null. A stale install adds one line naming the components that differ;
 * `no-stamp` / `unknown` keep the historical unconditional text, so a machine that has never installed
 * with a stamp still warns.
 */
export function mergeNoticeText({ item, repo, project, localPath, pulledSha, pending }) {
  if (pending?.kind === 'same') return null
  const lines = [
    `PR #${item.pr} merged in ${repo}.`,
    `The local clone at ${localPath} moved to ${pulledSha}.`,
    'A cold install is now pending: the running service cannot install itself.',
  ]
  if (pending?.kind === 'stale') {
    lines.push(`The installed copy differs from this checkout in: ${describeInstallChanges(pending)}.`)
  }
  // `project` is that repository's registered project name; every command must name it, because this repo no
  // longer has a base deployment that a bare `service`/`install.sh` would implicitly mean.
  const targeted = shellQuote(String(project ?? '<project>'))
  lines.push(
    '',
    `Stop only ${project ?? 'that deployment'}'s holders, install from that checkout, then start again:`,
    `  wheelchair-agent service stop --project ${targeted}`,
    '  # exit the SPV session (Ctrl-D); it cannot be stopped from here',
    `  bash ${shellQuote(localPath)}/install.sh --project ${targeted}`,
    `  wheelchair-agent service start --project ${targeted}`,
    '  wheelchair-agent spv',
  )
  return lines.join('\n')
}

/**
 * Handle a PR that just became MERGED: one `git pull --ff-only`, then (only for this repository) one
 * cold-install notice.
 *
 * Never force, never reset, never stash: a dirty or diverged tree makes git fail, and that failure is
 * recorded on the item instead of thrown. The caller persists the returned fields, so the next poll sees
 * `mergeHandledAt` and does neither the pull nor the notice again. The notice id is derived from the item
 * id, so even a retry after a partial write overwrites one outbox file rather than stacking notices.
 */
async function handleMergedPull({ item, repo, name, project, localPath, existing, observedAt, settings, log = () => {} }) {
  const at = new Date().toISOString()
  const mergeObservedAt = existing?.mergeObservedAt || observedAt
  let pulledSha = existing?.pulledSha
  let pullAt = existing?.pullAt
  let pullError
  // A previous pull that succeeded is reused while retrying only the notice: do not move the clone again.
  const canReusePull = Boolean(existing?.pulledSha && !existing?.pullError && existing?.mergeObservedAt)
  if (!canReusePull) {
    try {
      await execFileAsync('git', ['-C', localPath, 'pull', '--ff-only'], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
      const { stdout } = await execFileAsync('git', ['-C', localPath, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
      })
      const sha = String(stdout ?? '').trim()
      if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(`git rev-parse HEAD returned ${JSON.stringify(sha)}`)
      pulledSha = sha
      pullAt = at
    } catch (error) {
      pullError = commandFailure(error)
      pulledSha = undefined
      pullAt = at
    }
  }
  if (pullError !== undefined) {
    log(`warning: ${item.id}: --ff-only pull failed: ${pullError}`)
    return { mergeObservedAt, pullAt, pullError, pulledSha: undefined }
  }

  let noticeAt = existing?.noticeAt
  let noticeError
  if (isInstallTargetRepo(name, repo, settings) && !noticeAt) {
    try {
      // Detection is best-effort: any failure becomes `unknown`, whose notice is the historical
      // unconditional one, so a broken fingerprint can never suppress a real cold-install warning.
      let pending
      try {
        pending = await detectInstallPending({ localPath })
      } catch (error) {
        pending = { kind: 'unknown', reason: commandFailure(error) }
      }
      if (pending.kind === 'same') {
        // Comment-only merges land here: the installed copy is semantically identical, so nothing is
        // written and noticeAt stays unset (the merge itself is still handled).
        log(`installed copy is up to date for ${item.id}; no cold-install notice queued`)
      } else {
        await writeMessage(dirsOf(resolveRoot()), {
          id: `inbox-merge-${item.id}`,
          source: 'spv',
          thread: 'main',
          kind: 'notice',
          text: mergeNoticeText({ item, repo, project, localPath, pulledSha, pending }),
          at: new Date().toISOString(),
          address: { thread: 'main' },
        })
        noticeAt = new Date().toISOString()
        log(`queued cold-install notice for ${item.id}`)
      }
    } catch (error) {
      noticeError = commandFailure(error)
      log(`warning: ${item.id}: could not queue the cold-install notice: ${noticeError}`)
    }
  }
  if (noticeError !== undefined) {
    // The pull succeeded but the notice did not: keep the merge unhandled so the next poll retries just
    // the notice (the pulled sha and pullAt are reused), rather than losing the mandated cold-install note.
    return { mergeObservedAt, pullAt, pulledSha, noticeError }
  }
  const mergeHandledAt = new Date().toISOString()
  return {
    mergeObservedAt,
    mergeHandledAt,
    pullAt,
    pulledSha,
    pullError: undefined,
    noticeError: undefined,
    ...(noticeAt === undefined ? {} : { noticeAt }),
  }
}

/** 校验一个「秒」间隔，沿用改造前的错误文案（configured 非法要大声报错，host 会 catch 并告警）。 */
function checkIntervalSeconds(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `intervalSeconds must be a non-negative number, got ${JSON.stringify(raw)}. ` +
        'Use 0 to disable the automatic inbox poller, or a positive number of seconds.',
    )
  }
  if (value * 1000 > MAX_TIMER_MS) {
    throw new Error(
      `intervalSeconds is ${raw}, over setTimeout's ${Math.floor(MAX_TIMER_MS / 1000)}s limit ` +
        '(larger values overflow into a ~1ms loop). Use a shorter interval.',
    )
  }
  return value
}

/**
 * 有效收件箱间隔（秒）：设置文件 > 插件 config（这里的 `configured`）> 环境变量 > 60。每次调用都重读文件。
 *
 * - `0` 表示关闭自动轮询（CLI 的 `inbox watch` 仍然可用）；
 * - **文件里有合法的显式值就直接用它**，不再校验低层：否则会出现「设置页显示 30s、轮询器却因一个写坏的
 *   环境变量回退 60s」——正是「看起来生效其实没生效」的失败模式；
 * - 文件没有该值（缺失 / 坏文件 / 坏值被忽略）时，才按改造前的契约校验低层：显式 `configured` 非法抛错
 *   （host 半身 catch 后回退 60 并告警），环境变量非法同样抛错，避免静默接受拼写错误；
 * - 设置文件本身的问题由 `resolveSettings` 忽略并告警，不会抛。
 *
 * `home` 是显式的数据根；`stateDir` 只是旧 superagent 目录（旧文件的迁移与回退来源）。
 */
export function resolveInboxIntervalSeconds(configured, { home, stateDir, env = process.env } = {}) {
  const hasConfigured = !(configured === undefined || configured === null || String(configured).trim() === '')
  // 先解析一次（不预先校验低层）：行来源为 file 就说明磁盘上有合法的显式值，直接返回。
  const settings = resolveSettings({
    home,
    stateDir,
    env,
    config: hasConfigured ? { 'inbox.intervalSeconds': configured } : {},
  })
  const row = settings.rows.find(item => item.key === 'inbox.intervalSeconds')
  if (row?.source === 'file') return row.value
  // 没有文件值：保留旧行为，坏 configured / 坏 env 仍然大声报错，而不是静默回退。
  if (hasConfigured) {
    checkIntervalSeconds(configured)
  } else {
    const fromEnv = env?.SPV_INBOX_INTERVAL_SECONDS
    if (fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim() !== '') {
      checkIntervalSeconds(fromEnv)
    }
  }
  return row?.value ?? INBOX_INTERVAL_DEFAULT
}

/**
 * Start the inbox poll loop and return a stop function plus a `done` promise.
 *
 * This is the one loop shared by the web host half and `wheelchair-agent inbox watch`: the first poll runs
 * immediately, then one `setTimeout` chain; a failed round is logged and the next one still runs. `unref`
 * lets the web plugin's timer stop holding a process open, while the CLI keeps the default (referenced)
 * timer. The host calls `stop()` from `ctx.effect`, so the poller dies with the plugin.
 *
 * `intervalSecondsOf` is the live-interval seam: when present it is called **before every schedule**, so a
 * settings change applies without a restart. It may return `0` to pause; a paused poller runs no `gh` call
 * and re-checks after ~1s, so enabling it again also needs no restart. Without the seam the old fixed
 * `intervalSeconds` contract holds (positive number, invalid values throw).
 */
export function startInboxWatcher({
  root,
  rootOf,
  projectsRoot = defaultProjectsRoot(),
  intervalSeconds = INBOX_INTERVAL_DEFAULT,
  intervalSecondsOf,
  gh,
  log = () => {},
  unref = false,
  once = false,
} = {}) {
  if (rootOf !== undefined && typeof rootOf !== 'function') {
    throw new Error('rootOf must be a function returning the inbox root.')
  }
  const currentRoot = () => (typeof rootOf === 'function' ? rootOf() : root ?? resolveInboxRoot())
  const dynamic = intervalSecondsOf !== undefined
  if (dynamic && typeof intervalSecondsOf !== 'function') {
    throw new Error('intervalSecondsOf must be a function returning the interval in seconds.')
  }
  const seconds = Number(intervalSeconds)
  if (!dynamic) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`intervalSeconds must be a positive number, got ${JSON.stringify(intervalSeconds)}.`)
    }
    if (seconds * 1000 > MAX_TIMER_MS) {
      throw new Error(
        `intervalSeconds is ${intervalSeconds}, over setTimeout's ${Math.floor(MAX_TIMER_MS / 1000)}s limit ` +
          '(larger values overflow into a ~1ms loop). Use a shorter interval.',
      )
    }
  }
  const warn = message => {
    try {
      log(message)
    } catch {
      // A logging sink must never take the poll loop down.
    }
  }
  /** 下一次调度：`{ delay, paused }`。动态间隔在这里重新解析，坏值回退到 60s 而不是停掉轮询。 */
  const plan = () => {
    if (!dynamic) return { delay: seconds * 1000, paused: false }
    let value
    try {
      value = Number(intervalSecondsOf())
    } catch (error) {
      warn(`warning: could not read the inbox interval: ${messageOf(error)}; using ${INBOX_INTERVAL_DEFAULT}s`)
      value = INBOX_INTERVAL_DEFAULT
    }
    if (!Number.isFinite(value) || value < 0 || value * 1000 > MAX_TIMER_MS) {
      warn(`warning: invalid inbox interval ${JSON.stringify(value)}; using ${INBOX_INTERVAL_DEFAULT}s`)
      value = INBOX_INTERVAL_DEFAULT
    }
    // 0 是「暂停」：不跑 gh，但 ~1s 后回来看一次，重新启用同样不需要重启。
    return value === 0 ? { delay: 1000, paused: true } : { delay: value * 1000, paused: false }
  }
  let stopped = false
  let timer
  let wake
  const done = new Promise(resolve => { wake = resolve })
  const poll = async () => {
    try {
      await pollOnce({ root: currentRoot(), projectsRoot, gh, log: warn })
    } catch (error) {
      warn(`warning: poll failed: ${messageOf(error)}`)
    }
  }
  const tick = async () => {
    if (stopped) {
      wake()
      return
    }
    const { delay, paused } = plan()
    // 暂停的轮询器一个 gh 都不跑；`once` 是 CLI 的显式单轮请求，仍然照跑。
    if (!paused || once) await poll()
    if (stopped || once) {
      wake()
      return
    }
    timer = setTimeout(() => { void tick() }, delay)
    if (unref) timer.unref?.()
  }
  void tick()
  return {
    done,
    stop() {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      wake()
    },
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
  // 每轮读一次：面板把 `merge.installRepo` 改掉后，下一次轮询就用新值，不需要重启服务。
  const settings = readPanelSettings()
  const counts = { created: 0, updated: 0, failed: 0, merged: 0 }
  const own = ownDeployment()
  // The registry is the only project list. Without an identified deployment this process polls nothing: guessing
  // would let two deployments pull the same PR (or review someone else's). One line says why, once per poll.
  if (own.entry === null) {
    log(`ownership: ${own.reason}; polling nothing until this instance can be identified`)
    return counts
  }
  const deployments = own.registry.deployments
  for (const { repo } of discoverRepos(projectsRoot)) {
    const project = projectForRepo(repo, { projectsRoot, deployments })
    if (project === null) {
      log(`skipping ${repo}: not owned by any registered deployment`)
      continue
    }
    if (project !== own.entry.project) {
      log(`skipping ${repo}: owned by deployment ${project}`)
      continue
    }
    const name = repo.split('/').pop()
    const localPath = join(projectsRoot, project)
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
          let handledMerge = false
          let mergeLocalPath
          // Only a transition the watcher itself observed counts. An item that was already MERGED before
          // this feature existed is not a fresh merge: handling it would pull once per historical PR and
          // queue a notice for every one of them on the first poll after an upgrade. A transition that
          // failed (pull or notice) stays observed and is retried on the next poll until it is handled.
          const wasMerged = existing !== undefined && String(existing.state).toUpperCase() === 'MERGED'
          const observedTransition = existing !== undefined && !wasMerged && String(next.state).toUpperCase() === 'MERGED'
          const retrying = Boolean(existing?.mergeObservedAt) && String(next.state).toUpperCase() === 'MERGED'
          if (existing !== undefined && !existing.mergeHandledAt && (observedTransition || retrying)) {
            const merge = await handleMergedPull({
              item: next,
              repo,
              name,
              project,
              localPath,
              existing,
              observedAt: new Date().toISOString(),
              settings,
              log,
            })
            Object.assign(next, merge)
            mergeLocalPath = localPath
            handledMerge = true
          }
          if (existing === undefined) {
            await writeItem(root, next)
            return 'created'
          }
          if (handledMerge || ITEM_FIELDS.some(field => existing[field] !== next[field])) {
            await writeItem(root, next)
            // Core path is complete: the item (including mergeHandledAt) is on disk. Only a fully
            // handled merge (pull succeeded and, when it applies, the cold-install notice queued) fires;
            // pullError / noticeError leave mergeHandledAt unset and are retried by the next poll.
            if (handledMerge && next.mergeHandledAt !== undefined) {
              fireHook(
                'inbox.merged',
                {
                  itemId: next.id,
                  pr: next.pr,
                  repo,
                  url: next.url,
                  mergeCommit: next.mergeCommit,
                  pulledSha: next.pulledSha,
                  localPath: mergeLocalPath,
                  at: next.mergeHandledAt,
                },
                `merge:${next.id}:${next.pulledSha ?? next.mergeHandledAt}`,
              )
            }
            return handledMerge ? 'merged' : 'updated'
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
      } else if (outcome === 'merged') {
        counts.merged += 1
        log(`merged ${id}`)
      }
    }
  }
  return counts
}

/**
 * 先立刻轮询一轮，然后按间隔循环；`once` 只跑一轮。单轮失败只记日志，循环不停。
 *
 * 与 web host 的自动刷新共用 `startInboxWatcher()`：这里只是把“等它结束”暴露成一个 promise，
 * CLI 的信号处理仍然直接 `process.exit`，所以行为与旧的 for (;;) 循环一致。
 */
export async function watch({ root, rootOf, projectsRoot = defaultProjectsRoot(), intervalSeconds = INBOX_INTERVAL_DEFAULT, once = false, log = () => {} } = {}) {
  const watcher = startInboxWatcher({ root, rootOf, projectsRoot, intervalSeconds, once, log })
  await watcher.done
}

// ------------------------------------------------------------------- HTTP

function pathOf(req) {
  try {
    return new URL(String(req.url ?? '/'), 'http://inbox.local').pathname
  } catch {
    return '/'
  }
}

/** 查询参数；解析失败返回空参数，让 `GET /items` 仍然给默认响应而不是 500。 */
function queryOf(req) {
  try {
    return new URL(String(req.url ?? '/'), 'http://inbox.local').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * 服务端过滤：`kind` / `repo` / `since` / `until` 以 AND 组合。
 *
 * 过滤放在 host 这一侧而不是 bundle 里，面板只负责把参数 URL-encode 后重新取。没有参数时原样返回
 * `readItems()` 的结果（同样的顺序、同样的项），所以旧调用方的行为不变。
 *
 * 时间取 `itemTime()`：PR 用创建时间，SPV 决策信写入时刻。`since`/`until` 是闭区间，接受任何
 * `Date.parse()` 能解析的 ISO 字符串。
 */
function filterItems(items, { kind, repo, since, until }) {
  const wantedKind = String(kind ?? '').trim()
  if (wantedKind !== '' && wantedKind !== 'all' && !KINDS.has(wantedKind)) {
    throw invalid(`kind must be "pr", "spv_message" or "all", got ${JSON.stringify(kind)}.`)
  }
  const wantedRepo = String(repo ?? '').trim()
  const from = String(since ?? '').trim()
  const to = String(until ?? '').trim()
  const fromTime = from === '' ? undefined : Date.parse(from)
  const toTime = to === '' ? undefined : Date.parse(to)
  if (from !== '' && !Number.isFinite(fromTime)) {
    throw invalid(`since is not a parseable date: ${JSON.stringify(since)}.`)
  }
  if (to !== '' && !Number.isFinite(toTime)) {
    throw invalid(`until is not a parseable date: ${JSON.stringify(until)}.`)
  }
  return items.filter(item => {
    if (wantedKind !== '' && wantedKind !== 'all' && kindOf(item) !== wantedKind) return false
    if (wantedRepo !== '' && item?.repo !== wantedRepo) return false
    if (fromTime === undefined && toTime === undefined) return true
    const when = Date.parse(itemTime(item))
    if (!Number.isFinite(when)) return false
    if (fromTime !== undefined && when < fromTime) return false
    if (toTime !== undefined && when > toTime) return false
    return true
  })
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
export function createInboxHandler({ root, rootOf } = {}) {
  if (rootOf !== undefined && typeof rootOf !== 'function') {
    throw new Error('rootOf must be a function returning the inbox root.')
  }
  // The root is resolved per request, not captured once: the first resolution may have fallen back to the
  // legacy inbox (lock held, root not writable yet), and a later migration must be picked up without a
  // service restart.
  const currentRoot = () => (typeof rootOf === 'function' ? rootOf() : root ?? resolveInboxRoot())
  return async function handle(req, res) {
    const pathname = pathOf(req)
    const method = String(req.method ?? 'GET').toUpperCase()
    let root
    try {
      root = currentRoot()
    } catch (error) {
      sendJson(res, 500, { code: 'internal-error', message: messageOf(error) })
      return
    }
    if (pathname === ITEMS_PATH) {
      if (method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      try {
        const params = queryOf(req)
        const items = await readItems(root)
        const filtered = filterItems(items, {
          kind: params.get('kind'),
          repo: params.get('repo'),
          since: params.get('since'),
          until: params.get('until'),
        })
        sendJson(res, 200, { items: filtered })
      } catch (error) {
        if (error.code === 'INBOX_INVALID') {
          sendJson(res, 400, { code: 'bad-request', message: messageOf(error) })
        } else {
          sendJson(res, 500, { code: 'internal-error', message: messageOf(error) })
        }
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
