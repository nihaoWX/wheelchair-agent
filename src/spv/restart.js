/**
 * `restart-all` orchestration: one command that restarts one deployment (`--project`) or every registered
 * deployment (`--all`), and brings the SPV TUI back.
 *
 * The order is not a preference, it is what the cold-install guard accepts (install.sh, PR #14):
 *
 *   guard -> service stop -> close a stale tmux dsh-spv -> stop the SPV chain (SIGTERM, wait, SIGKILL)
 *         -> wait for the session lease -> install.sh -> service start -> relaunch the TUI in tmux
 *
 * install.sh refuses with exit 3 while the service or a live SPV session holds the install targets, and a
 * half-installed deployment that still answers is worse than a stopped one. So the service and the session
 * must be gone before the install starts; if the install fails, the service is deliberately left stopped.
 *
 * `--project` skips the install (one shared preset serves every deployment); `--all` stops every registry
 * instance, installs once with an explicit project, and starts every instance again.
 *
 * The command usually runs *inside* the SPV session it has to replace, so the slash command arms a detached
 * `--run` child (`armDetached`); that child survives the session's death and performs the steps. The detached
 * run writes a marker before it stops anything; the terminal that launched `wheelchair-agent spv` reads it,
 * narrates the log and relaunches the TUI there, resumed into the same conversation from
 * `~/.dsh-tui/resume.txt`. tmux is only the fallback for a terminal that is gone: after steps 1-4 the
 * orchestrator waits for that terminal's claim (`restart-claimed.json`) before it launches tmux, and the
 * fallback resumes the same conversation too.
 * This module is pure Node builtins and never calls `process.exit`, so the CLI can test it with fake `/proc`
 * entries and fake executables on PATH.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { RESTART_LOG_FILE, dataPaths, resolveData } from '../shared/home.js'
import {
  listDeployments,
  missingDeploymentError,
  missingRegistryError,
} from '../shared/deployments.js'

import {
  claimExists,
  claimHeldByLiveTerminal,
  clearRestartState,
  markFallback,
  readArmed,
  resolveResume,
  restartPaths,
  resumeDetail,
  writeArmed,
} from './restart-ux.js'
import { githubRemote, projectForRepo } from './ownership.js'
import {
  DEFAULT_LEASE_MS,
  holderInRestartChain,
  occupiedSessionNotice,
  resolveSession,
  sessionHolders,
  sessionsRoot,
  waitForLeaseFree,
} from './session.js'

/** Log file name; one `[ISO] text` line per entry. This is #21's data-root name. */
export const LOG_NAME = RESTART_LOG_FILE
/** tmux session the detached orchestrator falls back to; the terminal normally brings the TUI back. */
export const TMUX_SESSION = 'dsh-spv'
/** Default management API base URL, the same one superagent itself uses. */
export const DEFAULT_URL = 'http://127.0.0.1:3082'

/** The health/load endpoint; the load field is what the guard reads. */
const STATE_PATH = '/orchestrator/api/state'

/* Timeouts, overridable through the test seams documented at the bottom of this file. */
const DEFAULT_TERM_MS = 10_000
const DEFAULT_KILL_MS = 5_000
const DEFAULT_PARENT_MS = 5_000
/** How long step 5 waits for the narrating terminal to claim the relaunch before it takes tmux. */
const DEFAULT_CLAIM_MS = 5_000
const POLL_MS = 100
const PARENT_POLL_MS = 50

const sleep = ms => new Promise(done => setTimeout(done, ms))

/** Resolve a path through symlinks; a path that does not exist resolves as an absolute path. */
function realPath(file) {
  try {
    return realpathSync(file)
  } catch {
    return resolve(file)
  }
}

/** Parse a positive millisecond value from the environment, or fall back to `fallback`. */
function envMs(env, name, fallback) {
  const value = Number.parseInt(String(env?.[name] ?? ''), 10)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/** A command-line argument list as one readable line for logs and plans. */
function display(argv) {
  return argv.join(' ')
}

/**
 * The environment for a step command: the detached child's private seams are removed.
 *
 * `WHEELCHAIR_RESTART_CHAIN`, `_PARENT_PID`, `_PRESET_PATCH` and `_SESSION_DIR` exist so `--run` can
 * re-verify the armed chain and wait for the session lease. They must not leak into the service/install/tmux
 * children, or a `restart-all` started from that tree later would trust a stale chain (a real dry run hit
 * exactly that).
 */
function childEnvironment(env) {
  const copy = { ...env }
  delete copy.WHEELCHAIR_RESTART_CHAIN
  delete copy.WHEELCHAIR_RESTART_PARENT_PID
  delete copy.WHEELCHAIR_RESTART_PRESET_PATCH
  delete copy.WHEELCHAIR_RESTART_SESSION_DIR
  // A supervised marker must describe the terminal tree, not a service that was started by one: the
  // service would otherwise pass it on to an unsupervised `wheelchair-agent spv`.
  delete copy.WHEELCHAIR_AGENT_SUPERVISED
  return copy
}

/** Read `/proc/<pid>/cmdline` as argv; an unreadable entry reads as an empty list. */
function cmdlineOf(procRoot, pid) {
  try {
    return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8')
      .split('\0')
      .filter(word => word !== '')
  } catch {
    return []
  }
}

/** Read the parent pid from `/proc/<pid>/status`; 0 when it cannot be read. */
function ppidOf(procRoot, pid) {
  try {
    const text = readFileSync(join(procRoot, String(pid), 'status'), 'utf8')
    const match = /^PPid:\s*(\d+)\s*$/m.exec(text)
    return match === null ? 0 : Number(match[1])
  } catch {
    return 0
  }
}

/**
 * Whether `pid` is a live (non-zombie) process.
 *
 * `/proc/<pid>/stat` is authoritative: a zombie or a dead task still has an entry briefly, and sending it a
 * signal would make the wait look like it failed. Mirrors `alive()` in `commands/superagent-service.py`.
 * When `/proc` cannot be read, fall back to the existence check; a permission error still means "exists".
 */
function pidAlive(pid) {
  try {
    const stat = readFileSync(`/proc/${Number(pid)}/stat`, 'utf8')
    // The comm field is parenthesised and may contain spaces or parentheses; the state is right after it.
    const state = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0]
    return state !== 'Z' && state !== 'X'
  } catch {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }
}

/** Whether `file` is an executable regular file (or a symlink to one). */
function isExecutable(file) {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `NAME` on PATH as a joined argv, or undefined. A name containing `/` is checked directly. */
function which(name, env = process.env) {
  if (name.includes('/')) return isExecutable(name) ? name : undefined
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * The restart log: `<root>/logs/restart-all.log` by default (`$WHEELCHAIR_AGENT_HOME` moves the root), or
 * the old `<stateDir>/restart-all.log` when the first-run move could not happen yet.
 *
 * The superagent state directory is only the migration source; the log is ours.
 */
export function resolveRestartLog({ env = process.env, home, stateDir } = {}) {
  return resolveData({ env, home, stateDir }).restartLog
}

/**
 * The state directory: `DSH_SUPERAGENT_STATE_DIR`, or `<DSH_HOME|~/.dsh>/state/superagent`.
 *
 * This deliberately honours `DSH_HOME` because the CLI's own `STATE_DIR` does the same; `src/spv/paths.js`
 * only reads `DSH_SUPERAGENT_STATE_DIR` (plus `SPV_QUEUE_DIR`), so the two are not a mirror of each other.
 */
export function resolveStateDir({ env = process.env } = {}) {
  const configured = String(env.DSH_SUPERAGENT_STATE_DIR ?? '').trim()
  if (configured) return configured
  const home = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'state', 'superagent')
}

/**
 * The management API base URL: `DSH_SUPERAGENT_URL`, then `SPV_SUPERAGENT_URL`, then a port override,
 * then the default. A trailing slash is stripped so paths concatenate exactly once.
 */
export function resolveServiceUrl({ env = process.env } = {}) {
  const configured = String(env.DSH_SUPERAGENT_URL ?? '').trim() ||
    String(env.SPV_SUPERAGENT_URL ?? '').trim()
  if (configured) return configured.replace(/\/+$/, '')
  const port = String(env.DSH_SUPERAGENT_PORT ?? env.SPV_SUPERAGENT_PORT ?? '').trim() || '3082'
  return `http://127.0.0.1:${port}`.replace(/\/+$/, '')
}

/** The dsh profile that runs the service. */
export function resolveProfile({ env = process.env } = {}) {
  return String(env.DSH_SUPERAGENT_PROFILE ?? '').trim() || 'superagent'
}

/**
 * Whether these argv launch a dsh session with `presetPatch`.
 *
 * This is the same runtime fact `commands/superagent-service.py probe` uses: the installed launcher execs
 * `dsh-tui --patch <preset>/preset-default.patch.yml`, and the dsh child keeps the argument. Symlinks are
 * compared through their targets.
 */
export function presetPatchUsed(argv, presetPatch) {
  if (!presetPatch) return false
  const target = realPath(presetPatch)
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    let value
    if (word === '--patch' && index + 1 < argv.length) value = argv[index + 1]
    else if (word.startsWith('--patch=')) value = word.slice('--patch='.length)
    if (value && realPath(value) === target) return true
  }
  return false
}

/**
 * Whether these argv are the main dsh service process for `profile`.
 *
 * Mirrors `serves()` in `commands/superagent-service.py`: a `--profile <name>` (or `--profile=<name>`)
 * anywhere, and no `plugin` subcommand (`dsh plugin ...` is the installer, not the service).
 */
export function servesProfile(argv, profile) {
  let matched = false
  let valueExpected = false
  const words = []
  for (const word of argv.slice(1)) {
    if (valueExpected) {
      matched = matched || word === profile
      valueExpected = false
    } else if (word === '--profile') {
      valueExpected = true
    } else if (word === `--profile=${profile}`) {
      matched = true
    } else if (!word.startsWith('-')) {
      words.push(word)
    }
  }
  return matched && !words.includes('plugin')
}

/** Every `/proc` entry as `{ pid, argv, ppid }`; unreadable entries are skipped, the list is sorted by pid. */
export function readProcTable({ procRoot = process.env.WHEELCHAIR_PROC_ROOT || '/proc' } = {}) {
  let names
  try {
    names = readdirSync(procRoot)
  } catch {
    return []
  }
  const table = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    table.push({ pid, argv: cmdlineOf(procRoot, pid), ppid: ppidOf(procRoot, pid) })
  }
  return table.sort((left, right) => left.pid - right.pid)
}

/**
 * The pid chain above `pid`, nearest parent first.
 *
 * Always the real `/proc`: this describes the orchestrator itself, not the deployment it is inspecting.
 */
export function ancestorPids(pid, { procRoot = '/proc' } = {}) {
  const ancestors = []
  const seen = new Set([Number(pid)])
  let current = Number(pid)
  while (Number.isInteger(current) && current > 1) {
    const parent = ppidOf(procRoot, current)
    if (!Number.isInteger(parent) || parent <= 1 || seen.has(parent)) break
    ancestors.push(parent)
    seen.add(parent)
    current = parent
  }
  return ancestors
}

