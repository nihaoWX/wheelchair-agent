/**
 * Project-scoped restart for one deployment (`wheelchair-agent restart-all --project <p>`).
 *
 * The global `restart-all` (without `--project`) keeps its old behavior: stop every service, cold-install
 * the shared preset, start the service, and let the SPV terminal bring the TUI back. A single deployment is
 * different in three ways:
 *
 *   - only its own `dsh` instance is stopped and started. The instance is identified by the same runtime
 *     facts the service manager uses: `--profile <profile>` plus the instance's `--patch <overlay>` file.
 *     A profile-wide match would stop every deployment, so it is never used here;
 *   - `install.sh` is not run. The preset, webui, CLI and core are installed once for every deployment, so a
 *     per-deployment restart has nothing to install;
 *   - the SPV session it resumes is that deployment's own session: the id passed with `--session` (the
 *     `/restart-wheelchair-agent` command passes the invoking session), else the record this command keeps
 *     under the deployment's stateDir. The global `~/.dsh-tui/resume.txt` belongs to whichever deployment
 *     wrote it last, so reading it here would resume another deployment's conversation; this module never
 *     touches it.
 *
 * Artifacts, registry and session paths all resolve from the environment, so tests use temp dirs and never
 * signal a real process.
 */
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { spawn as spawnFn, spawnSync } from 'node:child_process'

import {
  deploymentSlug,
  instancePath,
  listDeployments,
  missingDeploymentError,
} from '../shared/deployments.js'
import { ancestorPids, killTargets, readLoad, resolveRestartLog, servesProfile } from './restart.js'
import { resolveSession, sessionHolders } from './session.js'

/** File under a deployment's stateDir that remembers the last session a project restart resumed. */
export const SESSION_RECORD = 'deployment-session.json'
export const SESSION_RECORD_VERSION = 1

/** The `--patch` values in an argv, in order (supports `--patch <file>` and `--patch=<file>`). */
export function patchesIn(argv = []) {
  const patches = []
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    if (word === '--patch' && index + 1 < argv.length) {
      patches.push(argv[index + 1])
      index += 1
    } else if (word.startsWith('--patch=')) {
      patches.push(word.slice('--patch='.length))
    }
  }
  return patches
}

/** Whether this argv loads any instance overlay at all. */
export function hasPatchArg(argv = []) {
  return patchesIn(argv).length > 0
}

function samePath(left, right) {
  return resolvePath(String(left)) === resolvePath(String(right))
}

/**
 * The pure instance selector: given a `/proc` table, the deployment's profile and its overlay path, return
 * the processes that serve exactly that instance.
 *
 * `patch === null` selects the legacy single service (no `--patch` at all). It is kept pure so tests can
 * prove two instances do not match each other, a legacy service is not mistaken for an instance, and the
 * `dsh plugin` installer (which also carries `--profile`) is excluded, without sending any signal.
 */
export function selectInstanceProcesses(table = [], { profile, patch } = {}) {
  const wanted = patch === null || patch === undefined ? null : patch
  return table.filter(({ argv }) => {
    if (!Array.isArray(argv) || !servesProfile(argv, profile)) return false
    if (wanted === null) return !hasPatchArg(argv)
    return patchesIn(argv).some(value => samePath(value, wanted))
  })
}

/** Absolute path of the session record for one deployment stateDir. */
export function sessionRecordPath(stateDir) {
  return join(stateDir, SESSION_RECORD)
}

/** Read the recorded session, or null when the file is missing, invalid or names no id. */
export function readSessionRecord(stateDir) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(sessionRecordPath(stateDir), 'utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.version !== SESSION_RECORD_VERSION) return null
  if (typeof parsed.sessionId !== 'string' || parsed.sessionId.trim() === '') return null
  return { sessionId: parsed.sessionId.trim(), project: parsed.project }
}

