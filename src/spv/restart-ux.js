/**
 * The same-terminal restart UX: the narrator and the `wheelchair-agent spv` loop.
 *
 * Before this module the CLI `exec`ed the launcher, so after the TUI died nothing of ours was left on the
 * operator's terminal. The detached orchestrator could only relaunch the TUI in a tmux session the operator
 * was never shown. Now `spv` runs the launcher as a child with inherited stdio, and when that child exits
 * because `restart-all --detach` armed a restart (`<stateDir>/restart-armed.json`), the CLI narrates the log
 * and starts the launcher again *in the same terminal*.
 *
 * Three files under the state dir coordinate the two processes without a new protocol:
 *
 *   - `restart-armed.json`    written by `armDetached` before the spawn; carries the orchestrator pid, the
 *                             log path and the offset the narrator must start at;
 *   - `restart-claimed.json`  written by the narrating CLI as soon as it sees the marker; tells the
 *                             orchestrator that a terminal owns the relaunch, so it skips its tmux fallback;
 *   - `restart-fallback.json` written by the orchestrator immediately before it launches tmux; a CLI that
 *                             sees it (or the log line "taking the tmux fallback") must not relaunch a second
 *                             TUI.
 *
 * Pure Node builtins and no `process.exit`: the CLI decides the exit code from the values returned here.
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  encodeSegment,
  leaseTimeoutMs,
  occupiedSessionNotice,
  resolveSession,
  resumeIdFromArgv,
  sessionHolders,
  waitForLeaseFree,
} from './session.js'

/** Marker written by `restart-all --detach`; also the file the narrator watches after the TUI exits. */
export const ARMED_FILE = 'restart-armed.json'
/** Claim written by the narrating CLI; the orchestrator waits for it before taking the tmux fallback. */
export const CLAIM_FILE = 'restart-claimed.json'
/** Written by the orchestrator right before it launches the tmux fallback. */
export const FALLBACK_FILE = 'restart-fallback.json'
/** The append-only restart log, one `[ISO] text` line per entry. */
export const LOG_NAME = 'restart-all.log'

/** Default narrator timeout: generous enough for a cold install, finite so it never waits forever. */
const DEFAULT_NARRATE_MS = 600_000
/** Poll interval for the log tail and the marker/claim files. */
const DEFAULT_POLL_MS = 150
/** How long a dead orchestrator pid may stay dead before the narrator calls it a failure. */
const DEFAULT_GRACE_MS = 1000
/** dsh-tui's own resume pointer: the only place a relaunch may take a session id from. */
export const RESUME_FILE = 'resume.txt'
/** A dsh session id is a UUID; anything else in resume.txt is not a usable target. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A resumed TUI that dies this fast did not start; the CLI retries once without `--resume`. */
const RESUME_FAIL_MS = 2500
/** Clock slack when comparing a marker's `startedAt` with the moment the launcher was spawned. */
const FRESH_SLACK_MS = 1000
/** Lines that mean the restart failed, after the ISO prefix has been stripped. */
const FAILURE_PATTERNS = [
  /restart failed \(exit \d+\)/,
  /install failed/,
  /restart aborted/,
  /FAIL: pids .* survived SIGKILL/,
  /preflight failed/,
  /FAIL: refusing to restart/,
  /FAIL: the arming process .* is still alive/,
  /FAIL: tmux session .* not present/,
  /FAIL: could not relaunch/,
]
/** The exact completion line `orchestrate` writes. */
const COMPLETE_PATTERN = /^restart complete \(exit 0\)$/
/** The orchestrator's own note that it took the tmux path. */
const FALLBACK_PATTERN = /taking the tmux fallback/

const sleep = ms => new Promise(done => setTimeout(done, ms))

/** The four files the restart handshake uses; `log` is the orchestrator's append-only log. */
export function restartPaths(stateDir) {
  return {
    armed: join(stateDir, ARMED_FILE),
    claim: join(stateDir, CLAIM_FILE),
    fallback: join(stateDir, FALLBACK_FILE),
    log: join(stateDir, LOG_NAME),
  }
}