/**
 * The pids the orchestrator may signal: the chain plus the session's fd holders, minus itself, its
 * ancestors and the service.
 *
 * Safety is a set subtraction, not a filter on process names: the chain is what carries the `--patch`, the
 * holders are what the kernel names through `/proc/<pid>/fd`, and the service is never ours to stop.
 */
export function killTargets({ chain = [], holders = [], selfPid, ancestors = [], servicePids = [] } = {}) {
  const excluded = new Set([
    Number(selfPid),
    ...ancestors.map(Number),
    ...servicePids.map(Number),
  ])
  const seen = new Set()
  const targets = []
  for (const value of [...chain, ...holders]) {
    const pid = Number(value)
    if (!Number.isInteger(pid) || pid <= 0 || excluded.has(pid) || seen.has(pid)) continue
    seen.add(pid)
    targets.push(pid)
  }
  return targets.sort((left, right) => left - right)
}

/**
 * Read the service's load from the management API.
 *
 * Three outcomes, and the guard treats the middle one as dangerous:
 *   - unreachable (`reachable:false`): a network error, a timeout, a reset or a truncated body. Nothing
 *     answers, so nothing can be working; the guard counts this as idle, as the spec requires;
 *   - answered but unreadable (`reachable:true, readable:false`): HTTP >=400, a body that is not JSON, or a
 *     JSON body without a `load` object. The service is alive and may be running work whose size we cannot
 *     see, so `preflight` refuses unless `--force`;
 *   - readable (`reachable:true, readable:true`): the counts are authoritative.
 *
 * The promise always settles: the response error/aborted events and an overall deadline cover a socket that
 * dies mid-body, and the deadline timer is cleared and unref'd so it cannot keep the process alive.
 */
export function readLoad({ url = DEFAULT_URL, timeoutMs = 3000 } = {}) {
  return new Promise(done => {
    let settled = false
    let deadline
    const finish = value => {
      if (settled) return
      settled = true
      if (deadline !== undefined) clearTimeout(deadline)
      done(value)
    }
    const unreachable = reason =>
      finish({ reachable: false, readable: false, running: 0, queued: 0, reason })
    const unreadable = reason =>
      finish({ reachable: true, readable: false, running: 0, queued: 0, reason })

    let req
    try {
      req = request(
        `${String(url).replace(/\/+$/, '')}${STATE_PATH}`,
        { method: 'GET', headers: { 'x-orchestrator-request': '1' }, timeout: timeoutMs },
        response => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', chunk => {
            body += chunk
          })
          // A reset or a truncated body never reaches 'end'; without these listeners the promise would hang.
          response.on('error', error => {
            unreachable(`reading the response from ${url} failed: ${error.message}`)
          })
          response.on('aborted', () => {
            unreachable(`the response from ${url} was aborted before it finished`)
          })
          response.on('end', () => {
            if (settled) return
            const status = response.statusCode
            if (status !== undefined && status >= 400) {
              unreadable(`the service answered HTTP ${status} at ${url}, so its load could not be read`)
              return
            }
            let value
            try {
              value = JSON.parse(body)
            } catch {
              unreadable(`the service answered at ${url} but did not return JSON, so its load could not be read`)
              return
            }
            if (value === null || typeof value !== 'object' || value.load === null || typeof value.load !== 'object') {
              unreadable(`the service answered at ${url} but the response has no load object`)
              return
            }
            const load = value.load
            finish({
              reachable: true,
              readable: true,
              running: Number.isFinite(Number(load.running)) ? Number(load.running) : 0,
              queued: Number.isFinite(Number(load.queued)) ? Number(load.queued) : 0,
              maxWorkers: Number.isFinite(Number(load.maxWorkers)) ? Number(load.maxWorkers) : undefined,
            })
          })
        },
      )
    } catch (error) {
      unreachable(`probing ${url} failed: ${error.message}`)
      return
    }
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', error => {
      const reason = error.code === 'ECONNREFUSED'
        ? `nothing is listening on ${url}`
        : error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN'
          ? `the host in ${url} cannot be resolved`
          : error.message === 'timeout'
            ? `${url} did not answer within ${timeoutMs}ms`
            : `probing ${url} failed: ${error.message}`
      unreachable(reason)
    })
    req.end()

    // `timeout` only covers socket inactivity; a server that trickles bytes forever needs a wall-clock cap.
    const slack = 500
    deadline = setTimeout(() => {
      unreachable(`${url} did not finish answering within ${timeoutMs + slack}ms`)
      try {
        req.destroy(new Error('deadline'))
      } catch {
        // The promise is already settled; the destroyed request has nowhere left to report.
      }
    }, timeoutMs + slack)
    deadline.unref?.()
  })
}

/** Whether `dir` holds the cold-install script. */
function hasInstall(dir) {
  return typeof dir === 'string' && dir !== '' && existsSync(join(dir, 'install.sh'))
}

/**
 * Resolve the checkout that owns `install.sh`.
 *
 * An installed CLI lives in `<preset>/cli.js` and cannot see the checkout that installed it, so
 * `render-preset.mjs` records `checkout` in the generated package.json. An explicit
 * `WHEELCHAIR_AGENT_CHECKOUT` (test seam / manual override) wins.
 */
