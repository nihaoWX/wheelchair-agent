/**
 * `/spv-cron` — a recurring self-check that wakes this SPV session and hands it a short brief.
 *
 * Why a slash command and not a tool: the model must not be able to turn the check on, off or
 * reschedule it. A command is invisible to the model and unreachable by a worker, so the checking
 * cadence belongs to the operator. (The brief itself does reach the model — that is the point.)
 *
 * Why not `dsh-schedule`: that service needs the Web composition's Session controller and is
 * documented as unmountable in headless-only or SDK-only combinations; this session runs under
 * dsh-tui. The timer is therefore a plain interval held by this plugin.
 *
 * The brief is two-tiered by design:
 *   - nothing wrong  -> "advance the operator's tasks", a nudge, no alarm
 *   - something wrong -> name it concretely and dispatch a subagent to look
 * Both are short on purpose: this fires hourly and must never crowd out the conversation.
 */

/** The command name, without the leading slash. */
export const NAME = 'spv-cron'
/** Hook occurrence fired on every timer tick; the prefix is what triggers it (the cron timer). */
export const HOOK_EVENT = 'cron.spv_cron'
/** How often the check fires when the operator names no interval. */
const DEFAULT_MINUTES = 60
/** Bounds on `--every`, in minutes: below 5 this is polling noise, above a day it is not a check. */
const MIN_MINUTES = 5
const MAX_MINUTES = 1440

/** What a run of the check decided, used for both the brief and the log line. */
const VERDICT = {
  quiet: 'quiet',
  attention: 'attention',
}

/**
 * Read the job ledger written by `jobctl`.
 *
 * Kept tolerant on purpose: a malformed line is skipped rather than thrown, because one bad
 * record must not stop the check from noticing everything else.
 */
function readLedger(path, readFileSync) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      continue
    }
  }
  return records
}

/** Latest submit record per unit, plus the set of units already recorded as ended. */
function summarise(records) {
  const submitted = new Map()
  const ended = new Set()
  for (const record of records) {
    if (!record || typeof record.unit !== 'string') continue
    if (record.event === 'submit') submitted.set(record.unit, record)
    else if (record.event === 'end') ended.add(record.unit)
  }
  return { submitted, ended }
}

/**
 * Build the brief the session receives.
 *
 * Returns `{ verdict, text }`. `text` is what the model reads; it is deliberately terse and
 * states what to do next rather than restating facts the session can look up.
 */
export function buildBrief({ ledgerPath, readFileSync, isActive, now }) {
  const { submitted } = summarise(readLedger(ledgerPath, readFileSync))
  const stuck = []
  const finished = []

  for (const [unit, record] of submitted) {
    const state = isActive(unit)
    if (state === 'active') continue
    // A unit that exists in the ledger but is not active either finished or never really started.
    const started = record.at ? Date.parse(record.at) : Number.NaN
    const ageMinutes = Number.isFinite(started) ? Math.round((now - started) / 60000) : undefined
    if (state === 'failed') stuck.push(`${unit} (failed${ageMinutes === undefined ? '' : `, submitted ${ageMinutes}m ago`})`)
    else finished.push(`${unit} (not active${ageMinutes === undefined ? '' : `, submitted ${ageMinutes}m ago`})`)
  }

  if (stuck.length || finished.length) {
    const lines = ['[spv-cron] long-job check found something to look at:']
    if (stuck.length) lines.push(`  failed: ${stuck.join('; ')}`)
    if (finished.length) lines.push(`  not running: ${finished.join('; ')}`)
    lines.push('Dispatch a subagent to inspect these with jobctl status / jobctl log and report back.')
    lines.push('Do not assume a job died: it may have finished and already handed off.')
    return { verdict: VERDICT.attention, text: lines.join('\n') }
  }

  return {
    verdict: VERDICT.quiet,
    text:
      '[spv-cron] routine check: no failed or stalled long jobs. ' +
      'If the operator has work in flight, ask whether the next stage should be dispatched; otherwise stay quiet.',
  }
}

/**
 * Resolve `--every <minutes>` from a raw input line.
 *
 * Returns `{ minutes }` or `{ error }` with a message the operator can act on.
 */
export function parseInterval(rawInput, configuredMinutes) {
  const words = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { minutes: configuredMinutes }

  if (words[0] === 'off') return { minutes: 0 }
  if (words[0] === 'status') return { status: true }

  if (words[0] === 'every') {
    const value = Number(words[1])
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return { error: `invalid interval ${JSON.stringify(words[1] ?? '')}: pass whole minutes, e.g. /spv-cron every 60` }
    }
    if (value < MIN_MINUTES || value > MAX_MINUTES) {
      return { error: `interval ${value}m is outside ${MIN_MINUTES}-${MAX_MINUTES} minutes` }
    }
    return { minutes: value }
  }

  return { error: `unknown argument ${JSON.stringify(words[0])}: use /spv-cron, /spv-cron every <minutes>, /spv-cron off, or /spv-cron status` }
}

