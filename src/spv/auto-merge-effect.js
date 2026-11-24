/**
 * 内建 hook 效果：`ticket.delivered` 之后自动合并工单的 PR（`merge.autoMerge`，默认关闭）。
 *
 * **为什么在 hook runner 里**：delivered 通常没有自定义脚本行，`runHooksFor` 在 `items.length === 0`
 * 时认领 occurrence 后提前返回，效果会被跳掉；runner 在脚本之后按 `builtinRowsFor(event)` 执行本效果
 * （见 `src/spv/hook-runner.js`）。它属于服务侧：由 `webui/lib/index.js` 的 host 注入，不是用户脚本。
 *
 * **PR 身份不来自负载**：`ticket.delivered` 只有 `ticketId` / `thread`，没有 PR 号。工单的执行目录按
 * dsh 的约定是 `<work root>/<slug>-<ticketId 前 12 位>`；本效果用 `work-plan` 的计划（host 注入的
 * `planOf`）找到那个目录，再从目录里的 git 分支和 `origin` 反推 `owner/name` 与 head 分支，最后让
 * `gh pr list --head <branch>` 给出唯一的 open PR。读不到目录就记一行日志放弃，不猜 PR。
 *
 * **五条闸门**（任何一条不成立都只记一行日志，不合并）：
 *   1. 恰好一个 open PR，且 head 分支与 head 仓库和工单克隆一致；
 *   2. 不是 draft（`isDraft === false`）；
 *   3. `mergeable === 'MERGEABLE'`；
 *   4. `statusCheckRollup` 非空且每一项都是 SUCCESS（没有 CI 检查时写 `no CI checks`，不合并）；
 *   5. `files` 不含 `ARCHITECTURE.md`、`ARCHITECTURE/**`、`PROGRESS.md`、`INSTRUCTIONS.md`。
 *
 * 另外：同一个效果实例合并过的 PR、同一个工单成功合并后，后续 delivered 不再动手；gh 报错/超时只记
 * warning。合并命令固定为 `gh pr merge <n> --repo <owner/name> --squash --delete-branch`，之后由收件箱
 * watcher 的既有 pull / 冷安装路径处理，本效果不 pull、不装。
 *
 * 纯 Node builtins：不 import dsh。`planOf`、`execFile`、日志、开关都由 host 注入（测试用假实现）。
 * 效果**永不抛**；单次执行的上限由 host 传 `{ run, timeoutMs: 120_000 }` 给 runner。
 */
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCallback)

/** 这个效果的 runner 上限：gh 正常很快，但 API 卡住时不能把串行 drain 钉住。 */
export const AUTO_MERGE_TIMEOUT_MS = 120_000

/** git 是本地命令；给它比 gh 短的上限，避免目录坏掉时白等两分钟。 */
const GIT_TIMEOUT_MS = 30_000

/** gh 的输出可能包含很长的检查列表；与 inbox watcher 用同一个上限。 */
const MAX_BUFFER = 64 * 1024 * 1024

/** dsh 的工单目录名以 ticketId 的前 12 位结尾（`<slug>-<12 hex>`）。 */
const TICKET_SUFFIX_CHARS = 12

/** HARNESS：这些文件归操作者，自动合并永远不许碰。 */
const HARNESS_FILES = new Set(['ARCHITECTURE.md', 'PROGRESS.md', 'INSTRUCTIONS.md'])
const HARNESS_DIRECTORY = 'ARCHITECTURE/'

/** `gh pr list` 请求的字段；headRefName/headRepository 是第一条闸门的证据。 */
const PR_LIST_FIELDS = [
  'number',
  'url',
  'isDraft',
  'mergeable',
  'mergeStateStatus',
  'statusCheckRollup',
  'files',
  'headRefName',
  'headRepository',
].join(',')

function messageOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
  const detail = stderr === '' || message.includes(stderr) ? message : `${message}: ${stderr}`
  // 日志必须是一行；gh 的 stderr 常常是多行。
  return detail.replace(/\s+/g, ' ').trim()
}

function repoEquals(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

function headRepositoryOf(pr) {
  const value = pr?.headRepository
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.nameWithOwner === 'string') return value.nameWithOwner
  return undefined
}

/**
 * 从 git remote URL 取出 GitHub 的 `owner/name`；不是 GitHub（或形状不认识）返回 `undefined`。
 *
 * 支持 `https://github.com/o/n(.git)`、`ssh://git@github.com/o/n(.git)`、`git@github.com:o/n(.git)`。
 */
export function parseGitHubRemote(url) {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (raw === '') return undefined
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):([^/\s].*)$/.exec(raw)
  if (scp !== null && scp[1].toLowerCase() === 'github.com') {
    return splitGitHubPath(scp[2])
  }
  try {
    const parsed = new URL(raw)
    if (parsed.hostname.toLowerCase() !== 'github.com') return undefined
    return splitGitHubPath(parsed.pathname)
  } catch {
    return undefined
  }
}