export function resolveCheckout({ env = process.env, root, presetDir, cwd = process.cwd(), installed } = {}) {
  const fromEnv = String(env.WHEELCHAIR_AGENT_CHECKOUT ?? '').trim()
  if (hasInstall(fromEnv)) return resolve(fromEnv)
  if (installed !== true && hasInstall(root)) {
    // In a checkout `root` is the repository; installed is undefined for direct callers/tests.
    if (installed === false || existsSync(join(root, 'bin', 'wheelchair-agent.mjs'))) return resolve(root)
  }
  if (presetDir) {
    try {
      const manifest = JSON.parse(readFileSync(join(presetDir, 'package.json'), 'utf8'))
      if (typeof manifest.checkout === 'string' && manifest.checkout !== '') {
        const candidate = resolve(presetDir, manifest.checkout)
        if (hasInstall(candidate)) return candidate
      }
    } catch {
      // No installed package.json; try the remaining candidates.
    }
  }
  let directory = resolve(cwd)
  for (;;) {
    if (hasInstall(directory) && existsSync(join(directory, 'bin', 'wheelchair-agent.mjs'))) {
      return directory
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const projectsRoot = String(env.SPV_PROJECTS_ROOT ?? '').trim() || join(homedir(), 'bioagentforge')
  const fallback = join(projectsRoot, 'tools', 'wheelchair-agent')
  return hasInstall(fallback) ? fallback : undefined
}

/**
 * Append one `[timestamp] text` line per entry, creating parent directories.
 *
 * Append-only on purpose: the operator's console has usually gone away by the time a detached run
 * finishes, so the log is the only record of what happened.
 */
export function appendLog(file, lines, { now = () => new Date() } = {}) {
  const entries = Array.isArray(lines) ? lines : [lines]
  mkdirSync(dirname(file), { recursive: true })
  const text = entries.map(line => `[${now().toISOString()}] ${line}\n`).join('')
  appendFileSync(file, text, 'utf8')
}

/** One-line description of the load, used by both the refusal and the `--force` note. */
function describeLoad(running, queued) {
  const parts = []
  if (running > 0) parts.push(`${running} worker${running === 1 ? '' : 's'} running`)
  if (queued > 0) parts.push(`${queued} ticket${queued === 1 ? '' : 's'} queued`)
  return parts.join(' and ')
}

/** The pid of a plan chain entry, whether the caller passed numbers or `{ pid }` objects. */
function pidOf(entry) {
  if (typeof entry === 'number') return entry
  if (typeof entry === 'string' && /^\d+$/.test(entry)) return Number(entry)
  return Number(entry?.pid)
}

/**
 * The plan the dry run prints: every step and every command, in order, with the pids and paths involved.
 *
 * No side effect: this function only formats. `chain` is the kill set; `service` carries the load and the
 * resolved cwd/agent used by the tmux relaunch. Both are deliberately plain objects so tests can call this
 * with a tiny fixture.
 */
export function planLines({
  service = {},
  chain = [],
  checkout,
  stateDir,
  logFile,
  tmuxSession = TMUX_SESSION,
  noInstall = false,
  install,
  resume,
  sessionId,
  sessionDir,
  holders = [],
  foreign = [],
  leaseMs = DEFAULT_LEASE_MS,
} = {}) {
  const pids = chain.map(pidOf).filter(pid => Number.isInteger(pid) && pid > 0)
  const holderPids = holders.map(pidOf).filter(pid => Number.isInteger(pid) && pid > 0)
  const foreignPids = foreign.map(pidOf).filter(pid => Number.isInteger(pid) && pid > 0)
  const servicePids = (service.pids ?? []).map(pidOf).filter(pid => Number.isInteger(pid) && pid > 0)
  const agent = service.agent ?? ['wheelchair-agent']
  const launch = service.launch ?? [...agent, 'spv']
  const launchArgv = resume?.ok ? [...launch, '--resume', resume.id] : launch
  const cwd = service.cwd ?? process.cwd()
  const termMs = service.termMs ?? DEFAULT_TERM_MS
  const killMs = service.killMs ?? DEFAULT_KILL_MS
  const installCommand = install ?? (checkout ? `bash ${join(checkout, 'install.sh')}` : 'bash <checkout>/install.sh')
  const lines = ['restart-all plan (dry run; nothing is changed)']
  lines.push(`  service:   ${service.url ?? DEFAULT_URL}${servicePids.length > 0 ? ` (pid ${servicePids.join(', ')})` : ' (no process found)'}`)
  const slots = service.maxWorkers === undefined ? '' : `, ${service.maxWorkers} slots`
  lines.push(`  load:      ${service.running ?? 0} running, ${service.queued ?? 0} queued${slots}${service.reachable === false ? ' (service unreachable)' : service.readable === false ? ' (load unreadable; the amount of work is unknown)' : ''}`)
  lines.push(`  spv pids:  ${pids.length > 0 ? pids.join(' ') : '(none identified)'}`)
  lines.push(
    `  session:   ${
      sessionId !== undefined && sessionId !== null
        ? `${sessionId} (${sessionDir ?? '(dir not found)'})`
        : sessionDir !== undefined
          ? `(id not resolved) ${sessionDir}`
          : resume?.ok
            ? `(directory not found for ${resume.id})`
            : '(not resolved; no usable ~/.dsh-tui/resume.txt)'
    }`,
  )
  lines.push(
    `  holders:   ${holderPids.length > 0 ? holderPids.join(' ') : '(none)'}` +
      (holderPids.length > 0 ? ' (fd holders of session.lock / session.v4.jsonl.zstd)' : ''),
  )
  if (foreignPids.length > 0) {
    lines.push(`  other:     ${foreignPids.join(' ')} (another terminal; not signalled)`)
  }
  lines.push(`  checkout:  ${checkout ?? '(not resolved)'}`)
  lines.push(`  state dir: ${stateDir ?? resolveStateDir()}`)
  lines.push(`  log:       ${logFile ?? dataPaths({ stateDir }).restartLog.current}`)
  lines.push(`  tmux:      ${tmuxSession}`)
  lines.push('steps:')
  lines.push(`  1. ${display([...agent, 'service', 'stop'])}`)
  lines.push(
    `  2. close a stale tmux session ${tmuxSession} when present; SIGTERM ` +
      `${pids.length > 0 ? pids.join(' ') : '(none)'}; wait up to ${termMs}ms for them to exit; ` +
      `SIGKILL survivors; wait up to ${killMs}ms; then wait up to ${leaseMs}ms for the session lease`,
  )
  lines.push(`  3. ${noInstall ? 'skipped (--no-install)' : installCommand}`)
  lines.push(`  4. ${display([...agent, 'service', 'start'])}`)
  lines.push(
    `  5. wait for the "wheelchair-agent spv" terminal to claim the relaunch; if it does not, relaunch the ` +
      `TUI in tmux session ${tmuxSession} (cwd ${cwd}), resumed into the same SPV conversation:`,
  )
  const resumeSource = resume?.source === 'session'
    ? 'invoking session'
    : '~/.dsh-tui/resume.txt fallback'
  lines.push(
    resume?.ok
      ? `       resume: --resume ${resume.id} (${resumeSource})`
      : `       resume: --resume unavailable (${resumeDetail(resume)}); the fallback starts a fresh session`,
  )
  if (resume?.ok) {
    lines.push(
      '       lease:  if the old session is still mounted when the wait ends, the launch starts without ' +
        '--resume (fresh session) and says so',
    )
  }
  lines.push(`       tmux has-session -t =${tmuxSession}`)
  lines.push(`       tmux new-window -t =${tmuxSession}: -n spv -c ${cwd} ${display(launchArgv)}`)
  lines.push(`       tmux new-session -d -s ${tmuxSession} -n spv -c ${cwd} ${display(launchArgv)}`)
  return lines
}

/** Print the plan block. Kept separate so callers can write a dry run without touching the log. */
export function renderPlan(lines) {
  return lines.join('\n')
}

/** One external command; never throws for a nonzero exit, a missing binary or a timeout. */
function runArgv(argv, { cwd, env, timeout } = {}) {
  const command = display(argv)
  try {
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd,
      env,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
      command,
      status: result.status,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      error: result.error,
    }
  } catch (error) {
    return { command, status: null, stdout: '', stderr: '', error }
  }
}

/** The exit code of one command; a spawn error or a signal counts as failure. */
function exitCodeOf(result) {
  if (result.error) return 1
  return result.status === 0 ? 0 : 1
}

/** A log-friendly exit description: a number, `signal <name>`, or the spawn error. */
function exitText(result) {
  if (result.error) return `error: ${result.error.code ?? result.error.message}`
  if (result.status === null) return `signal ${result.signal ?? 'unknown'}`
  return String(result.status)
}

/** The pid whose argv selects `--profile dsh-tui`, preferring that one for the TUI's cwd. */
function tuiCwd({ chain, procRoot, fallback }) {
  const candidates = []
  for (const pid of chain) {
    const argv = cmdlineOf(procRoot, pid)
    const hasProfile = argv.some((word, index) =>
      word === '--profile' ? argv[index + 1] === 'dsh-tui' : word === '--profile=dsh-tui')
    candidates.push({ pid, hasProfile })
  }
  candidates.sort((left, right) => Number(right.hasProfile) - Number(left.hasProfile))
  for (const candidate of candidates) {
    try {
      return readlinkSync(join(procRoot, String(candidate.pid), 'cwd'))
    } catch {
      // Fall through to the next candidate or the caller's cwd.
    }
  }
  return fallback
}

/** The `wheelchair-agent` argv the orchestrator drives; `WHEELCHAIR_AGENT_BIN` is a test seam. */
function agentArgv(context, env) {
  const override = String(env.WHEELCHAIR_AGENT_BIN ?? '').trim()
  if (override) return [override]
  if (which('wheelchair-agent', env) !== undefined) return ['wheelchair-agent']
  if (context.cliPath) return [process.execPath, context.cliPath]
  return ['wheelchair-agent']
}

/** A failed preflight: the lines to print, and the exit code. */
function preflightFailure(lines, extra = {}) {
  return { ok: false, code: 1, lines, ...extra }
}

/**
 * Read-only inspection shared by dry-run, detach and the two executing modes.
 *
 * It performs the guard, finds the chain and service through `/proc`, resolves the checkout and tmux, and
 * computes the kill set. It never writes a file, spawns a command or signals a process.
 */
async function preflight(context, options, { detached = false } = {}) {
  const env = context.env ?? process.env
  // `armDetached` hands the armed chain and patch to the `--run` child through the environment. Those
  // overrides are meaningful only in that child: honoring them in a dry run, a foreground run or the
  // arming preflight would let a stale leaked environment bypass the real `/proc` scan.
  const armed = options.run === true
  const presetPatch = (armed ? String(env.WHEELCHAIR_RESTART_PRESET_PATCH ?? '').trim() : '') ||
    context.presetPatch
  const serviceUrl = resolveServiceUrl({ env })
  const profile = resolveProfile({ env })
  const lines = []

  const load = await readLoad({ url: serviceUrl })
  const running = load.reachable ? load.running : 0
  const queued = load.reachable ? load.queued : 0
  const what = describeLoad(running, queued)

  if (!load.reachable) {
    lines.push(
      `note: the superagent service is unreachable at ${serviceUrl} (${load.reason ?? 'no answer'}), ` +
        'so nothing can be running.',
    )
  }
  // An answered-but-unreadable response is not idle: the service is alive and may be running work we cannot
  // see, so this is a refusal unless the operator explicitly takes the unknown amount of work on.
  if (load.reachable && load.readable === false) {
    if (!options.force) {
      lines.push(
        `FAIL: refusing to restart: the superagent service answered at ${serviceUrl} but its load could not ` +
          `be read (${load.reason ?? 'unknown response'}), so it may be running work.`,
      )
      lines.push(
        'fix: pass --force to restart anyway; that interrupts an unknown amount of work, and the running ' +
          'worker Sessions and queued tickets will be stopped without being counted.',
      )
      return preflightFailure(lines, { serviceUrl, load })
    }
    lines.push(
      `note: --force: the service answered at ${serviceUrl} but its load could not be read ` +
        `(${load.reason ?? 'unknown response'}); the amount of running work is unknown, proceeding.`,
    )
  }
  if (!options.force && (running > 0 || queued > 0)) {
    lines.push(`FAIL: refusing to restart: the superagent service reports ${what}.`)
    lines.push(
      'fix: pass --force to interrupt them (the running worker Sessions and the queued tickets), ' +
        'or wait until the work finishes.',
    )
    return preflightFailure(lines, { serviceUrl, load })
  }
  if (options.force && (running > 0 || queued > 0)) {
    lines.push(`note: --force: interrupting ${what} now.`)
  }

  const procRoot = String(env.WHEELCHAIR_PROC_ROOT ?? '').trim() || '/proc'
  const table = readProcTable({ procRoot })
  const chainOverride = armed ? String(env.WHEELCHAIR_RESTART_CHAIN ?? '').trim() : ''
  const chainOverridePids = chainOverride
    ? [...new Set(chainOverride.split(/\s+/).map(Number).filter(pid => Number.isInteger(pid) && pid > 0))]
    : undefined
  // The armed child accepts a non-patch pid as a holder only for the session its *marker* names. The
  // environment is a transport detail an outer shell can forge or leak; if it is present it must agree with
  // the marker, otherwise holder acceptance is disabled and only the `--patch` check can vouch for a pid.
  const envSessionDir = armed ? String(env.WHEELCHAIR_RESTART_SESSION_DIR ?? '').trim() : ''
  let armedSessionDir = ''
  if (armed) {
    const marker = readArmed(context.stateDir || resolveStateDir({ env }))
    const markerSessionDir = typeof marker?.sessionDir === 'string' ? marker.sessionDir.trim() : ''
    if (markerSessionDir !== '' && (envSessionDir === '' || envSessionDir === markerSessionDir)) {
      armedSessionDir = markerSessionDir
    }
  }
  if (chainOverridePids !== undefined) {
    // Pid reuse or a stale environment must not turn into signalling an unrelated process: the armed chain
    // is only trustworthy if every pid still carries the same `--patch` right now, or is a current fd
    // holder of the session the marker armed for (a holder need not carry the patch).
    for (const pid of chainOverridePids) {
      const argv = cmdlineOf(procRoot, pid)
      const holdsSession = armedSessionDir !== '' &&
        sessionHolders({ sessionDir: armedSessionDir, procRoot }).some(holder => holder.pid === pid)
      if (!presetPatchUsed(argv, presetPatch) && !holdsSession) {
        lines.push(
          `FAIL: the armed SPV chain is stale or changed (pid ${pid} no longer carries ` +
            `--patch ${presetPatch ?? '(no preset patch)'}); nothing was stopped`,
        )
        lines.push(
          'fix: rerun /restart-wheelchair-agent from the live SPV session, which re-arms the chain; ' +
            'nothing was stopped.',
        )
        return preflightFailure(lines, { serviceUrl, load, presetPatch })
      }
    }
  }
  const chain = chainOverridePids ??
    table.filter(entry => presetPatchUsed(entry.argv, presetPatch)).map(entry => entry.pid)
  chain.sort((left, right) => left - right)
  const servicePids = table.filter(entry => servesProfile(entry.argv, profile)).map(entry => entry.pid)

  // The session whose lease the relaunch needs. The invoking Session is authoritative when the command
  // handler could pass it; `~/.dsh-tui/resume.txt` is dsh-tui's global last-opened pointer, so it is only a
  // fallback, and every fallback says why it was used.
  const requested = typeof options.session === 'string' ? options.session.trim() : ''
  const sessionCwd = context.cwd ?? process.cwd()
  let resume
  let session
  if (requested !== '') {
    session = resolveSession({ env, cwd: sessionCwd, id: requested })
    if (session !== undefined) {
      resume = { ok: true, id: session.id, source: 'session' }
    } else {
      resume = resolveResume()
      lines.push(
        `note: the invoking session ${requested} has no directory under ${sessionsRoot({ env })}; using ` +
          `${resume.ok ? `~/.dsh-tui/resume.txt (${resume.id})` : `the fallback (${resumeDetail(resume)})`} instead`,
      )
      session = resume.ok ? resolveSession({ env, cwd: sessionCwd, id: resume.id }) : undefined
    }
  } else {
    resume = resolveResume()
    lines.push(
      `note: no invoking session id was passed to restart-all; using ` +
        `${resume.ok ? `~/.dsh-tui/resume.txt (${resume.id})` : `the fallback (${resumeDetail(resume)})`} instead`,
    )
    session = resume.ok ? resolveSession({ env, cwd: sessionCwd, id: resume.id }) : undefined
  }
  if (resume.ok && session === undefined) {
    lines.push(
      `note: the session ${resume.id} named by ~/.dsh-tui/resume.txt has no directory under ` +
        `${sessionsRoot({ env })}; its lease holders cannot be identified before the relaunch.`,
    )
  }
  const holders = session === undefined
    ? []
    : sessionHolders({ sessionDir: session.dir, procRoot })
  // A holder is only ours when it is in the chain being restarted. A holder from another terminal is never
  // signalled: it may release the lease itself, and on timeout the relaunch starts a new session.
  const chainPids = chain
  const ours = holders.filter(holder => holderInRestartChain({ pid: holder.pid, chain: chainPids, procRoot }))
  const foreign = holders.filter(holder => !holderInRestartChain({ pid: holder.pid, chain: chainPids, procRoot }))
  if (ours.length > 0) {
    lines.push(
      `note: pid ${ours.map(holder => holder.pid).join(' ')} ` +
        `${ours.length === 1 ? 'holds' : 'hold'} the session ${session.id} lease; ` +
        `${ours.length === 1 ? 'it is' : 'they are'} added to the kill set`,
    )
  }
  if (foreign.length > 0) {
    lines.push(
      `note: pid ${foreign.map(holder => holder.pid).join(' ')} ` +
        `${foreign.length === 1 ? 'holds' : 'hold'} the session ${session.id} lease but ` +
        `${foreign.length === 1 ? 'is' : 'are'} not part of this restart chain (another terminal); ` +
        'not preempted',
    )
  }

  if (chain.length === 0) {
    lines.push(
      `FAIL: cannot identify the live SPV session: no process carries --patch ${presetPatch ?? '(no preset patch)'}.`,
    )
    lines.push(
      'fix: start the SPV session with "wheelchair-agent spv", then rerun; nothing was stopped. Do not pass ' +
        '--patch to that command: it would put the supervising CLI itself in the kill chain.',
    )
    return preflightFailure(lines, { serviceUrl, load, presetPatch })
  }

  let checkout
  if (!options.noInstall) {
    checkout = resolveCheckout({
      env,
      root: context.root,
      presetDir: context.presetDir,
      cwd: context.cwd,
      installed: context.installed,
    })
    if (checkout === undefined) {
      lines.push('FAIL: cannot find the wheelchair-agent checkout that holds install.sh.')
      lines.push(
        'fix: set WHEELCHAIR_AGENT_CHECKOUT to the checkout, or rerun with --no-install if the preset is ' +
          'already installed; nothing was stopped.',
      )
      return preflightFailure(lines, { serviceUrl, load, presetPatch })
    }
  }

  // tmux is only the fallback: the terminal that launched `wheelchair-agent spv` needs none. A missing tmux
  // is therefore a note, and only step 5 fails if no terminal claims and there is no way to launch the TUI.
  const tmuxAvailable = which('tmux', env) !== undefined
  if (!tmuxAvailable) {
    lines.push(
      'note: tmux is not on PATH; the terminal that launched "wheelchair-agent spv" can still bring the TUI ' +
        'back in place, but the fallback for a closed terminal is unavailable.',
    )
  }

  const ancestors = detached ? [] : ancestorPids(process.pid)
  if (!detached && chain.some(pid => pid === process.pid || ancestors.includes(pid))) {
    lines.push('FAIL: the orchestrator is still a descendant of the SPV session it must replace; nothing was stopped')
    lines.push(
      'fix: use --detach (or /restart-wheelchair-agent), which reparents the orchestrator before it stops the ' +
        'session it was started from.',
    )
    return preflightFailure(lines, { serviceUrl, load, presetPatch, checkout, chain, servicePids })
  }

  const targets = killTargets({
    chain,
    holders: ours.map(holder => holder.pid),
    selfPid: process.pid,
    ancestors,
    servicePids,
  })
  if (targets.length === 0) {
    lines.push(
      'FAIL: cannot identify an SPV process to stop (the matching pids are this process, its ancestors or ' +
        'the service); nothing was stopped',
    )
    lines.push('fix: rerun from outside the SPV session with --detach, or start the session with "wheelchair-agent spv".')
    return preflightFailure(lines, { serviceUrl, load, presetPatch, checkout, chain, servicePids })
  }

  const cwd = tuiCwd({
    chain,
    procRoot,
    fallback: context.cwd ?? process.cwd(),
  })
  const agent = agentArgv(context, env)
  // The tmux server has its own PATH (it may have been started from another shell), so the TUI launch uses
  // an absolute node + CLI argv. Prefer the *installed preset* CLI: a checkout CLI's `spv` command runs the
  // checkout's unrendered preset/spv-launcher.sh (@SPV_HOME@ placeholder), which cannot start the TUI. The
  // chain was identified through `<presetDir>/preset-default.patch.yml`, and after the cold install that
  // directory holds the newly installed cli.js. Fall back to the invoking CLI only when it is absent.
  const presetCli = typeof context.presetDir === 'string' && context.presetDir !== ''
    ? join(context.presetDir, 'cli.js')
    : undefined
  const launchCli = presetCli !== undefined && existsSync(presetCli)
    ? presetCli
    : typeof context.cliPath === 'string' && existsSync(context.cliPath)
      ? context.cliPath
      : undefined
  const launch = launchCli === undefined ? [...agent, 'spv'] : [process.execPath, launchCli, 'spv']
  return {
    ok: true,
    code: 0,
    lines,
    presetPatch,
    profile,
    serviceUrl,
    servicePids,
    chain,
    targets,
    holders,
    ours,
    foreign,
    session,
    sessionId: session?.id,
    sessionDir: session?.dir,
    leaseMs: envMs(env, 'WHEELCHAIR_RESTART_LEASE_MS', DEFAULT_LEASE_MS),
    procRoot,
    resume,
    load,
    checkout,
    cwd,
    agent,
    launch,
    tmux: tmuxAvailable,
    termMs: envMs(env, 'WHEELCHAIR_RESTART_TERM_MS', DEFAULT_TERM_MS),
    killMs: envMs(env, 'WHEELCHAIR_RESTART_KILL_MS', DEFAULT_KILL_MS),
  }
}

/** The object `planLines` formats, built from one successful preflight. */
function planService(pre) {
  return {
    url: pre.serviceUrl,
    pids: pre.servicePids,
    reachable: pre.load.reachable,
    readable: pre.load.readable,
    running: pre.load.running,
    queued: pre.load.queued,
    maxWorkers: pre.load.maxWorkers,
    cwd: pre.cwd,
    agent: pre.agent,
    launch: pre.launch,
    termMs: pre.termMs,
    killMs: pre.killMs,
    sessionId: pre.sessionId,
    sessionDir: pre.sessionDir,
    holders: pre.holders,
    leaseMs: pre.leaseMs,
  }
}

/** Signal every pid, treating ESRCH as already gone. Returns what was sent and the real errors. */
function signalPids(pids, signal) {
  const sent = []
  const errors = []
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
      sent.push(pid)
    } catch (error) {
      if (error?.code !== 'ESRCH') errors.push(`${pid}: ${error.message}`)
    }
  }
  return { sent, errors }
}

