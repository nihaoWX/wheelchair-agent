/**
 * The dsh command plugin for `/restart-wheelchair-agent`.
 *
 * The command is deliberately thin: it runs the CLI's guard and arms the detached orchestrator, then tells
 * the operator their session is about to end. It never claims to have restarted anything itself, because it
 * cannot: it executes inside the very SPV session the restart has to stop. The actual work (service stop,
 * chain TERM/KILL, install.sh, service start) happens in `src/spv/restart.js`, driven by the CLI, and the
 * terminal that launched `wheelchair-agent spv` narrates it and relaunches the TUI there
 * (`src/spv/restart-ux.js`). tmux is only the fallback when that terminal is gone. This file imports only
 * `node:child_process` so the plugin has no dsh dependency and no duplicate implementation.
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
TUI session. This command only arms a detached orchestrator and returns; this SPV session ends here.

The terminal that launched "wheelchair-agent spv" stays open across the restart: it prints every step and
brings the TUI back in that same terminal, resumed into the same SPV conversation (the session id comes from
~/.dsh-tui/resume.txt; if that file is missing or does not hold a usable id, it says so and starts a fresh
session). Before resuming, it waits for the old TUI's kernel session lease (the open session.lock /
session.v4.jsonl.zstd descriptors) to be released; if that does not happen in the bounded window it starts a
fresh session and says so instead of replaying the resume into dsh-tui's "mounted by another TUI terminal"
error. If that terminal is gone (closed, or the CLI died with it), the fallback is tmux session "dsh-spv"
(attach with: tmux attach -t =dsh-spv), resumed the same way. Every step is appended to
<root>/logs/restart-all.log (default ~/.wheelchair-agent/logs/restart-all.log), which is the record
to read if the TUI does not come back.

One-time rollout: a session started before the same-terminal narrator existed has no supervising
"wheelchair-agent spv", so its first restart comes back in tmux "dsh-spv"; start a fresh
"wheelchair-agent spv" afterwards. dsh-tui's own /update, /restart and /backend handoff also end the
supervising CLI — run "wheelchair-agent spv" again to restore it. Do not pass --patch to
"wheelchair-agent spv": the CLI would join the kill chain and forfeit the narrator.

Arguments:
  --force   interrupt running workers and queued tickets instead of refusing. The command prints what it is
            interrupting before anything is stopped. At most once.

The detached orchestrator stops the service, stops this SPV session's process chain (SIGTERM, then SIGKILL
after a bounded wait), runs install.sh cold and starts the service again. It does not relaunch the TUI itself
unless no terminal claims the restart. A failed install or a service that does not start leaves the service
stopped and does not relaunch a TUI into a broken deployment. Every step is appended to
<root>/logs/restart-all.log (default ~/.wheelchair-agent/logs/restart-all.log) with its command and exit code.

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
    description: 'Restart the deployment and bring the SPV TUI back in this terminal',
    input: { hint: '[--force]' },
    handler: makeHandler(config),
  })
}
