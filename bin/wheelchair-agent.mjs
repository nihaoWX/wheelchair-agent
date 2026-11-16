#!/usr/bin/env node
/**
 * `wheelchair-agent` —— 操作者与 worker 的唯一命令入口（契约见 `ARCHITECTURE/cli.md`）。
 *
 * 本文件只做三件事：解析 argv、把子命令交给实现、决定退出码。**`process.exit` 只出现在这里**：
 * `src/` 是纯函数库，插件与 CLI 都 import 它，谁都不许自己结束进程。
 *
 * 子命令的实现分三类：
 *   - `prepare` / `service` / `jobctl`：`exec` 一个异构实现（sh / python3）。CLI 是门面，
 *     门面后面挂异构工具是正常的；`prepare.sh` 刻意保持 POSIX sh，不重写（`ARCHITECTURE/layout.md`）。
 *   - `spv`：把启动器当子进程跑（终端用 `stdio: 'inherit'` 继承），子进程因 `restart-all --detach`
 *     留下的 marker 退出时，由本进程叙述日志并在**同一终端**重新拉起；普通退出原样返回子进程的退出码。
 *     实现在 `src/spv/restart-ux.js`，所以 CLI 不再用 `exec` 换掉自己。
 *   - `dispatch` / `status`：直接 import `src/spv/*.js`，**不 spawn 子进程**——队列格式只有
 *     一份实现，`spv_dispatch` 工具与这里走同一个 `submitTask`。
 *   - `check`：`src/spv/check.js` 的四项运行时检查。
 *
 * 路径解析：安装后本文件是 `<preset>/cli.js`，`prepare.sh`、`spv-launcher.sh`、`commands/`、`src/` 都在
 * 同一目录下；在 checkout 里它是 `bin/wheelchair-agent.mjs`，对应文件在 `../commands/`、`../preset/`、
 * `../src/`。`INSTALLED` 用「同目录有没有 preset.yml」区分这两种布局，不猜、不向上找。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
/** 安装形态：`<preset>/cli.js` 旁边就有 preset.yml。 */
const INSTALLED = existsSync(join(SELF_DIR, 'preset.yml'))
/** 仓库根（checkout）或 preset 根（安装后）。 */
const ROOT = INSTALLED ? SELF_DIR : join(SELF_DIR, '..')

/** 安装后 `prepare.sh` 与 `spv-launcher.sh` 在 preset 根；checkout 里在 `commands/` 与 `preset/`。 */
const PREPARE = INSTALLED ? join(ROOT, 'prepare.sh') : join(ROOT, 'commands', 'prepare.sh')
const LAUNCHER = INSTALLED ? join(ROOT, 'spv-launcher.sh') : join(ROOT, 'preset', 'spv-launcher.sh')
const SERVICE = join(ROOT, 'commands', 'superagent-service.py')
const JOBCTL = join(ROOT, 'commands', 'jobctl.py')

