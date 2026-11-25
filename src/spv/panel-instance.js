/**
 * Lifecycle glue for the standalone wheelchair-agent panel.
 *
 * The panel used to be a hand-written `node:http` host. It is now an ordinary dsh instance of its
 * own: the shipped `panel` profile (dsh-base + dsh-web-app + `wheelchair-agent-webui`) plus a small
 * overlay passed with `--patch`. The instance deliberately loads no dsh-superagent, so it has no
 * orchestrator, no sources and no tickets; the routes and the page are the same files the
 * deployments mount, and the data root is ours.
 *
 * Process lifecycle (start/stop/token URL) is shared with deployments and lives in
 * `commands/superagent-service.py --mode panel`. This module only computes what is specific to the
 * panel (profile name, session, overlay, state dir, port, log) and can run the instance in the
 * foreground for tests and debugging.
 *
 * The overlay is installed with the preset (`panel.patch.yml`) and reads its port from the
 * environment; that is why `--port` and settings `panel.port` do not require rewriting a file per
 * run.
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { dataPaths } from '../shared/home.js'
import { resolveSettings } from '../shared/settings.js'

export const PANEL_PROFILE_ID = 'panel'
export const PANEL_SESSION = 'wca-panel'
export const PANEL_HOST = '127.0.0.1'
export const DEFAULT_PANEL_PORT = 3080
/** The overlay reads this variable; the `!!js` expression cannot see the CLI's argv. */
export const PANEL_PORT_ENV = 'WHEELCHAIR_PANEL_PORT'

/** A usable TCP port. Port 0 would make the printed URL wrong, so it is not accepted. */
export function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

/** The configured panel port; settings `panel.port` (env override included), else 3080. */
export function panelPort({ env = process.env, home, stateDir } = {}) {
  try {
    const settings = resolveSettings({ env, home, stateDir })
    const port = settings.effective?.['panel.port'] ?? settings.values?.['panel.port']
    return validPort(port) ? port : DEFAULT_PANEL_PORT
  } catch {
    return DEFAULT_PANEL_PORT
  }
}

/**
 * The instance's own state directory: `<data root>/panel`.
 *
 * It is not a deployment state dir: `service stop --all` walks the deployment registry, and the
 * panel must not be in it. Exporting it as `DSH_SUPERAGENT_STATE_DIR` is still the one seam the
 * webui plugin already understands (settings/work lookups), without mounting dsh-superagent.
 */
export function panelStateDir({ env = process.env, home, stateDir } = {}) {
  return join(dataPaths({ env, home, stateDir }).root, 'panel')
}

/** The instance log; the startup token is printed here and nowhere else. */
export function panelLogPath({ env = process.env, dshHome } = {}) {
  const home = dshHome || String(env.DSH_HOME ?? '').trim() || join(env.HOME || homedir(), '.dsh')
  return join(home, '.artifacts', `${PANEL_SESSION}.log`)
}

/** Arguments that select the panel instance in the shared service manager. */
export function panelServiceArgs({ action, overlay, port, stateDir, log }) {
  return [
    action,
    '--mode', 'panel',
    '--profile', PANEL_PROFILE_ID,
    '--patch', overlay,
    '--session', PANEL_SESSION,
    '--state-dir', stateDir,
    '--log', log,
    '--url', `http://${PANEL_HOST}:${port}/`,
    '--port', String(port),
  ]
}

/** The dsh command; tests may point `DSH_BIN` at a stub, otherwise PATH decides. */
function dshBinary(env) {
  return String(env.DSH_BIN ?? '').trim() || 'dsh'
}

/**
 * Run the instance in the current terminal. The child's output is teed to the artifact log so
 * `panel status`/`panel open` can find the token while a foreground run is alive, exactly as they
 * do for a tmux-started instance.
 */
export function runPanelForeground({ overlay, port, stateDir, log, env = process.env } = {}) {
  return new Promise(resolve => {
    mkdirSync(dirname(log), { recursive: true })
    const fd = openSync(log, 'a')
    const child = spawn(
      dshBinary(env),
      ['--profile', PANEL_PROFILE_ID, '--patch', overlay, '--no-open'],
      {
        env: {
          ...env,
          [PANEL_PORT_ENV]: String(port),
          DSH_SUPERAGENT_STATE_DIR: stateDir,
        },
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    )
    const forward = (stream, destination) => {
      stream.on('data', chunk => {
        writeSync(fd, chunk)
        destination.write(chunk)
      })
    }
    forward(child.stdout, process.stdout)
    forward(child.stderr, process.stderr)
    let settled = false
    const finish = code => {
      if (settled) return
      settled = true
      closeSync(fd)
      resolve(code ?? 1)
    }
    child.on('error', error => {
      process.stderr.write(`wheelchair-agent: cannot start ${dshBinary(env)}: ${error.message}\n`)
      finish(1)
    })
    child.on('exit', (code, signal) => finish(code ?? (signal === null ? 1 : 0)))
    // The terminal usually delivers SIGINT to the whole process group; forward explicitly for
    // non-tty callers (tests, `sh -c`), and let the child shut down gracefully.
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        try {
          child.kill(signal)
        } catch {
          // It already exited; the exit handler is the authority.
        }
      })
    }
  })
}
