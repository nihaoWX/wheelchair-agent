#!/usr/bin/env node
/**
 * tests/test-inbox-refresh.mjs：收件箱自动刷新、合并拉取与合并状态的离线证据。
 *
 * 覆盖：
 *   - `startInboxWatcher()` 不用人手就轮询并刷新 item，`stop()` 后不再轮询；
 *   - 一个 MERGED PR 只做一次 `git pull --ff-only`、只写一条冷安装 notice；重复轮询与“重启”
 *     （再起一个 watcher）都不再做第二次；
 *   - 拉取失败（脏工作区）把原因写进 item、保留脏文件、后续轮询重试；清理树后可完成并写 notice；
 *   - notice 写入失败保留已拉到的 sha，后续只重试 notice、不重复 pull；
 *   - 一个 gh 仓库失败只记 warning，其他仓库继续刷新；
 *   - MERGED 但没有 review 的 PR 仍是 pending；PR state 由 `stateOf()` 单独提供（open/merged/closed）；
 *   - 升级前就已经 MERGED 的 item 不会被当成新合并重放；
 *   - host 半身通过 `ctx.effect` 启动同一个循环，能解析 core 副本的导入；
 *   - `research/` 不会被轮询或拉取；
 *   - 间隔配置的默认值、环境变量覆盖与 0（关闭）。
 *
 * 全程离线：假 `gh` 只 `cat` 一份 JSON；假 `git` 只记录参数再 exec 真 git；拉取通过仓库本地的
 * `url.<local-bare>.insteadOf` 指向 `mkdtemp` 里的 bare 仓库，不访问 github.com，不需要凭据。
 *
 * 用法：node tests/test-inbox-refresh.mjs（任一断言失败则 exit 1）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  INBOX_INTERVAL_DEFAULT,
  discoverRepos,
  readItem,
  resolveInboxIntervalSeconds,
  startInboxWatcher,
} from '../src/spv/inbox.js'

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
const REPO = fileURLToPath(new URL('..', import.meta.url))
const SANDBOXES = []

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(5)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** Run the real git binary; test setup must never go through the logging wrapper. */
function git(args, options = {}) {
  return execFileSync(REAL_GIT, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function gitIn(dir, ...args) {
  return git(['-C', dir, ...args])
}

async function writeJson(file, value) {
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/** A fake `gh`: append its arguments to the log, then print the current fixture JSON. */
async function writeFakeGh(box) {
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ -n "$FAKE_GH_FAIL_REPO" ]; then
  case "$*" in
    *"$FAKE_GH_FAIL_REPO"*) exit 1 ;;
  esac
fi
cat "$FAKE_GH_JSON"
`
  await writeFile(join(box.bin, 'gh'), script, 'utf8')
  await chmod(join(box.bin, 'gh'), 0o755)
}

/** A fake `git` that records every call and then execs the real binary. */
async function writeFakeGit(box) {
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
exec "$REAL_GIT" "$@"
`
  await writeFile(join(box.bin, 'git'), script, 'utf8')
  await chmod(join(box.bin, 'git'), 0o755)
}

async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'wheelchair-agent-inbox-refresh-test-'))
  SANDBOXES.push(base)
  const box = {
    base,
    bin: join(base, 'bin'),
    projects: join(base, 'projects'),
    tools: join(base, 'projects', 'tools'),
    remotes: join(base, 'remotes'),
    inbox: join(base, 'inbox'),
    queue: join(base, 'queue'),
    ghJson: join(base, 'gh.json'),
    ghLog: join(base, 'gh-calls.log'),
    gitLog: join(base, 'git-calls.log'),
  }
  for (const dir of [box.bin, box.tools, join(base, 'projects', 'research'), box.remotes]) {
    await mkdir(dir, { recursive: true })
  }
  await writeFile(box.ghLog, '', 'utf8')
  await writeFile(box.gitLog, '', 'utf8')
  await writeFakeGh(box)
  await writeFakeGit(box)
  box.gh = join(box.bin, 'gh')
  // The watcher (and the fake git it executes) sees these; setup uses REAL_GIT directly.
  process.env.PATH = `${box.bin}${delimiter}${process.env.PATH}`
  process.env.FAKE_GH_JSON = box.ghJson
  process.env.FAKE_GH_LOG = box.ghLog
  process.env.FAKE_GIT_LOG = box.gitLog
  process.env.REAL_GIT = REAL_GIT
  process.env.SPV_QUEUE_DIR = box.queue
  // The panel settings store also lives under the deployment state dir: keep it inside the sandbox, so a
  // real `~/.dsh/state/superagent/panel-settings.json` can never change what these cases assert.
  process.env.DSH_SUPERAGENT_STATE_DIR = join(base, 'state')
  delete process.env.SPV_INSTALL_REPO
  delete process.env.FAKE_GH_FAIL_REPO
  return box
}

