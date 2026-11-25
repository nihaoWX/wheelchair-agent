/**
 * The standalone wheelchair-agent panel: a loopback-only HTTP host for the same three JSON routes the
 * dsh plugin serves, plus the existing dsh-client bundle. It imports no `@deepseek-ai/*` package and
 * no dsh service; the background work (inbox polling, hook runner, auto-merge, cold-install notices)
 * deliberately stays in each deployment's dsh plugin — see `ARCHITECTURE/webui/index.md`.
 *
 * Lifecycle:
 *   - `panel --foreground` owns the process: writes `<data root>/panel.pid` after listening and
 *     removes it on SIGINT/SIGTERM;
 *   - `panel --detach` spawns the same CLI with `--foreground`, detached from the terminal, and polls
 *     until the page answers (or the child exits);
 *   - `panel stop` sends SIGTERM to the recorded pid and waits for the port to close.
 *
 * `service open` talks only to this module: it starts the panel when stopped and opens its URL, never
 * an instance's token URL.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dataPaths } from '../shared/home.js'
import { resolveSettings } from '../shared/settings.js'
import { createPanelHandlers, panelRouteTable } from './panel-routes.js'
import { PANEL_SHELL_HTML } from './panel-shell.js'

export const PANEL_HOST = '127.0.0.1'
export const DEFAULT_PANEL_PORT = 3080
export const PANEL_PID_FILE = 'panel.pid'

const READY_TIMEOUT_MS = 8000
const READY_INTERVAL_MS = 120
const STOP_TIMEOUT_MS = 5000
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const CHECKOUT_WEBUI = join(MODULE_DIR, '..', '..', 'webui')

/**
 * Locate the browser bundle and its vendored React.
 *
 * In a checkout the bundle is `<repo>/webui/lib/client.js`; in an installed preset `panel.js` lives
 * under `<preset>/src/spv/`, while the webui package sits in the profile's `node_modules` next to
 * the preset. The caller (`bin/wheelchair-agent.mjs`) passes `clientPath` for the installed case; the
 * fallbacks keep direct imports (tests, `node src/spv/panel.js`) usable from the checkout.
 */
export function resolvePanelAssets(options = {}) {
  const { env = process.env, clientPath, vendorDir } = options
  const candidates = []
  if (typeof clientPath === 'string' && clientPath !== '') candidates.push(clientPath)
  const override = String(env.WHEELCHAIR_AGENT_WEBUI ?? '').trim()
  if (override !== '') candidates.push(join(override, 'lib', 'client.js'))
  candidates.push(join(CHECKOUT_WEBUI, 'lib', 'client.js'))
  const profile = String(env.DSH_SUPERAGENT_PROFILE ?? '').trim() || 'superagent'
  const dshHome = String(env.DSH_HOME ?? '').trim() || join(env.HOME ?? '', '.dsh')
  candidates.push(join(dshHome, 'profiles', profile, 'node_modules', 'wheelchair-agent-webui', 'lib', 'client.js'))
  const client = candidates.find(candidate => existsSync(candidate))
  if (client === undefined) {
    throw new Error(`cannot find the panel client bundle; tried ${candidates.join(', ')}. Run "bash install.sh --project <project>" (or set WHEELCHAIR_AGENT_WEBUI) to install it.`)
  }
  return {
    clientPath: client,
    vendorDir: typeof vendorDir === 'string' && vendorDir !== '' ? vendorDir : join(dirname(dirname(client)), 'vendor'),
  }
}

const STATIC_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** The configured panel port, falling back to 3080 when the settings file has no usable value. */
export function panelPort({ env = process.env, home, stateDir } = {}) {
  try {
    const settings = resolveSettings({ env, home, stateDir })
    // effective already folds the env override (`SPV_PANEL_PORT`) and the stored default, while
    // `values` holds only explicit user writes.
    const port = settings.effective?.['panel.port'] ?? settings.values?.['panel.port']
    return validPort(port) ? port : DEFAULT_PANEL_PORT
  } catch {
    return DEFAULT_PANEL_PORT
  }
}

export function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

export function panelPidPath({ env = process.env, home, stateDir } = {}) {
  return join(dataPaths({ env, home, stateDir }).root, PANEL_PID_FILE)
}

export function panelLogPath({ env = process.env, home, stateDir } = {}) {
  return join(dataPaths({ env, home, stateDir }).logs, 'panel.log')
}

export function readPanelState({ env = process.env, home, stateDir } = {}) {
  try {
    const state = JSON.parse(readFileSync(panelPidPath({ env, home, stateDir }), 'utf8'))
    if (typeof state?.pid === 'number' && validPort(state.port)) return state
  } catch {
    // Missing or malformed: report "stopped" and let start overwrite it.
  }
  return null
}

