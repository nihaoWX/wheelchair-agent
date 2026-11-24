/**
 * Which deployment owns which project, and which deployment this process is.
 *
 * The registry (`<data root>/deployments.json`) is the only project list. This module answers the two
 * questions the inbox needs without adding registry fields:
 *
 *   - which running instance is this? The entry whose `queueDir` equals the queue this process reads
 *     (`resolveRoot()`). No match (old install, no registry, deleted entry, `$SPV_QUEUE_DIR` override) means
 *     "unknown": callers keep the pre-stage-3 behavior instead of guessing;
 *   - which project owns a repo? The local checkout is `<projectsRoot>/<project>`; its `origin` URL is the
 *     authoritative back-reference. When a project has no checkout to read, the repo name equal to the
 *     project's leaf name is the fallback (reported as such; no registry field is invented for it).
 *
 * Pure Node builtins, synchronous and bounded: the watcher calls this once per poll, not per PR.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { listDeployments } from '../shared/deployments.js'
import { resolveRoot } from './paths.js'

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
 * `{entry: null, reason}` is the degradation path: the caller keeps polling every project and logs the
 * reason once per poll. `queue` is the effective queue this process reads, useful in that log line.
 */
export function ownDeployment({ env = process.env } = {}) {
  let registry
  try {
    registry = listDeployments({ env })
  } catch (error) {
    return { entry: null, registry: null, queue: null, reason: `cannot read the deployment registry: ${error.message}` }
  }
  if (!registry.exists) return { entry: null, registry, queue: null, reason: 'no deployment registry exists' }
  let queue
  try {
    queue = resolveRoot()
  } catch (error) {
    return { entry: null, registry, queue: null, reason: `cannot resolve this queue: ${error.message}` }
  }
  const entry = registry.deployments.find(item => item.queueDir === queue) ?? null
  return {
    entry,
    registry,
    queue,
    reason: entry === null ? `no registered deployment reads ${queue}` : undefined,
  }
}