/** 面板与 `check` 都按命令名引用本程序，所以默认 preset 目录由 DSH_HOME 推出。 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PRESET_DIR = INSTALLED ? SELF_DIR : join(DSH_HOME, '.agent-presets', 'spv')
const STATE_DIR = process.env.DSH_SUPERAGENT_STATE_DIR || join(DSH_HOME, 'state', 'superagent')
const PROJECTS_ROOT = process.env.SPV_PROJECTS_ROOT || join(homedir(), 'bioagentforge')

const USAGE = `usage: wheelchair-agent <command> [options]

The single entry point for the SPV session and the superagent service.

commands:
  spv [dsh-tui args...]        start the SPV session (backend first; narrates a restart and comes back here)
  prepare                      the panel's prepare command: clone the project, install a managed
                               AGENTS.md, give tools/<name> a private GitHub remote
  service <start|stop|restart|status|open>
                               start, stop, restart or inspect the superagent service
  jobctl <submit|status|log|verify|cancel>
                               hand a long job to systemd so it outlives the worker's turn
  dispatch --project <p> --task <t> [--thread <n>] [--preset <id>]
                               write one task into the queue and return
  status [--thread <n>]        show the queue without waiting
  inbox                        print where the review inbox lives (the dsh Web UI panel)
  inbox add --title <text> --body <markdown|@file> [--thread <name>]
                               push one SPV decision letter into the inbox and print its id
  inbox watch [--once] [--interval <seconds>]
                               poll the tools repos and write PR items into the inbox (default 60s)
  work gc [--dry-run] [--keep <n>] [--keep-days <d>]
                               reclaim ticket clones that are clean, unused and fully pushed
  work restored <ticket>       print the commands that rebuild a reclaimed ticket clone
  restart-all [--dry-run] [--force] [--no-install] [--detach]
                               restart the superagent service, cold-install the preset and bring the SPV TUI back
  where [--json]               where this install put everything (data root, preset, wrappers, queue, logs)
  check                        runtime health: service, preset, panel prepare value, prepare dry run
  --help                       this text
  --version                    the installed version

Run "wheelchair-agent <command> --help" for one command's options.`

const INBOX_USAGE = `usage: wheelchair-agent inbox <command>

The review inbox is a section of the wheelchair-agent panel in the dsh Web UI.
Open the superagent service, then pick "wheelchair-agent" in the sidebar:

  wheelchair-agent service start
  wheelchair-agent service open

commands:
  add --title <text> --body <markdown|@file> [--thread <name>]
                               write one SPV decision letter into the inbox (prints the new id)
  watch [--once] [--interval <seconds>]
                               poll the tools/ repos into the inbox`

const INBOX_ADD_USAGE = `usage: wheelchair-agent inbox add --title <text> --body <markdown|@file> [--thread <name>]

Write one "spv_message" decision letter into the review inbox: the SPV agent records
what it decided and why while the operator was away, and the operator later accepts
it or objects. The body is Markdown; "@file" reads it from a file. The new item id is
printed on stdout.

options:
  --title <text>    one line naming the decision (required)
  --body <value>    Markdown body, or @file to read it from a file (required)
  --thread <name>   spv queue thread the letter belongs to (default main)`

const INBOX_WATCH_USAGE = `usage: wheelchair-agent inbox watch [--once] [--interval <seconds>]

Poll the tools/ repos with "gh pr list" and write one item per PR into the inbox.

options:
  --once                 poll once and exit
  --interval <seconds>   seconds between polls (default 60)`

const WORK_USAGE = `usage: wheelchair-agent work <command>

Reclaim ticket clones under the execution root. A clone is reclaimed only when nothing has its cwd
inside it, its working tree is clean, and every commit is already pushed. The record it leaves in
<root>/records/work-reclaimed.jsonl (default ~/.wheelchair-agent) is enough to rebuild it.

environment:
  WHEELCHAIR_AGENT_HOME     our data root for records and logs (default ~/.wheelchair-agent)
  DSH_SUPERAGENT_STATE_DIR  superagent state dir; still owns the queue and the work root
  DSH_SUPERAGENT_WORK_DIR   settings.executor.directory, when it is not <stateDir>/work
  SPV_SUPERAGENT_URL        management API base URL (default http://127.0.0.1:3082)
  DSH_SUPERAGENT_URL        service-manager fallback base URL
  SPV_SUPERAGENT_PORT       management API port when no URL is set (default 3082)

commands:
  gc [--dry-run] [--keep <n>] [--keep-days <d>]
                               print the plan, or reclaim every directory that passes the gate
  restored <ticket>            print the commands that clone the source repo at the recorded commit`

const WORK_GC_USAGE = `usage: wheelchair-agent work gc [--dry-run] [--keep <n>] [--keep-days <d>]

Reclaim ticket directories that are reproducible duplicates of their source repository.

Before planning, work gc asks the running service which tickets are open and keeps their
directories, because a live worker's process cwd is not inside its ticket between tool calls.
If the service is not running that check is skipped (nothing can be working); any other failure
keeps everything. --keep and --keep-days are optional guards, not the safety mechanism.

options:
  --dry-run          print every directory and the reason it is kept; delete nothing
  --keep <n>         never delete the newest n passing directories (default: settings work.keep, built-in 0)
  --keep-days <d>    keep passing directories modified less than d days ago (default: settings
                     work.keepDays, built-in 0)

environment:
  WHEELCHAIR_AGENT_HOME     our data root for records and logs (default ~/.wheelchair-agent)
  DSH_SUPERAGENT_STATE_DIR  superagent state dir; still owns the queue and the work root
  DSH_SUPERAGENT_WORK_DIR   settings.executor.directory, when it is not <stateDir>/work
  SPV_SUPERAGENT_URL        management API base URL (default http://127.0.0.1:3082)
  DSH_SUPERAGENT_URL        service-manager fallback base URL
  SPV_SUPERAGENT_PORT       management API port when no URL is set (default 3082)`

const WORK_RESTORED_USAGE = `usage: wheelchair-agent work restored <ticket>

Print copy-paste commands that rebuild a reclaimed ticket clone from
<root>/records/work-reclaimed.jsonl (default ~/.wheelchair-agent). The directory name is the ticket name,
for example "agent-tool-dsh-install-0312cf6b4046".`

const WHERE_USAGE = `usage: wheelchair-agent where [--json]

Print where this install put everything: the wheelchair-agent data root (settings, inbox, rebuild records
and logs), the preset directory, the four command wrappers, the webui package, the checkout that install.sh
comes from, the superagent queue, the ticket work root, the logs and the panel URL.

Nothing is created, moved or changed: this is a read-only listing. The one-shot data migration runs when a
reader actually resolves a path, not here.

options:
  --json    print one JSON object for scripting`

const RESTART_USAGE = `usage: wheelchair-agent restart-all [--dry-run] [--force] [--no-install] [--detach]

Restart everything this deployment runs: the superagent service, a cold install of the preset, and the SPV TUI
session. The cold-install guard refuses while the service or a live SPV session holds the install targets, so
the order is fixed: guard -> service stop -> stop the SPV chain -> install.sh cold -> service start -> the
terminal that ran "wheelchair-agent spv" brings the TUI back in that same terminal. tmux session "dsh-spv" is
only the fallback for a terminal that is gone.

options:
  --dry-run     print the plan and change nothing (no log, no command, no signal)
  --force       interrupt running workers and queued tickets instead of refusing; prints what it interrupts
  --no-install  skip install.sh and only restart the service and the TUI
  --detach      arm a detached orchestrator and return; this is what /restart-wheelchair-agent uses, and the
                SPV session you run it from is about to end
  --run         internal: run the orchestration in this process (used by --detach)
  --help        this text

--detach appends every step to <root>/logs/restart-all.log (default
~/.wheelchair-agent/logs/restart-all.log). The terminal that ran "wheelchair-agent spv" stays open across the
restart: it tails that log, prints each step, and starts the TUI again there, resumed into the same SPV
conversation from ~/.dsh-tui/resume.txt (a missing or unusable id prints one note and starts a fresh
session). If that terminal is gone, the orchestrator falls back to relaunching the TUI in tmux session
"dsh-spv", resuming the same way.
`

/** 用法错误：退出码 2，与「命令失败」（1）分开。 */
class UsageError extends Error {}