/** A tools/ repo with .git and a GitHub origin; enough for discoverRepos(). */
async function makeRepo(box, name, origin = `https://github.com/acme/${name}.git`) {
  const dir = join(box.tools, name)
  await mkdir(dir, { recursive: true })
  git(['init', '-q', '-b', 'main', dir])
  await writeFile(join(dir, 'file.txt'), 'initial\n', 'utf8')
  gitIn(dir, 'add', '-A')
  gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  gitIn(dir, 'remote', 'add', 'origin', origin)
  return dir
}

/** A bare remote, a seed clone, an initial commit, and a project clone that fetches through insteadOf. */
async function makeClone(box, name) {
  const remote = join(box.remotes, `${name}.git`)
  git(['init', '-q', '--bare', '-b', 'main', remote])
  const seed = join(box.base, `seed-${name}`)
  git(['init', '-q', '-b', 'main', seed])
  await writeFile(join(seed, 'file.txt'), 'initial\n', 'utf8')
  gitIn(seed, 'add', '-A')
  gitIn(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  gitIn(seed, 'remote', 'add', 'origin', remote)
  gitIn(seed, 'push', '-q', 'origin', 'main')
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remote })

  const local = join(box.tools, name)
  git(['clone', '-q', remote, local])
  gitIn(local, 'remote', 'set-url', 'origin', `https://github.com/acme/${name}.git`)
  gitIn(local, 'config', `url.${box.remotes}${'/'}.insteadOf`, 'https://github.com/acme/')
  return { remote, seed, local, initialSha: gitIn(local, 'rev-parse', 'HEAD').trim() }
}

/** Add one commit to a seed clone and push it; returns the new sha. */
async function pushChange(seed, content = 'changed\n') {
  await writeFile(join(seed, 'file.txt'), content, 'utf8')
  gitIn(seed, 'add', '-A')
  gitIn(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'change')
  gitIn(seed, 'push', '-q', 'origin', 'main')
  return gitIn(seed, 'rev-parse', 'HEAD').trim()
}

function pullCount(box) {
  return readFile(box.gitLog, 'utf8').then(text => text.split('\n').filter(line => line.includes('pull --ff-only')).length)
}

async function ghCallCount(box) {
  return (await readFile(box.ghLog, 'utf8')).split('\n').filter(Boolean).length
}

async function outboxNames(box) {
  return (await readdir(join(box.queue, 'outbox')).catch(() => [])).filter(name => name.endsWith('.json')).sort()
}

function prPayload({ number, repo, state = 'OPEN', title = 'PR', mergedAt = '', mergeCommit = '' }) {
  return [{
    number,
    title,
    state,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    url: `https://github.com/${repo}/pull/${number}`,
    body: 'body',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
    mergedAt,
    mergeCommit: mergeCommit === '' ? null : { oid: mergeCommit },
  }]
}

