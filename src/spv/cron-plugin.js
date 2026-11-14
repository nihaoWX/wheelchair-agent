/**
 * The dsh plugin entry for `/spv-cron`.
 *
 * Separate from `src/spv/cron.js` because that file is pure logic and stays testable: it takes
 * injected functions instead of importing Node APIs. This file supplies the real ones.
 *
 * `isActive` shells out to systemctl rather than reading a state file, because systemd is the one
 * authority on whether a unit is still running. A job that already handed off (and was collected)
 * reads as inactive on purpose — the brief tells the session to check the log before concluding
 * anything, since "no longer running" covers both "finished" and "died".
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply as applyCore, inject as coreInject, name as coreName } from './cron.js'

export const name = coreName
export const inject = coreInject

/** Ledger written by `commands/jobctl.py`; the same default that script uses. */
const LEDGER = join(process.env.JOBCTL_STATE_DIR || join(homedir(), '.local', 'state', 'jobctl'), 'ledger.jsonl')

/**
 * Ask systemd for one unit's state.
 *
 * Synchronous because the brief is built synchronously; a job check must not stall the session.
 * `systemctl is-active` answers in milliseconds, so the alternative (threading an async pass
 * through the whole brief builder) buys nothing at this size.
 */
function unitIsActive(unit) {
  try {
    const answer = String(execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' })).trim()
    if (answer === 'active' || answer === 'activating' || answer === 'reloading') return 'active'
    if (answer === 'failed') return 'failed'
    return 'inactive'
  } catch (error) {
    // `is-active` exits non-zero for anything but active, so a thrown error is a normal answer.
    const answer = String(error?.stdout ?? '').trim()
    return answer === 'failed' ? 'failed' : 'inactive'
  }
}

/**
 * Hand a brief to the session.
 *
 * `followup` queues it for the next turn, so it never interrupts a turn the operator is in the
 * middle of; an idle session starts one immediately. The message needs the same three fields any
 * user message carries, and `source.kind: 'user'` is what the log records it as.
 */
function injectBrief(agent, text) {
  agent.followup({
    id: `spv-cron-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

export function apply(ctx, config = {}) {
  return applyCore(ctx, {
    minutes: config.minutes,
    ledgerPath: config.ledgerPath || LEDGER,
    fs: { readFileSync },
    isActive: unitIsActive,
    inject: injectBrief,
  })
}
