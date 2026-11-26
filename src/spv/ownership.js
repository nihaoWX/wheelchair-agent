/**
 * Which deployment owns which project, and which deployment this process is.
 *
 * The registry (`<data root>/deployments.json`) is the only project list. This module answers the two
 * questions the inbox needs without adding registry fields:
 *
 *   - which running instance is this? The entry whose `queueDir` equals `$SPV_QUEUE_DIR`, the queue the
 *     launcher sets for this instance (`service start` from the project checkout). No match (no registry, no override,
 *     deleted entry) means "unknown": callers poll nothing and say why; the registry is the only source.
 *   - which project owns a repo? The local checkout is `<projectsRoot>/<project>`; its `origin` URL is the
 *     authoritative back-reference. When a project has no checkout to read, the repo name equal to the
 *     project's leaf name is the fallback (reported as such; no registry field is invented for it).
 *
 * Pure Node builtins, synchronous and bounded: the watcher calls this once per poll, not per PR.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { listDeployments } from '../shared/deployments.js'

/** `owner/name` from a GitHub remote URL; null for anything else. */
export function githubRemote(url) {
  const match = /^(?:https?:\/\/|git@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? '').trim())
  return match === null ? null : `${match[1]}/${match[2]}`
}

/** The project a repo belongs to, using the local checkout first and the repo-name leaf as fallback. */
export function projectForRepo(repo, { projectsRoot, deployments } = {}) {
  const wanted = String(repo ?? '').trim().toLowerCase()
  if (wanted === '') return null
  const entries = Array.isArray(deployments) ? deployments : []
  for (const entry of entries) {
    const local = join(projectsRoot, entry.project)
    let remote
    try {
      remote = execFileSync('git', ['-C', local, 'config', '--get', 'remote.origin.url'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      continue
    }
    if (githubRemote(remote)?.toLowerCase() === wanted) return entry.project
  }
  const leaf = wanted.split('/').pop()
  return entries.find(entry => entry.project.split('/').pop().toLowerCase() === leaf)?.project ?? null
}

/**
 * The registry entry of the running instance, or a reason why it cannot be identified.
 *
 * The launcher (`service start` from the project checkout) exports `SPV_QUEUE_DIR=<entry.queueDir>` for the instance, so
 * this is a plain reverse lookup. `queue` may be passed explicitly (tests, or a caller that resolved it
 * another way). `{entry: null, reason}` is not a fallback: the watcher polls nothing and logs the reason,
 * `spv_status` reports it as a problem, and `/restart-wheelchair-agent` refuses to guess.
 */
export function ownDeployment({ env = process.env, queue } = {}) {
  let registry
  try {
    registry = listDeployments({ env })
  } catch (error) {
    return { entry: null, registry: null, queue: null, reason: `cannot read the deployment registry: ${error.message}` }
  }
  if (!registry.exists) return { entry: null, registry, queue: null, reason: 'no deployment registry exists' }
  const fromEnv = String(queue ?? env.SPV_QUEUE_DIR ?? '').trim()
  if (fromEnv === '') {
    return {
      entry: null,
      registry,
      queue: null,
      reason: 'this instance has no SPV_QUEUE_DIR, so it cannot tell which deployment it is',
    }
  }
  const entry = registry.deployments.find(item => item.queueDir === fromEnv) ?? null
  return {
    entry,
    registry,
    queue: fromEnv,
    reason: entry === null ? `no registered deployment reads ${fromEnv}` : undefined,
  }
}