/** 打印用法错误并退出 2。 */
function usage(message) {
  process.stderr.write(`wheelchair-agent: ${message}\n`)
  process.stderr.write('fix: run "wheelchair-agent --help" to see the commands and their options\n')
  process.exit(2)
}

/**
 * 在 PATH 里找一个可执行文件，返回绝对路径；找不到返回 undefined。
 *
 * `process.execve` **不做 PATH 查找**（它直接调 execve(2)），所以 `python3` 这样的名字必须先解析成
 * 绝对路径，否则 execve 以 ENOENT 失败——而那个失败是致命的，连 catch 都来不及。
 */
function which(name) {
  if (name.includes('/')) return existsSync(name) ? name : undefined
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 用 `exec` 换掉本进程，让子进程直接继承终端、信号与退出码。
 *
 * `process.execve` 在 Node 22.15+ / 24 上可用；不可用时退回 `spawnSync` + 转发退出码，行为等价，
 * 只是多一个进程。两者都不经过 shell，所以参数里的空格与引号不会被重新解释。
 */
function exec(file, args) {
  const resolved = which(file)
  if (resolved === undefined) {
    process.stderr.write(`wheelchair-agent: cannot find ${file} on PATH\n`)
    process.exit(1)
  }
  if (typeof process.execve === 'function') {
    try {
      process.execve(resolved, [resolved, ...args])
    } catch (error) {
      // execve 的失败在部分平台上不可捕获（进程直接退出），所以能走到这里时只补一句说明。
      process.stderr.write(`wheelchair-agent: cannot run ${resolved}: ${error.message}\n`)
      process.exit(1)
    }
  }
  const child = spawnSync(resolved, args, { stdio: 'inherit' })
  if (child.error) {
    process.stderr.write(`wheelchair-agent: cannot run ${resolved}: ${child.error.message}\n`)
    process.exit(1)
  }
  process.exit(child.status ?? 1)
}

/** 取一个子命令自己的参数；`--help` 就地打印该命令的用法。 */
function options(argv, spec) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    if (word === '--help' || word === '-h') {
      process.stdout.write(`${spec.usage}\n`)
      process.exit(0)
    }
    const name = spec.flags[word]
    if (name === undefined) throw new UsageError(`unknown option ${JSON.stringify(word)} for "${spec.command}"`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${word} needs a value`)
    }
    parsed[name] = value
    index += 1
  }
  return parsed
}

/** 读版本号：checkout 用仓库 package.json，安装后用 preset 的 package.json。 */
function version() {
  for (const file of [join(ROOT, 'package.json'), join(SELF_DIR, 'package.json')]) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof value.version === 'string' && value.version !== '') return value.version
    } catch {
      // 下一个候选；都没有时退回下面的常量。
    }
  }
  return '0.0.0-unknown'
}

/** 动态 import 一个 `src/` 模块（安装后与 checkout 的相对位置不同，所以按绝对路径 import）。 */
function load(...segments) {
  return import(pathToFileURL(join(ROOT, ...segments)).href)
}

/** 一行预览：把正文压成单行，避免 CLI 输出被长文本淹没。 */
function preview(text, limit) {
  const flat = String(text ?? '').trim().replace(/\s+/g, ' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

// ------------------------------------------------------------------ commands

/**
 * `spv`：拉起后端（幂等）后启动 SPV 会话，其余参数透传给 dsh-tui。
 *
 * 本命令**不** `exec` 启动器：它把启动器当子进程跑，终端由子进程继承，所以 TUI 退出后本进程还在。
 * `restart-all --detach` 留下的 marker 让本进程变成叙述者——tail 日志、打印每一步、然后在同一终端重新
 * 拉起启动器；没有 marker 时就是普通退出，退出码原样透传。循环本身在 `src/spv/restart-ux.js`。
 * `WHEELCHAIR_AGENT_LAUNCHER`（绝对路径）是测试与手动覆盖用的 seam。
 */
async function commandSpv(argv) {
  const configured = String(process.env.WHEELCHAIR_AGENT_LAUNCHER ?? '').trim()
  const launcher = configured === '' ? LAUNCHER : configured
  if (!existsSync(launcher)) {
    process.stderr.write(`wheelchair-agent: the SPV launcher is missing at ${launcher}\n`)
    process.stderr.write('fix: run "bash install.sh" from the wheelchair-agent checkout\n')
    process.exit(1)
  }
  const { runSpvSession } = await load('src', 'spv', 'restart-ux.js')
  process.exitCode = await runSpvSession({
    launcher,
    launcherArgv: argv,
    stateDir: STATE_DIR,
    env: process.env,
  })
}

/**
 * `prepare`：面板的 prepare 命令。
 *
 * 面板里存的是 `wheelchair-agent prepare`（命令名，不是绝对路径），项目路径来自执行环境变量
 * `DSH_SUPERAGENT_SPV_PROJECT` / `DSH_SUPERAGENT_DIR`。`--project` / `--dir` 是手动调试与测试用的显式
 * 覆盖，两者都给时显式参数优先（直接覆盖同名环境变量，`prepare.sh` 只读环境变量）。
 */
function commandPrepare(argv) {
  const parsed = options(argv, {
    command: 'prepare',
    usage: 'usage: wheelchair-agent prepare [--project tools/<name>|research/<name>] [--dir <ticket dir>]',
    flags: { '--project': 'project', '--dir': 'dir' },
  })
  if (!existsSync(PREPARE)) {
    process.stderr.write(`wheelchair-agent: the prepare command is missing at ${PREPARE}\n`)
    process.stderr.write('fix: run "bash install.sh" from the wheelchair-agent checkout\n')
    process.exit(1)
  }
  const env = { ...process.env }
  if (parsed.project !== undefined) env.DSH_SUPERAGENT_SPV_PROJECT = parsed.project
  if (parsed.dir !== undefined) env.DSH_SUPERAGENT_DIR = parsed.dir
  const shell = which('sh') ?? '/bin/sh'
  if (typeof process.execve === 'function') {
    try {
      process.execve(shell, [shell, PREPARE], env)
    } catch (error) {
      process.stderr.write(`wheelchair-agent: cannot run ${PREPARE}: ${error.message}\n`)
      process.exit(1)
    }
  }
  const child = spawnSync(shell, [PREPARE], { stdio: 'inherit', env })
  if (child.error) {
    process.stderr.write(`wheelchair-agent: cannot run ${PREPARE}: ${child.error.message}\n`)
    process.exit(1)
  }
  process.exit(child.status ?? 1)
}

/** `service` / `jobctl`：把参数原样交给 python 实现。 */
function commandPython(script, argv, name) {
  if (!existsSync(script)) {
    process.stderr.write(`wheelchair-agent: ${name} is missing at ${script}\n`)
    process.stderr.write('fix: run "bash install.sh" from the wheelchair-agent checkout\n')
    process.exit(1)
  }
  exec('python3', [script, ...argv])
}

/** `dispatch`：写一个任务进队列。与 `spv_dispatch` 工具共用 `src/spv/dispatch.js`。 */
async function commandDispatch(argv) {
  const parsed = options(argv, {
    command: 'dispatch',
    usage: 'usage: wheelchair-agent dispatch --project <tools/<name>|research/<name>> --task <text> ' +
      '[--thread <name>] [--preset <id>]',
    flags: { '--project': 'project', '--task': 'task', '--thread': 'thread', '--preset': 'preset' },
  })
  const { checkPreset, checkProject, checkTask, checkThread, submitTask } = await load('src', 'spv', 'dispatch.js')
  const { probe, serviceDown } = await load('src', 'spv', 'health.js')
  const { missingQueue, resolveRoot } = await load('src', 'spv', 'paths.js')
  const { dirsOf } = await load('src', 'shared', 'queue.js')
  const root = resolveRoot()
  const project = checkProject(parsed.project)
  const task = checkTask(parsed.task)
  const thread = checkThread(parsed.thread)
  const preset = checkPreset(parsed.preset)
  // 与 spv_dispatch 工具同样的理由：队列目录在服务停止后仍然存在，只查目录会把任务写进没人读的地方。
  const health = await probe()
  if (!health.alive) throw serviceDown(health)
  try {
    const record = await submitTask(dirsOf(root), { project, task, thread, preset })
    process.stdout.write(`dispatched ${record.id} on thread "${record.thread}" for project ${record.project}\n`)
  } catch (error) {
    if (error.code === 'ENOENT') throw missingQueue(root)
    throw error
  }
}

/** `status`：非阻塞看队列。 */
async function commandStatus(argv) {
  const parsed = options(argv, {
    command: 'status',
    usage: 'usage: wheelchair-agent status [--thread <name>]',
    flags: { '--thread': 'thread' },
  })
  const { pendingTasks, unreadMessages } = await load('src', 'spv', 'outbox.js')
  const { checkThread } = await load('src', 'spv', 'dispatch.js')
  const { missingQueue, resolveRoot } = await load('src', 'spv', 'paths.js')
  const { dirsOf } = await load('src', 'shared', 'queue.js')
  const root = resolveRoot()
  const thread = parsed.thread === undefined ? undefined : checkThread(parsed.thread)
  const dirs = dirsOf(root)
  let tasks
  let messages
  try {
    tasks = await pendingTasks(dirs)
    messages = await unreadMessages(dirs, thread)
  } catch (error) {
    if (error.code === 'ENOENT') throw missingQueue(root)
    throw error
  }
  const waiting = tasks.filter(task => thread === undefined || task.thread === thread)
  const lines = [`queue: ${root}`]
  lines.push(waiting.length === 0 ? 'waiting for pickup: none' : `waiting for pickup: ${waiting.length}`)
  for (const task of waiting) lines.push(`  ${task.id} ${task.thread} ${task.project}: ${preview(task.text, 120)}`)
  lines.push(messages.length === 0 ? 'unread messages: none' : `unread messages: ${messages.length}`)
  for (const message of messages) {
    lines.push(`  ${String(message.id ?? '')} [${String(message.kind ?? 'unknown')}] ${String(message.thread ?? 'main')}: ${preview(message.text, 120)}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * `inbox add`：写一封 SPV 决策信。
 *
 * 与 `spv_notify` 工具共用 `createSpvMessage()`，所以 CLI 与模型写出的信件字段完全一致。`--body @file`
 * 让长正文走文件，避免命令行引号与长度限制；读文件失败时在写任何东西之前报错。
 */
async function commandInboxAdd(argv) {
  const parsed = options(argv, {
    command: 'inbox add',
    usage: INBOX_ADD_USAGE,
    flags: { '--title': 'title', '--body': 'body', '--thread': 'thread' },
  })
  if (parsed.title === undefined) throw new UsageError('inbox add needs --title <text>')
  if (parsed.body === undefined) throw new UsageError('inbox add needs --body <markdown|@file>')
  let body = parsed.body
  if (body.startsWith('@')) {
    const file = body.slice(1)
    if (file === '') throw new UsageError('--body @ needs a file path after "@"')
    try {
      body = readFileSync(file, 'utf8')
    } catch (error) {
      throw new Error(`cannot read the body file ${JSON.stringify(file)}: ${error.message}`)
    }
  }
  const { createSpvMessage, resolveInboxRoot } = await load('src', 'spv', 'inbox.js')
  const item = await createSpvMessage(resolveInboxRoot(), {
    title: parsed.title,
    body,
    thread: parsed.thread,
  })
  process.stdout.write(`${item.id}\n`)
}

/** `inbox watch`：先立刻轮询一轮，然后按间隔循环；`--once` 只跑一轮。 */
async function commandInboxWatch(argv) {
  let once = false
  let intervalText = '60'
  let intervalSeconds = 60
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    if (word === '--help' || word === '-h') {
      process.stdout.write(`${INBOX_WATCH_USAGE}\n`)
      process.exit(0)
    }
    if (word === '--once') {
      once = true
      continue
    }
    if (word === '--interval') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError('--interval needs a value')
      intervalText = value
      intervalSeconds = Number(value)
      index += 1
      continue
    }
    throw new UsageError(`unknown option ${JSON.stringify(word)} for "inbox watch"`)
  }
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new UsageError(
      `--interval must be a positive number of seconds, got ${JSON.stringify(intervalText)}`,
    )
  }
  // setTimeout overflows above 2^31-1 ms and fires roughly every 1 ms: refuse rather than busy-loop.
  if (intervalSeconds * 1000 > 2_147_483_647) {
    throw new UsageError(
      `--interval is too large for one timer (at most 2147483 seconds), got ${JSON.stringify(intervalText)}`,
    )
  }
  const { resolveInboxRoot, watch } = await load('src', 'spv', 'inbox.js')
  const root = resolveInboxRoot()
  process.stdout.write(`inbox watch: ${root} (every ${intervalSeconds}s${once ? ', once' : ''})\n`)
  const stop = () => {
    process.stdout.write(`inbox watch: stopped ${root}\n`)
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await watch({
    root,
    rootOf: () => resolveInboxRoot(),
    intervalSeconds,
    once,
    log: message => process.stdout.write(`${message}\n`),
  })
  process.stdout.write(`inbox watch: stopped ${root}\n`)
  process.exit(0)
}

