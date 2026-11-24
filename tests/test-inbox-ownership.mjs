/**
 * Stage 3: one deployment owns its own projects.
 *
 * Every case uses temp directories and a fake `gh`, so no real inbox, registry, checkout or `git pull` is
 * touched. The fake `gh` only answers `pr list`; nothing in these cases reaches a merge transition.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendReview, pollOnce, writeItem } from '../src/spv/inbox.js'
import { ownDeployment, projectForRepo } from '../src/spv/ownership.js'

const PASS = []
function ok(name) {
  PASS.push(name)
  console.log(`PASS ${name}`)
}

function makeBox() {
  const base = mkdtempSync(join(tmpdir(), 'wca-owner-'))
  return {
    base,
    home: join(base, 'home'),
    dsh: join(base, 'dsh'),
    data: join(base, 'data'),
    stateA: join(base, 'state-a'),
    stateB: join(base, 'state-b'),
    stateC: join(base, 'state-c'),
    projects: join(base, 'projects'),
    inbox: join(base, 'inbox'),
    ghLog: join(base, 'gh.log'),
  }
}

function registry(box, entries) {
  mkdirSync(box.data, { recursive: true })
  writeFileSync(join(box.data, 'deployments.json'), `${JSON.stringify({ version: 1, deployments: entries }, null, 2)}\n`)
}

function entry(project, stateDir, port) {
  return { project, profile: 'superagent', stateDir, queueDir: join(stateDir, 'spv'), port, installedSha: null }
}

function repo(box, project, origin) {
  const dir = join(box.projects, project)
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin])
  return dir
}

function fakeGh(box, pulls) {
  const file = join(box.base, 'fake-gh.mjs')
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(box.ghLog)}, args.join(' ') + '\\n')
const repo = args[args.indexOf('--repo') + 1]
const pulls = ${JSON.stringify(pulls)}
process.stdout.write(JSON.stringify(pulls[repo] ?? []))
`)
  chmodSync(file, 0o755)
  return file
}

function pull(number, title) {
  return {
    number,
    title,
    state: 'OPEN',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    url: `https://github.com/acme/beta/pull/${number}`,
    body: '',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    mergedAt: '',
    mergeCommit: '',
  }
}

function pendingFiles(queueRoot) {
  try {
    return readdirSync(join(queueRoot, 'pending')).filter(name => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

function readPending(queueRoot) {
  return pendingFiles(queueRoot).map(name => JSON.parse(readFileSync(join(queueRoot, 'pending', name), 'utf8')))
}

function withEnv(box, extra = {}) {
  const saved = {}
  const values = {
    HOME: box.home,
    WHEELCHAIR_AGENT_HOME: box.data,
    DSH_HOME: box.dsh,
    DSH_SUPERAGENT_STATE_DIR: box.stateA,
    SPV_QUEUE_DIR: join(box.stateA, 'spv'),
    SPV_INBOX_DIR: box.inbox,
    SPV_PROJECTS_ROOT: box.projects,
    ...extra,
  }
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function testOwnProjectOnly() {
  const box = makeBox()
  const restore = withEnv(box)
  try {
    repo(box, 'tools/alpha', 'https://github.com/acme/alpha.git')
    repo(box, 'tools/beta', 'https://github.com/acme/beta.git')
    registry(box, [entry('tools/alpha', box.stateA, 3082), entry('tools/beta', box.stateB, 3083)])
    const gh = fakeGh(box, {
      'acme/alpha': [pull(1, 'alpha one')],
      'acme/beta': [pull(2, 'beta two')],
    })
    const logs = []
    const own = ownDeployment()
    assert.equal(own.entry?.project, 'tools/alpha')
    assert.equal(own.queue, join(box.stateA, 'spv'))
    assert.equal(projectForRepo('acme/beta', { projectsRoot: box.projects, deployments: own.registry.deployments }), 'tools/beta')

    await pollOnce({ root: box.inbox, projectsRoot: box.projects, gh, log: line => logs.push(line) })
    const items = readdirSync(box.inbox).filter(name => name.endsWith('.json'))
    assert.deepEqual(items, ['acme-alpha-1.json'], 'only the owned project produced an item')
    assert.ok(logs.some(line => line === 'skipping acme/beta: owned by deployment tools/beta'), 'beta was skipped by name')
    const calls = readFileSync(box.ghLog, 'utf8')
    assert.match(calls, /--repo acme\/alpha/)
    assert.doesNotMatch(calls, /--repo acme\/beta/, 'the other deployment is never asked for its PRs')
    ok('the watcher polls only the project of the deployment that reads this queue')
  } finally {
    restore()
    rmSync(box.base, { recursive: true, force: true })
  }
}

async function testNoRegistryPollsNothing() {
  const box = makeBox()
  const restore = withEnv(box)
  try {
    repo(box, 'tools/alpha', 'https://github.com/acme/alpha.git')
    repo(box, 'tools/beta', 'https://github.com/acme/beta.git')
    const gh = fakeGh(box, {
      'acme/alpha': [pull(1, 'alpha one')],
      'acme/beta': [pull(2, 'beta two')],
    })
    mkdirSync(box.inbox, { recursive: true })
    const logs = []
    await pollOnce({ root: box.inbox, projectsRoot: box.projects, gh, log: line => logs.push(line) })
    assert.deepEqual(readdirSync(box.inbox).filter(name => name.endsWith('.json')), [], 'nothing is polled')
    assert.ok(!existsSync(box.ghLog), 'gh was never called')
    assert.ok(
      logs.some(line => /ownership: no deployment registry exists; polling nothing until this instance can be identified/.test(line)),
      `the reason is stated once per poll, got ${JSON.stringify(logs)}`,
    )
    ok('without a registry the watcher polls nothing and states why')
  } finally {
    restore()
    rmSync(box.base, { recursive: true, force: true })
  }
}

async function testReviewForwarding() {
  const box = makeBox()
  const restore = withEnv(box)
  try {
    repo(box, 'tools/alpha', 'https://github.com/acme/alpha.git')
    repo(box, 'tools/beta', 'https://github.com/acme/beta.git')
    registry(box, [entry('tools/alpha', box.stateA, 3082), entry('tools/beta', box.stateB, 3083)])
    mkdirSync(box.inbox, { recursive: true })
    const betaItem = {
      id: 'acme-beta-7',
      kind: 'pr',
      repo: 'acme/beta',
      pr: 7,
      title: 'beta seven',
      state: 'OPEN',
      url: 'https://github.com/acme/beta/pull/7',
      at: '2026-11-01T00:00:00Z',
      review: [],
    }
    await writeItem(box.inbox, betaItem)
    await appendReview(box.inbox, { id: 'acme-beta-7', kind: 'issue', text: 'please fix X' })
    const forwarded = readPending(join(box.stateB, 'spv'))
    assert.equal(forwarded.length, 1, 'exactly one review message in the owning deployment queue')
    const message = forwarded[0]
    assert.equal(message.kind, 'review')
    assert.equal(message.project, 'tools/beta')
    assert.equal(message.repo, 'acme/beta')
    assert.equal(message.number, 7)
    assert.equal(message.verdict, 'issue')
    assert.equal(message.comment, 'please fix X')
    assert.match(message.text, /这是另一份部署转来的审查结论/)
    assert.match(message.text, /acme\/beta/)
    assert.match(message.text, /#7/)
    assert.deepEqual(pendingFiles(join(box.stateA, 'spv')), [], 'the reviewing deployment does not queue it locally')

    await appendReview(box.inbox, { id: 'acme-beta-7', kind: 'issue', text: 'please fix X' })
    assert.equal(readPending(join(box.stateB, 'spv')).length, 1, 'a retry overwrites the same review message')

    await appendReview(box.inbox, { id: 'acme-beta-7', kind: 'approve', text: 'looks good' })
    const afterApprove = readPending(join(box.stateB, 'spv'))
    assert.equal(afterApprove.length, 2)
    assert.ok(afterApprove.some(item => item.verdict === 'approve' && item.kind === 'review'))
    ok('a review of another deployment is forwarded once, idempotently, and never queued locally')
  } finally {
    restore()
    rmSync(box.base, { recursive: true, force: true })
  }
}

async function testOwnReviewStaysLocal() {
  const box = makeBox()
  const restore = withEnv(box)
  try {
    repo(box, 'tools/alpha', 'https://github.com/acme/alpha.git')
    registry(box, [entry('tools/alpha', box.stateA, 3082)])
    mkdirSync(box.inbox, { recursive: true })
    const item = {
      id: 'acme-alpha-1',
      kind: 'pr',
      repo: 'acme/alpha',
      pr: 1,
      title: 'alpha one',
      state: 'OPEN',
      url: 'https://github.com/acme/alpha/pull/1',
      at: '2026-11-01T00:00:00Z',
      review: [],
    }
    await writeItem(box.inbox, item)
    await appendReview(box.inbox, { id: 'acme-alpha-1', kind: 'issue', text: 'local problem' })
    assert.deepEqual(pendingFiles(join(box.stateA, 'spv')), [], 'the old path writes outbox, not pending')
    const outbox = readdirSync(join(box.stateA, 'spv', 'outbox')).filter(name => name.endsWith('.json'))
    assert.equal(outbox.length, 1, 'the owning deployment keeps the historical notice path')
    assert.ok(!readFileSync(join(box.stateA, 'spv', 'outbox', outbox[0]), 'utf8').includes('转来的审查结论'))
    ok('a review of the deployment\'s own project keeps the existing notice path')
  } finally {
    restore()
    rmSync(box.base, { recursive: true, force: true })
  }
}

async function main() {
  await testOwnProjectOnly()
  await testNoRegistryPollsNothing()
  await testReviewForwarding()
  await testOwnReviewStaysLocal()
  console.log(`ok (${PASS.length} passed)`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