function splitGitHubPath(pathname) {
  const path = String(pathname ?? '')
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  const parts = path.split('/')
  if (parts.length !== 2) return undefined
  const [owner, name] = parts
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) return undefined
  return `${owner}/${name}`
}

/**
 * 从 `work-plan` 的计划里选出该工单的执行目录。
 *
 * dsh 的目录名是 `<slug>-<ticketId 前 12 位>`；也接受目录名恰好等于完整 ticketId 的布局。只有**唯一**
 * 匹配才返回路径：0 个（目录已被回收、工单来自别的 work root）或 2 个（名字碰撞）都视为读不到。
 */
export function ticketDirectoryFromPlan(plan, ticketId) {
  const id = typeof ticketId === 'string' ? ticketId.trim() : ''
  if (id === '') return undefined
  const entries = Array.isArray(plan?.entries) ? plan.entries : []
  const suffix = `-${id.slice(0, TICKET_SUFFIX_CHARS)}`
  const matches = entries.filter(entry => {
    if (entry === null || typeof entry !== 'object') return false
    if (typeof entry.path !== 'string' || entry.path === '') return false
    const name = typeof entry.name === 'string' ? entry.name : ''
    return name === id || name.endsWith(suffix)
  })
  return matches.length === 1 ? matches[0].path : undefined
}

/** 一项检查是否 SUCCESS：CheckRun 看 conclusion，StatusContext 看 state。 */
function checkSucceeded(check) {
  if (check === null || typeof check !== 'object') return false
  const state = String(check.state ?? '').toUpperCase()
  if (state !== '') return state === 'SUCCESS'
  const conclusion = String(check.conclusion ?? '').toUpperCase()
  if (conclusion === '') return false
  if (conclusion !== 'SUCCESS') return false
  const status = String(check.status ?? '').toUpperCase()
  return status === '' || status === 'COMPLETED'
}

function checkName(check) {
  return String(check?.name ?? check?.context ?? check?.__typename ?? 'check')
}

function failedCheckNames(checks) {
  const names = checks.filter(check => !checkSucceeded(check)).map(checkName)
  if (names.length <= 4) return names.join(', ')
  return `${names.slice(0, 4).join(', ')} +${names.length - 4} more`
}

/** PR 改到的 HARNESS 文件；只看路径，不看内容。 */
function harnessFileOf(files) {
  for (const file of files) {
    const path = typeof file?.path === 'string' ? file.path : ''
    if (HARNESS_FILES.has(path) || path.startsWith(HARNESS_DIRECTORY)) return path
  }
  return undefined
}

/**
 * 造一个可以交给 `startHookRunner({ effects })` 的效果。
 *
 * @param {object} options
 * @param {(line: string) => void} [options.log] 日志出口；`warning:` 由 host 映射到 `logger.warn`。
 * @param {() => boolean|Promise<boolean>} [options.enabled] 读 `merge.autoMerge`；默认 false。
 * @param {() => Promise<object|undefined>|object|undefined} [options.planOf] `work-plan` 的结果。
 * @param {string} [options.gh] gh 可执行文件；缺省 `$SPV_GH`，再缺省 `gh`。
 * @param {object} [options.env] 读 `$SPV_GH` 的环境；默认 `process.env`。
 * @param {Function} [options.execFile] 注入的命令执行器（测试用）；默认 `promisify(execFile)`。
 */