/** Poll until every pid is gone or the timeout expires; returns the survivors. */
async function waitGone(pids, timeoutMs) {
  if (pids.length === 0) return []
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let alive = pids.filter(pidAlive)
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS)
    alive = pids.filter(pidAlive)
  }
  return alive
}

/** Read the orchestrator's own parent pid from the real `/proc`, with `process.ppid` as a fallback. */
function ownPpid() {
  try {
    const match = /^PPid:\s*(\d+)\s*$/m.exec(readFileSync('/proc/self/status', 'utf8'))
    if (match !== null) return Number(match[1])
  } catch {
    // Fall through to the runtime value.
  }
  return process.ppid
}

/** Wait until the arming process is no longer our parent (or is gone), so the session can be signalled. */
async function waitForReparent(parentPid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    if (ownPpid() !== parentPid) return true
    if (!pidAlive(parentPid)) return true
    if (Date.now() >= deadline) return false
    await sleep(PARENT_POLL_MS)
  }
}

/**
 * Close a stale `dsh-spv` tmux session between the service stop and the chain kill.
 *
 * A previous fallback can leave that session behind with a TUI that is still holding the session lease; the
 * relaunch then has to wait for a process nothing else is going to stop. This is a `note:`, not a numbered
 * step, and every failure is a warning: the restart must not abort because tmux is unhappy.
 *
 * The safety rule is the operator's own terminal: when this CLI runs inside `dsh-spv` (env `TMUX` and the
 * name tmux reports), killing it would kill the process narrating the restart, so it only warns.
 */
function closeStaleTmux({ pre, env, stepEnv, record }) {
  if (pre.tmux !== true) return
  if (typeof env.TMUX === 'string' && env.TMUX !== '') {
    const current = runArgv(['tmux', 'display-message', '-p', '#S'], {
      env: stepEnv,
      cwd: pre.cwd,
      timeout: 10_000,
    })
    if (exitCodeOf(current) !== 0) {
      record(`note: could not determine the current tmux session; not closing ${TMUX_SESSION} before the restart`)
      return
    }
    if (current.stdout.trim() === TMUX_SESSION) {
      record(`warning: this CLI is inside tmux session ${TMUX_SESSION}; not closing it before the restart`)
      return
    }
  }
  const hasSession = runArgv(['tmux', 'has-session', '-t', `=${TMUX_SESSION}`], {
    env: stepEnv,
    cwd: pre.cwd,
    timeout: 10_000,
  })
  if (exitCodeOf(hasSession) !== 0) return
  const killed = runArgv(['tmux', 'kill-session', '-t', `=${TMUX_SESSION}`], {
    env: stepEnv,
    cwd: pre.cwd,
    timeout: 10_000,
  })
  if (exitCodeOf(killed) === 0) {
    record(`note: closed the stale tmux session ${TMUX_SESSION} before the restart`)
    return
  }
  const detail = `${killed.stdout ?? ''}${killed.stderr ?? ''}`.trim() || `exit ${exitText(killed)}`
  record(`note: could not close the stale tmux session ${TMUX_SESSION}: ${detail.split('\n')[0]}`)
}

/** The pid of the holder that blocks the lease (ignoring the orchestrator itself), or undefined. */
function leaseBlockedBy(holders, selfPid) {
  const blocking = holders.filter(holder => holder.pid !== Number(selfPid))
  return blocking.length === 0 ? undefined : blocking[0].pid
}

/**
 * Execute the restart steps in this process.
 *
 * Both `--run` (the detached child) and the foreground command use this; the only difference is the mode
 * label in the start line. Every message also goes to the log, because an operator who ran the detach path
 * has no console left when it finishes.
 */