/**
 * `inbox`：`inbox watch ...` 仍是轮询；其余形态只说明面板在哪里。
 *
 * 面板现在是 dsh Web UI 里的 Client React 页面（`webui/lib/client.js`），Host 不再发 HTML，
 * 所以独立页与 `--port` 都已移除。
 */
async function commandInbox(argv) {
  if (argv[0] === 'add') {
    await commandInboxAdd(argv.slice(1))
    return
  }
  if (argv[0] === 'watch') {
    await commandInboxWatch(argv.slice(1))
    return
  }
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${INBOX_USAGE}\n`)
    return
  }
  throw new UsageError(`unknown option ${JSON.stringify(argv[0])} for "inbox"`)
}

/**
 * `work gc`：解析 argv，然后交给 `src/shared/work.js`（挂载时的自动回收走同一个实现）。
 *
 * `--dry-run` 是布尔开关，`options()` 只处理「带值」选项，所以这里自己解析；非法值在任何文件系统操作
 * 之前就报错。
 */
async function commandWorkGc(argv) {
  const parsed = { dryRun: false, keep: undefined, keepDays: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    if (word === '--help' || word === '-h') {
      process.stdout.write(`${WORK_GC_USAGE}\n`)
      return
    }
    if (word === '--dry-run') {
      parsed.dryRun = true
      continue
    }
    const name = { '--keep': 'keep', '--keep-days': 'keepDays' }[word]
    if (name === undefined) throw new UsageError(`unknown option ${JSON.stringify(word)} for "work gc"`)
    const value = argv[index + 1]
    if (value === undefined || !/^\d+$/.test(value)) {
      throw new UsageError(`${word} needs a non-negative whole number`)
    }
    parsed[name] = Number(value)
    index += 1
  }
  const { KEEP_DEFAULT, KEEP_DAYS_DEFAULT, formatBytes, openTicketDirectories, reclaimWork, resolveWorkRoot } =
    await load('src', 'shared', 'work.js')
  // 面板设置的 `work.keep` / `work.keepDays` 是 `work gc` 的默认保留策略；显式 `--keep` / `--keep-days` 仍然优先。
  // 坏文件/读设置失败退回今天的默认（都是 0），**绝不**让 `work gc` 因为设置而失败。
  let settingsKeep = KEEP_DEFAULT
  let settingsKeepDays = KEEP_DAYS_DEFAULT
  try {
    const { resolveSettings } = await load('src', 'shared', 'settings.js')
    const effective = resolveSettings({ stateDir: STATE_DIR, migrate: !parsed.dryRun }).effective
    settingsKeep = effective['work.keep']
    settingsKeepDays = effective['work.keepDays']
  } catch {
    // The built-in defaults are exactly today's behaviour; the CLI must keep working without settings.
  }
  const { fetchOpenTickets } = await load('src', 'spv', 'health.js')
  const open = await openTicketDirectories(() => fetchOpenTickets())
  let skipDirectories = new Map()
  let blockedReason
  const notices = []
  if (open.ok) {
    skipDirectories = open.directories
    if (skipDirectories.size > 0) notices.push(`open tickets: ${skipDirectories.size} directory(s) in use`)
  } else if (open.down) {
    notices.push(`open-ticket check skipped: ${open.reason}`)
  } else {
    blockedReason = `cannot read open tickets: ${open.reason}`
    notices.push(`${blockedReason}; keeping everything`)
  }
  const root = resolveWorkRoot({ stateDir: STATE_DIR })
  const summary = await reclaimWork({
    root,
    stateDir: STATE_DIR,
    keep: parsed.keep ?? settingsKeep,
    keepDays: parsed.keepDays ?? settingsKeepDays,
    dryRun: parsed.dryRun,
    skipDirectories,
    blockedReason,
  })
  const lines = [`work root: ${root}${parsed.dryRun ? ' (dry run; nothing is deleted)' : ''}`, ...notices]
  if (summary.entries.length === 0) lines.push('  (no directories)')
  for (const entry of summary.entries) {
    const label = entry.action === 'reclaim' ? 'reclaim' : entry.action === 'unknown' ? 'unknown' : 'keep'
    const reason = entry.reason === undefined ? '' : ` (${entry.reason})`
    lines.push(`  ${label.padEnd(8)} ${formatBytes(entry.bytes).padStart(10)}  ${entry.name}${reason}`)
  }
  const verb = parsed.dryRun ? 'would reclaim' : 'reclaimed'
  const freedVerb = parsed.dryRun ? 'free' : 'freed'
  const unknown = summary.unknown > 0 ? ` (${summary.unknown} unknown)` : ''
  lines.push(
    `${verb} ${summary.reclaimed}, kept ${summary.kept}${unknown}, ${freedVerb} ${formatBytes(summary.freedBytes)}`,
  )
  process.stdout.write(`${lines.join('\n')}\n`)
  if (blockedReason !== undefined) process.exitCode = 1
}

/** `work restored <ticket>`：只读回收记录，打印可粘贴的重建命令。 */
async function commandWorkRestored(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${WORK_RESTORED_USAGE}\n`)
    return
  }
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    throw new UsageError('work restored needs exactly one ticket directory name')
  }
  const { readReclaimed, restoreCommands, resolveWorkRoot } = await load('src', 'shared', 'work.js')
  const { record } = await readReclaimed({ stateDir: STATE_DIR, ticket: argv[0] })
  process.stdout.write(`${restoreCommands(record, { root: resolveWorkRoot({ stateDir: STATE_DIR }) })}\n`)
}