/** (a) The loop refreshes items without a human and stops cleanly. */
async function testWatcherRefreshes() {
  const box = await sandbox()
  await makeRepo(box, 'demo')
  // research/ must never be a candidate even with a GitHub-looking origin.
  const research = join(box.base, 'projects', 'research', 'task')
  await mkdir(research, { recursive: true })
  git(['init', '-q', '-b', 'main', research])
  gitIn(research, 'remote', 'add', 'origin', 'https://github.com/acme/research-task.git')

  await writeJson(box.ghJson, prPayload({ number: 1, repo: 'acme/demo', title: 'first' }))
  const logs = []
  const watcher = startInboxWatcher({
    root: box.inbox,
    projectsRoot: box.projects,
    intervalSeconds: 0.02,
    gh: box.gh,
    log: line => logs.push(line),
    unref: true,
  })
  try {
    await waitFor(async () => (await readItem(box.inbox, 'acme-demo-1'))?.title === 'first', 'the first item')
    await writeJson(box.ghJson, prPayload({ number: 1, repo: 'acme/demo', title: 'second' }))
    await waitFor(async () => (await readItem(box.inbox, 'acme-demo-1'))?.title === 'second', 'the refreshed title')
    assert.ok((await ghCallCount(box)) >= 2, 'the loop polled more than once')
    assert.deepEqual(discoverRepos(box.projects).map(repo => repo.name), ['demo'], 'research/ is not a polling candidate')
    assert.ok(!(await readFile(box.ghLog, 'utf8')).includes('research-task'), 'no gh call was made for research/')
    assert.ok(!(await readdir(box.inbox)).some(name => name.includes('research')), 'research/ never reaches the inbox')
  } finally {
    watcher.stop()
  }
  await watcher.done
  await sleep(60)
  const afterStop = await ghCallCount(box)
  await sleep(100)
  assert.equal(await ghCallCount(box), afterStop, 'stop() ends the poll loop')
  assert.ok(!logs.some(line => line.includes('poll failed')), 'a healthy loop logs no poll failure')
}