async function orchestrate(context, options, mode) {
  const env = context.env ?? process.env
  const stateDir = context.stateDir || resolveStateDir({ env })
  const logFile = context.logFile || resolveRestartLog({ env, home: context.home, stateDir })
  // The orchestrator's private seams must not reach the service it starts (see childEnvironment).
  const stepEnv = childEnvironment(env)
  const pre = await preflight(context, options, { detached: false })
  if (!pre.ok) {
    // A detached run whose re-guard refused will never narrate a completion; clear the marker so a later
    // normal TUI exit in the still-open terminal is not mistaken for this dead run.
    if (mode === 'detached') clearRestartState(stateDir)
    // The detached path has already promised a log to the operator, and the console may be gone by the time
    // the child's re-guard fails, so the reason must be in the log even though nothing was mutated.
    const failureLines = [
      ...pre.lines,
      `restart-all: preflight failed, nothing was stopped (exit ${pre.code})`,
    ]
    try {
      appendLog(logFile, failureLines)
    } catch (error) {
      process.stdout.write(`note: cannot append the preflight failure to ${logFile}: ${error.message}\n`)
    }
    process.stdout.write(`${pre.lines.join('\n')}\n`)
    return pre.code
  }

  const startLine =
    `restart-all: pid ${process.pid}, mode ${mode}, force=${options.force ? 'yes' : 'no'}, ` +
    `install=${options.noInstall ? 'skipped (--no-install)' : 'yes'}, ` +
    `chain ${pre.targets.join(' ') || '(none)'}, service ${pre.servicePids.join(' ') || '(none)'}`
  try {
    appendLog(logFile, [...pre.lines, startLine])
  } catch (error) {
    process.stdout.write(`FAIL: cannot write the restart log ${logFile}: ${error.message}\n`)
    process.stdout.write('fix: make the state directory writable, then rerun; nothing was stopped.\n')
    return 1
  }
  for (const line of pre.lines) process.stdout.write(`${line}\n`)

  const record = line => {
    process.stdout.write(`${line}\n`)
    try {
      appendLog(logFile, [line])
    } catch (error) {
      process.stdout.write(`FAIL: cannot append to the restart log ${logFile}: ${error.message}\n`)
    }
  }

  const total = 5

  // 1. Stop the service first: the guard requires it, and a stopped service cannot accept new work.
  const stop = runArgv([...pre.agent, 'service', 'stop'], { env: stepEnv, cwd: pre.cwd, timeout: 330_000 })
  record(`step 1/${total}: ${stop.command} -> exit ${exitText(stop)}`)
  if (exitCodeOf(stop) !== 0) {
    record('restart aborted: the superagent service did not stop; the SPV session was left alone (exit 1)')
    return 1
  }

  // A stale fallback session is closed here, after the service and before the kill: a TUI nobody narrates
  // would otherwise keep the session lease open across the install.
  closeStaleTmux({ pre, env, stepEnv, record })

  // 2. Stop the exact `/proc`-identified SPV chain. The kill set excludes self, ancestors and the service.
  const targets = pre.targets
  const term = signalPids(targets, 'SIGTERM')
  if (term.errors.length > 0) record(`note: SIGTERM errors: ${term.errors.join('; ')}`)
  let survivors = await waitGone(targets, pre.termMs)
  record(`step 2/${total}: SIGTERM ${targets.join(' ')} -> sent ${term.sent.length}, survivors ${survivors.length}`)
  if (survivors.length > 0) {
    const kill = signalPids(survivors, 'SIGKILL')
    if (kill.errors.length > 0) record(`note: SIGKILL errors: ${kill.errors.join('; ')}`)
    survivors = await waitGone(survivors, pre.killMs)
    record(`step 2/${total}: SIGKILL ${targets.join(' ')} -> sent ${kill.sent.length}, survivors ${survivors.length}`)
  }
  if (survivors.length > 0) {
    record(
      `FAIL: pids ${survivors.join(' ')} survived SIGKILL; install.sh would refuse, so it was not run. ` +
        'The superagent service is left stopped (exit 1)',
    )
    return 1
  }

  // The kill set is gone, but the kernel lease is what dsh-tui checks: a process that held session.lock
  // while not carrying the patch was only found by its descriptor. Wait (bounded) for the descriptors to
  // close before anything resumes the session; if they do not, the relaunch must start fresh.
  let leaseBlockedPid
  if (pre.sessionDir !== undefined) {
    const lease = await waitForLeaseFree({
      sessionDir: pre.sessionDir,
      procRoot: pre.procRoot,
      timeoutMs: pre.leaseMs,
      selfPid: process.pid,
      say: line => record(line),
    })
    if (!lease.ok) {
      leaseBlockedPid = lease.holder?.pid
      if (leaseBlockedPid !== undefined) {
        record(occupiedSessionNotice({ sessionId: pre.sessionId, pid: leaseBlockedPid }))
        try {
          const marker = readArmed(stateDir)
          if (marker !== undefined) writeArmed(stateDir, { ...marker, leaseBlockedPid })
        } catch {
          // The launch below already drops --resume; the marker is only the other process's hint.
        }
      }
    }
  }

  // 3. Cold install. Abort the whole restart if it fails: do NOT start a half-installed deployment.
  if (options.noInstall) {
    record(`step 3/${total}: install.sh skipped (--no-install)`)
  } else {
    const install = runArgv(['bash', join(pre.checkout, 'install.sh')], {
      env: stepEnv,
      cwd: pre.checkout,
      timeout: 600_000,
    })
    record(`step 3/${total}: ${install.command} -> exit ${exitText(install)}`)
    if (exitCodeOf(install) !== 0) {
      // The last lines are the only diagnosis the operator has once the console is gone.
      const detail = `${install.stdout ?? ''}${install.stderr ?? ''}`
        .split('\n')
        .filter(line => line.trim() !== '')
        .slice(-20)
      for (const line of detail) record(`install output: ${line}`)
      if (install.error === undefined && install.status === 3) {
        record(
          'install failed: install.sh refused with exit 3 because a holder is still alive; nothing was ' +
            'installed; the superagent service is left stopped; not starting it back (exit 1)',
        )
      } else {
        record('install failed; the superagent service is left stopped; not starting it back (exit 1)')
      }
      // A failed restart leaves no SPV session for `restart-all --force` to identify, so the recovery is
      // necessarily by hand, in the order the cold-install guard accepts.
      record(
        `fix: recover by hand: bash ${join(pre.checkout, 'install.sh')} && wheelchair-agent service start && ` +
          'wheelchair-agent spv',
      )
      return 1
    }
  }

  // 4. Start the service back. A failure here ends the restart: a TUI relaunched against a dead service
  // would only produce a backend-less session and hide the failure the operator has to fix.
  const start = runArgv([...pre.agent, 'service', 'start'], { env: stepEnv, cwd: pre.cwd, timeout: 180_000 })
  record(`step 4/${total}: ${start.command} -> exit ${exitText(start)}`)
  if (exitCodeOf(start) !== 0) {
    record(
      'FAIL: the superagent service did not start; the TUI was not relaunched; fix the service and run ' +
        '"wheelchair-agent spv"',
    )
    record('restart failed (exit 1)')
    return 1
  }

  // 5. The terminal that launched `wheelchair-agent spv` is normally still there: it saw the marker, narrates
  // this log and relaunches the TUI itself. It claims that job by writing restart-claimed.json. Only when no
  // claim arrives within the grace period is the terminal gone, and tmux becomes the fallback relaunch.
  const claimMs = envMs(env, 'WHEELCHAIR_RESTART_CLAIM_MS', DEFAULT_CLAIM_MS)
  const claimDeadline = Date.now() + claimMs
  let claimed = false
  let staleClaim = false
  for (;;) {
    if (claimExists(stateDir)) {
      // A claim only counts while its narrator is alive: if the CLI wrote it and then died with the
      // terminal, waiting would leave the operator with no TUI at all.
      if (claimHeldByLiveTerminal(stateDir)) claimed = true
      else staleClaim = true
      break
    }
    if (Date.now() >= claimDeadline) break
    await sleep(POLL_MS)
  }
  if (claimed) {
    record(`step 5/${total}: skipped; the terminal claimed the restart and relaunches the TUI here`)
    record('restart complete (exit 0)')
    return 0
  }
  if (pre.tmux !== true) {
    // No terminal claimed and the fallback binary is missing: there is no way to bring the TUI back.
    record('FAIL: tmux is not on PATH; the fallback TUI was not started')
    record('restart failed (exit 1)')
    return 1
  }
  try {
    markFallback(stateDir, { pid: process.pid, at: new Date().toISOString(), tmux: TMUX_SESSION })
  } catch {
    // The tmux launch is what matters; without the file a still-open narrator learns the outcome from the
    // log line below instead.
  }
  record(
    staleClaim
      ? 'note: the terminal that claimed the restart is gone; taking the tmux fallback'
      : `note: no terminal claim within ${claimMs}ms; taking the tmux fallback`,
  )

  // The TUI is dead by now, and preflight already chose the target: the invoking session when it was passed,
  // otherwise `~/.dsh-tui/resume.txt`. If that target is unusable, log one note and start a fresh session.
  // When the lease is still held (or the marker says the wait already failed), a resume would race the old
  // holder and land in the safe-mode prompt, so the fallback starts fresh and says so instead.
  const resume = pre.resume
  if (!resume.ok) {
    record(
      `note: cannot resume the previous SPV session (${resumeDetail(resume)}); the tmux fallback starts a ` +
        'fresh SPV session',
    )
  }
  let blockedPid = leaseBlockedPid
  if (blockedPid === undefined && pre.sessionDir !== undefined) {
    blockedPid = leaseBlockedBy(
      sessionHolders({ sessionDir: pre.sessionDir, procRoot: pre.procRoot }),
      process.pid,
    )
    if (blockedPid !== undefined) {
      record(occupiedSessionNotice({ sessionId: pre.sessionId, pid: blockedPid }))
    }
  }
  const launch = resume.ok && blockedPid === undefined ? [...pre.launch, '--resume', resume.id] : pre.launch
  if (resume.ok && blockedPid !== undefined) {
    record('note: the tmux fallback starts without --resume')
  }
  // The fallback launch is an absolute node + CLI argv (pre.launch), so it does not depend on the tmux
  // server's PATH.
  const hasSession = runArgv(['tmux', 'has-session', '-t', `=${TMUX_SESSION}`], {
    env: stepEnv,
    cwd: pre.cwd,
    timeout: 30_000,
  })
  const relaunch = hasSession.status === 0
    ? ['tmux', 'new-window', '-t', `=${TMUX_SESSION}:`, '-n', 'spv', '-c', pre.cwd, ...launch]
    : ['tmux', 'new-session', '-d', '-s', TMUX_SESSION, '-n', 'spv', '-c', pre.cwd, ...launch]
  const tui = runArgv(relaunch, { env: stepEnv, cwd: pre.cwd, timeout: 30_000 })
  record(`step 5/${total}: ${tui.command} -> exit ${exitText(tui)}`)
  let tuiFailed = exitCodeOf(tui) !== 0
  if (tuiFailed) {
    record(`FAIL: could not relaunch the TUI in tmux session ${TMUX_SESSION}; start it by hand with "wheelchair-agent spv"`)
  } else {
    // `tmux new-session -d` exits 0 even when the command in the pane dies immediately, so verify the
    // session really exists instead of trusting the exit code.
    const deadline = Date.now() + 2000
    let present = false
    while (Date.now() < deadline) {
      const check = runArgv(['tmux', 'has-session', '-t', `=${TMUX_SESSION}`], {
        env: stepEnv,
        cwd: pre.cwd,
        timeout: 30_000,
      })
      if (check.status === 0) {
        present = true
        break
      }
      await sleep(POLL_MS)
    }
    if (present) {
      record(`note: tmux session ${TMUX_SESSION} is present after the relaunch`)
    } else {
      tuiFailed = true
      record(`FAIL: tmux session ${TMUX_SESSION} is not present 2s after the relaunch; the TUI did not come back`)
    }
  }

  const code = tuiFailed ? 1 : 0
  if (code === 0) record('restart complete (exit 0)')
  else record(`restart failed (exit ${code}); the log above says which step failed`)
  return code
}