export function createAutoMergeEffect({
  log = () => {},
  enabled = () => false,
  planOf = async () => undefined,
  gh = '',
  env = process.env,
  execFile: run = execFileAsync,
} = {}) {
  const say = line => {
    try {
      log(line)
    } catch {
      // 日志 sinks 永远不能把效果拖死。
    }
  }
  const warn = message => say(`warning: ${message}`)
  const ghBinary = String(gh ?? '').trim() || String(env?.SPV_GH ?? '').trim() || 'gh'
  const mergedPrs = new Set()
  const handledTickets = new Set()

  const git = async (cwd, args) => {
    const result = await run('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    })
    return String(result?.stdout ?? '').trim()
  }

  const ghJson = async args => {
    const result = await run(ghBinary, args, {
      encoding: 'utf8',
      timeout: AUTO_MERGE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    })
    try {
      return JSON.parse(String(result?.stdout ?? ''))
    } catch (error) {
      throw new Error(`gh returned unparsable JSON (${messageOf(error)})`)
    }
  }

  return async function autoMergeEffect(context) {
    let on
    try {
      on = await enabled()
    } catch (error) {
      warn(`cannot read merge.autoMerge (${messageOf(error)}); not merging`)
      return undefined
    }
    if (!on) return undefined

    const ticketId = typeof context?.payload?.ticketId === 'string' ? context.payload.ticketId.trim() : ''
    if (ticketId === '') {
      warn('ticket.delivered without a ticketId; cannot auto-merge a PR')
      return undefined
    }
    if (handledTickets.has(ticketId)) {
      say(`skipping auto-merge for ticket ${ticketId}: this effect already merged its PR`)
      return undefined
    }

    let directory
    try {
      const plan = await planOf()
      directory = ticketDirectoryFromPlan(plan, ticketId)
    } catch (error) {
      warn(`cannot read the work plan for ticket ${ticketId} (${messageOf(error)}); not merging`)
      return undefined
    }
    if (directory === undefined) {
      say(`no unique work directory for ticket ${ticketId}; not merging`)
      return undefined
    }

    let branch
    let remote
    try {
      branch = await git(directory, ['rev-parse', '--abbrev-ref', 'HEAD'])
      remote = await git(directory, ['config', '--get', 'remote.origin.url'])
    } catch (error) {
      warn(`cannot read the git branch or origin of ${directory} (${messageOf(error)}); not merging`)
      return undefined
    }
    if (branch === '' || branch === 'HEAD') {
      warn(`the work directory ${directory} is not on a branch; not merging`)
      return undefined
    }
    const repo = parseGitHubRemote(remote)
    if (repo === undefined) {
      warn(`the origin of ${directory} is not a GitHub repository (${remote || 'empty'}); not merging`)
      return undefined
    }

    let prs
    try {
      prs = await ghJson([
        'pr',
        'list',
        '--repo',
        repo,
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        PR_LIST_FIELDS,
      ])
    } catch (error) {
      warn(`gh pr list for ${repo}:${branch} failed (${messageOf(error)}); not merging`)
      return undefined
    }
    if (!Array.isArray(prs)) {
      warn(`gh pr list for ${repo}:${branch} returned an unexpected shape; not merging`)
      return undefined
    }
    if (prs.length === 0) {
      say(`no open PR for ${repo}:${branch}; not merging`)
      return undefined
    }
    if (prs.length > 1) {
      say(`found ${prs.length} open PRs for ${repo}:${branch}; not merging`)
      return undefined
    }

    const pr = prs[0]
    const number = Number(pr?.number)
    if (!Number.isInteger(number) || number <= 0) {
      warn(`gh pr list for ${repo}:${branch} returned no usable PR number; not merging`)
      return undefined
    }
    const key = `${repo.toLowerCase()}#${number}`
    if (mergedPrs.has(key)) {
      say(`skipping ${repo}#${number}: this effect already merged it`)
      return undefined
    }

    // 1) 唯一 open PR，且 head 分支/仓库与工单克隆一致（fork 的同名分支不算）。
    const headRepo = headRepositoryOf(pr)
    if (!repoEquals(headRepo, repo)) {
      say(`PR ${repo}#${number} comes from ${headRepo ?? 'an unknown repository'}, not ${repo}; not merging`)
      return undefined
    }
    if (pr?.headRefName !== branch) {
      say(`PR ${repo}#${number} has head ${pr?.headRefName ?? 'unknown'}, not ${branch}; not merging`)
      return undefined
    }
    // 2) 不是 draft。
    if (pr?.isDraft !== false) {
      say(`PR ${repo}#${number} is a draft; not merging`)
      return undefined
    }
    // 3) 可合并。
    if (pr?.mergeable !== 'MERGEABLE') {
      say(`PR ${repo}#${number} is not mergeable (${pr?.mergeable ?? 'unknown'}); not merging`)
      return undefined
    }
    // 4) CI 检查非空且全部 SUCCESS。
    const checks = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : []
    if (checks.length === 0) {
      say(`PR ${repo}#${number} has no CI checks; not merging`)
      return undefined
    }
    const failed = checks.filter(check => !checkSucceeded(check))
    if (failed.length > 0) {
      say(`PR ${repo}#${number} has failing or unfinished checks (${failedCheckNames(checks)}); not merging`)
      return undefined
    }
    // 5) 不碰 HARNESS。
    if (!Array.isArray(pr?.files)) {
      warn(`gh pr list for ${repo}#${number} returned no files; not merging`)
      return undefined
    }
    const harness = harnessFileOf(pr.files)
    if (harness !== undefined) {
      say(`PR ${repo}#${number} touches HARNESS file ${harness}; not merging`)
      return undefined
    }

    try {
      await run(
        ghBinary,
        ['pr', 'merge', String(number), '--repo', repo, '--squash', '--delete-branch'],
        { encoding: 'utf8', timeout: AUTO_MERGE_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      )
    } catch (error) {
      warn(`gh pr merge ${repo}#${number} failed (${messageOf(error)}); not merging`)
      return undefined
    }
    mergedPrs.add(key)
    handledTickets.add(ticketId)
    say(`merged ${repo}#${number} for ticket ${ticketId}`)
    return undefined
  }
}