function writePanelState(state, options) {
  const file = panelPidPath(options)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp.${process.pid}`
  writeFileSync(temporary, JSON.stringify({ version: 1, ...state }), { mode: 0o644 })
  chmodSync(temporary, 0o644)
  renameSync(temporary, file)
}

function clearPanelState(options) {
  try {
    unlinkSync(panelPidPath(options))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export function panelUrl(port) {
  return `http://${PANEL_HOST}:${port}/`
}

/** A cheap liveness probe: the page is served even when the inbox/settings store is temporarily broken. */
export async function probePanel(port, { timeoutMs = 800, path = '/' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://${PANEL_HOST}:${port}${path}`, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'text/html' },
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function kill(pid, signal = 'SIGTERM') {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
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

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/**
 * Build the HTTP server. Loopback binding is necessary but not sufficient (DNS rebinding points a
 * browser at 127.0.0.1), so every request must also present the loopback Host and, when a browser
 * sends one, a same-origin Origin. The dsh host keeps its own connection fence; this one is the
 * standalone host's equivalent.
 */
export function createPanelServer(options = {}) {
  const { env = process.env, home, stateDir, config = {}, log = () => {} } = options
  const assets = resolvePanelAssets(options)
  const handlers = createPanelHandlers({ env, home, stateDir, config })
  const routes = panelRouteTable(handlers)
  const server = createServer((req, res) => {
    void handle(req, res)
  })

  let boundPort = 0
  const sameOrigin = value => {
    try {
      const origin = new URL(value)
      return origin.protocol === 'http:' && origin.hostname === PANEL_HOST && Number(origin.port) === boundPort
    } catch {
      return false
    }
  }
  const hostAllowed = req => {
    const host = String(req.headers.host ?? '')
    return host === `${PANEL_HOST}:${boundPort}` || host === `localhost:${boundPort}`
  }
  const reject = (res, status, message) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, message }))
  }
  const serveStatic = (res, file, contentType) => {
    let body
    try {
      body = readFileSync(file)
    } catch (error) {
      log(`panel asset ${file} is unreadable: ${error?.message ?? error}`)
      return reject(res, 500, `panel asset ${file} is unreadable; reinstall the webui package`)
    }
    res.statusCode = 200
    res.setHeader('content-type', contentType)
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  }

  async function handle(req, res) {
    if (!hostAllowed(req)) return reject(res, 403, 'the panel only answers its loopback host')
    const origin = req.headers.origin
    if (origin !== undefined && !sameOrigin(origin)) return reject(res, 403, 'cross-origin requests are refused')
    const path = new URL(req.url ?? '/', `http://${PANEL_HOST}:${boundPort}`).pathname
    if (path === '/' || path === '/index.html') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(PANEL_SHELL_HTML)
      return
    }
    if (path === '/client.js') {
      serveStatic(res, assets.clientPath, 'text/javascript; charset=utf-8')
      return
    }
    if (path === '/vendor/react.production.min.js') {
      serveStatic(res, join(assets.vendorDir, 'react.production.min.js'), 'text/javascript; charset=utf-8')
      return
    }
    if (path === '/vendor/react-dom.production.min.js') {
      serveStatic(res, join(assets.vendorDir, 'react-dom.production.min.js'), 'text/javascript; charset=utf-8')
      return
    }
    if (path === '/vendor/LICENSE.react' || path === '/vendor/LICENSE.react-dom' || path === '/vendor/README.md') {
      const name = path.slice('/vendor/'.length)
      serveStatic(res, join(assets.vendorDir, name), STATIC_TYPES[name.slice(name.lastIndexOf('.'))] ?? 'text/plain; charset=utf-8')
      return
    }
    if (path === '/favicon.ico') {
      res.statusCode = 204
      res.end()
      return
    }
    const route = routes.find(item => item.path === path)
    if (route === undefined) return reject(res, 404, `no route ${path}`)
    try {
      await route.handler(req, res)
    } catch (error) {
      log(`panel route ${path} failed: ${error?.message ?? error}`)
      if (!res.headersSent) reject(res, 500, error?.message ?? String(error))
      else res.end()
    }
  }

  return {
    server,
    handlers,
    listen(port = DEFAULT_PANEL_PORT) {
      return new Promise((resolve, reject) => {
        const fail = error => reject(error)
        server.once('error', fail)
        server.listen(port, PANEL_HOST, () => {
          server.removeListener('error', fail)
          boundPort = server.address().port
          resolve(boundPort)
        })
      })
    },
  }
}

