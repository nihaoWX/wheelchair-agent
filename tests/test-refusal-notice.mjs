#!/usr/bin/env node
/**
 * tests/test-refusal-notice.mjs — offline evidence for the cold-install refusal notice.
 *
 * `install.sh` calls `build/refusal-notice.mjs` after a refusal. Since #48 the deployment registry is
 * the only source of a queue: the helper must ask the registry for the project's queue instead of
 * calling `resolveRoot()` with no deployment context (which threw, so the notice was never sent).
 *
 * Everything runs in `mkdtemp` sandboxes with `SPV_QUEUE_DIR` removed: no dsh, no service, no real
 * data root. Covered here:
 *   - no registry yet (a cold install before the first service start) prints one `skipped:` line,
 *     exits 0, and creates no queue;
 *   - a registered project whose queue directory does not exist is skipped the same way;
 *   - an unregistered project, or no project at all, is skipped rather than crashing;
 *   - an existing queue gets exactly one outbox `notice` with the piped text, and repeating the same
 *     id overwrites that one file instead of stacking notices;
 *   - bad arguments still exit 2 with usage on stderr.
 *
 * Usage: node tests/test-refusal-notice.mjs
 * Exit status: 0 when every check passes, 1 otherwise.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dirsOf } from '../src/shared/queue.js'

const NOTICE = fileURLToPath(new URL('../build/refusal-notice.mjs', import.meta.url))
const BODY = 'Cold install refused: the wheelchair-agent install targets are in use.\n'
const PROJECT = 'tools/alpha'

let pass = 0
let fail = 0

async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${name}`)
    console.log(`      ${String(error?.message ?? error).split('\n').join('\n      ')}`)
  }
}

/** A sandbox env with the explicit queue overrides removed, so only the registry can resolve a queue. */
function envFor(sandbox) {
  const env = {
    ...process.env,
    HOME: join(sandbox, 'home'),
    WHEELCHAIR_AGENT_HOME: join(sandbox, 'home'),
    DSH_HOME: join(sandbox, 'dsh'),
  }
  delete env.SPV_QUEUE_DIR
  delete env.DSH_SUPERAGENT_STATE_DIR
  delete env.SPV_INBOX_DIR
  return env
}

function run(args, { sandbox, input = BODY } = {}) {
  return spawnSync(process.execPath, [NOTICE, ...args], {
    encoding: 'utf8',
    input,
    env: envFor(sandbox),
  })
}

/**
 * Write a registry with one entry. A deployment's queue is always `<stateDir>/spv` (the registry
 * refuses any other value), so the helper returns that queue path.
 */
async function writeRegistry(sandbox, project = PROJECT) {
  const home = join(sandbox, 'home')
  const stateDir = join(sandbox, 'state')
  const queueDir = join(stateDir, 'spv')
  await mkdir(home, { recursive: true })
  await writeFile(
    join(home, 'deployments.json'),
    JSON.stringify({
      version: 1,
      deployments: [{ project, profile: 'superagent', stateDir, queueDir, port: 3101 }],
    }),
  )
  return queueDir
}

async function listOrEmpty(dir) {
  return readdir(dir).catch(() => [])
}

const sandboxes = []
async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'wca-refusal-notice-'))
  sandboxes.push(dir)
  return dir
}

try {
  await check('no registry, no project: one skipped line, exit 0, and no queue is created', async () => {
    const box = await sandbox()
    const result = run(['install-cold-refusal-1'], { sandbox: box })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /^skipped: cannot tell which deployment this process belongs to/)
    assert.equal(result.stderr, '')
    assert.deepEqual(await listOrEmpty(join(box, 'state')), [])
  })

  await check('no registry, named project: skipped through the registry error, exit 0', async () => {
    const box = await sandbox()
    const result = run(['install-cold-refusal-2', '--project', PROJECT], { sandbox: box })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /^skipped: .*deployment registry.*does not exist|^skipped: .*no deployment registry/)
    assert.equal(result.stderr, '')
  })

  await check('registered project, queue directory absent: skipped, exit 0, nothing created', async () => {
    const box = await sandbox()
    const queue = await writeRegistry(box)
    const result = run(['install-cold-refusal-3', '--project', PROJECT], { sandbox: box })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(result.stdout, `skipped: no spv queue at ${queue} (the service has never run)\n`)
    assert.equal(result.stderr, '')
    assert.deepEqual(await listOrEmpty(queue), [])
  })

  await check('unregistered project: skipped, exit 0, no queue created', async () => {
    const box = await sandbox()
    const queue = await writeRegistry(box, 'tools/other')
    const result = run(['install-cold-refusal-4', '--project', PROJECT], { sandbox: box })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /^skipped: .*tools\/alpha/)
    assert.match(result.stdout, /deployment add/)
    assert.deepEqual(await listOrEmpty(queue), [])
  })

  await check('existing queue: one notice with the piped text and a single file per id', async () => {
    const box = await sandbox()
    const queue = await writeRegistry(box)
    const id = 'install-cold-refusal-5'
    await mkdir(queue, { recursive: true })

    const first = run([id, '--project', PROJECT], { sandbox: box })
    assert.equal(first.status, 0, first.stdout + first.stderr)
    const dirs = dirsOf(queue)
    assert.equal(first.stdout, `queued: ${dirs.outbox}/${id}.json\n`)
    assert.deepEqual(await readdir(dirs.outbox), [`${id}.json`])
    const message = JSON.parse(await readFile(join(dirs.outbox, `${id}.json`), 'utf8'))
    assert.equal(message.id, id)
    assert.equal(message.kind, 'notice')
    assert.equal(message.thread, 'main')
    assert.equal(message.source, 'spv')
    assert.equal(message.text, BODY.trim())
    assert.equal(message.address.thread, 'main')

    // The same blockers (same id) replace the file instead of stacking a second notice.
    const second = run([id, '--project=' + PROJECT], { sandbox: box, input: BODY + 'second refusal\n' })
    assert.equal(second.status, 0, second.stdout + second.stderr)
    assert.deepEqual(await readdir(dirs.outbox), [`${id}.json`])
  })

  await check('queue path is taken from the registry, not from the caller', async () => {
    const box = await sandbox()
    const queue = await writeRegistry(box)
    await mkdir(queue, { recursive: true })
    const result = run(['install-cold-refusal-6'], {
      sandbox: box,
      input: BODY,
    })
    // No project argument: the registry cannot be guessed from, so this must be skipped, not queued.
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /^skipped: cannot tell which deployment/)
  })

  await check('bad arguments exit 2 with usage on stderr', async () => {
    const box = await sandbox()
    for (const args of [[], ['bad id'], ['id', '--project'], ['id', '--project=']]) {
      const result = run(args, { sandbox: box })
      assert.equal(result.status, 2, `args ${JSON.stringify(args)} -> ${result.status}`)
      assert.match(result.stderr, /usage:/)
      assert.equal(result.stdout, '')
    }
    const empty = run(['install-cold-refusal-7'], { sandbox: box, input: '   \n' })
    assert.equal(empty.status, 2)
    assert.match(empty.stderr, /usage:/)
  })
} finally {
  for (const dir of sandboxes) await rm(dir, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
