/**
 * `restart-all` orchestration: one command that restarts everything this deployment runs.
 *
 * The order is not a preference, it is what the cold-install guard accepts (install.sh, PR #14):
 *
 *   guard -> service stop -> stop the SPV chain (SIGTERM, wait, SIGKILL) -> install.sh
 *         -> service start -> relaunch the TUI in tmux
 *
 * install.sh refuses with exit 3 while the service or a live SPV session holds the install targets, and a
 * half-installed deployment that still answers is worse than a stopped one. So the service and the session
 * must be gone before the install starts; if the install fails, the service is deliberately left stopped.
 *
 * The command usually runs *inside* the SPV session it has to replace, so the slash command arms a detached
 * `--run` child (`armDetached`); that child survives the session's death and performs the steps. This module
 * is pure Node builtins and never calls `process.exit`, so the CLI can test it with fake `/proc` entries and
 * fake executables on PATH.
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

/** Log file name; one `[ISO] text` line per entry. */
export const LOG_NAME = RESTART_LOG_FILE
/** tmux session the detached orchestrator comes back in; the operator's console is gone by then. */
export const TMUX_SESSION = 'dsh-spv'
/** Default management API base URL, the same one superagent itself uses. */
export const DEFAULT_URL = 'http://127.0.0.1:3082'

/** The health/load endpoint; the load field is what the guard reads. */
const STATE_PATH = '/orchestrator/api/state'

/* Timeouts, overridable through the test seams documented at the bottom of this file. */
const DEFAULT_TERM_MS = 10_000
const DEFAULT_KILL_MS = 5_000
const DEFAULT_PARENT_MS = 5_000
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
 * The pids the orchestrator may signal: the chain minus itself, its ancestors and the service.
 *
 * Safety is a set subtraction, not a filter on process names: the only evidence that a pid belongs to the
 * live SPV session is the `--patch` match that produced `chain`, and the service is never ours to stop.
 */