/** Run in the foreground until SIGINT/SIGTERM; writes the pid file once listening. */
export async function runPanelForeground(options = {}) {
  const { env = process.env, port, log = message => process.stdout.write(`${message}\n`) } = options
  const chosen = port === 0 ? 0 : validPort(port) ? port : panelPort(options)
  const existing = readPanelState(options)
  if (existing !== null && alive(existing.pid) && (await probePanel(existing.port))) {
    log(`panel already running on ${panelUrl(existing.port)} (pid ${existing.pid})`)
    return 0
  }
  const panel = createPanelServer({ ...options, log })
  let bound
  try {
    bound = await panel.listen(chosen)
  } catch (error) {
    log(`FAIL: cannot listen on ${PANEL_HOST}:${chosen}: ${error?.message ?? error}`)
    log('fix: stop the process using that port, or set "panel.port" in the settings file, then retry')
    return 1
  }
  writePanelState({ pid: process.pid, port: bound, startedAt: new Date().toISOString() }, options)
  log(`panel listening on ${panelUrl(bound)}`)
  const stop = () => {
    clearPanelState(options)
    panel.server.close()
    setTimeout(() => panel.server.closeAllConnections?.(), 300).unref()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // Keep the event loop alive through the server; the CLI decides when the process exits.
  return new Promise(resolve => {
    panel.server.once('close', () => {
      clearPanelState(options)
      resolve(0)
    })
  })
}

/** Start a detached foreground panel and wait until its page answers. */
export async function startPanelDetached(options = {}) {
  const { env = process.env, port, log = message => process.stdout.write(`${message}\n`) } = options
  const chosen = validPort(port) ? port : panelPort(options)
  const existing = readPanelState(options)
  if (existing !== null && alive(existing.pid) && (await probePanel(existing.port))) return { ...existing, started: false }
  if (await probePanel(chosen)) {
    // Another process owns the port but left no state file. Refuse instead of silently shadowing it.
    throw new Error(`port ${chosen} is already serving a page but has no panel pid file; stop that process or choose another --port`)
  }
  const logPath = panelLogPath(options)
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'a', 0o644)
  try {
    const child = spawn(process.execPath, [process.argv[1], 'panel', '--foreground', '--port', String(chosen)], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...env },
    })
    child.unref()
  } finally {
    closeSync(fd)
  }
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const state = readPanelState(options)
    if (state !== null && alive(state.pid) && (await probePanel(state.port))) return { ...state, started: true }
    await sleep(READY_INTERVAL_MS)
  }
  throw new Error(`the panel did not start within ${READY_TIMEOUT_MS / 1000}s; see ${logPath}`)
}

/** Stop the recorded panel process and wait for its port to stop answering. */
export async function stopPanel(options = {}) {
  const { log = message => process.stdout.write(`${message}\n`) } = options
  const state = readPanelState(options)
  if (state === null) {
    clearPanelState(options)
    log('panel is not running')
    return 0
  }
  const stopped = await stopPid(state.pid, state.port, options)
  if (!stopped) {
    log(`FAIL: the panel (pid ${state.pid}) did not stop; kill it by hand if it is still serving ${panelUrl(state.port)}`)
    return 1
  }
  log(`panel stopped (was listening on ${panelUrl(state.port)})`)
  return 0
}

async function stopPid(pid, port, options) {
  if (alive(pid)) kill(pid, 'SIGTERM')
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!alive(pid)) break
    await sleep(READY_INTERVAL_MS)
  }
  if (alive(pid)) {
    kill(pid, 'SIGKILL')
    await sleep(READY_INTERVAL_MS)
  }
  if (alive(pid)) return false
  clearPanelState(options)
  // A dead process releases its socket immediately; the probe is only a readiness fence.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!(await probePanel(port, { timeoutMs: 200 }))) return true
    await sleep(100)
  }
  return true
}

/**
 * `service open`: make sure the panel is running, then open it in the operator's browser. The
 * opener is injectable through WHEELCHAIR_AGENT_OPEN (used by tests and non-desktop SSH sessions);
 * a missing opener still prints the URL and succeeds.
 */
export async function openPanel(options = {}) {
  const { env = process.env, port, log = message => process.stdout.write(`${message}\n`) } = options
  const chosen = validPort(port) ? port : panelPort(options)
  let state = readPanelState(options)
  if (state === null || !alive(state.pid) || !(await probePanel(state.port))) {
    state = await startPanelDetached({ ...options, port: chosen })
    log(state.started ? `started the panel on ${panelUrl(state.port)} (pid ${state.pid})` : `panel already running on ${panelUrl(state.port)} (pid ${state.pid})`)
  }
  const url = panelUrl(state.port)
  log(url)
  const opener = String(env.WHEELCHAIR_AGENT_OPEN ?? '').trim()
  if (opener !== '') {
    const result = spawnSync(opener, [url], { env, stdio: 'ignore' })
    if (result.status !== 0) log(`note: the opener "${opener}" exited ${result.status ?? 'without a status'}; open the URL above by hand`)
    return 0
  }
  const platform = process.platform
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const result = spawnSync(command, args, { env, stdio: 'ignore' })
  if (result.error !== undefined || result.status !== 0) {
    log(`note: could not open a browser (${result.error?.message ?? `exit ${result.status}`}); open the URL above by hand`)
  }
  return 0
}

export function panelStatusLine(options = {}) {
  const port = panelPort(options)
  const state = readPanelState(options)
  if (state !== null && alive(state.pid)) return `panel:  port ${state.port}  running  ${state.pid}`
  return `panel:  port ${port}  stopped  -`
}
