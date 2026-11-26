#!/usr/bin/env node
/**
 * Write exactly one cold-install-refusal notice into the SPV outbox.
 *
 * `install.sh` calls this when the pre-flight finds that the files it installs are in use. The text is
 * read from stdin so the shell owns the operator-facing wording (it is the same text the terminal shows),
 * and `writeMessage()` from `src/shared/queue.js` is the supported channel into the SPV session: the
 * background injector in the running session consumes `outbox/` and pushes the notice into the
 * conversation. No other file format or queue path is invented here.
 *
 * The message id comes from the shell and is derived from the blockers, so two runs of the same refused
 * install overwrite one outbox file instead of stacking notices, while a changed blocker set (the service
 * restarted, the SPV session came or went) is a new notice. The file name is what the injector keys on,
 * so this is also safe across processes.
 *
 * The queue is resolved through the deployment registry: `install.sh` passes the project it inferred
 * (`--project <p>`), and the registry is the only source that names a deployment's queue. A cold install
 * can run before the first service start, so a missing registry, an unregistered project or an unknown
 * project is "nobody to notify yet", not a crash. Print one line and exit 0: a refusal must keep its exit
 * code 3 even when nobody can be notified. Any other write failure is reported on stderr with exit 1,
 * and `install.sh` downgrades it to a note for the same reason.
 */
import { stat } from 'node:fs/promises'
import { dirsOf, writeMessage } from '../src/shared/queue.js'
import { resolveRoot } from '../src/spv/paths.js'

/** Read all of stdin; the shell pipes the notice body in. */
async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** Split `--project <p>` / `--project=<p>` out of the arguments; anything else is a usage error. */
function parseArgs(argv) {
  let project = ''
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--project') {
      project = String(argv[index + 1] ?? '').trim()
      index += 1
      if (project === '') return { error: '--project needs a value' }
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length).trim()
      if (project === '') return { error: '--project needs a value' }
    } else {
      rest.push(arg)
    }
  }
  return { id: String(rest[0] ?? '').trim(), project }
}

/** One line: `install.sh` prints this as a `note:` and a multi-line error would break that shape. */
function oneLine(value) {
  return String(value?.message ?? value).replace(/\s+/g, ' ').trim()
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error !== undefined) {
    process.stderr.write(`usage: refusal-notice.mjs <message-id> [--project <project>] < notice-text (${parsed.error})\n`)
    return 2
  }
  const id = parsed.id
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    process.stderr.write('usage: refusal-notice.mjs <message-id> [--project <project>] < notice-text\n')
    return 2
  }
  const text = (await readStdin()).trim()
  if (text === '') {
    process.stderr.write('usage: refusal-notice.mjs <message-id> [--project <project>] < notice-text\n')
    return 2
  }
  // Resolve through the registry, the one deployment source. `install.sh` passes the project it
  // inferred; without it `resolveRoot()` refuses to guess between deployments, and that refusal is
  // also a "skipped:" line rather than a crash.
  let root
  try {
    root = resolveRoot({}, { project: parsed.project })
  } catch (error) {
    process.stdout.write(`skipped: ${oneLine(error)}\n`)
    return 0
  }
  const info = await stat(root).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    // One line, no queue is created: the refusal did not cause it, and creating one would write state
    // that the service would later treat as its own.
    process.stdout.write(`skipped: no spv queue at ${root} (the service has never run)\n`)
    return 0
  }
  const dirs = dirsOf(root)
  try {
    await writeMessage(dirs, {
      id,
      source: 'spv',
      thread: 'main',
      kind: 'notice',
      text,
      at: new Date().toISOString(),
      address: { thread: 'main' },
    })
  } catch (error) {
    process.stderr.write(`FAIL: could not write the SPV refusal notice: ${error?.message ?? error}\n`)
    return 1
  }
  process.stdout.write(`queued: ${dirs.outbox}/${id}.json\n`)
  return 0
}

process.exitCode = await main()