/** Atomically record the session a project restart resumed (temp file + rename, 0644). */
export function writeSessionRecord(stateDir, { project, sessionId }) {
  const file = sessionRecordPath(stateDir)
  mkdirSync(stateDir, { recursive: true })
  const temporary = `${file}.tmp.${process.pid}`
  writeFileSync(temporary, `${JSON.stringify({
    version: SESSION_RECORD_VERSION,
    project,
    sessionId,
    at: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o644 })
  renameSync(temporary, file)
  return file
}

/**
 * Pick the session a project restart brings back.
 *
 * Priority: the `--session` the caller passed, then the record under the deployment's stateDir. There is no
 * third step: `~/.dsh-tui/resume.txt` is global state and would hand this deployment another deployment's
 * conversation, so when neither source names a session the caller prints the reason and leaves the TUI
 * alone. Pure: it never reads resume.txt and never writes anything.
 */
export function resolveProjectSession({ env = process.env, stateDir, session } = {}) {
  const requested = typeof session === 'string' ? session.trim() : ''
  if (requested !== '') {
    const found = resolveSession({ env, cwd: stateDir, id: requested })
    return { id: requested, dir: found?.dir, source: 'command' }
  }
  const record = readSessionRecord(stateDir)
  if (record === null) return null
  const found = resolveSession({ env, cwd: stateDir, id: record.sessionId })
  return { id: record.sessionId, dir: found?.dir, source: 'record' }
}

/** The installed per-deployment log path, matching `wheelchair-agent service --project`. */
function instanceLog(env, slug) {
  const home = String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, '.artifacts', `wca-${slug}.log`)
}

/** Run the python service manager and return its exit code (never throws for a nonzero result). */
function runManager(script, args, env) {
  const result = spawnSync('python3', [script, ...args], { stdio: 'inherit', env })
  if (result.error) throw result.error
  return result.status ?? 1
}

function planLines(entry, session, log, env) {
  const slug = deploymentSlug(entry.project)
  const url = `http://127.0.0.1:${entry.port}`
  return [
    `restart-all --project ${entry.project} plan (dry run; nothing is changed)`,
    `deployment: ${entry.project}  profile ${entry.profile}  port ${entry.port}  instance ${instancePath(entry.project, { env })}`,
    `service stop:  stop profile ${entry.profile} with --patch ${instancePath(entry.project, { env })} (other deployments untouched)`,
    'install:       skipped (the preset, webui, CLI and core are installed once for every deployment)',
    `service start: start profile ${entry.profile} with --patch ${instancePath(entry.project, { env })}`,
    `session:       ${session === null ? 'none recorded; pass --session <id> to bring a TUI back' : `${session.id} (from ${session.source})`}`,
    `log:           ${log}`,
    `url:           ${url}`,
  ]
}

/**
 * Arm a detached `restart-all --run --project` child and return immediately.
 *
 * This is what `/restart-wheelchair-agent` uses: the command executes inside a session the restart is about
 * to affect, so it must not run the stop/start inline. Unlike the global detach, no narrator claim is needed:
 * the child does the whole thing itself, logs to the shared restart log, and opens the deployment's TUI in a
 * per-deployment tmux session when the old terminal is gone. It never runs `install.sh`.
 */
export function armProjectRestart(context, options = {}) {
  const env = context.env ?? process.env
  let registry
  try {
    registry = listDeployments({ env })
  } catch (error) {
    process.stdout.write(`FAIL: ${error.message}\n`)
    return 1
  }
  const entry = registry.deployments.find(item => item.project === options.project)
  if (entry === undefined) {
    const error = missingDeploymentError(options.project, registry.file, registry.exists)
    process.stdout.write(`FAIL: ${error.message}\n`)
    return 1
  }
  if (entry.port === null) {
    process.stdout.write(
      `FAIL: deployment ${JSON.stringify(entry.project)} has no port, so there is no instance to restart: run ` +
        `"wheelchair-agent deployment add ${entry.project} --port <n>", then retry.\n`,
    )
    return 1
  }
  if (!existsSync(instancePath(entry.project, { env }))) {
    process.stdout.write(
      `FAIL: the instance overlay for ${JSON.stringify(entry.project)} is missing at ` +
        `${instancePath(entry.project, { env })}: run "wheelchair-agent deployment add ${entry.project}".\n`,
    )
    return 1
  }
  const logFile = resolveRestartLog({ env, home: context.home, stateDir: context.stateDir })
  const argv = [
    process.argv[1],
    'restart-all',
    '--run',
    '--project', entry.project,
    ...(options.session !== undefined ? ['--session', options.session] : []),
    ...(options.force ? ['--force'] : []),
  ]
  let fd
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    fd = openSync(logFile, 'a', 0o644)
  } catch (error) {
    process.stdout.write(`FAIL: cannot write the restart log ${logFile}: ${error.message}\n`)
    return 1
  }
  try {
    const child = spawnDetached(process.execPath, argv, env, fd)
    process.stdout.write(
      `restart-all --project ${entry.project}: armed pid ${child.pid}; the instance restarts in the background, ` +
        `install is skipped, log ${logFile}\n`,
    )
  } catch (error) {
    process.stdout.write(`FAIL: could not arm the restart: ${error.message}\n`)
    return 1
  }
  return 0
}

/** Fire-and-forget child whose output lands in the restart log. */
function spawnDetached(file, argv, env, fd) {
  const child = spawnFn(file, argv, { detached: true, stdio: ['ignore', fd, fd], env })
  child.unref()
  return child
}

/**
 * Restart the service instance of one deployment, without touching the install.
 *
 * `options.dryRun` prints the plan and stops; nothing is written or signalled. A live TUI that still holds
 * the session lease is left in place (it survives a service restart); when the lease is gone, the TUI is
 * brought back in a deployment-specific tmux session `wca-tui-<slug>` so it cannot be confused with another
 * deployment. The caller passes `--session` from `/restart-wheelchair-agent`; a plain CLI call falls back to
 * the record and otherwise only restarts the service.
 */