/** (b) MERGED -> one --ff-only pull -> one cold-install notice; repeated poll/restart does neither again. */
async function testMergePullAndNotice() {
  const box = await sandbox()
  const clone = await makeClone(box, 'wheelchair-agent')
  const mergedSha = await pushChange(clone.seed)
  const open = prPayload({ number: 7, repo: 'acme/wheelchair-agent', state: 'OPEN' })
  await writeJson(box.ghJson, open)

  let noticeAt
  let itemNoticeAt
  const first = startInboxWatcher({
    root: box.inbox,
    projectsRoot: box.projects,
    intervalSeconds: 0.02,
    gh: box.gh,
    log: () => {},
    unref: true,
  })
  try {
    await waitFor(async () => (await readItem(box.inbox, 'acme-wheelchair-agent-7'))?.state === 'OPEN', 'the open item')
    await writeJson(box.ghJson, prPayload({
      number: 7,
      repo: 'acme/wheelchair-agent',
      state: 'MERGED',
      mergedAt: '2026-11-15T00:00:00.000Z',
      mergeCommit: mergedSha,
    }))
    await waitFor(async () => (await readItem(box.inbox, 'acme-wheelchair-agent-7'))?.pulledSha === mergedSha, 'the merged item to be pulled')
    await waitFor(async () => (await outboxNames(box)).length === 1, 'one cold-install notice')
    assert.equal(await pullCount(box), 1, 'exactly one --ff-only pull')

    const item = await readItem(box.inbox, 'acme-wheelchair-agent-7')
    assert.equal(item.mergedAt, '2026-11-15T00:00:00.000Z')
    assert.equal(item.mergeCommit, mergedSha)
    assert.equal(item.pulledSha, mergedSha)
    assert.ok(item.mergeHandledAt, 'the merge is marked handled')
    assert.ok(item.noticeAt, 'the notice is marked sent')
    assert.equal(item.pullError, undefined)
    assert.equal(gitIn(clone.local, 'rev-parse', 'HEAD').trim(), mergedSha, 'the local clone moved to the merged sha')

    const notice = JSON.parse(await readFile(join(box.queue, 'outbox', (await outboxNames(box))[0]), 'utf8'))
    noticeAt = notice.at
    itemNoticeAt = item.noticeAt
    assert.equal(notice.kind, 'notice')
    assert.equal(notice.thread, 'main')
    assert.ok(notice.text.includes('PR #7'), 'the notice names the PR')
    assert.ok(notice.text.includes('acme/wheelchair-agent'), 'the notice names the repo')
    assert.ok(notice.text.includes(mergedSha), 'the notice names the pulled sha')
    assert.ok(notice.text.includes('moved to'), 'the notice says the local clone moved')
    assert.ok(notice.text.includes('cold install is now pending'), 'the notice says the cold install is pending')
    assert.ok(notice.text.includes('wheelchair-agent service stop'), 'the notice has the stop command')
    assert.ok(notice.text.includes('bash install.sh'), 'the notice has the install command')
    assert.ok(notice.text.includes('wheelchair-agent service start'), 'the notice has the start command')
    assert.ok(notice.text.includes('cannot install itself'), 'the notice says the service cannot install itself')

    // A later poll must not pull or notice again.
    await waitFor(async () => (await ghCallCount(box)) >= 3, 'later polls')
    assert.equal(await pullCount(box), 1)
    assert.equal((await outboxNames(box)).length, 1)
  } finally {
    first.stop()
  }
  await first.done

  // A restart is a new watcher over the same item: the persisted mergeHandledAt still deduplicates.
  const second = startInboxWatcher({
    root: box.inbox,
    projectsRoot: box.projects,
    intervalSeconds: 0.02,
    gh: box.gh,
    log: () => {},
    unref: true,
  })
  try {
    const before = await ghCallCount(box)
    await waitFor(async () => (await ghCallCount(box)) > before, 'the restarted watcher to poll')
    assert.equal(await pullCount(box), 1, 'a restart does not pull again')
    assert.equal((await outboxNames(box)).length, 1, 'a restart does not queue a second notice')
    const replayed = JSON.parse(await readFile(join(box.queue, 'outbox', (await outboxNames(box))[0]), 'utf8'))
    assert.equal(replayed.at, noticeAt, 'a repeated poll or restart does not rewrite the notice')
    assert.equal((await readItem(box.inbox, 'acme-wheelchair-agent-7')).noticeAt, itemNoticeAt, 'noticeAt is stable')
  } finally {
    second.stop()
  }
  await second.done
}

/** An item that was already MERGED when first seen is not a fresh transition: no pull, no notice. */
async function testPreexistingMergedNotHandled() {
  const box = await sandbox()
  await makeRepo(box, 'wheelchair-agent')
  await writeJson(box.ghJson, prPayload({
    number: 8,
    repo: 'acme/wheelchair-agent',
    state: 'MERGED',
    mergedAt: '2026-11-01T00:00:00.000Z',
    mergeCommit: '1'.repeat(40),
  }))
  const watcher = startInboxWatcher({
    root: box.inbox,
    projectsRoot: box.projects,
    intervalSeconds: 0.02,
    gh: box.gh,
    log: () => {},
    unref: true,
  })
  try {
    await waitFor(async () => (await readItem(box.inbox, 'acme-wheelchair-agent-8'))?.state === 'MERGED', 'the old merged item')
    const before = await ghCallCount(box)
    await waitFor(async () => (await ghCallCount(box)) > before, 'a later poll')
    const item = await readItem(box.inbox, 'acme-wheelchair-agent-8')
    assert.equal(item.mergeHandledAt, undefined, 'a historical merge is not treated as new')
    assert.equal(await pullCount(box), 0, 'a historical merge is not pulled')
    assert.deepEqual(await outboxNames(box), [], 'a historical merge queues no notice')
  } finally {
    watcher.stop()
  }
  await watcher.done
}