/** `work`：回收或重建记录；未知子命令是用法错误。 */
async function commandWork(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${WORK_USAGE}\n`)
    return
  }
  if (argv[0] === 'gc') {
    await commandWorkGc(argv.slice(1))
    return
  }
  if (argv[0] === 'restored') {
    await commandWorkRestored(argv.slice(1))
    return
  }
  throw new UsageError(`unknown option ${JSON.stringify(argv[0])} for "work"`)
}

/**
 * `restart-all`：解析布尔开关后交给 `src/spv/restart.js`（服务停止 → SPV 链停止 → 冷安装 → 服务启动 →
 * 由 `spv` 终端叙述并重开 TUI；tmux 只在终端消失时兜底）。
 *
 * 布尔项自己解析（`options()` 只处理带值选项）；任何未知项都在读服务/扫 `/proc` 之前报用法错误。退出码由
 * 实现返回，这里只写 `process.exitCode`，不结束进程。
 */
async function commandRestartAll(argv) {
  const parsed = { dryRun: false, force: false, noInstall: false, detach: false, run: false }
  const booleans = {
    '--dry-run': 'dryRun',
    '--force': 'force',
    '--no-install': 'noInstall',
    '--detach': 'detach',
    '--run': 'run',
  }
  for (const word of argv) {
    if (word === '--help' || word === '-h') {
      process.stdout.write(`${RESTART_USAGE}\n`)
      return
    }
    const name = booleans[word]
    if (name === undefined) throw new UsageError(`unknown option ${JSON.stringify(word)} for "restart-all"`)
    parsed[name] = true
  }
  // --run is the detached child's mode. Combining them would spawn a child that immediately arms another.
  if (parsed.detach && parsed.run) throw new UsageError('--detach and --run cannot be combined')
  const { runRestart } = await load('src', 'spv', 'restart.js')
  const code = await runRestart({
    root: ROOT,
    installed: INSTALLED,
    presetDir: PRESET_DIR,
    presetPatch: join(PRESET_DIR, 'preset-default.patch.yml'),
    stateDir: STATE_DIR,
    env: process.env,
    cwd: process.cwd(),
    cliPath: fileURLToPath(import.meta.url),
  }, parsed)
  process.exitCode = code
}

/**
 * `where`：只读地列出这次安装把东西放在哪。
 *
 * 它回答的是「这东西到底把什么写到了哪里」——此前要读三个文件再加一次 `--check`。数据根的布局
 * （new/old/both）和待迁移状态只是描述，不触发迁移；真正的搬迁发生在第一个读文件的进程里。
 */
async function commandWhere(argv) {
  let json = false
  for (const word of argv) {
    if (word === '--json') {
      json = true
      continue
    }
    if (word === '--help' || word === '-h') {
      process.stdout.write(`${WHERE_USAGE}\n`)
      return
    }
    throw new UsageError(`unknown option ${JSON.stringify(word)} for "where"`)
  }
  const { dataPaths, describeData } = await load('src', 'shared', 'home.js')
  const { resolveRoot } = await load('src', 'spv', 'paths.js')
  const { resolveWorkRoot } = await load('src', 'shared', 'work.js')
  const { resolveCheckout, resolveServiceUrl } = await load('src', 'spv', 'restart.js')
  const paths = dataPaths({ env: process.env, stateDir: STATE_DIR })
  const described = describeData({ env: process.env, stateDir: STATE_DIR })
  // The four wrappers are installed into BIN_DIR (SPV_BIN_DIR or ~/.local/bin), never into the preset
  // directory, so an installed CLI reports the same directory as a checkout CLI.
  const binDir = String(process.env.SPV_BIN_DIR ?? '').trim() || join(homedir(), '.local', 'bin')
  const wrappers = ['wheelchair-agent', 'spv', 'superagent-service', 'jobctl'].map(name => {
    const path = join(binDir, name)
    return { name, path, exists: existsSync(path) }
  })
  const profile = String(process.env.DSH_SUPERAGENT_PROFILE ?? '').trim() || 'superagent'
  const webuiPackage = join(DSH_HOME, 'profiles', profile, 'node_modules', 'wheelchair-agent-webui')
  let checkout = null
  try {
    checkout = resolveCheckout({
      env: process.env,
      root: ROOT,
      presetDir: PRESET_DIR,
      cwd: process.cwd(),
      installed: INSTALLED,
    }) ?? null
  } catch {
    // A malformed installed package.json must not hide every other path.
  }
  let workRoot
  let workRootError
  try {
    workRoot = resolveWorkRoot({ stateDir: STATE_DIR })
  } catch (error) {
    workRootError = error instanceof Error ? error.message : String(error)
  }
  const queue = resolveRoot()
  const payload = {
    root: paths.root,
    rootExists: existsSync(paths.root),
    layout: described.layout,
    migrationPending: described.migrationPending,
    legacyStateDir: paths.legacyStateDir,
    data: {
      settings: paths.settings.current,
      inbox: paths.inbox.current,
      records: paths.records,
      reclaimed: paths.reclaimed.current,
      logs: paths.logs,
      restartLog: paths.restartLog.current,
      prepareLog: paths.prepareLog.current,
      migrationLog: paths.migrationLog,
    },
    presetDir: PRESET_DIR,
    presetDirExists: existsSync(PRESET_DIR),
    binDir,
    wrappers,
    webuiPackage,
    webuiPackageExists: existsSync(webuiPackage),
    checkout,
    checkoutExists: checkout !== null && existsSync(checkout),
    queue: { path: queue, exists: existsSync(queue) },
    workRoot: workRootError === undefined
      ? { path: workRoot, exists: existsSync(workRoot) }
      : { path: null, exists: false, error: workRootError },
    logs: { dir: paths.logs, restartAll: paths.restartLog.current, prepare: paths.prepareLog.current },
    panelUrl: resolveServiceUrl({ env: process.env }),
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  const yes = value => (value ? 'exists' : 'missing')
  const lines = [
    `wheelchair-agent ${version()}`,
    `  root:          ${payload.root} (${yes(payload.rootExists)}; layout ${payload.layout}` +
      `${payload.migrationPending ? ', migration pending' : ''})`,
    `    settings:    ${payload.data.settings}`,
    `    inbox:       ${payload.data.inbox}`,
    `    records:     ${payload.data.records}`,
    `    reclaimed:   ${payload.data.reclaimed}`,
    `    logs:        ${payload.data.logs}`,
    `  preset:        ${payload.presetDir} (${yes(payload.presetDirExists)})`,
    `  wrappers:      ${payload.binDir}`,
    ...payload.wrappers.map(wrapper => `    ${wrapper.name.padEnd(18)} ${wrapper.path} (${yes(wrapper.exists)})`),
    `  webui package: ${payload.webuiPackage} (${yes(payload.webuiPackageExists)})`,
    `  checkout:      ${payload.checkout ?? '(not resolved)'} (${yes(payload.checkoutExists)})`,
    `  queue:         ${payload.queue.path} (${yes(payload.queue.exists)})`,
    `  work root:     ${payload.workRoot.path ?? `(not resolved: ${payload.workRoot.error})`} ` +
      `(${yes(payload.workRoot.exists)})`,
    `  logs:          ${payload.logs.dir}`,
    `    restart-all: ${payload.logs.restartAll}`,
    `    prepare:     ${payload.logs.prepare}`,
    `  panel:         ${payload.panelUrl}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

/** `check`：四项运行时健康检查，任一项失败退出 1。 */
async function commandCheck() {
  const { runChecks } = await load('src', 'spv', 'check.js')
  const results = runChecks({
    serviceScript: join(PRESET_DIR, 'commands', 'superagent-service.py'),
    presetDir: PRESET_DIR,
    stateDir: STATE_DIR,
    prepareScript: join(PRESET_DIR, 'prepare.sh'),
    projectsRoot: PROJECTS_ROOT,
  })
  let failed = 0
  for (const item of results) {
    if (item.ok) {
      process.stdout.write(`OK: ${item.name} — ${item.detail}\n`)
    } else {
      failed += 1
      process.stdout.write(`FAIL: ${item.name} — ${item.detail}\n`)
      if (item.fix) process.stdout.write(`fix: ${item.fix}\n`)
    }
  }
  process.exit(failed === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2)

try {
  switch (command) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(`${USAGE}\n`)
      break
    case '--version':
    case '-v':
    case 'version':
      process.stdout.write(`wheelchair-agent ${version()}\n`)
      break
    case 'spv':
      await commandSpv(rest)
      break
    case 'prepare':
      commandPrepare(rest)
      break
    case 'service':
      commandPython(SERVICE, rest, 'the service manager')
      break
    case 'jobctl':
      commandPython(JOBCTL, rest, 'jobctl')
      break
    case 'dispatch':
      await commandDispatch(rest)
      break
    case 'status':
      await commandStatus(rest)
      break
    case 'inbox':
      await commandInbox(rest)
      break
    case 'work':
      await commandWork(rest)
      break
    case 'restart-all':
      await commandRestartAll(rest)
      break
    case 'where':
      await commandWhere(rest)
      break
    case 'check':
      await commandCheck()
      break
    default:
      usage(`unknown command ${JSON.stringify(command)}`)
  }
} catch (error) {
  if (error instanceof UsageError) usage(error.message)
  process.stderr.write(`wheelchair-agent: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
