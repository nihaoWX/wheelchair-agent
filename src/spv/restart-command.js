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
 * `--force` interrupts running workers and queued tickets instead of refusing; the CLI prints exactly what it
 * is interrupting before it proceeds. Without --all the target is the deployment this session belongs to
 * (resolved from the instance's SPV_QUEUE_DIR through the registry); `--project <p>` overrides it for a copied
 * command. If neither identifies a deployment, the command refuses instead of falling back to a machine-wide
 * restart. `--all` restarts every registered deployment and installs once, using this session's deployment
 * (or --project) only to choose the checkout that installs. The handler
 * passes the invoking Session's id (`invocation.agent.session.id`) as
 * `--session`, so the restart targets the conversation this command was typed in; the global
 * `~/.dsh-tui/resume.txt` is only the fallback when that id is unavailable.
 */
import { spawnSync } from 'node:child_process'

import { ownDeployment } from './ownership.js'

/** Plugin name used by the preset's plugin row. */
export const name = 'spv-restart-command'
/** The command registry is the only service this plugin needs. */
export const inject = ['commands']
/** Command name, without the leading slash. */
export const COMMAND = 'restart-wheelchair-agent'

/** Usage text: the argument grammar, the safety statement and where the log lands. */
export const USAGE = `Usage: /restart-wheelchair-agent [--force] [--project <p>] [--all]

Without --all, restart this session's deployment: its instance is stopped and started, install.sh is skipped,
and its own session is resumed. --project <p> restarts another registered deployment instead (install.sh is
skipped there too); without it the target is resolved from this instance's SPV_QUEUE_DIR. When no deployment
can be identified the command refuses and lists what to do; a machine-wide restart is not the fallback.

With --all, stop every registered deployment, stop this SPV session's process chain, run install.sh once,
start every deployment, and resume the TUI. The install uses this session's deployment (or --project <p>) to
choose the checkout; if neither identifies one the CLI refuses before stopping anything. This is the explicit
entry point for installing new code everywhere. This command only arms a detached orchestrator and returns;
this SPV session ends here.

The terminal that launched "wheelchair-agent spv" stays open across the restart: it prints every step and
brings the TUI back in that same terminal, resumed into the same SPV conversation. The target is the session
this command runs in (its id is passed to the CLI as --session); ~/.dsh-tui/resume.txt is only a fallback when
that id is unavailable, and the command says when it falls back. Before resuming, it waits for the old TUI's
kernel session lease (the open session.lock / session.v4.jsonl.zstd descriptors) to be released. A lease held
by another terminal is never preempted: after the bounded wait the relaunch starts a new session and says so.
If that terminal is gone (closed, or the CLI died with it), the fallback is tmux session "dsh-spv"
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
  --project <p>
            restart the deployment registered for project <p> instead of this session's deployment. The
            instance is stopped and started, the shared install is skipped, and that deployment's own session
            is resumed. With --all, only select the deployment whose checkout installs; every deployment is
            still restarted.
  --all      restart every registered deployment: stop all instances, stop the SPV chain, install once,
            start all instances, resume the TUI.

The detached orchestrator stops the target instance(s), stops this SPV session's process chain (SIGTERM, then
SIGKILL after a bounded wait), runs install.sh once (with an explicit --project; skipped without --all) and
starts the instance(s) again. It only signals processes in that chain: a session held by another terminal is
left alone. It does not relaunch the TUI itself unless no
terminal claims the restart. A failed install or a service that does not start leaves the service
stopped and does not relaunch a TUI into a broken deployment. Every step is appended to
<root>/logs/restart-all.log (default ~/.wheelchair-agent/logs/restart-all.log) with its command and exit code.

No other argument is accepted. Without --force the command refuses when the service reports a running worker
or a queued ticket, because stopping the service then would throw that work away; the same guard covers the
requested deployment.`

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
    let all = false
    let project
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token === '--all') {
        if (all) return errorResult(USAGE)
        all = true
        continue
      }
      if (token === '--force') {
        if (force) return errorResult(USAGE)
        force = true
        continue
      }
      if (token === '--project') {
        const value = tokens[index + 1]
        if (value === undefined || value.startsWith('--')) return errorResult(USAGE)
        if (project !== undefined) return errorResult(USAGE)
        project = value
        index += 1
        continue
      }
      return errorResult(USAGE)
    }
    const own = ownDeployment()
    if (all) {
      // --all needs a checkout for install.sh, not a target: prefer this session's deployment, else let the
      // CLI decide and refuse with its own --project guidance.
      if (project === undefined && own.entry !== null) project = own.entry.project
    } else if (project === undefined) {
      if (own.entry === null) {
        return errorResult(
          `cannot restart: this session does not belong to a registered deployment (${own.reason}). ` +
            'Run "wheelchair-agent deployment list" and pass --project <p>, or start this deployment with ' +
            '"wheelchair-agent service start --project <p>" so it can identify itself. A machine-wide restart ' +
            'is no longer the fallback.',
        )
      }
      project = own.entry.project
    }
    const sessionId = typeof invocation?.agent?.session?.id === 'string'
      ? invocation.agent.session.id.trim()
      : ''
    const args = [
      'restart-all',
      '--detach',
      ...(all ? ['--all'] : []),
      ...(sessionId !== '' ? ['--session', sessionId] : []),
      ...(project !== undefined ? ['--project', project] : []),
      ...(force ? ['--force'] : []),
    ]
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
    description: 'Restart this deployment (or --all) and bring the SPV TUI back in this terminal',
    input: { hint: '[--force]' },
    handler: makeHandler(config),
  })
}