/** A merged non-install repo is pulled but queues no cold-install notice. */
async function testMergeNonInstallRepoNoNotice() {
  const box = await sandbox()
  const clone = await makeClone(box, 'demo')
  const mergedSha = await pushChange(clone.seed)
  await writeJson(box.ghJson, prPayload({ number: 4, repo: 'acme/demo', state: 'OPEN' }))
  const watcher = startInboxWatcher({
    root: box.inbox,
    projectsRoot: box.projects,
    intervalSeconds: 0.02,
    gh: box.gh,
    log: () => {},
    unref: true,
  })
  try {
    await waitFor(async () => (await readItem(box.inbox, 'acme-demo-4'))?.state === 'OPEN', 'the open non-install item')
    await writeJson(box.ghJson, prPayload({
      number: 4,
      repo: 'acme/demo',
      state: 'MERGED',
      mergedAt: '2026-11-15T00:30:00.000Z',
      mergeCommit: mergedSha,
    }))
    await waitFor(async () => (await readItem(box.inbox, 'acme-demo-4'))?.pulledSha === mergedSha, 'the non-install pull')
    assert.deepEqual(await outboxNames(box), [], 'only the install repository queues a notice')
    assert.equal(gitIn(clone.local, 'rev-parse', 'HEAD').trim(), mergedSha)
  } finally {
    watcher.stop()
  }
  await watcher.done
}

/** (c) A dirty tree records the pull failure; a later clean tree retries and finishes with one notice. */
async function testPullFailureRecovers() {
  const box = await sandbox()
  const clone = await makeClone(box, 'wheelchair-agent')
  const mergedSha = await pushChange(clone.seed, 'remote change\n')
  await writeFile(join(clone.local, 'file.txt'), 'dirty local\n', 'utf8')
  await writeJson(box.ghJson, prPayload({ number: 3, repo: 'acme/wheelchair-agent', state: 'OPEN' }))

  const watcher = startInboxWatcher({
    root: box.inbox,
    projectsRoot: box.projects,
    intervalSeconds: 0.02,
    gh: box.gh,
    log: () => {},
    unref: true,
  })
  try {
    await waitFor(async () => (await readItem(box.inbox, 'acme-wheelchair-agent-3'))?.state === 'OPEN', 'the open item')
    await writeJson(box.ghJson, prPayload({
      number: 3,
      repo: 'acme/wheelchair-agent',
      state: 'MERGED',
      mergedAt: '2026-11-15T01:00:00.000Z',
      mergeCommit: mergedSha,
    }))
    await waitFor(async () => Boolean((await readItem(box.inbox, 'acme-wheelchair-agent-3'))?.pullError), 'the pull failure to be recorded')
    const failed = await readItem(box.inbox, 'acme-wheelchair-agent-3')
    assert.ok(failed.mergedAt, 'the merge is recorded')
    assert.ok(failed.mergeObservedAt, 'the observed transition is recorded for retry')
    assert.equal(failed.mergeHandledAt, undefined, 'a failed pull is not marked handled')
    assert.equal(failed.pulledSha, undefined)
    assert.equal(await readFile(join(clone.local, 'file.txt'), 'utf8'), 'dirty local\n', 'the dirty file is never touched')
    assert.deepEqual(await outboxNames(box), [], 'a failed pull queues no cold-install notice')

    const firstPull = await pullCount(box)
    const before = await ghCallCount(box)
    await waitFor(async () => (await ghCallCount(box)) > before, 'the loop to keep polling after a failed pull')
    await waitFor(async () => (await pullCount(box)) > firstPull, 'a later poll to retry the failed pull')
    const retried = await readItem(box.inbox, 'acme-wheelchair-agent-3')
    assert.equal(retried.mergeHandledAt, undefined, 'the retry still failed, so it stays unhandled')
    assert.ok(retried.pullError, 'the retry records its failure again')

    // Clean the tree: the next poll pulls the same transition again and completes it.
    gitIn(clone.local, 'checkout', '--', 'file.txt')
    await waitFor(
      async () => (await readItem(box.inbox, 'acme-wheelchair-agent-3'))?.pulledSha === mergedSha,
      'the retry after cleaning the tree',
    )
    await waitFor(async () => (await outboxNames(box)).length === 1, 'one cold-install notice after recovery')
    const recovered = await readItem(box.inbox, 'acme-wheelchair-agent-3')
    assert.ok(recovered.mergeHandledAt, 'the recovered merge is marked handled')
    assert.equal(recovered.pullError, undefined, 'the old pull error is cleared')
    assert.ok(recovered.noticeAt, 'the notice is recorded')
    assert.ok((await pullCount(box)) >= 2, 'the failed pull was retried')
  } finally {
    watcher.stop()
  }
  await watcher.done
}

