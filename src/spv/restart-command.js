/**
 * The dsh command plugin for `/restart-wheelchair-agent`.
 *
 * The command is deliberately thin: it runs the CLI's guard and arms the detached orchestrator, then tells
 * the operator their session is about to end. It never claims to have restarted anything itself, because it
 * cannot: it executes inside the very SPV session the restart has to stop. The actual work (service stop,
 * chain TERM/KILL, install.sh, service start, tmux relaunch) happens in `src/spv/restart.js`, driven by the
 * CLI; this file imports only `node:child_process` so the plugin has no dsh dependency and no duplicate
 * implementation.
 *
 * Only `--force` is accepted. `--force` interrupts running workers and queued tickets instead of refusing;
 * the CLI prints exactly what it is interrupting before it proceeds.
 */
import { spawnSync } from 'node:child_process'

/** Plugin name used by the preset's plugin row. */
export const name = 'spv-restart-command'
/** The command registry is the only service this plugin needs. */
export const inject = ['commands']
/** Command name, without the leading slash. */
export const COMMAND = 'restart-wheelchair-agent'

/** Usage text: the argument grammar, the safety statement and where the log lands. */
export const USAGE = `Usage: /restart-wheelchair-agent [--force]

Restart everything this deployment runs: the superagent service, a cold install of the preset, and the SPV
TUI session. This command only arms a detached orchestrator and returns; your session is about to end.

Arguments:
  --force   interrupt running workers and queued tickets instead of refusing. The command prints what it is
            interrupting before anything is stopped. At most once.

The detached orchestrator stops the service, stops this SPV session's process chain (SIGTERM, then SIGKILL
after a bounded wait), runs install.sh cold, starts the service again, and relaunches the TUI in tmux session
"dsh-spv". Every step is appended to <root>/logs/restart-all.log (default
~/.wheelchair-agent/logs/restart-all.log) with its command and exit code.

No other argument is accepted. Without --force the command refuses when the service reports a running worker
or a queued ticket, because stopping the service then would throw that work away.`

/** The result shape the command registry expects for an expected failure. */
function errorResult(text) {
  return { kind: 'error', text }
}

/**
 * Build the handler around one executable.
 *
 * `config.executable` is a test seam and a manual override; the default is the installed command name, which
 * resolves through PATH just as the panel's prepare command does.
 */
function makeHandler(config = {}) {
  const executable = typeof config.executable === 'string' && config.executable !== ''
    ? config.executable
    : 'wheelchair-agent'
  return invocation => {
    const tokens = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
    let force = false
    for (const token of tokens) {
      if (token !== '--force') return errorResult(USAGE)
      if (force) return errorResult(USAGE)
      force = true
    }
    const args = ['restart-all', '--detach', ...(force ? ['--force'] : [])]
    let result
    try {
      result = spawnSync(executable, args, {
        encoding: 'utf8',
        timeout: 60_000,
        env: process.env,
      })
    } catch (error) {
      return errorResult(
        `could not run ${executable} ${args.join(' ')}: ${error.message}. ` +
          'fix: check that the wheelchair-agent CLI is on PATH, or pass its path in the plugin config.',
      )
    }
    if (result.error) {
      const reason = result.error.code ?? result.error.message
      return errorResult(
        `could not run ${executable} ${args.join(' ')}: ${reason}. ` +
          'fix: check that the wheelchair-agent CLI is on PATH, or pass its path in the plugin config.',
      )
    }
    if (result.status === 0) {
      return { kind: 'success', text: String(result.stdout ?? '').trim() }
    }
    const detail = String(result.stderr || result.stdout || '').trim() ||
      `${executable} ${args.join(' ')} exited ${result.status}`
    return errorResult(detail)
  }
}

/**
 * Register the command.
 *
 * No `ctx.effect` is needed: the registration is owned by this plugin's context and disappears with it,
 * which is exactly the lifetime `cron.js` relies on.
 */
export function apply(ctx, config = {}) {
  ctx.commands.register({
    name: COMMAND,
    description: 'Restart the deployment: superagent service, cold install and SPV TUI',
    input: { hint: '[--force]' },
    handler: makeHandler(config),
  })
}