/** Human-readable state for `/spv-cron status`. */
export function describeState(state) {
  if (state.timer === undefined) return 'spv-cron: off'
  const since = state.lastRun ? `, last run ${state.lastRun}` : ''
  return `spv-cron: on, every ${state.minutes} minutes${since}`
}

/** The session id a hook row can use to tell sessions apart; absent on agents that expose no session. */
function sessionIdOf(agent) {
  const id = agent?.session?.id
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined
}

/**
 * One check: build the brief, inject it, then fire the hook event.
 *
 * Extracted from the timer so tests can drive it without waiting an hour. `inject` is the core path and
 * runs first; the hook is best-effort afterwards, inside its own try/catch, so a broken hook can never
 * suppress or delay the brief. `injected` records that the brief really was handed to the session
 * (the current behaviour injects on `quiet` ticks too, hence the separate `verdict`).
 */
export function runOnce({ agent, ledgerPath, readFileSync, isActive, inject, fireHook, minutes, now = Date.now() }) {
  if (!agent) return undefined
  const brief = buildBrief({ ledgerPath, readFileSync, isActive, now })
  const at = new Date(now).toISOString()
  inject(agent, brief.text)
  const sessionId = sessionIdOf(agent)
  const payload = {
    ...(sessionId === undefined ? {} : { sessionId }),
    minutes,
    at,
    injected: true,
    verdict: brief.verdict,
  }
  if (typeof fireHook === 'function') {
    try {
      fireHook(HOOK_EVENT, payload)
    } catch {
      // Hook 只是附带的副作用：任何失败都不能影响已经完成的注入或下一次轮询。
    }
  }
  return { brief, at, payload }
}

/**
 * Register `/spv-cron` against the receiving agent.
 *
 * The plugin owns one timer for the session it is mounted on. A second `/spv-cron` with no
 * argument re-arms rather than stacking timers, so repeat invocations cannot multiply the
 * wake-ups.
 */
export function apply(ctx, config = {}) {
  const { readFileSync } = config.fs ?? {}
  if (typeof readFileSync !== 'function') {
    throw new Error('spv-cron needs fs.readFileSync to read the job ledger')
  }
  const ledgerPath = config.ledgerPath
  const isActive = config.isActive
  const inject = config.inject
  const fireHook = config.fireHook
  if (typeof ledgerPath !== 'string' || !ledgerPath) throw new Error('spv-cron needs ledgerPath')
  if (typeof isActive !== 'function') throw new Error('spv-cron needs isActive(unit)')
  if (typeof inject !== 'function') throw new Error('spv-cron needs inject(agent, text)')

  const settled = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Number(config.minutes) || DEFAULT_MINUTES))
  const state = { timer: undefined, minutes: settled, lastRun: undefined, lastVerdict: undefined, agent: undefined }

  const stop = () => {
    if (state.timer !== undefined) clearInterval(state.timer)
    state.timer = undefined
  }

  const run = () => {
    const agent = state.agent
    if (!agent) return
    const executed = runOnce({
      agent,
      ledgerPath,
      readFileSync,
      isActive,
      inject,
      fireHook,
      minutes: state.minutes,
      now: Date.now(),
    })
    state.lastRun = executed.at
    state.lastVerdict = executed.brief.verdict
  }

  // One timer per plugin instance, owned by the plugin's fiber: the disposer returned here runs
  // when the plugin is unloaded, so a closed session never leaves an interval behind.
  ctx.effect(() => {
    const start = () => {
      state.timer = setInterval(run, state.minutes * 60_000)
      // A lone check must not keep the process alive after the session closes.
      state.timer.unref?.()
    }
    start()
    return () => stop()
  }, 'spv-cron interval')

  const restart = minutes => {
    stop()
    state.minutes = minutes
    state.timer = setInterval(run, minutes * 60_000)
    state.timer.unref?.()
  }

  const handler = ({ agent, rawInput }) => {
    state.agent = agent
    const parsed = parseInterval(rawInput, state.minutes)

    if (parsed.error) return { kind: 'error', text: parsed.error }
    if (parsed.status) return { kind: 'success', text: describeState(state) }
    if (parsed.minutes === 0) {
      stop()
      return { kind: 'success', text: 'spv-cron: off' }
    }
    restart(parsed.minutes)
    return {
      kind: 'success',
      text: `spv-cron: on, every ${parsed.minutes} minutes. Each run hands this session a short brief; it never dispatches work itself.`,
    }
  }

  ctx.commands.register({
    name: NAME,
    description: 'Recurring long-job check for this SPV session',
    input: { hint: '[every <minutes> | off | status]' },
    handler,
  })
}

export const inject = ['commands']
export const name = 'spv-cron'