/**
 * The `--run` orchestrator: wait until the arming process is gone, then perform the restart.
 *
 * `detached: true` gave this process its own process group, so the session's SIGTERM does not reach it; the
 * wait is for the parent link to break (a child started from the session is reparented when it exits), after
 * which the ancestor check in `preflight` is meaningful.
 */
export async function runOrchestrator(context, options = {}) {
  const env = context.env ?? process.env
  const parentPid = Number.parseInt(String(env.WHEELCHAIR_RESTART_PARENT_PID ?? ''), 10)
  if (Number.isInteger(parentPid) && parentPid > 0) {
    const timeoutMs = envMs(env, 'WHEELCHAIR_RESTART_PARENT_MS', DEFAULT_PARENT_MS)
    const reparented = await waitForReparent(parentPid, timeoutMs)
    if (!reparented) {
      const stateDir = context.stateDir || resolveStateDir({ env })
      const logFile = context.logFile || resolveRestartLog({ env, home: context.home, stateDir })
      // Keep the marker: the still-open terminal narrates the FAIL line below and exits non-zero, which is
      // more useful than silently returning to a shell.
      const lines = [
        `FAIL: the arming process ${parentPid} is still alive after ${timeoutMs}ms; nothing was stopped.`,
        'fix: rerun /restart-wheelchair-agent, or run "wheelchair-agent restart-all --dry-run" to inspect the plan.',
      ]
      try {
        appendLog(logFile, lines)
      } catch {
        // The operator will see the printed line even if the log cannot be written.
      }
      process.stdout.write(`${lines.join('\n')}\n`)
      return 1
    }
  }
  // The marker was written before the spawn; now that this process owns the run, make its pid authoritative
  // so the narrator's death check watches the orchestrator, not the short-lived arming process.
  try {
    const stateDir = context.stateDir || resolveStateDir({ env })
    const marker = readArmed(stateDir)
    if (marker !== undefined) writeArmed(stateDir, { ...marker, pid: process.pid })
  } catch {
    // Best effort: the completion line is still the primary signal.
  }
  if (options.all) return runAllRestart(context, options)
  return orchestrate(context, options, 'detached')
}

/**
 * Arm the detached orchestrator and return immediately.
 *
 * This process is inside the session it must replace, so it cannot do the work itself. It preflights,
 * writes the arming lines to the log, spawns `restart-all --run` in its own process group and exits. The
 * operator sees the session and the log path; the session then ends, and the child does the steps.
 */
export async function armDetached(context, options = {}) {
  const env = context.env ?? process.env
  const pre = await preflight(context, options, { detached: true })
  if (!pre.ok) {
    process.stdout.write(`${pre.lines.join('\n')}\n`)
    return pre.code
  }

  const stateDir = context.stateDir || resolveStateDir({ env })
  const logFile = context.logFile || resolveRestartLog({ env, home: context.home, stateDir })
  const startLine =
    `restart-all: pid ${process.pid}, mode detach, force=${options.force ? 'yes' : 'no'}, ` +
    `install=${options.noInstall ? 'skipped (--no-install)' : 'yes'}, ` +
    `chain ${pre.targets.join(' ') || '(none)'}, service ${pre.servicePids.join(' ') || '(none)'}`
  try {
    appendLog(logFile, [...pre.lines, startLine])
  } catch (error) {
    process.stdout.write(`FAIL: cannot write the restart log ${logFile}: ${error.message}\n`)
    process.stdout.write('fix: make the state directory writable, then rerun; nothing was stopped.\n')
    return 1
  }

  // The arming line is written before the marker's offset is measured, so the narrator starts *after* it and
  // the operator never sees this internal line. Reworded around the normal path, because tmux is the fallback.
  try {
    appendLog(logFile, [
      'restart-all: arming a detached orchestrator; the "wheelchair-agent spv" terminal claims and narrates ' +
        `the restart in place, tmux session ${TMUX_SESSION} is the fallback, state dir ${stateDir}`,
    ])
  } catch (error) {
    process.stdout.write(`note: cannot append the arming line to ${logFile}: ${error.message}\n`)
  }

  // The marker is what turns the TUI's exit into a narrated restart: the terminal that launched
  // `wheelchair-agent spv` reads it, tails the log from `logOffset` and relaunches there. It is written
  // *after* preflight and the arming lines but *before* the spawn; a write failure aborts with nothing
  // stopped, and the child re-asserts its own pid at startup.
  const paths = restartPaths(stateDir)
  let logOffset = 0
  try {
    logOffset = statSync(logFile).size
  } catch {
    // The append above succeeded, so a failing stat is not worth aborting for; start the tail at 0.
  }
  try {
    clearRestartState(stateDir)
    writeArmed(stateDir, {
      pid: null,
      armedPid: process.pid,
      startedAt: new Date().toISOString(),
      log: logFile,
      logOffset,
      checkout: pre.checkout ?? null,
      tmux: TMUX_SESSION,
      service: pre.serviceUrl,
      sessionId: pre.sessionId ?? null,
      sessionDir: pre.sessionDir ?? null,
      leaseBlockedPid: null,
      force: Boolean(options.force),
      noInstall: Boolean(options.noInstall),
    })
  } catch (error) {
    process.stdout.write(`FAIL: cannot write the restart marker ${paths.armed}: ${error.message}\n`)
    process.stdout.write('fix: make the state directory writable, then rerun; nothing was stopped.\n')
    return 1
  }

  const args = [
    'restart-all',
    '--run',
    ...(options.all ? ['--all'] : []),
    ...(options.all && typeof options.project === 'string' && options.project !== ''
      ? ['--project', options.project]
      : []),
    ...(pre.sessionId !== undefined ? ['--session', pre.sessionId] : []),
    ...(options.force ? ['--force'] : []),
    ...(options.noInstall ? ['--no-install'] : []),
  ]
  let spawnError
  let child
  try {
    child = spawn(process.execPath, [context.cliPath, ...args], {
      detached: true,
      stdio: 'ignore',
      cwd: context.cwd ?? process.cwd(),
      env: {
        ...env,
        // Chain only: the patch-carrying pids are the stable re-verification facts. An fd holder seen at
        // arm time may exit before `--run` (exactly the straggler this restart is for), and `--run` rescans
        // the current holders itself; putting them here would only make the re-guard report a stale chain.
        WHEELCHAIR_RESTART_CHAIN: pre.chain.join(' '),
        WHEELCHAIR_RESTART_PARENT_PID: String(process.pid),
        WHEELCHAIR_RESTART_PRESET_PATCH: pre.presetPatch,
        WHEELCHAIR_RESTART_SESSION_DIR: pre.sessionDir ?? '',
      },
    })
  } catch (error) {
    spawnError = error
  }
  if (child !== undefined) {
    child.on('error', error => {
      spawnError = error
    })
    child.unref()
  }
  // Let an immediate spawn failure (ENOENT, EACCES) surface before claiming the run is armed.
  await new Promise(done => setImmediate(done))
  if (spawnError !== undefined) {
    // No child will ever complete this run; clear the marker so the still-open terminal does not narrate
    // a restart that never started.
    clearRestartState(stateDir)
    const failLine = `FAIL: cannot arm the detached orchestrator: ${spawnError.message}`
    try {
      appendLog(logFile, [failLine, 'restart-all: nothing was stopped'])
    } catch {
      // The printed failure below still reaches the operator when the console is still attached.
    }
    process.stdout.write(`${failLine}\n`)
    process.stdout.write('fix: check that node and the CLI path are usable, then rerun.\n')
    return 1
  }
  // The marker knows the orchestrator now; `--run` re-asserts the same pid after the reparent wait.
  try {
    const marker = readArmed(stateDir)
    if (marker !== undefined && child?.pid !== undefined) writeArmed(stateDir, { ...marker, pid: child.pid })
  } catch {
    // Best effort: the narrator then treats the run as pid-less and only the completion line ends it.
  }
  const installStep = options.noInstall ? 'skipped (--no-install)' : `bash ${join(pre.checkout, 'install.sh')}`
  const resume = pre.resume
  // A session started before this narrator existed has no supervising `wheelchair-agent spv`: its first
  // restart necessarily comes back in tmux. The marker is set by the launcher environment of a new CLI.
  const supervised = String(env.WHEELCHAIR_AGENT_SUPERVISED ?? '') === '1'
  const rollout = supervised
    ? []
    : [
      'note: this SPV session has no supervising "wheelchair-agent spv" (it was started before the',
      '      same-terminal narrator existed), so this restart comes back in tmux session "dsh-spv". After',
      '      it finishes, run "wheelchair-agent spv" in a terminal to get the in-place return.',
    ]
  process.stdout.write(
    [
      `${pre.lines.join('\n')}${pre.lines.length > 0 ? '\n' : ''}` +
        'restart-all: armed a detached orchestrator; it will restart the deployment after this session ends.',
      ...rollout,
      `  terminal:     the terminal that ran "wheelchair-agent spv" narrates the restart, brings the TUI ` +
        'back in that same terminal and resumes the same SPV conversation',
      `  resume:       ${
        resume.ok
          ? `--resume ${resume.id} (${resume.source === 'session' ? 'invoking session' : '~/.dsh-tui/resume.txt fallback'})`
          : `unavailable (${resumeDetail(resume)}); the TUI starts a fresh session`
      }`,
      `  session:      ${
        pre.sessionDir === undefined
          ? 'no session directory resolved, so no lease holders were added to the kill set'
          : `${pre.sessionDir} (our holders: ${pre.ours.map(holder => holder.pid).join(' ') || 'none'}; ` +
            `other terminals: ${pre.foreign.map(holder => holder.pid).join(' ') || 'none'})`
      }`,
      `  lease:        waits up to ${pre.leaseMs}ms for the old session to be released; if another ` +
        'terminal still holds it, the relaunch starts without --resume, says so and never kills it',
      `  fallback:     tmux session ${TMUX_SESSION} (only if that terminal is gone; attach with: ` +
        `tmux attach -t =${TMUX_SESSION})`,
      `  log:          ${logFile}`,
      `  service:      ${pre.serviceUrl}`,
      `  spv pids:     ${pre.targets.join(' ') || '(none)'}`,
      `  checkout:     ${pre.checkout ?? '(not resolved)'}`,
      `  plan:         service stop -> close a stale tmux session ${TMUX_SESSION} -> SIGTERM ` +
        `${pre.targets.join(' ')} -> wait for the session lease -> ${installStep} -> service start -> ` +
        'relaunch the TUI in the same terminal',
      'note: this command has not restarted anything itself. The SPV session you are in is about to end;',
      '      leave the terminal that launched "wheelchair-agent spv" open: it prints every step and starts',
      `      the TUI again there. If that terminal is gone, the TUI comes back in tmux session ` +
        `"${TMUX_SESSION}". If neither happens, read the log: ${logFile}`,
    ].join('\n') + '\n',
  )
  return 0
}