export function killTargets({ chain = [], selfPid, ancestors = [], servicePids = [] } = {}) {
  const excluded = new Set([
    Number(selfPid),
    ...ancestors.map(Number),
    ...servicePids.map(Number),
  ])
  const seen = new Set()
  const targets = []
  for (const value of chain) {
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
} = {}) {
  const pids = chain.map(pidOf).filter(pid => Number.isInteger(pid) && pid > 0)
  const servicePids = (service.pids ?? []).map(pidOf).filter(pid => Number.isInteger(pid) && pid > 0)
  const agent = service.agent ?? ['wheelchair-agent']
  const launch = service.launch ?? [...agent, 'spv']
  const cwd = service.cwd ?? process.cwd()
  const termMs = service.termMs ?? DEFAULT_TERM_MS
  const killMs = service.killMs ?? DEFAULT_KILL_MS
  const installCommand = install ?? (checkout ? `bash ${join(checkout, 'install.sh')}` : 'bash <checkout>/install.sh')
  const lines = ['restart-all plan (dry run; nothing is changed)']
  lines.push(`  service:   ${service.url ?? DEFAULT_URL}${servicePids.length > 0 ? ` (pid ${servicePids.join(', ')})` : ' (no process found)'}`)
  const slots = service.maxWorkers === undefined ? '' : `, ${service.maxWorkers} slots`
  lines.push(`  load:      ${service.running ?? 0} running, ${service.queued ?? 0} queued${slots}${service.reachable === false ? ' (service unreachable)' : service.readable === false ? ' (load unreadable; the amount of work is unknown)' : ''}`)
  lines.push(`  spv pids:  ${pids.length > 0 ? pids.join(' ') : '(none identified)'}`)
  lines.push(`  checkout:  ${checkout ?? '(not resolved)'}`)
  lines.push(`  state dir: ${stateDir ?? resolveStateDir()}`)
  lines.push(`  log:       ${logFile ?? dataPaths({ stateDir }).restartLog.current}`)
  lines.push(`  tmux:      ${tmuxSession}`)
  lines.push('steps:')
  lines.push(`  1. ${display([...agent, 'service', 'stop'])}`)
  lines.push(
    `  2. SIGTERM ${pids.length > 0 ? pids.join(' ') : '(none)'}; wait up to ${termMs}ms for them to exit; ` +
      `SIGKILL survivors; wait up to ${killMs}ms`,
  )
  lines.push(`  3. ${noInstall ? 'skipped (--no-install)' : installCommand}`)
  lines.push(`  4. ${display([...agent, 'service', 'start'])}`)
  lines.push(`  5. relaunch the TUI in tmux session ${tmuxSession} (cwd ${cwd}):`)
  lines.push(`       tmux has-session -t =${tmuxSession}`)
  lines.push(`       tmux new-window -t =${tmuxSession}: -n spv -c ${cwd} ${display(launch)}`)
  lines.push(`       tmux new-session -d -s ${tmuxSession} -n spv -c ${cwd} ${display(launch)}`)
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
  const presetPatch = String(env.WHEELCHAIR_RESTART_PRESET_PATCH ?? '').trim() || context.presetPatch
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
  const chainOverride = String(env.WHEELCHAIR_RESTART_CHAIN ?? '').trim()
  const chainOverridePids = chainOverride
    ? [...new Set(chainOverride.split(/\s+/).map(Number).filter(pid => Number.isInteger(pid) && pid > 0))]
    : undefined
  if (chainOverridePids !== undefined) {
    // Pid reuse or a stale environment must not turn into signalling an unrelated process: the armed chain
    // is only trustworthy if every pid still carries the same `--patch` right now.
    for (const pid of chainOverridePids) {
      const argv = cmdlineOf(procRoot, pid)
      if (!presetPatchUsed(argv, presetPatch)) {
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

  if (chain.length === 0) {
    lines.push(
      `FAIL: cannot identify the live SPV session: no process carries --patch ${presetPatch ?? '(no preset patch)'}.`,
    )
    lines.push(
      'fix: start the SPV session with "wheelchair-agent spv" (or pass the patch the session actually uses), ' +
        'then rerun; nothing was stopped.',
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

  if (which('tmux', env) === undefined) {
    lines.push('FAIL: tmux is not on PATH, so the SPV TUI cannot be relaunched after the restart.')
    lines.push('fix: install tmux (apt install tmux), then rerun; nothing was stopped.')
    return preflightFailure(lines, { serviceUrl, load, presetPatch, checkout })
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

  const targets = killTargets({ chain, selfPid: process.pid, ancestors, servicePids })
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
    load,
    checkout,
    cwd,
    agent,
    launch,
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
  const pre = await preflight(context, options, { detached: false })
  if (!pre.ok) {
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
  const stop = runArgv([...pre.agent, 'service', 'stop'], { env, cwd: pre.cwd, timeout: 330_000 })
  record(`step 1/${total}: ${stop.command} -> exit ${exitText(stop)}`)
  if (exitCodeOf(stop) !== 0) {
    record('restart aborted: the superagent service did not stop; the SPV session was left alone (exit 1)')
    return 1
  }

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

  // 3. Cold install. Abort the whole restart if it fails: do NOT start a half-installed deployment.
  if (options.noInstall) {
    record(`step 3/${total}: install.sh skipped (--no-install)`)
  } else {
    const install = runArgv(['bash', join(pre.checkout, 'install.sh')], {
      env,
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

  // 4. Start the service back. A failure here still relaunches the TUI: its launcher retries the service.
  const start = runArgv([...pre.agent, 'service', 'start'], { env, cwd: pre.cwd, timeout: 180_000 })
  record(`step 4/${total}: ${start.command} -> exit ${exitText(start)}`)
  const startFailed = exitCodeOf(start) !== 0
  if (startFailed) {
    record('FAIL: the superagent service did not start; the TUI relaunch still runs so its launcher can retry')
  }

  // 5. Relaunch the TUI in tmux: the original terminal belongs to the session that was just stopped.
  // The launch is an absolute node + CLI argv (pre.launch), so it does not depend on the tmux server's PATH.
  const hasSession = runArgv(['tmux', 'has-session', '-t', `=${TMUX_SESSION}`], {
    env,
    cwd: pre.cwd,
    timeout: 30_000,
  })
  const relaunch = hasSession.status === 0
    ? ['tmux', 'new-window', '-t', `=${TMUX_SESSION}:`, '-n', 'spv', '-c', pre.cwd, ...pre.launch]
    : ['tmux', 'new-session', '-d', '-s', TMUX_SESSION, '-n', 'spv', '-c', pre.cwd, ...pre.launch]
  const tui = runArgv(relaunch, { env, cwd: pre.cwd, timeout: 30_000 })
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
        env,
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

  const code = startFailed || tuiFailed ? 1 : 0
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

  const args = [
    'restart-all',
    '--run',
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
        WHEELCHAIR_RESTART_CHAIN: pre.targets.join(' '),
        WHEELCHAIR_RESTART_PARENT_PID: String(process.pid),
        WHEELCHAIR_RESTART_PRESET_PATCH: pre.presetPatch,
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
  try {
    appendLog(logFile, [
      `restart-all: arming a detached orchestrator; tmux session ${TMUX_SESSION}, state dir ${stateDir}`,
    ])
  } catch (error) {
    process.stdout.write(`note: cannot append the arming line to ${logFile}: ${error.message}\n`)
  }

  const installStep = options.noInstall ? 'skipped (--no-install)' : `bash ${join(pre.checkout, 'install.sh')}`
  process.stdout.write(
    [
      `${pre.lines.join('\n')}${pre.lines.length > 0 ? '\n' : ''}` +
        'restart-all: armed a detached orchestrator; it will restart the deployment after this session ends.',
      `  tmux session: ${TMUX_SESSION}`,
      `  log:          ${logFile}`,
      `  service:      ${pre.serviceUrl}`,
      `  spv pids:     ${pre.targets.join(' ') || '(none)'}`,
      `  checkout:     ${pre.checkout ?? '(not resolved)'}`,
      `  plan:         service stop -> SIGTERM ${pre.targets.join(' ')} -> ${installStep} -> service start -> ` +
        `tmux ${TMUX_SESSION}`,
      'note: this command has not restarted anything itself. The SPV session you are in is about to end;',
      `      the TUI comes back in tmux session "${TMUX_SESSION}" (attach with: tmux attach -t =${TMUX_SESSION}).`,
    ].join('\n') + '\n',
  )
  return 0
}

/**
 * Entry point used by `bin/wheelchair-agent.mjs`.
 *
 * `--dry-run` prints the plan and writes nothing, even when combined with `--detach`. Otherwise `--run`
 * executes the steps, `--detach` arms the child, and the default runs the steps in this process.
 */
export async function runRestart(context, options = {}) {
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