/** Read a JSON object from `file`; missing, unreadable or non-object JSON is undefined. */
function readObject(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value
  } catch {
    return undefined
  }
}

/** Read `<stateDir>/restart-armed.json`; undefined when it is missing or not a JSON object. */
export function readArmed(stateDir) {
  return readObject(restartPaths(stateDir).armed)
}

/** Read `<stateDir>/restart-claimed.json`; undefined when it is missing or not a JSON object. */
export function readClaim(stateDir) {
  return readObject(restartPaths(stateDir).claim)
}

/** Atomically write a JSON file (tmp + rename), creating the state dir. */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, 'utf8')
  renameSync(temporary, file)
}

/** Atomically write the restart marker; `armDetached` owns the contents. */
export function writeArmed(stateDir, value) {
  writeJson(restartPaths(stateDir).armed, value)
}

/** Best-effort removal of the marker, the claim and the fallback file; never throws. */
export function clearRestartState(stateDir) {
  const paths = restartPaths(stateDir)
  for (const file of [paths.armed, paths.claim, paths.fallback]) {
    try {
      rmSync(file, { force: true })
    } catch {
      // Best effort: a stale marker is cleared again at the start of the next launch.
    }
  }
}

/** Whether the orchestrator already claimed the restart for tmux. */
export function fallbackExists(stateDir) {
  return existsSync(restartPaths(stateDir).fallback)
}

/** Whether the narrating terminal already claimed the restart. */
export function claimExists(stateDir) {
  return existsSync(restartPaths(stateDir).claim)
}

/**
 * Whether a claim is held by a terminal that can still relaunch the TUI.
 *
 * A claim whose pid is dead means the CLI wrote it and then died with the terminal (SIGHUP, a closed
 * window): waiting for that relaunch would leave the operator with no TUI at all, so the orchestrator must
 * take the tmux fallback. A claim without a pid is treated as valid for compatibility with older writers.
 */
export function claimHeldByLiveTerminal(stateDir) {
  const claim = readClaim(stateDir)
  if (claim === undefined) return false
  const pid = Number(claim.pid)
  if (!Number.isInteger(pid) || pid <= 0) return true
  return pidAlive(pid)
}

/**
 * Write the narrator's claim. Returns false when the orchestrator already took the tmux fallback; the
 * caller must then not relaunch a second TUI.
 */
export function claimRestart(stateDir, { pid, at } = {}) {
  if (fallbackExists(stateDir)) return false
  writeJson(restartPaths(stateDir).claim, { pid: pid ?? process.pid, at: at ?? new Date().toISOString() })
  return true
}

/** Write the orchestrator's fallback record immediately before launching tmux. */
export function markFallback(stateDir, { pid, at, tmux } = {}) {
  writeJson(restartPaths(stateDir).fallback, {
    pid: pid ?? process.pid,
    at: at ?? new Date().toISOString(),
    tmux: tmux ?? 'dsh-spv',
  })
}

/**
 * Remove the leading `[ISO] ` prefix from one log line, keeping the step text and the exit code.
 * A line without a timestamp is returned unchanged.
 */
export function stripTimestamp(line) {
  return String(line ?? '').replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]*\] ?/, '')
}

/**
 * Split an append-only log buffer into complete lines.
 *
 * The trailing fragment is returned as `rest`: the orchestrator may be mid-write, and echoing half a step
 * line would make the narration lie. A `\r` before `\n` is dropped so a CRLF log reads cleanly.
 */
export function splitCompleteLines(buffer) {
  const text = String(buffer ?? '')
  const cut = text.lastIndexOf('\n')
  if (cut === -1) return { lines: [], rest: text }
  return {
    lines: text.slice(0, cut).split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line)),
    rest: text.slice(cut + 1),
  }
}