/** The default projects root, the same one `bin/wheelchair-agent.mjs` and `prepare.sh` use. */
function projectsRootOf(env) {
  const configured = String(env.SPV_PROJECTS_ROOT ?? '').trim()
  return configured !== '' ? resolve(configured) : join(homedir(), 'bioagentforge')
}

/** The checkout's GitHub origin, normalized, or undefined when it is not a GitHub remote. */
function checkoutRepo(dir, env) {
  const result = runArgv(['git', '-C', dir, 'config', '--get', 'remote.origin.url'], {
    env,
    cwd: dir,
    timeout: 20_000,
  })
  if (exitCodeOf(result) !== 0) return undefined
  return githubRemote(String(result.stdout ?? '').trim())
}

/**
 * The deployment whose checkout installs once during `restart-all --all`.
 *
 * The checkout the command runs from decides: a normalized GitHub origin that maps to one registered
 * project wins, then the registered checkout path itself. If neither identifies exactly one deployment the
 * caller must pass `--project`; `--all` never runs install.sh without one.
 */
export function resolveAllInstallProject(context, entries, env = context.env ?? process.env) {
  const checkout = resolveCheckout({
    env,
    root: context.root,
    presetDir: context.presetDir,
    cwd: context.cwd,
    installed: context.installed,
  })
  if (context.allProject !== undefined && context.allProject !== '') {
    return { project: context.allProject, checkout: checkout ?? null }
  }
  if (checkout === undefined) return { project: null, checkout: null }
  const here = realPath(checkout)
  const repo = checkoutRepo(checkout, env)
  if (repo !== undefined) {
    const project = projectForRepo(repo, { projectsRoot: projectsRootOf(env), deployments: entries })
    if (project !== null && project !== undefined && entries.some(entry => entry.project === project)) {
      return { project, checkout }
    }
  }
  let match
  for (const entry of entries) {
    if (realPath(join(projectsRootOf(env), entry.project)) === here) match = entry.project
  }
  return { project: match ?? null, checkout }
}

/** The dry-run plan for `restart-all --all`: every registered deployment, one install, no side effects. */
export function allPlanLines({ entries, installProject, checkout, logFile, pre, noInstall = false }) {
  const servicePids = (pre?.servicePids ?? []).map(pidOf).filter(pid => Number.isInteger(pid) && pid > 0)
  const chainPids = (pre?.targets ?? []).map(pidOf).filter(pid => Number.isInteger(pid) && pid > 0)
  const resume = pre?.resume
  const session = pre?.session
  const lines = ['restart-all --all plan (dry run; nothing is changed)']
  lines.push(`  deployments: ${entries.map(entry => entry.project).join(', ')}`)
  lines.push(
    `  service:   ${pre?.serviceUrl ?? DEFAULT_URL}${
      servicePids.length > 0 ? ` (pid ${servicePids.join(', ')})` : ' (no process found)'
    }`,
  )
  const load = pre?.load
  lines.push(
    `  load:      ${load?.running ?? 0} running, ${load?.queued ?? 0} queued` +
      (load && load.reachable === false
        ? ' (service unreachable)'
        : load && load.readable === false
          ? ' (load unreadable; the amount of work is unknown)'
          : ''),
  )
  lines.push(`  spv pids:  ${chainPids.length > 0 ? chainPids.join(' ') : '(none identified)'}`)
  lines.push(
    `  session:   ${
      session?.id !== undefined
        ? `${session.id} (${session.dir ?? '(dir not found)'})`
        : resume?.ok
          ? `(directory not found for ${resume.id})`
          : '(not resolved; the TUI starts fresh)'
    }`,
  )
  lines.push(`  checkout:  ${checkout ?? '(not resolved)'}`)
  const holderPids = (pre?.holders ?? []).map(pidOf).filter(pid => Number.isInteger(pid) && pid > 0)
  const foreignPids = (pre?.foreign ?? []).map(pidOf).filter(pid => Number.isInteger(pid) && pid > 0)
  lines.push(`  holders:   ${holderPids.length > 0 ? holderPids.join(' ') : '(none)'}`)
  if (foreignPids.length > 0) lines.push(`  other:     ${foreignPids.join(' ')} (another terminal; not signalled)`)
  lines.push(
    `  install:   ${
      noInstall || installProject === '(skipped)'
        ? 'skipped (--no-install); every deployment is stopped and started back'
        : 'once, from this checkout; every deployment is stopped before it and started after it'
    }`,
  )
  lines.push(`  log:       ${logFile ?? '(not resolved)'}`)
  lines.push(`  tmux:      ${TMUX_SESSION}`)
  lines.push('steps:')
  for (const entry of entries) lines.push(`  1. stop:  wheelchair-agent service stop --project ${entry.project}`)
  lines.push(
    `  2. close a stale tmux session ${TMUX_SESSION} when present; SIGTERM ` +
      `${chainPids.length > 0 ? chainPids.join(' ') : '(none)'}; wait for the pids to exit, SIGKILL survivors, ` +
      'then wait for the session lease',
  )
  lines.push(
    noInstall || installProject === '(skipped)'
      ? '  3. skipped (--no-install)'
      : `  3. bash ${join(checkout ?? '<checkout>', 'install.sh')} --project ${installProject}`,
  )
  for (const entry of entries) lines.push(`  4. start: wheelchair-agent service start --project ${entry.project}`)
  const launch = pre?.launch ?? ['wheelchair-agent', 'spv']
  const launchArgv = resume?.ok ? [...launch, '--resume', resume.id] : launch
  lines.push(
    `  5. wait for the "wheelchair-agent spv" terminal to claim the relaunch; if it does not, relaunch the TUI ` +
      `in tmux session ${TMUX_SESSION} (tmux new-session -d -s ${TMUX_SESSION}) with ${display(launchArgv)}`,
  )
  const resumeSource = resume?.source === 'session'
    ? 'invoking session'
    : resume?.source === 'armed'
      ? 'armed marker'
      : '~/.dsh-tui/resume.txt fallback'
  lines.push(
    resume?.ok
      ? `  resume:    --resume ${resume.id} (${resumeSource})`
      : '  resume:    --resume unavailable (no ~/.dsh-tui/resume.txt); the fallback starts a fresh session',
  )
  return lines
}

/** Fail before anything is stopped when `--all` cannot name the deployment whose checkout installs. */
function allInstallFailure(entries, checkout, registryFile) {
  const lines = []
  if (checkout === undefined || checkout === null) {
    lines.push('FAIL: cannot find the wheelchair-agent checkout that holds install.sh; nothing was stopped.')
    lines.push(
      'fix: run restart-all from the checkout, set WHEELCHAIR_AGENT_CHECKOUT, or pass --project <p> to choose ' +
        'the deployment whose checkout installs.',
    )
  } else {
    lines.push(
      `FAIL: cannot tell which deployment this checkout installs: ${checkout} does not uniquely match a ` +
        'registered deployment, and restart-all --all never runs install.sh without a project.',
    )
    lines.push(
      'fix: pass --project <p> to choose the deployment whose checkout installs, or run the command from that ' +
        `deployment's checkout. Registered deployments: ${entries.map(entry => entry.project).join(', ')}.`,
    )
    if (registryFile !== undefined) lines.push(`registry: ${registryFile}`)
  }
  return lines
}

/**
 * `restart-all --all`: one machine-wide round — stop every registered instance, stop the SPV session and
 * wait for its lease, install once (with the deployment whose checkout installs), start every instance,
 * then resume the TUI. It never falls back to the deleted single-deployment install/start commands.
 */