/** (c2) A transient outbox failure keeps the merge unhandled and retries only the notice. */
async function testNoticeFailureRetries() {
  const box = await sandbox()
  const clone = await makeClone(box, 'wheelchair-agent')
  const mergedSha = await pushChange(clone.seed)
  const badQueue = join(box.base, 'queue-is-a-file')
  await writeFile(badQueue, 'not a directory', 'utf8')
  process.env.SPV_QUEUE_DIR = badQueue
  await writeJson(box.ghJson, prPayload({ number: 5, repo: 'acme/wheelchair-agent', state: 'OPEN' }))

  const watcher = startInboxWatcher({
    root: box.inbox,
    projectsRoot: box.projects,
    intervalSeconds: 0.02,
    gh: box.gh,
    log: () => {},
    unref: true,
  })
  try {
    await waitFor(async () => (await readItem(box.inbox, 'acme-wheelchair-agent-5'))?.state === 'OPEN', 'the open item')
    await writeJson(box.ghJson, prPayload({
      number: 5,
      repo: 'acme/wheelchair-agent',
      state: 'MERGED',
      mergedAt: '2026-11-15T02:00:00.000Z',
      mergeCommit: mergedSha,
    }))
    await waitFor(async () => Boolean((await readItem(box.inbox, 'acme-wheelchair-agent-5'))?.noticeError), 'the notice failure to be recorded')
    const failed = await readItem(box.inbox, 'acme-wheelchair-agent-5')
    assert.ok(failed.pullError === undefined, 'the pull itself succeeded')
    assert.equal(failed.pulledSha, mergedSha)
    assert.equal(failed.mergeHandledAt, undefined, 'a failed notice is not marked handled')

    // Fix the queue: the next poll must retry the notice without pulling the already-updated clone again.
    process.env.SPV_QUEUE_DIR = box.queue
    const firstPull = await pullCount(box)
    await waitFor(async () => (await outboxNames(box)).length === 1, 'the notice retry')
    const recovered = await readItem(box.inbox, 'acme-wheelchair-agent-5')
    assert.ok(recovered.mergeHandledAt, 'the recovered notice marks the merge handled')
    assert.equal(recovered.noticeError, undefined, 'the notice error is cleared')
    assert.ok(recovered.noticeAt)
    assert.equal(await pullCount(box), firstPull, 'retrying the notice does not pull the clone again')
  } finally {
    watcher.stop()
  }
  await watcher.done
}

/** (d) Review status is independent of GitHub state; the separate PR-state chip has its own helper. */
async function testReviewStatusAndPrState() {
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        captured = factory(id => (id === 'react' ? {} : { jsx: () => null, jsxs: () => null }))
      },
    },
  }
  try {
    await import('../webui/lib/client.js')
  } finally {
    delete globalThis.window
  }
  assert.ok(captured?.__test?.statusOf, 'the client bundle exposes statusOf for the offline test')
  assert.ok(captured.__test.stateOf, 'the client bundle exposes stateOf for the PR-state chip')
  const { statusOf, stateOf } = captured.__test

  // Review status: merge state must never make an unreviewed PR look reviewed.
  assert.equal(statusOf({ state: 'MERGED', review: [] }), 'pending', 'a merged but unreviewed PR is still pending')
  assert.equal(statusOf({ state: 'OPEN', review: [] }), 'pending')
  assert.equal(statusOf({ state: 'MERGED', review: [{ kind: 'approve' }] }), 'approved', 'an explicit approval survives the merge')
  assert.equal(statusOf({ state: 'MERGED', review: [{ kind: 'issue', text: 'x' }] }), 'issue', 'an issue review wins')
  assert.equal(
    statusOf({ state: 'MERGED', mergedAt: '2026-11-15T00:00:00.000Z', review: [{ at: '2026-11-01T00:00:00.000Z', kind: 'issue', text: 'early' }] }),
    'issue',
    'a pre-merge issue also wins',
  )

  // PR state: separate display axis for the chip.
  assert.equal(stateOf({ state: 'MERGED' }), 'merged')
  assert.equal(stateOf({ state: 'CLOSED' }), 'closed')
  assert.equal(stateOf({ state: 'OPEN' }), 'open')
  assert.equal(stateOf({}), '')
}

