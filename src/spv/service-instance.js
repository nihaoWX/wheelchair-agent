/**
 * How one deployment is handed to the service manager.
 *
 * `service start|stop|status|restart` and the dispatch path must describe the same instance in exactly the
 * same way: the profile, the instance overlay, the deployment's state/queue directories, its log and port.
 * Keeping the argv here means on-demand start (dispatch) cannot drift from `wheelchair-agent service start`.
 *
 * The manager itself is `commands/superagent-service.py` next to the repository/installed preset root; the
 * relative path is the same in a checkout (`src/spv/` -> `commands/`) and in an installed copy.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { deploymentSlug, instancePath } from '../shared/deployments.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** `commands/superagent-service.py` in both a checkout and an installed preset. */
export const SERVICE_MANAGER = join(HERE, '..', '..', 'commands', 'superagent-service.py')

/** The DSH home whose `.artifacts/` holds the instance logs. */
export function dshHomeOf(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

/** The manager arguments for one deployment, with `rest` in front (`start`, `status`, ...). */
export function deploymentServiceArgs(entry, rest = [], { env = process.env } = {}) {
  if (entry.port === null || entry.port === undefined) {
    throw new Error(
      `deployment ${JSON.stringify(entry.project)} has no port, so it has no instance to address: run ` +
        `"wheelchair-agent deployment add ${entry.project} --port <n>" and start the deployment again.`,
    )
  }
  const instance = instancePath(entry.project, { env })
  if (!existsSync(instance)) {
    throw new Error(
      `the instance overlay for ${JSON.stringify(entry.project)} is missing at ${instance}: run ` +
        `"wheelchair-agent deployment add ${entry.project}" to render it from the registry.`,
    )
  }
  const slug = deploymentSlug(entry.project)
  return [
    ...rest,
    '--profile', entry.profile,
    '--patch', instance,
    '--session', `wca-${slug}`,
    '--state-dir', entry.stateDir,
    '--queue-dir', entry.queueDir,
    '--log', join(dshHomeOf(env), '.artifacts', `wca-${slug}.log`),
    '--url', deploymentUrl(entry),
    '--port', String(entry.port),
  ]
}

/** The deployment's own instance URL; never the global service URL. */
export function deploymentUrl(entry) {
  return `http://127.0.0.1:${entry.port}`
}

/**
 * Run the manager for one deployment. The caller decides how output is handled (`inherit` for the CLI,
 * `pipe` when the result must fit into an error), but the argv always comes from `deploymentServiceArgs`.
 */
export function runDeploymentService(entry, rest = [], { env = process.env, stdio = 'inherit' } = {}) {
  if (!existsSync(SERVICE_MANAGER)) {
    throw new Error(
      `the service manager is missing at ${SERVICE_MANAGER}: run "bash install.sh --project <project>" ` +
        'from the wheelchair-agent checkout to install it.',
    )
  }
  const child = spawnSync('python3', [SERVICE_MANAGER, ...deploymentServiceArgs(entry, rest, { env })], {
    stdio,
    env,
    encoding: 'utf8',
  })
  if (child.error) throw new Error(`cannot run the service manager: ${child.error.message}`)
  return child
}