/** Parse a non-negative millisecond value from the environment, or fall back to `fallback`. */
function envMs(env, name, fallback) {
  const value = Number.parseInt(String(env?.[name] ?? ''), 10)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Whether `pid` is a live (non-zombie) process.
 *
 * Same rule as `pidAlive` in `restart.js`: `/proc/<pid>/stat` is authoritative because a zombie still has an
 * entry; when `/proc` cannot be read, fall back to the existence check.
 */
function pidAlive(pid) {
  try {
    const stat = readFileSync(`/proc/${Number(pid)}/stat`, 'utf8')
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

/**
 * The by-hand recovery, in the order the cold-install guard accepts; the install part is skipped when it
 * was skipped by the run or when the marker carries no checkout.
 */
function recoveryCommands(marker) {
  const checkout = typeof marker?.checkout === 'string' && marker.checkout !== '' ? marker.checkout : undefined
  const steps = []
  if (marker?.noInstall !== true && checkout !== undefined) steps.push(`bash ${join(checkout, 'install.sh')}`)
  steps.push('wheelchair-agent service start', 'wheelchair-agent spv')
  return steps.join(' && ')
}

/**
 * Resolve the SPV conversation to resume: `<home>/.dsh-tui/resume.txt`, trimmed and validated as a UUID.
 *
 * This is the one source of the id. `homedir()` honours HOME, so the offline tests point it at a sandbox;
 * nothing here lists session directories or invents an id when the file is missing.
 */
export function resolveResume({ home = homedir() } = {}) {
  const file = join(home, '.dsh-tui', RESUME_FILE)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, file, reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
  const id = text.trim()
  if (!SESSION_ID.test(id)) return { ok: false, file, reason: 'invalid' }
  return { ok: true, file, id }
}

/** The human detail shared by the CLI note and the orchestrator's log note. */
export function resumeDetail(resume) {
  if (resume?.reason === 'unreadable') return '~/.dsh-tui/resume.txt is unreadable'
  if (resume?.reason === 'invalid') return '~/.dsh-tui/resume.txt does not contain a session id'
  return 'no ~/.dsh-tui/resume.txt'
}

/**
 * Remove the operator's own session-selection flags from an argv.
 *
 * The first launch must keep them untouched — that is the operator's command. A relaunch we own must not
 * repeat them: an old `--resume <id>` reopens the wrong conversation, and a bare `-c`/`--continue` after the
 * TUI failed to rewrite resume.txt exits dsh-tui with status 1. The relaunch takes its target from
 * resume.txt instead.
 */
export function stripResumeArgs(argv) {
  const stripped = []
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    if (word === '--resume') {
      // Drop the flag and its value when it has one; a bare --resume reads resume.txt, which we replace.
      if (index + 1 < argv.length && !argv[index + 1].startsWith('-')) index += 1
      continue
    }
    if (word.startsWith('--resume=') || word === '-c' || word === '--continue') continue
    stripped.push(word)
  }
  return stripped
}

/**
 * The argv for a relaunch we own: the operator's non-session args plus `--resume <id>`. `resumeId` is the
 * armed marker's session id (the session the operator restarted from); it wins over resume.txt, which is
 * dsh-tui's global last-opened pointer. Only when the marker has no id does `resolve()` (resume.txt) decide.
 * When no usable id exists, the stale session flags stay stripped, the caller prints one note and the TUI
 * starts fresh rather than dead-ending. `blocked` is the orchestrator's `leaseBlockedPid`: it already
 * printed the fresh-session line and cleared nothing about the reason, so the relaunch must not add
 * `--resume` again (that would make the CLI wait the whole lease window a second time).
 */
function prepareRelaunch(argv, resolve = resolveResume, { blocked = false, resumeId } = {}) {
  const base = stripResumeArgs(argv)
  if (blocked) return { argv: base, addedResume: false }
  const target = typeof resumeId === 'string' ? resumeId.trim() : ''
  if (target !== '') return { argv: [...base, '--resume', target], addedResume: true }
  const resume = resolve()
  if (!resume.ok) {
    return {
      argv: base,
      addedResume: false,
      note: `restart: cannot resume the previous SPV session (${resumeDetail(resume)}); starting a fresh one.`,
    }
  }
  return { argv: [...base, '--resume', resume.id], addedResume: true }
}

/** The log as a Buffer, or undefined when it does not exist yet. */
function readLog(file) {
  try {
    return readFileSync(file)
  } catch {
    return undefined
  }
}

/**
 * Narrate one armed restart and return `{ kind, code }`.
 *
 * `kind` is `none` (no marker: nothing to narrate), `done` (completion line seen; relaunch),
 * `fallback` (tmux already took over), `failed` (a failure line, or the orchestrator died) or `timeout`.
 * Only `done` means the caller may start the launcher again.
 *
 * Options: `{ stateDir, env, stdout, now, sleep, exists, readFile, isAlive, pollMs, graceMs }`. The
 * injection points exist so the algorithm can be tested without real files or real pids.
 */
export async function narrateRestart(options = {}) {
  const stateDir = options.stateDir
  const env = options.env ?? process.env
  const say = options.stdout ?? (line => process.stdout.write(`${line}\n`))
  const now = options.now ?? (() => Date.now())
  const sleepFor = options.sleep ?? sleep
  const isAlive = options.isAlive ?? pidAlive
  const fileExists = options.exists ?? existsSync
  const paths = restartPaths(stateDir)

  const readMarker = () => {
    try {
      const value = JSON.parse((options.readFile ?? (file => readFileSync(file, 'utf8')))(paths.armed))
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
      return value
    } catch {
      return undefined
    }
  }
  const marker = options.readMarker === undefined ? readMarker() : options.readMarker
  if (marker === undefined) return { kind: 'none', code: 0 }

  const logPath = typeof marker.log === 'string' && marker.log !== '' ? marker.log : paths.log
  const tmux = typeof marker.tmux === 'string' && marker.tmux !== '' ? marker.tmux : 'dsh-spv'

  const fallback = () => {
    say(`restart: the terminal did not claim the restart; the TUI is in tmux session ${tmux}`)
    say(`restart: attach with: tmux attach -t =${tmux}`)
    say(`log: ${logPath}`)
    return { kind: 'fallback', code: 0 }
  }
  const failure = reason => {
    say(`restart: failed — ${reason}`)
    say(`log: ${logPath}`)
    say(`fix: ${recoveryCommands(marker)}`)
    clearRestartState(stateDir)
    return { kind: 'failed', code: 1 }
  }

  // Print the first line before touching the log: the operator must see that something is happening
  // immediately after the TUI disappears, even if the orchestrator has not written a step yet.
  say('restart: stopping the service…')

  // The fallback file means tmux owns the relaunch, but the run is not over: keep tailing so a failed tmux
  // launch is reported as a failure instead of as success. File appearance alone is not success.
  let sawFallback = fallbackExists(stateDir)
  // Claim before tailing, so the orchestrator's grace window starts from "a terminal is watching".
  if (!sawFallback && !claimRestart(stateDir, { pid: process.pid, at: new Date(now()).toISOString() })) {
    sawFallback = true
  }

  const timeoutMs = envMs(env, 'WHEELCHAIR_RESTART_NARRATE_MS', DEFAULT_NARRATE_MS)
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(10, options.pollMs) : DEFAULT_POLL_MS
  const graceMs = Number.isFinite(options.graceMs) ? Math.max(0, options.graceMs) : DEFAULT_GRACE_MS
  const started = now()
  const pid = Number(marker.pid)

  const first = readLog(logPath)
  const offset = Number(marker.logOffset)
  let position = Number.isFinite(offset) && offset > 0 && first !== undefined && first.length >= offset
    ? offset
    : 0
  let pending = ''
  let deadSince

  const timeout = () => {
    say(`restart: timed out after ${timeoutMs}ms waiting for the orchestrator to finish`)
    say(`log: ${logPath}`)
    say(`fix: ${recoveryCommands(marker)}`)
    clearRestartState(stateDir)
    return { kind: 'timeout', code: 1 }
  }

  for (;;) {
    const log = readLog(logPath)
    if (log !== undefined) {
      // A truncated or rotated log invalidates the byte offset; replay from the start rather than lie.
      if (log.length < position) {
        position = 0
        pending = ''
      }
      if (log.length > position) {
        pending += log.subarray(position, log.length).toString('utf8')
        position = log.length
        const split = splitCompleteLines(pending)
        pending = split.rest
        for (const raw of split.lines) {
          const line = stripTimestamp(raw)
          if (line === '') continue
          const failed = FAILURE_PATTERNS.some(pattern => pattern.test(line))
          // Internal orchestrator lines belong in the log, not on the operator's terminal; a failure line
          // still surfaces even when it carries the `restart-all:` prefix.
          if (line.startsWith('restart-all:') && !failed) continue
          say(line)
          if (COMPLETE_PATTERN.test(line)) {
            // tmux already owns the relaunch; never start a second TUI next to it. The completion is still
            // proof that the fallback succeeded, so this is a success with a different message.
            if (sawFallback || fileExists(paths.fallback)) return fallback()
            say('restart: done; starting the SPV session again…')
            clearRestartState(stateDir)
            return { kind: 'done', code: 0 }
          }
          if (failed) return failure(line)
          if (FALLBACK_PATTERN.test(line)) sawFallback = true
        }
      }
    }

    // The fallback file can appear without a log line; keep watching the log so a failed tmux launch is not
    // mistaken for success.
    if (fileExists(paths.fallback)) sawFallback = true

    // A dead orchestrator will never write the completion line. Wait one short grace period first, so a
    // pid that is only briefly absent (or updated by `--run`) is not called a failure.
    if (Number.isInteger(pid) && pid > 0) {
      if (isAlive(pid)) {
        deadSince = undefined
      } else if (deadSince === undefined) {
        deadSince = now()
      } else if (now() - deadSince >= graceMs) {
        return failure('the orchestrator exited without completing')
      }
    } else if (now() - started >= graceMs) {
      // The marker was written before the spawn; no pid after the startup grace means nothing is running
      // to complete it. Fail quickly instead of waiting for the full narrator timeout.
      return failure('the orchestrator did not start (the restart marker has no pid)')
    }

    if (now() - started >= timeoutMs) return timeout()
    await sleepFor(pollMs)
  }
}

/** Deployment-private env names that must not reach the launcher or the TUI it starts. */
const PRIVATE_ENV = [
  'WHEELCHAIR_RESTART_CHAIN',
  'WHEELCHAIR_RESTART_PARENT_PID',
  'WHEELCHAIR_RESTART_PRESET_PATCH',
  'WHEELCHAIR_RESTART_SESSION_DIR',
  'WHEELCHAIR_AGENT_LAUNCHER',
]

/**
 * The launcher's environment: the CLI's own env minus the armed-chain seams and the test override.
 * `WHEELCHAIR_AGENT_SUPERVISED` marks the tree as watched by this loop, which is how the slash command
 * knows whether the one-time rollout note applies.
 */
function launcherEnvironment(env) {
  const copy = { ...env }
  for (const name of PRIVATE_ENV) delete copy[name]
  copy.WHEELCHAIR_AGENT_SUPERVISED = '1'
  return copy
}

/**
 * Whether a marker was written for this launch (or at least not before it).
 * A marker without `startedAt` is fresh for compatibility; an older marker is left over from a previous run.
 */
function markerIsFresh(marker, launchedAt) {
  if (marker.startedAt === undefined) return true
  const started = Date.parse(String(marker.startedAt))
  return Number.isFinite(started) && started >= launchedAt - FRESH_SLACK_MS
}

/** Wait for a spawned child to close; an `error` (failed spawn) settles the same promise. */
function waitForClose(child) {
  return new Promise(done => {
    child.once('error', error => done({ status: null, signal: null, error }))
    child.once('close', (status, signal) => done({ status, signal, error: undefined }))
  })
}

/**
 * Run the SPV launcher as a child and own the terminal across restarts.
 *
 * The launcher gets the terminal through `stdio: 'inherit'`, so a normal TUI session behaves exactly as the
 * previous `exec` did: signals reach it through the foreground process group and its exit status becomes the
 * CLI's status. The loop continues only when a marked restart completed (`done`); any other narrated outcome
 * ends the CLI with that outcome's code, and a normal exit is never turned into a relaunch.
 *
 * A relaunch we own appends `--resume <id>` from the armed marker's session id (the session the operator
 * restarted from); `~/.dsh-tui/resume.txt` is only the fallback when the marker has no id, and the loop says
 * when it falls back. Before any launch that carries a resume id (ours or the tmux fallback's
 * `spv --resume`), the loop waits for the old session's kernel lease to be released. A lease held by another
 * terminal is never preempted: the launch drops `--resume`, prints one line and starts a new session instead
 * of racing that terminal into dsh-tui's safe-mode prompt. If dsh-tui rejects a resume we added (a non-zero exit within
 * `RESUME_FAIL_MS`), the CLI says so and retries once without the flag; the operator's own first start and
 * normal long-running exits are never retried.
 *
 * Options: `{ launcher, launcherArgv, stateDir, sessionDir, presetPatch, cwd, env, spawn, stdout, stderr,
 * now, sleep, resolveResume }`. `sessionDir` is an already-resolved hint for this launch's id;
 * `presetPatch` is the installed preset patch the CLI owns (kept with the session options so one caller
 * decides both).
 */
export async function runSpvSession(options = {}) {
  const launcher = options.launcher
  const launcherArgv = options.launcherArgv ?? []
  const stateDir = options.stateDir
  const env = options.env ?? process.env
  const spawnChild = options.spawn ?? spawn
  const say = options.stdout ?? (line => process.stdout.write(`${line}\n`))
  const warn = options.stderr ?? (line => process.stderr.write(`${line}\n`))
  const now = options.now ?? (() => Date.now())
  const resolve = options.resolveResume ?? resolveResume
  const cwd = options.cwd ?? process.cwd()

  let launchArgv = [...launcherArgv]
  let addedResume = false
  let retriedResume = false
  const childEnv = launcherEnvironment(env)

  /** The session directory for one launch id: the CLI's hint when it names the same id, else a lookup. */
  const sessionFor = id => {
    if (
      typeof options.sessionDir === 'string' &&
      basename(options.sessionDir) === encodeSegment(id)
    ) {
      return { id, dir: options.sessionDir }
    }
    return resolveSession({ env, cwd, id })
  }

  /**
   * Wait out the previous holder before this launch takes the session. Returns the (possibly stripped)
   * argv and whether the resume was dropped; a blocked lease is reported once, never retried for the same
   * launch.
   */
  const guardLease = async launch => {
    const resume = resolve()
    const id = resumeIdFromArgv(launch, resume.ok ? resume.id : undefined)
    if (id === undefined) return { argv: launch, blocked: false }
    const session = sessionFor(id)
    // No directory means no lease we can name: the launch proceeds and dsh-tui decides.
    if (session === undefined) return { argv: launch, blocked: false }
    const lease = await waitForLeaseFree({
      sessionDir: session.dir,
      timeoutMs: leaseTimeoutMs(env),
      say,
      selfPid: process.pid,
    })
    if (lease.ok) return { argv: launch, blocked: false }
    say(occupiedSessionNotice({ sessionId: id, pid: lease.holder?.pid }))
    return { argv: stripResumeArgs(launch), blocked: true }
  }

  for (;;) {
    const launchedAt = now()
    // The orchestrator records a failed lease wait in the marker. If the marker names this same resume id
    // and the named holder still holds the resolved session, this launch did not need to wait: drop
    // --resume and go fresh, saying so (the orchestrator's line is only in the log on this path). The
    // holder check, not the marker's age, makes an old marker harmless: the tmux fallback starts long after
    // the marker was armed, while a leftover pid that is gone is ignored.
    const pending = readArmed(stateDir)
    const pendingBlocked = Number(pending?.leaseBlockedPid)
    if (Number.isInteger(pendingBlocked) && pendingBlocked > 0) {
      const resume = resolve()
      const markerId = typeof pending.sessionId === 'string' ? pending.sessionId : undefined
      const pendingId = resumeIdFromArgv(launchArgv, markerId ?? (resume.ok ? resume.id : undefined))
      const session = pendingId === undefined ? undefined : sessionFor(pendingId)
      const markerMatches = pendingId !== undefined && markerId === pendingId
      const stillHeld = session !== undefined &&
        sessionHolders({ sessionDir: session.dir }).some(holder => holder.pid === pendingBlocked)
      if (markerMatches && stillHeld) {
        say(occupiedSessionNotice({ sessionId: pendingId, pid: pendingBlocked }))
        launchArgv = stripResumeArgs(launchArgv)
        addedResume = false
      }
    }
    const guarded = await guardLease(launchArgv)
    if (guarded.blocked) addedResume = false
    launchArgv = guarded.argv
    let child
    try {
      child = spawnChild('sh', [launcher, ...launchArgv], { stdio: 'inherit', env: childEnv })
    } catch (error) {
      warn(`wheelchair-agent: cannot run the SPV launcher ${launcher}: ${error.message}`)
      return 1
    }
    const closed = await waitForClose(child)
    if (closed.error !== undefined) {
      warn(`wheelchair-agent: cannot run the SPV launcher ${launcher}: ${closed.error.message}`)
      return 1
    }

    // A resume this loop added, rejected by dsh-tui: say so and start a fresh session instead of leaving
    // the operator at a shell. Only once, and only for an immediately failing resume launch.
    if (
      addedResume &&
      !retriedResume &&
      closed.status !== null &&
      closed.status !== 0 &&
      now() - launchedAt < RESUME_FAIL_MS
    ) {
      retriedResume = true
      say(`restart: the resumed SPV session did not start (dsh-tui exited ${closed.status}); starting a fresh one.`)
      // Fresh means fresh: never put the operator's original (possibly stale) session flags back.
      launchArgv = stripResumeArgs(launcherArgv)
      addedResume = false
      continue
    }

    const marker = readArmed(stateDir)
    if (marker === undefined) return closed.status ?? 1
    if (!markerIsFresh(marker, launchedAt)) {
      // A marker left by an older run must not turn a normal TUI exit into a relaunch.
      clearRestartState(stateDir)
      return closed.status ?? 1
    }
    // Capture the orchestrator's blocked-lease hint before narrating: `narrateRestart` clears the marker
    // on completion, and the next iteration would otherwise re-add `--resume` and wait the whole lease
    // window a second time.
    const leaseBlockedPid = Number(marker.leaseBlockedPid)
    const blocked = Number.isInteger(leaseBlockedPid) && leaseBlockedPid > 0
    const outcome = await narrateRestart({
      stateDir,
      env,
      stdout: say,
      now: options.now,
      sleep: options.sleep,
    })
    if (outcome.kind === 'done') {
      // Back in this terminal, and back in the conversation the operator restarted from (the marker's
      // session id); resume.txt is only the fallback. A blocked lease (already announced by the orchestrator
      // and echoed by the narrator) means fresh argv only.
      const next = prepareRelaunch(launcherArgv, resolve, { blocked, resumeId: marker.sessionId })
      if (next.note !== undefined) say(next.note)
      launchArgv = next.argv
      addedResume = next.addedResume
      retriedResume = false
      continue
    }
    if (outcome.kind === 'none') return closed.status ?? 1
    return outcome.code
  }
}
