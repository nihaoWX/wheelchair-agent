/**
 * The dsh-independent half of the wheelchair-agent panel: the three exact JSON routes and their
 * handlers. It imports only pure Node modules from this repository — no `@deepseek-ai/*` — so the
 * same handlers serve the dsh plugin (`webui/lib/index.js`) and the standalone host
 * (`wheelchair-agent panel`).
 *
 * The host owns the security fence and the background effects:
 *   - the dsh host asks `ctx.connection.requestRejection` before every request;
 *   - the standalone host refuses non-loopback sockets and checks Host/Origin itself;
 *   - inbox polling, the hook runner, auto-merge and cold-install notices stay in the dsh plugin's
 *     host (see `ARCHITECTURE/webui/index.md`): without a deployment instance nothing merges or
 *     reminds, whether or not the panel is open.
 */
import { buildHookPanel } from '../shared/hooks.js'
import {
  SETTINGS_PATH,
  createSettingsHandler,
  ensureSettingsFile,
  resolveSettings,
} from '../shared/settings.js'
import { createInboxHandler, resolveInboxRoot, resolveInboxIntervalSeconds } from './inbox.js'
import { projectCards } from './projects-view.js'

export const ITEMS_PATH = '/wheelchair-inbox/items'
export const REVIEW_PATH = '/wheelchair-inbox/review'
export const PROJECTS_PATH = '/wheelchair-projects'
export { SETTINGS_PATH }

/**
 * Build the route handlers. `env` is passed explicitly rather than read at module scope so the
 * standalone panel can run a throwaway data root in tests, and the dsh plugin can pass
 * `process.env` exactly as before.
 */
export function createPanelHandlers({ env = process.env, home, stateDir, config = {}, decorate } = {}) {
  const rootOf = () => resolveInboxRoot({ env, home, stateDir })
  const inbox = createInboxHandler({ rootOf })
  // First run on an upgraded machine: ship the self-contained settings file (all defaults, marked
  // in `filled`) so neither host has to explain a missing file. A failure is a warning, not a
  // mount failure; the Settings page still works with fallback values and reports the write
  // problem on save.
  let settingsFileError = null
  try {
    ensureSettingsFile({ env, home, stateDir })
  } catch (error) {
    settingsFileError = error
  }
  const hookViewOf = snapshot => {
    try {
      return { ...snapshot, hookView: buildHookPanel({ settings: snapshot, env, home, stateDir }) }
    } catch (error) {
      return {
        ...snapshot,
        hookView: null,
        hookViewError: error instanceof Error ? error.message : String(error),
      }
    }
  }
  const settings = createSettingsHandler({
    home,
    stateDir,
    env,
    config,
    decorate: snapshot => (typeof decorate === 'function' ? decorate(snapshot) : hookViewOf(snapshot)),
  })
  const projects = async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' })
      res.end(`${JSON.stringify({ error: 'method not allowed' })}\n`)
      return
    }
    try {
      const body = await projectCards({ env, home, stateDir })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`${JSON.stringify(body)}\n`)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`)
    }
  }
  return {
    items: inbox,
    review: inbox,
    settings,
    projects,
    rootOf,
    settingsFileError,
    // `config` is the settings-shaped map ({"inbox.intervalSeconds": n}); the plugin's own
    // `{intervalSeconds}` option is translated by the host before it reaches this core.
    intervalSecondsOf: () => resolveInboxIntervalSeconds(config?.['inbox.intervalSeconds'], { env, home, stateDir }),
    settingsSnapshot: () => resolveSettings({ env, home, stateDir, config }),
  }
}

/** Only pass an interval that was actually configured; `undefined` would add a spurious warning. */
export function intervalConfig(config) {
  const seconds = config?.intervalSeconds
  return seconds === undefined || seconds === null ? {} : { 'inbox.intervalSeconds': seconds }
}

/** The route table, in registration order: method-agnostic handlers, like the dsh webServer rows. */
export function panelRouteTable(handlers) {
  return [
    { path: ITEMS_PATH, handler: handlers.items },
    { path: REVIEW_PATH, handler: handlers.review },
    { path: SETTINGS_PATH, handler: handlers.settings },
    { path: PROJECTS_PATH, handler: handlers.projects },
  ]
}