/** (d2) One failing gh repo is a warning; the healthy repo still refreshes on later polls. */
async function testOneRepoFailureDoesNotStopLoop() {
  const box = await sandbox()
  await makeRepo(box, 'bad')
  await makeRepo(box, 'good')
  process.env.FAKE_GH_FAIL_REPO = 'acme/bad'
  await writeJson(box.ghJson, prPayload({ number: 1, repo: 'acme/good', title: 'good one' }))
  const logs = []
  const watcher = startInboxWatcher({
    root: box.inbox,
    projectsRoot: box.projects,
    intervalSeconds: 0.02,
    gh: box.gh,
    log: line => logs.push(line),
    unref: true,
  })
  try {
    await waitFor(async () => (await readItem(box.inbox, 'acme-good-1'))?.title === 'good one', 'the healthy repo item')
    assert.ok(logs.some(line => line.includes('warning: acme/bad')), 'the failing repo is logged and skipped')
    assert.equal(await readItem(box.inbox, 'acme-bad-1'), undefined, 'the failing repo writes no item')
    await writeJson(box.ghJson, prPayload({ number: 1, repo: 'acme/good', title: 'good two' }))
    await waitFor(async () => (await readItem(box.inbox, 'acme-good-1'))?.title === 'good two', 'the loop to continue after a repo failure')
  } finally {
    watcher.stop()
  }
  await watcher.done
}