export async function runAllRestart(context, options = {}) {
  const env = context.env ?? process.env
  const stateDir = context.stateDir || resolveStateDir({ env })
  const logFile = context.logFile || resolveRestartLog({ env, home: context.home, stateDir })
  const stepEnv = childEnvironment(env)
  const registry = listDeployments({ env, home: context.home, stateDir })
  const entries = registry.deployments
  if (!registry.exists) {
    process.stdout.write(`${missingRegistryError(registry.file).message}\n`)
    return 1
  }
  if (entries.length === 0) {
    process.stdout.write(
      `FAIL: no deployment is registered in ${registry.file}; --all has nothing to restart. ` +
        'Run "wheelchair-agent deployment migrate" (or "deployment add <project>") first.\n',
    )
    return 1
  }
  if (options.project !== undefined && !entries.some(entry => entry.project === options.project)) {
    process.stdout.write(`${missingDeploymentError(options.project, registry.file, true).message}\n`)
    return 1
  }
  const picked = options.noInstall
    ? { project: options.project ?? '(skipped)', checkout: null }
    : resolveAllInstallProject({ ...context, allProject: options.project }, entries, env)
  const installProject = picked.project
  if (
    !options.noInstall &&
    (installProject === null || picked.checkout === null || !entries.some(entry => entry.project === installProject))
  ) {
    process.stdout.write(`${allInstallFailure(entries, picked.checkout, registry.file).join('\n')}\n`)
    return 1
  }

  const pre = await preflight({ ...context, stateDir }, { ...options, noInstall: true }, { detached: false })
  if (!pre.ok) {
    if (!options.dryRun) {
      try {
        appendLog(logFile, [...pre.lines, `restart-all --all: preflight failed, nothing was stopped (exit ${pre.code})`])
      } catch {
        // The printed lines are the primary diagnosis.
      }
    }
    process.stdout.write(`${pre.lines.join('\n')}\n`)
    return pre.code
  }

  if (options.dryRun) {
    const lines = allPlanLines({
      entries,
      installProject,
      checkout: picked.checkout,
      logFile:
        context.logFile || dataPaths({ env, home: context.home, stateDir }).restartLog.current,
      pre,
      noInstall: options.noInstall === true,
    })
    process.stdout.write(`${pre.lines.join('\n')}\n${lines.join('\n')}\n`)
    return 0
  }

  const startLine =
    `restart-all --all: pid ${process.pid}, mode ${options.run ? 'detached' : 'foreground'}, ` +
    `force=${options.force ? 'yes' : 'no'}, install=${options.noInstall ? 'skipped (--no-install)' : 'yes'}, ` +
    `projects ${entries.map(entry => entry.project).join(' ')}, chain ${pre.targets.join(' ') || '(none)'}, ` +
    `service ${pre.servicePids.join(' ') || '(none)'}`
  try {
    appendLog(logFile, [...pre.lines, startLine])
  } catch (error) {
    process.stdout.write(`FAIL: cannot write the restart log ${logFile}: ${error.message}\n`)
    process.stdout.write('fix: make the state directory writable, then rerun; nothing was stopped.\n')
    return 1
  }
  for (const line of pre.lines) process.stdout.write(`${line}\n`)
  const record = line => {
    process.stdout.write(`${line}\n`)
    try {
      appendLog(logFile, [line])
    } catch (error) {
      process.stdout.write(`FAIL: cannot append to the restart log ${logFile}: ${error.message}\n`)
    }
  }

  const total = 5

  // 1. Stop every registered instance. A partial stop is recoverable: the remaining instances are still
  // running and the session/install steps are not started.
  for (const entry of entries) {
    const stop = runArgv([...pre.agent, 'service', 'stop', '--project', entry.project], {
      env: stepEnv,
      cwd: pre.cwd,
      timeout: 330_000,
    })
    record(`step 1/${total}: ${stop.command} -> exit ${exitText(stop)}`)
    if (exitCodeOf(stop) !== 0) {
      record(
        `restart-all --all aborted: ${entry.project} did not stop; the SPV session and the install were left ` +
          'alone (exit 1)',
      )
      return 1
    }
  }

  // 2. Close the stale tmux fallback, stop the exact `/proc`-identified SPV chain and wait for its lease.
  closeStaleTmux({ pre, env, stepEnv, record })
  const targets = pre.targets
  const term = signalPids(targets, 'SIGTERM')
  if (term.errors.length > 0) record(`note: SIGTERM errors: ${term.errors.join('; ')}`)
  let survivors = await waitGone(targets, pre.termMs)
  record(`step 2/${total}: SIGTERM ${targets.join(' ')} -> sent ${term.sent.length}, survivors ${survivors.length}`)
  if (survivors.length > 0) {
    const kill = signalPids(survivors, 'SIGKILL')
    if (kill.errors.length > 0) record(`note: SIGKILL errors: ${kill.errors.join('; ')}`)
    survivors = await waitGone(survivors, pre.killMs)
    record(`step 2/${total}: SIGKILL ${targets.join(' ')} -> sent ${kill.sent.length}, survivors ${survivors.length}`)
  }
  if (survivors.length > 0) {
    record(
      `FAIL: pids ${survivors.join(' ')} survived SIGKILL; install.sh would refuse, so it was not run. ` +
        'Every deployment is left stopped (exit 1)',
    )
    return 1
  }
  let leaseBlockedPid
  if (pre.sessionDir !== undefined) {
    const lease = await waitForLeaseFree({
      sessionDir: pre.sessionDir,
      procRoot: pre.procRoot,
      timeoutMs: pre.leaseMs,
      selfPid: process.pid,
      say: line => record(line),
    })
    if (!lease.ok) {
      leaseBlockedPid = lease.holder?.pid
      if (leaseBlockedPid !== undefined) {
        record(occupiedSessionNotice({ sessionId: pre.sessionId, pid: leaseBlockedPid }))
        try {
          const marker = readArmed(stateDir)
          if (marker !== undefined) writeArmed(stateDir, { ...marker, leaseBlockedPid })
        } catch {
          // The launch below already drops --resume; the marker is only the other process's hint.
        }
      }
    }
  }

  // 3. Install once, naming the deployment whose checkout installs. There is no bare install.sh anymore.
  if (options.noInstall) {
    record(`step 3/${total}: install.sh skipped (--no-install)`)
  } else {
    const install = runArgv(['bash', join(picked.checkout, 'install.sh'), '--project', installProject], {
      env: stepEnv,
      cwd: picked.checkout,
      timeout: 600_000,
    })
    record(`step 3/${total}: ${install.command} -> exit ${exitText(install)}`)
    if (exitCodeOf(install) !== 0) {
      const detail = `${install.stdout ?? ''}${install.stderr ?? ''}`
        .split('\n')
        .filter(line => line.trim() !== '')
        .slice(-20)
      for (const line of detail) record(`install output: ${line}`)
      if (install.error === undefined && install.status === 3) {
        record('install.sh refused with exit 3 because a holder is still alive; nothing was installed; every deployment stays stopped')
      }
      record('install failed; every deployment is left stopped; not starting any of them back (exit 1)')
      record(
        `fix: recover by hand: bash ${join(picked.checkout, 'install.sh')} --project ${installProject} && ` +
          `wheelchair-agent service start --project ${installProject}`,
      )
      record('     every deployment was stopped: also run "wheelchair-agent service start --all" for the rest.')
      return 1
    }
  }

  // 4. Start every registered instance back; a failure ends the restart and says which one failed.
  for (const entry of entries) {
    const start = runArgv([...pre.agent, 'service', 'start', '--project', entry.project], {
      env: stepEnv,
      cwd: pre.cwd,
      timeout: 180_000,
    })
    record(`step 4/${total}: ${start.command} -> exit ${exitText(start)}`)
    if (exitCodeOf(start) !== 0) {
      record(
        `FAIL: the superagent service did not start for ${entry.project}; the TUI was not relaunched. Run ` +
          `"wheelchair-agent service start --project ${entry.project}" (and --all only after every start works).`,
      )
      record('restart failed (exit 1)')
      return 1
    }
  }

  // 5. The terminal that launched `wheelchair-agent spv` claims and narrates; tmux is the fallback.
  const claimMs = envMs(env, 'WHEELCHAIR_RESTART_CLAIM_MS', DEFAULT_CLAIM_MS)
  const claimDeadline = Date.now() + claimMs
  let claimed = false
  let staleClaim = false
  for (;;) {
    if (claimExists(stateDir)) {
      if (claimHeldByLiveTerminal(stateDir)) claimed = true
      else staleClaim = true
      break
    }
    if (Date.now() >= claimDeadline) break
    await sleep(POLL_MS)
  }
  if (claimed) {
    record(`step 5/${total}: skipped; the terminal claimed the restart and relaunches the TUI here`)
    record('restart complete (exit 0)')
    return 0
  }
  if (pre.tmux !== true) {
    record('FAIL: tmux is not on PATH; the fallback TUI was not started')
    record('restart failed (exit 1)')
    return 1
  }
  try {
    markFallback(stateDir, { pid: process.pid, at: new Date().toISOString(), tmux: TMUX_SESSION })
  } catch {
    // The tmux launch is what matters.
  }
  record(
    staleClaim
      ? 'note: the terminal that claimed the restart is gone; taking the tmux fallback'
      : `note: no terminal claim within ${claimMs}ms; taking the tmux fallback`,
  )
  const resume = pre.resume
  if (!resume.ok) {
    record(
      `note: cannot resume the previous SPV session (${resumeDetail(resume)}); the tmux fallback starts a ` +
        'fresh SPV session',
    )
  }
  let blockedPid = leaseBlockedPid
  if (blockedPid === undefined && pre.sessionDir !== undefined) {
    blockedPid = leaseBlockedBy(
      sessionHolders({ sessionDir: pre.sessionDir, procRoot: pre.procRoot }),
      process.pid,
    )
    if (blockedPid !== undefined) {
      record(occupiedSessionNotice({ sessionId: pre.sessionId, pid: blockedPid }))
    }
  }
  const launch = resume.ok && blockedPid === undefined ? [...pre.launch, '--resume', resume.id] : pre.launch
  if (resume.ok && blockedPid !== undefined) record('note: the tmux fallback starts without --resume')
  const hasSession = runArgv(['tmux', 'has-session', '-t', `=${TMUX_SESSION}`], {
    env: stepEnv,
    cwd: pre.cwd,
    timeout: 30_000,
  })
  const relaunch = hasSession.status === 0
    ? ['tmux', 'new-window', '-t', `=${TMUX_SESSION}:`, '-n', 'spv', '-c', pre.cwd, ...launch]
    : ['tmux', 'new-session', '-d', '-s', TMUX_SESSION, '-n', 'spv', '-c', pre.cwd, ...launch]
  const tui = runArgv(relaunch, { env: stepEnv, cwd: pre.cwd, timeout: 30_000 })
  record(`step 5/${total}: ${tui.command} -> exit ${exitText(tui)}`)
  let tuiFailed = exitCodeOf(tui) !== 0
  if (tuiFailed) {
    record(`FAIL: could not relaunch the TUI in tmux session ${TMUX_SESSION}; start it by hand with "wheelchair-agent spv"`)
  } else {
    const deadline = Date.now() + 2000
    let present = false
    while (Date.now() < deadline) {
      const check = runArgv(['tmux', 'has-session', '-t', `=${TMUX_SESSION}`], {
        env: stepEnv,
        cwd: pre.cwd,
        timeout: 30_000,
      })
      if (check.status === 0) {
        present = true
        break
      }
      await sleep(POLL_MS)
    }
    if (present) record(`note: tmux session ${TMUX_SESSION} is present after the relaunch`)
    if (!present) {
      tuiFailed = true
      record(`FAIL: tmux session ${TMUX_SESSION} is not present 2s after the relaunch; the TUI did not come back`)
    }
  }
  const code = tuiFailed ? 1 : 0
  if (code === 0) record('restart complete (exit 0)')
  else record(`restart failed (exit ${code}); the log above says which step failed`)
  return code
}

/**
 * Entry point used by `bin/wheelchair-agent.mjs`.
 *
 * `--dry-run` prints the plan and writes nothing, even when combined with `--detach`. Otherwise `--run`
 * executes the steps, `--detach` arms the child, and the default runs the steps in this process.
 */
export async function runRestart(context, options = {}) {
  if (options.all) {
    if (options.run && !options.dryRun) return runOrchestrator(context, options)
    if (options.dryRun || !options.detach) return runAllRestart(context, options)
    return armDetached(context, options)
  }
  if (options.dryRun) {
    const pre = await preflight(context, options, { detached: Boolean(options.detach) })
    const lines = [...pre.lines]
    if (pre.ok) {
      lines.push(
        ...planLines({
          service: planService(pre),
          chain: pre.targets,
          checkout: pre.checkout,
          stateDir: context.stateDir || resolveStateDir({ env: context.env ?? process.env }),
          // A dry run promises to change nothing, so it displays the configured log path without
          // triggering the one-shot migration that resolving the log normally performs.
          logFile: context.logFile ||
            dataPaths({
              env: context.env ?? process.env,
              home: context.home,
              stateDir: context.stateDir || resolveStateDir({ env: context.env ?? process.env }),
            }).restartLog.current,
          tmuxSession: TMUX_SESSION,
          noInstall: Boolean(options.noInstall),
          resume: pre.resume,
          sessionId: pre.sessionId,
          sessionDir: pre.sessionDir,
          holders: pre.ours,
          foreign: pre.foreign,
          leaseMs: pre.leaseMs,
        }),
      )
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    return pre.ok ? 0 : pre.code
  }
  if (options.run) return runOrchestrator(context, options)
  if (options.detach) return armDetached(context, options)
  return orchestrate(context, options, 'foreground')
}
