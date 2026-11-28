/**
 * The browser-shaped SPV host (profile `wca-spv-web`).
 *
 * It is the third instance shape next to a deployment and the panel: not a deployment, not written to
 * `deployments.json`, and started by `wheelchair-agent spv` when `spv.surface` is `web`. It reuses the
 * same service manager as the deployments/panel (`commands/superagent-service.py --mode spv`), so
 * there is one process-management path, one token-URL printer and one status contract.
 *
 * The overlay `<data root>/deployments/spv.yml` carries only the runtime port; the `wca-spv-web`
 * profile itself carries the SPV plugin rows and no deployment-only rows.
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dataPaths } from '../shared/home.js'
import { resolveSettings } from '../shared/settings.js'

export const SPV_WEB_PROFILE_ID = 'wca-spv-web'
export const SPV_SESSION = 'wca-spv'
export const SPV_HOST = '127.0.0.1'
export const DEFAULT_SPV_WEB_PORT = 3081
export const SPV_WEB_PORT_ENV = 'WHEELCHAIR_SPV_WEB_PORT'
export const SPV_WEB_OVERLAY_FILE = 'spv.yml'

/** Port validation shared by the settings and the argv builders. */
export function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

/** The configured `spv.surface`: `tui` (default) or `web`. The install/launcher seam wins. */
export function spvSurface({ env = process.env, home, stateDir } = {}) {
  const explicit = String(env.WHEELCHAIR_AGENT_SPV_SURFACE ?? '').trim()
  if (explicit === 'tui' || explicit === 'web') return explicit
  try {
    const settings = resolveSettings({ env, home, stateDir })
    return settings.effective?.['spv.surface'] === 'web' ? 'web' : 'tui'
  } catch {
    return 'tui'
  }
}

/** The configured SPV browser port: settings `spv.webPort`, else 3081. */
export function spvWebPort({ env = process.env, home, stateDir } = {}) {
  try {
    const settings = resolveSettings({ env, home, stateDir })
    const port = settings.effective?.['spv.webPort'] ?? settings.values?.['spv.webPort']
    return validPort(port) ? port : DEFAULT_SPV_WEB_PORT
  } catch {
    return DEFAULT_SPV_WEB_PORT
  }
}

/** Read the port without the settings layer (no default filling, no migration): install/check path. */
export function readOnlySpvWebPort({ env = process.env, home, stateDir } = {}) {
  const candidates = [env.WHEELCHAIR_SPV_WEB_PORT, env.SPV_WEB_PORT]
  try {
    const file = dataPaths({ env, home, stateDir }).settings.current
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    candidates.push(parsed?.values?.['spv.webPort'])
  } catch {
    // No settings file yet: the runtime default applies.
  }
  for (const candidate of candidates) {
    if (validPort(candidate)) return candidate
  }
  return DEFAULT_SPV_WEB_PORT
}

/** The host's own state directory: `<data root>/spv` (the SPV root, not a deployment stateDir). */
export function spvStateDir({ env = process.env, home, stateDir } = {}) {
  return join(dataPaths({ env, home, stateDir }).root, 'spv')
}

/** The overlay the host starts with. */
export function spvOverlayPath({ env = process.env, home, stateDir } = {}) {
  return join(dataPaths({ env, home, stateDir }).root, 'deployments', SPV_WEB_OVERLAY_FILE)
}

/** The host log; the startup token is printed here and nowhere else. */
export function spvLogPath({ env = process.env, dshHome } = {}) {
  const home = dshHome || String(env.DSH_HOME ?? '').trim() || join(env.HOME || homedir(), '.dsh')
  return join(home, '.artifacts', `${SPV_SESSION}.log`)
}

/** The tokenised URL `dsh web` printed last, or null when the log has no startup line yet. */
const SPV_TOKEN_URL = /https?:\/\/[^\s]*[?&]token=[A-Za-z0-9._-]+/g
export function spvTokenFromLog(file) {
  try {
    const matches = [...readFileSync(file, 'utf8').matchAll(SPV_TOKEN_URL)]
    return matches.length === 0 ? null : matches[matches.length - 1][0]
  } catch {
    return null
  }
}

/**
 * One loopback probe of the SPV web page. Mirror `panel-instance.probePanelHttp`: the status code is
 * the answer (dsh web replies 401 without the session cookie and 303 for the token exchange, and both
 * mean the host is alive); only a refused/timed-out connection is null.
 */
export function probeSpvWebHost({ port, host = SPV_HOST, timeoutMs = 800, probe } = {}) {
  if (probe !== undefined) return probe(port)
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = request({ host, port, path: '/', method: 'GET', timeout: timeoutMs }, response => {
      response.resume()
      response.on('end', () => finish(response.statusCode ?? null))
      response.on('error', () => finish(null))
    })
    req.on('timeout', () => {
      req.destroy()
      finish(null)
    })
    req.on('error', () => finish(null))
    req.end()
  })
}

/**
 * Decide what a foreground `wheelchair-agent spv` should do. Any HTTP answer means something serves
 * the port; `running` additionally needs our startup token in the log and either our own listener
 * (`--profile wca-spv-web` in its cmdline, or an unreadable cmdline) or no readable listener at all.
 * `occupied` is a live port without those credentials; `free` is a refused/timed-out probe.
 * `probe`, `listenerPid` and `cmdline` are injected so tests never touch a real port or /proc.
 */
export async function spvHostState({
  port,
  logPath,
  probe,
  listenerPid = () => null,
  cmdline = () => '',
} = {}) {
  const status = await probeSpvWebHost({ port, probe })
  if (status === null || status === undefined) return { state: 'free', port }
  const url = spvTokenFromLog(logPath)
  const raw = listenerPid(port)
  const pid = Number.isInteger(raw) && raw > 0 ? raw : null
  let ours = false
  if (url !== null) {
    if (pid === null) {
      ours = true
    } else {
      const line = String(cmdline(pid) ?? '')
      ours = line === '' ? true : /--profile[= ]wca-spv-web(?:\s|$)/.test(line)
    }
  }
  if (ours) return { state: 'running', port, url }
  return { state: 'occupied', port, pid }
}

/** Arguments that select the SPV host in the shared service manager. Pure; the tests assert it. */
export function spvServiceArgs({ action, overlay, port, stateDir, log }) {
  const url = `http://${SPV_HOST}:${port}/`
  return [
    action,
    '--mode', 'spv',
    '--profile', SPV_WEB_PROFILE_ID,
    '--patch', overlay,
    '--session', SPV_SESSION,
    '--state-dir', stateDir,
    '--log', log,
    '--url', url,
    '--port', String(port),
  ]
}

function dshBinary(env) {
  return String(env.DSH_BIN ?? '').trim() || 'dsh'
}

/** Run the SPV browser host in the current terminal, teeing its output to the artifact log. */
export function runSpvWebForeground({ overlay, port, stateDir, log, env = process.env } = {}) {
  return new Promise(resolve => {
    mkdirSync(dirname(log), { recursive: true })
    const fd = openSync(log, 'a')
    const child = spawn(dshBinary(env), ['--profile', SPV_WEB_PROFILE_ID, '--patch', overlay, '--no-open'], {
      env: {
        ...env,
        [SPV_WEB_PORT_ENV]: String(port),
        DSH_SUPERAGENT_STATE_DIR: stateDir,
      },
      stdio: ['inherit', 'pipe', 'pipe'],
    })
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
