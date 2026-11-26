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
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
export function panelPort({ env = process.env, home, stateDir, migrate = true } = {}) {
  try {
    const settings = resolveSettings({ env, home, stateDir, migrate })
    const port = settings.effective?.['panel.port'] ?? settings.values?.['panel.port']
    return validPort(port) ? port : DEFAULT_PANEL_PORT
  } catch {
    return DEFAULT_PANEL_PORT
  }
}

/**
 * The configured panel port read without the settings layer.
 *
 * `resolveSettings` fills missing defaults on its first read and migrates the legacy settings file, which
 * is right for the CLI but wrong for `install.sh --check` (it must write nothing). This reads the file
 * as-is, falls back to the two environment names, and never writes.
 */
export function readOnlyPanelPort({ env = process.env, home, stateDir } = {}) {
  const candidates = [env.SPV_PANEL_PORT, env.WHEELCHAIR_PANEL_PORT]
  try {
    const file = dataPaths({ env, home, stateDir }).settings.current
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    candidates.push(parsed?.values?.['panel.port'])
  } catch {
    // No settings file yet (or an unreadable one): the runtime default applies.
  }
  for (const candidate of candidates) {
    if (validPort(candidate)) return candidate
  }
  return DEFAULT_PANEL_PORT
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

/**
 * Whether these argv belong to a panel host from before the panel became its own dsh instance
 * (#58). That host was `node .../cli.js panel --foreground --port 3080`: it mentions the panel but
 * carries no `--patch`, so a cold install that replaces `webui/lib/client.js` leaves it serving the
 * new bundle out of its old page shell (the TDZ `ReferenceError` the operator saw on 3080).
 *
 * A current panel instance always loads `panel.patch.yml`; anything without it is foreign to the
 * panel profile and is reported, never killed.
 */
export function looksLikeLegacyPanelHost(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false
  const words = argv.map(String)
  // The old host's shape: `node .../cli.js panel --foreground --port 3080`, or a bare
  // `panel --foreground` when it was started through the launcher.
  const cliPanel = words.some((word, index) => /(^|\/)cli\.js$/.test(word) && words[index + 1] === 'panel')
  const panelForeground = words.some((word, index) => word === 'panel' && words[index + 1] === '--foreground')
  if (!cliPanel && !panelForeground) return false
  // A current instance is `dsh --profile panel --patch <…>/panel.patch.yml`; never report it.
  const profilePanel = words.some(
    (word, index) => word === `--profile=${PANEL_PROFILE_ID}` || (word === '--profile' && words[index + 1] === PANEL_PROFILE_ID),
  )
  const overlay = words.some(word => word.endsWith('panel.patch.yml'))
  return !(profilePanel && overlay)
}

/**
 * Whether something answers HTTP on `port`: the status code, or null when nothing does.
 *
 * This is the liveness half of "who holds the port": `/proc` says *whose* process it is, this says
 * whether the port is actually being served right now. A port with no HTTP answer (closed, half-dead,
 * firewalled) is not worth reporting or signalling.
 */
export function probePanelHttp(port, { host = PANEL_HOST, timeoutMs = 800 } = {}) {
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

/** The PID listening on `port`; `SPV_INSTALL_PANEL_HOLDER` is the install-test seam. */
function portListenerPid(port, env) {
  const injected = String(env.SPV_INSTALL_PANEL_HOLDER ?? '').trim()
  if (injected !== '') {
    const pid = Number(injected)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }
  try {
    const result = spawnSync('ss', ['-lptnH', `sport = :${port}`], { encoding: 'utf8', timeout: 10_000 })
    if (result.error || typeof result.stdout !== 'string') return null
    const found = /\bpid=(\d+)/.exec(result.stdout)
    return found === null ? null : Number(found[1])
  } catch {
    return null
  }
}

/** `argv` of `pid` from `/proc` (or `WHEELCHAIR_PROC_ROOT`); empty when it cannot be read. */
export function cmdlineOfProcess(pid, { env = process.env } = {}) {
  const procRoot = String(env.WHEELCHAIR_PROC_ROOT ?? '').trim() || '/proc'
  try {
    return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * The old panel host holding the configured panel port, or null.
 *
 * `install.sh` prints the holder and the exact commands; it never signals it. A port held by the
 * current panel instance is normal and returns null because its argv carries the overlay.
 */
export async function legacyPanelHolder({ port, env = process.env, probe = probePanelHttp } = {}) {
  const chosen = port ?? panelPort({ env, migrate: false })
  if (!validPort(chosen)) return null
  // The seam stands in for the listener as a whole (port probe + PID), so tests never depend on a
  // real /proc entry or a real socket.
  const injected = String(env.SPV_INSTALL_PANEL_HOLDER ?? '').trim()
  let pid
  if (injected !== '') {
    pid = Number(injected)
    if (!Number.isInteger(pid) || pid <= 0) return null
  } else {
    if ((await probe(chosen)) === null) return null
    pid = portListenerPid(chosen, env)
    if (pid === null) return null
  }
  const argv = cmdlineOfProcess(pid, { env })
  if (!looksLikeLegacyPanelHost(argv)) return null
  return { port: chosen, pid, argv }
}

/** Whether `pid` still exists. `process.kill(pid, 0)` is the only portable probe here. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Stop the pre-#58 standalone panel host that holds `panel.port`, if there is one.
 *
 * `superagent-service.py --mode panel stop` only knows the panel-profile instance (profile + overlay),
 * so it answers "not running" while the old `node cli.js panel --foreground` host keeps the port. This
 * sends it SIGINT the same way the manager stops any other instance, and only when its cmdline already
 * looks like a panel host; a foreign listener is left alone. Returns `null` when there is nothing of
 * ours on the port, otherwise `{pid, port, stopped}`.
 */
export async function stopLegacyPanelHost({
  port,
  env = process.env,
  timeoutMs = 5_000,
  intervalMs = 2_000,
  probe = probePanelHttp,
} = {}) {
  const holder = await legacyPanelHolder({ port, env, probe })
  if (holder === null) return null
  try {
    process.kill(holder.pid, 'SIGINT')
  } catch (error) {
    return { ...holder, stopped: !alive(holder.pid), reason: error?.message ?? String(error) }
  }
  // Bounded wait, no SIGKILL: an operator-visible `kill -INT <pid>` is better than silently
  // escalating on a process we only guessed about.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(holder.pid)) return { ...holder, stopped: true }
    await sleep(Math.max(50, intervalMs))
  }
  return { ...holder, stopped: !alive(holder.pid) }
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

/*
 * Read-only check for `install.sh` (install and --check both print the same note): the port and the
 * PID of a pre-#58 panel host, as machine-readable `key=value` lines. Nothing is signalled or written;
 * an unreadable /proc, a missing settings file or a healthy current instance yields empty values.
 */
async function main() {
  if (process.argv[1] === undefined || process.argv[1] !== fileURLToPath(import.meta.url)) return
  if (process.argv[2] !== 'legacy-holder') return
  const holder = await legacyPanelHolder({ env: process.env, port: readOnlyPanelPort({ env: process.env }) })
  process.stdout.write(`panel_holder_port=${holder === null ? '' : holder.port}\n`)
  process.stdout.write(`panel_holder_pid=${holder === null ? '' : holder.pid}\n`)
}

await main()