export async function runProjectRestart(context, options = {}) {
  const env = context.env ?? process.env
  const out = context.out ?? process.stdout
  const registry = listDeployments({ env })
  const entry = registry.deployments.find(item => item.project === options.project)
  if (entry === undefined) throw missingDeploymentError(options.project, registry.file, registry.exists)
  if (entry.port === null) {
    throw new Error(
      `deployment ${JSON.stringify(entry.project)} has no port, so there is no instance to restart: run ` +
        `"wheelchair-agent deployment add ${entry.project} --port <n>", then retry.`,
    )
  }
  const instance = instancePath(entry.project, { env })
  if (!existsSync(instance)) {
    throw new Error(
      `the instance overlay for ${JSON.stringify(entry.project)} is missing at ${instance}: run ` +
        `"wheelchair-agent deployment add ${entry.project}" to render it from the registry.`,
    )
  }
  const slug = deploymentSlug(entry.project)
  const log = instanceLog(env, slug)
  const session = resolveProjectSession({ env, stateDir: entry.stateDir, session: options.session })
  if (options.dryRun) {
    out.write(`${planLines(entry, session, log, env).join('\n')}\n`)
    return 0
  }

  const url = `http://127.0.0.1:${entry.port}`
  if (!options.force) {
    const load = await readLoad({ url })
    if (load.readable && (load.running > 0 || load.queued > 0)) {
      out.write(
        `FAIL: deployment ${entry.project} reports ${load.running} running and ${load.queued} queued ticket(s)\n` +
          'fix: pass --force to interrupt them, or wait until they finish\n',
      )
      return 1
    }
    if (load.reachable && !load.readable) {
      out.write(
        `FAIL: deployment ${entry.project} answers at ${url} but its load cannot be read\n` +
          'fix: pass --force to restart it anyway\n',
      )
      return 1
    }
  }

  const script = join(context.root, 'commands', 'superagent-service.py')
  const common = [
    '--profile', entry.profile,
    '--patch', instance,
    '--session', `wca-${slug}`,
    '--state-dir', entry.stateDir,
    '--queue-dir', entry.queueDir,
    '--log', log,
    '--url', url,
    '--port', String(entry.port),
  ]
  out.write(`restart-all --project ${entry.project}: stopping its service instance (other deployments stay up)\n`)
  const stopped = runManager(script, ['stop', ...common], env)
  if (stopped !== 0) {
    out.write(`FAIL: could not stop the instance of ${entry.project} (exit ${stopped}); it was not restarted\n`)
    return stopped
  }
  if (session !== null) writeSessionRecord(entry.stateDir, { project: entry.project, sessionId: session.id })
  out.write('install: skipped (installs are global, not per deployment)\n')
  out.write(`restart-all --project ${entry.project}: starting its service instance\n`)
  const started = runManager(script, ['start', ...common], env)
  if (started !== 0) {
    out.write(`FAIL: the instance of ${entry.project} did not start (exit ${started})\n`)
    return started
  }

  if (session === null) {
    out.write(
      `note: no session is recorded for ${entry.project}; the service is back, but no TUI was reopened.\n` +
        `fix: run "wheelchair-agent spv --resume <id>" in that deployment's terminal, or pass --session <id>.\n`,
    )
    return 0
  }
  // A live TUI still holds this session's lease; it cannot be resumed twice, so stop only the holders of
  // *this* session (never the global chain and never this process or its ancestors), then bring it back.
  if (session.dir !== undefined) {
    const holders = sessionHolders({ sessionDir: session.dir })
    const targets = killTargets({
      holders: holders.map(holder => holder.pid),
      selfPid: process.pid,
      ancestors: ancestorPids(process.pid),
    })
    if (targets.length > 0) {
      out.write(`stopping the TUI of ${entry.project} (pid ${targets.join(' ')})\n`)
      terminate(targets)
    }
  }
  const resumed = launchTui({ env, entry, session, context, slug })
  if (resumed === 0) out.write(`OK: ${entry.project} is back; resumed session ${session.id} in tmux session wca-tui-${slug}\n`)
  else out.write(
    `OK: ${entry.project} is back; could not open the TUI automatically (${resumed}).\n` +
      `fix: run "wheelchair-agent spv --resume ${session.id}" in that deployment's terminal.\n`,
  )
  return 0
}

/** SIGTERM a bounded set, wait, then SIGKILL survivors; never signals this process or its ancestors. */
function terminate(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && pids.some(pid => alive(pid))) {
    sleep(100)
  }
  for (const pid of pids) {
    if (!alive(pid)) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Bring the TUI back in a per-deployment tmux session; returns 0 on success, otherwise a short reason. */
function launchTui({ env, entry, session, context, slug }) {
  const sessionName = `wca-tui-${slug}`
  const cli = context.cliPath ?? process.argv[1]
  const result = spawnSync(
    'tmux',
    ['new-session', '-d', '-s', sessionName, '-c', entry.stateDir, cli, 'spv', '--resume', session.id],
    {
      env: { ...env, DSH_SUPERAGENT_STATE_DIR: entry.stateDir },
      encoding: 'utf8',
    },
  )
  if (result.error) return result.error.code ?? result.error.message
  if (result.status !== 0) return `tmux exit ${result.status}`
  return 0
}