/** (e) The web host starts the same poll loop from ctx.effect, using the configured interval. */
async function testHostStartsPoller() {
  const box = await sandbox()
  await makeRepo(box, 'demo')
  const app = join(box.base, 'webui')
  await mkdir(join(app, 'lib', 'core'), { recursive: true })
  await mkdir(join(app, 'lib', 'shared'), { recursive: true })
  await writeFile(join(app, 'package.json'), '{"type":"module"}\n', 'utf8')
  for (const [source, target] of [
    ['src/spv/inbox.js', 'lib/core/inbox.js'],
    ['src/spv/dispatch.js', 'lib/core/dispatch.js'],
    ['src/spv/paths.js', 'lib/core/paths.js'],
    ['src/shared/queue.js', 'lib/shared/queue.js'],
    ['src/shared/settings.js', 'lib/shared/settings.js'],
    ['webui/lib/index.js', 'lib/index.js'],
  ]) {
    await copyFile(join(REPO, source), join(app, target))
  }
  process.env.SPV_INBOX_DIR = box.inbox
  process.env.SPV_PROJECTS_ROOT = box.projects
  const { apply } = await import(pathToFileURL(join(app, 'lib', 'index.js')).href)

  const hostContext = () => {
    const effects = []
    const lines = []
    return {
      effects,
      lines,
      ctx: {
        logger: { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) },
        connection: { requestRejection: () => undefined },
        webServer: { register: () => () => {} },
        effect: (fn, label) => { effects.push({ fn, label }) },
      },
    }
  }

  await writeJson(box.ghJson, prPayload({ number: 1, repo: 'acme/demo', title: 'first' }))
  const host = hostContext()
  apply(host.ctx, { intervalSeconds: 0.02 })
  const poller = host.effects.find(effect => effect.label.includes('wheelchair-agent-webui: inbox poller'))
  assert.ok(poller, 'the host registers the inbox poller through ctx.effect')
  const stop = poller.fn()
  try {
    await waitFor(async () => (await readItem(box.inbox, 'acme-demo-1'))?.title === 'first', 'the host to refresh an item')
    await writeJson(box.ghJson, prPayload({ number: 1, repo: 'acme/demo', title: 'second' }))
    await waitFor(async () => (await readItem(box.inbox, 'acme-demo-1'))?.title === 'second', 'the host loop to use the configured interval')
    assert.ok(host.lines.some(line => line.includes('refreshing every 0.02s')), 'the host logs the configured interval')
  } finally {
    stop()
  }
  await sleep(60)
  const afterStop = await ghCallCount(box)
  await sleep(100)
  assert.equal(await ghCallCount(box), afterStop, 'the host disposer stops the loop')

  const disabled = hostContext()
  apply(disabled.ctx, { intervalSeconds: 0 })
  assert.ok(!disabled.effects.some(effect => effect.label.includes('inbox poller')), 'intervalSeconds=0 registers no poller')
  assert.ok(disabled.lines.some(line => line.includes('automatic refresh disabled')), 'intervalSeconds=0 is logged')

  const invalid = hostContext()
  apply(invalid.ctx, { intervalSeconds: 'soon' })
  assert.ok(invalid.lines.some(line => line.includes('using 60s')), 'an invalid interval falls back to 60s')
  assert.ok(invalid.effects.some(effect => effect.label.includes('inbox poller')), 'the fallback still registers the poller')
}

/** (f) Interval configuration: default 60, env/argument override, 0 disables, bad values throw. *//** (f) Interval configuration: default 60, env/argument override, 0 disables, bad values throw. */
function testIntervalConfig() {
  const saved = process.env.SPV_INBOX_INTERVAL_SECONDS
  const savedStateDir = process.env.DSH_SUPERAGENT_STATE_DIR
  delete process.env.SPV_INBOX_INTERVAL_SECONDS
  // A sandbox state dir proves the assertion holds when no panel settings file exists (and keeps a real
  // one on the operator's machine out of the test).
  process.env.DSH_SUPERAGENT_STATE_DIR = join(tmpdir(), `wheelchair-agent-inbox-interval-${process.pid}`)
  try {
    assert.equal(INBOX_INTERVAL_DEFAULT, 60)
    assert.equal(resolveInboxIntervalSeconds(), 60)
    process.env.SPV_INBOX_INTERVAL_SECONDS = '15'
    assert.equal(resolveInboxIntervalSeconds(), 15)
    assert.equal(resolveInboxIntervalSeconds(5), 5, 'the plugin config wins over the environment')
    assert.equal(resolveInboxIntervalSeconds(0), 0, '0 disables the host poller')
    assert.throws(() => resolveInboxIntervalSeconds(-1), /non-negative/)
    assert.throws(() => resolveInboxIntervalSeconds('soon'), /non-negative/)
  } finally {
    if (saved === undefined) delete process.env.SPV_INBOX_INTERVAL_SECONDS
    else process.env.SPV_INBOX_INTERVAL_SECONDS = saved
    if (savedStateDir === undefined) delete process.env.DSH_SUPERAGENT_STATE_DIR
    else process.env.DSH_SUPERAGENT_STATE_DIR = savedStateDir
  }
}

// ------------------------------------------------------------------- main

try {
  await testWatcherRefreshes()
  await testMergePullAndNotice()
  await testPreexistingMergedNotHandled()
  await testMergeNonInstallRepoNoNotice()
  await testPullFailureRecovers()
  await testNoticeFailureRetries()
  await testReviewStatusAndPrState()
  await testOneRepoFailureDoesNotStopLoop()
  await testHostStartsPoller()
  testIntervalConfig()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true })
}
