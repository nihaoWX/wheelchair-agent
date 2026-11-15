/**
 * Plugin entry of the `spv` Source: registers the kind and runs its polling loop.
 *
 * The loop reads `pending/` oldest first, hands each task to the Engine through `ctx.receive`, then renames the file into
 * `done/`. That rename is the consumed marker, so a crash replays at most the task that was in flight, and stable
 * Trigger ids make even that replay a `duplicate` rather than a second Ticket.
 */
import { join } from 'node:path'
import { Queue, SOURCE, health, spvKind, triggerOf } from './spv.js'
import { consumeTask, ensureDirs, pendingNames, quarantineTask, readTask } from '../shared/queue.js'
import { megabytes, reclaimWork, resolveWorkRoot } from '../shared/work.js'

export const name = 'wheelchair-agent-spv'
export const inject = ['orchestrator']
export { SOURCE, channelFor, spvKind, triggerOf } from './spv.js'

/** Consecutive failed rounds tolerated before the Source reports an error; one bad round retries quietly. */
const FAILURES_BEFORE_ERROR = 3

/** The reclaim pass belongs to one service start, not to every hot remount of the plugin. */
let reclaimedAtMount = false

export function apply(ctx) {
  const queue = new Queue()
  const kind = spvKind(queue)
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'spv: source kind')
  ctx.effect(() => {
    // `ctx.orchestrator.context(kind)` is the SourceContext; `sourceContext()` is not exported by the built package.
    const source = ctx.orchestrator.context(kind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, queue, controller.signal)
      .catch(error => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
  // Reclaim once at service start, where the mount path is the only one that can run before workers do. The call is
  // not awaited: a large directory, a slow disk or a failed gate must never delay or break the Source's own startup.
  if (!reclaimedAtMount) {
    reclaimedAtMount = true
    const skipDirectories = openTicketDirectories(ctx, kind)
    reclaimAtMount(ctx, { skipDirectories }).catch(error => {
      ctx.logger?.warn?.(`wheelchair-agent work gc failed: ${error?.message ?? error}`)
    })
  }
}

/**
 * Directories an open Ticket still owns. The mount sweep deletes a clone only when it is reproducible, but an open
 * Ticket will resume in its directory, so the mount path additionally keeps it; the CLI cannot see Ticket state and
 * stays as aggressive as the gate allows. This makes the mount strictly less aggressive, never more.
 */
function openTicketDirectories(ctx, kind) {
  try {
    const source = ctx.orchestrator.context(kind)
    return new Set(source.tickets.open().map(ticket => ticket.execution?.directory).filter(Boolean))
  } catch {
    return new Set()
  }
}

/**
 * One-shot reclamation at mount, through the same `src/shared/work.js` implementation as `wheelchair-agent work gc`.
 *
 * The orchestrator service is provided before setup runs, and its `machine.stateDir` plus the settings store are
 * constructed with it. When both are readable, the reclaim happens before setup resumes any worker — the moment the
 * assignment calls the safe one. If the plugin is mounted later (or the store is not ready), the resolved deployment
 * from the orchestrator service is used instead, still under the same gate. Gate 1 (no process cwd inside the
 * directory) is what keeps a live worker safe, not the mount timing.
 */
export async function reclaimAtMount(ctx, { skipDirectories = new Set() } = {}) {
  let stateDir = ''
  let directory = ''
  let early = false
  try {
    stateDir = String(ctx.orchestrator?.machine?.stateDir ?? '')
    const current = ctx.orchestrator?.settings?.current
    if (stateDir !== '' && typeof current === 'function') {
      directory = String(current.call(ctx.orchestrator.settings)?.executor?.directory ?? '')
      early = true
    }
  } catch {
    // A store that is not ready yet falls through to the resolved deployment below.
  }
  if (!early) {
    // A plugin context has no `ready`/`configured()`/`deployment`; those live on the orchestrator service.
    await ctx.orchestrator.ready
    if (!ctx.orchestrator.configured()) return
    stateDir = ctx.orchestrator.deployment.stateDir
    try {
      directory = String(ctx.orchestrator.settings.current()?.executor?.directory ?? '')
    } catch {
      // The default root is correct when the settings block cannot be read.
    }
  }
  const result = await reclaimWork({
    root: resolveWorkRoot({ stateDir, directory }),
    stateDir,
    skipDirectories,
  })
  ctx.logger?.info?.(
    `wheelchair-agent work gc: reclaimed ${result.reclaimed}, kept ${result.kept}, freed ${megabytes(result.freedBytes)} MB`,
  )
}

/** Resolve after `ms`, or at once when `signal` aborts; the timer is cleared so a stop does not wait. */
function delay(ms, signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

async function watch(ctx, queue, signal) {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is read.
  if (!ctx.configured()) {
    ctx.report(SOURCE, health('paused', 'setupPending'))
    return
  }
  // `stateDir` comes from the resolved deployment, so it is only readable once setup has completed.
  const stateDir = ctx.deployment.stateDir
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config(SOURCE)
    if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else {
      queue.resolve(config.queueDir, stateDir)
      const at = new Date().toISOString()
      try {
        const { read, taken, unreadable } = await pollQueue(ctx, queue, config, signal)
        failures = 0
        ctx.report(SOURCE, { state: 'ready', detail: `${read} tasks in the queue; ${taken} taken in, ${unreadable} unreadable`, at })
      } catch (error) {
        if (signal.aborted) break
        failures += 1
        // One transient failure is retried on the next round; three in a row need a person.
        if (failures >= FAILURES_BEFORE_ERROR) {
          ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((ctx.config(SOURCE)?.pollSeconds ?? 2) * 1000, signal)
  }
}

/**
 * One polling round: take in every waiting task, then rename it into `done/`.
 * A file that does not parse, or that names no text, is moved aside with a `.bad` suffix and counted, so it neither
 * blocks the round nor repeats.
 */
export async function pollQueue(ctx, queue, config, signal) {
  const dirs = queue.dirs()
  await ensureDirs(dirs)
  const names = await pendingNames(dirs)
  let taken = 0
  let unreadable = 0
  for (const name of names) {
    if (signal.aborted) return { read: names.length, taken, unreadable }
    const file = join(dirs.pending, name)
    let task
    try {
      task = await readTask(file)
    } catch {
      unreadable += 1
      await quarantineTask(file, dirs)
      continue
    }
    const trigger = triggerOf(task, name, config)
    if (!trigger) {
      unreadable += 1
      await quarantineTask(file, dirs)
      continue
    }
    await ctx.receive(trigger)
    // Describe the Thread so the panel shows a readable label instead of the raw key.
    ctx.threads.describe(`${SOURCE}:${trigger.threads[0].id}`, {
      label: `spv ${trigger.threads[0].id}`,
      facts: { actor: { value: trigger.actor.id } },
    })
    await consumeTask(file, dirs)
    taken += 1
  }
  return { read: names.length, taken, unreadable }
}
