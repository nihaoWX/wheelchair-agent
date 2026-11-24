/**
 * 每部署实例（stage 2 第一刀）的测试。
 *
 * 覆盖的不变量：
 *   - 实例名（slug）只含 `[a-z0-9._-]`，去掉 `tools/`/`research/` 前缀并小写；同名的两个项目在读取
 *     注册表时就被拒绝，不会共用一个实例文件；
 *   - 实例 overlay 是 `dsh --patch` 的输入：端口、stateDir、queueDir 与注册表一致，文件末尾有换行；
 *   - 实例文件只在不存在时创建，操作者改过的文件不会被下一次 `deployment add` 覆盖；
 *   - 端口从 3082 起分配第一个未注册的；显式端口冲突、重复端口、`queueDir != <stateDir>/spv`
 *     都是错误而不是静默接受；`--port` 后的真实占用由 service start 报告，这里不启动服务；
 *   - `service` 的 `--project` 缺少值、或项目没有部署时，给出可执行的下一步；
 *   - 全部在 mkdtemp 沙箱里跑（WHEELCHAIR_AGENT_HOME / DSH_HOME / DSH_SUPERAGENT_STATE_DIR），
 *     不写真实数据根，也不碰正在运行的服务。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  allocatePort,
  deploymentSlug,
  deploymentsDir,
  instancePath,
  renderInstance,
  writeInstance,
} from '../src/shared/deployments.js'
import {
  SESSION_RECORD,
  readSessionRecord,
  resolveProjectSession,
  selectInstanceProcesses,
  sessionRecordPath,
} from '../src/spv/deployment-restart.js'
import { encodeSegment, projectKey } from '../src/spv/session.js'
import { apply as applyRestartCommand, USAGE as RESTART_COMMAND_USAGE } from '../src/spv/restart-command.js'

const CLI = fileURLToPath(new URL('../bin/wheelchair-agent.mjs', import.meta.url))
const SANDBOXES = []

let passed = 0
function pass(message) {
  passed += 1
  process.stdout.write(`PASS ${message}\n`)
}

async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'wheelchair-agent-instance-test-'))
  SANDBOXES.push(base)
  const dsh = join(base, 'dsh')
  // A fake /proc keeps the restart preflight entirely inside the sandbox: one dsh session carries the
  // sandbox preset patch, so the guard can name a chain instead of scanning the operator's real processes.
  const proc = join(base, 'proc')
  const chainPid = 424242
  await mkdir(join(proc, String(chainPid)), { recursive: true })
  await writeFile(
    join(proc, String(chainPid), 'cmdline'),
    ['node', join(dsh, 'dsh'), '--patch', join(dsh, '.agent-presets', 'spv', 'preset-default.patch.yml')].join('\0') + '\0',
  )
  await writeFile(join(proc, String(chainPid), 'status'), 'Name:\tdsh\nPPid:\t1\n')
  // A second profile process stands in for the service, so the chain pid is not mistaken for it.
  const servicePid = 424243
  await mkdir(join(proc, String(servicePid)), { recursive: true })
  await writeFile(join(proc, String(servicePid), 'cmdline'), ['node', join(dsh, 'dsh'), '--profile', 'superagent'].join('\0') + '\0')
  await writeFile(join(proc, String(servicePid), 'status'), 'Name:\tdsh\nPPid:\t1\n')
  return {
    base,
    home: join(base, 'home'),
    dsh,
    data: join(base, 'data'),
    state: join(dsh, 'state', 'superagent'),
    proc,
  }
}

function envFor(box, extra = {}) {
  const env = { ...process.env }
  for (const key of [
    'SPV_QUEUE_DIR', 'SPV_SUPERAGENT_URL', 'SPV_SUPERAGENT_PORT', 'DSH_SUPERAGENT_PORT',
    'SPV_SERVICE_PORT', 'DSH_SUPERAGENT_PROFILE', 'SPV_INSTALL_REPO', 'SPV_INBOX_DIR',
    'SPV_PREPARE_LOG', 'SPV_PROJECTS_ROOT',
  ]) {
    delete env[key]
  }
  return {
    ...env,
    HOME: box.home,
    DSH_HOME: box.dsh,
    WHEELCHAIR_AGENT_HOME: box.data,
    DSH_SUPERAGENT_STATE_DIR: box.state,
    WHEELCHAIR_PROC_ROOT: box.proc,
    // Never probe the operator's real service: an unreachable loopback URL makes the
    // read-only preflight see "nothing known" instead of live load.
    DSH_SUPERAGENT_URL: 'http://127.0.0.1:9',
    ...extra,
  }
}

function cli(box, argv, extra = {}) {
  const result = spawnSync(process.execPath, [CLI, ...argv], { env: envFor(box, extra), encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function exists(file) {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}

function testSlugRules() {
  assert.equal(deploymentSlug('tools/wheelchair-agent'), 'wheelchair-agent')
  assert.equal(deploymentSlug('research/My_Lab.x'), 'my_lab.x')
  assert.equal(deploymentSlug('tools/A B'), 'a-b')
  assert.equal(deploymentSlug('tools/---x---'), 'x')
  assert.equal(deploymentSlug('tools/'), '')
  pass('instance names are lower-case leaves with only [a-z0-9._-]')
}

async function testRenderAndWrite() {
  const box = await sandbox()
  const entry = {
    project: 'tools/alpha',
    profile: 'superagent',
    stateDir: box.state,
    queueDir: join(box.state, 'spv'),
    port: 3105,
    installedSha: null,
  }
  assert.equal(instancePath('tools/alpha', { env: envFor(box) }), join(deploymentsDir({ env: envFor(box) }), 'alpha.yml'))
  const yaml = renderInstance(entry)
  assert.match(yaml, /^- id: webserver$/m)
  assert.match(yaml, /^    port: 3105$/m)
  assert.ok(yaml.includes(`stateDir: ${JSON.stringify(box.state)}`))
  assert.ok(yaml.includes(`queueDir: ${JSON.stringify(join(box.state, 'spv'))}`))
  assert.match(yaml, /- id: dsh-superagent/)
  assert.match(yaml, /- id: wheelchair-spv/)
  assert.ok(yaml.endsWith('\n'))
  assert.match(yaml, /panel label is the same for every deployment/)

  const written = writeInstance(entry, { env: envFor(box) })
  assert.equal(written.created, true)
  assert.equal(await exists(written.file), true)

  // 操作者改过的实例文件不被覆盖。
  const custom = '# operator edit\n'
  await writeFile(written.file, custom, 'utf8')
  const again = writeInstance(entry, { env: envFor(box) })
  assert.equal(again.created, false)
  assert.equal(await readFile(written.file, 'utf8'), custom)

  // 注册表里没有项目时也按同样规则渲染目录。
  assert.equal(instancePath('research/thing', { env: envFor(box) }), join(box.data, 'deployments', 'thing.yml'))
  pass('the overlay renders port/stateDir/queueDir and writeInstance never overwrites an existing file')
}

function testPortAllocation() {
  assert.equal(allocatePort([]), 3082)
  assert.equal(allocatePort([{ port: 3082 }, { port: 3084 }]), 3083)
  assert.equal(allocatePort([{ port: null }, { port: 3082 }]), 3083)
  assert.throws(() => allocatePort([{ port: 65535 }], { start: 65535 }), /cannot allocate a port/)
  pass('ports are the first unused number from 3082, never a shifted guess')
}

async function testAddAllocatesPortsAndRendersInstances() {
  const box = await sandbox()
  const first = cli(box, ['deployment', 'add', 'tools/alpha'])
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /registered project tools\/alpha/)
  assert.match(first.stdout, /instance .*deployments\/alpha\.yml/)
  const firstEntry = JSON.parse(await readFile(join(box.data, 'deployments.json'), 'utf8')).deployments[0]
  assert.equal(firstEntry.stateDir, join(box.state, 'alpha'))
  assert.equal(firstEntry.queueDir, join(box.state, 'alpha', 'spv'))
  assert.equal(firstEntry.port, 3082)
  assert.match(await readFile(join(box.data, 'deployments', 'alpha.yml'), 'utf8'), /port: 3082/)

  const second = cli(box, ['deployment', 'add', 'research/beta'])
  assert.equal(second.status, 0, second.stderr)
  const entries = JSON.parse(await readFile(join(box.data, 'deployments.json'), 'utf8')).deployments
  assert.deepEqual(entries.map(item => [item.project, item.port]), [['research/beta', 3083], ['tools/alpha', 3082]])

  // 显式端口冲突是用法错误，且不改注册表。
  const before = await readFile(join(box.data, 'deployments.json'), 'utf8')
  const clash = cli(box, ['deployment', 'add', 'tools/gamma', '--port', '3082'])
  assert.equal(clash.status, 2)
  assert.match(clash.stderr, /already registered for tools\/alpha/)
  assert.equal(await readFile(join(box.data, 'deployments.json'), 'utf8'), before)

  // 注册表里重复端口在读的时候就拒绝。
  const broken = {
    version: 1,
    deployments: [
      { project: 'tools/a', profile: 'superagent', stateDir: join(box.state, 'a'), queueDir: join(box.state, 'a', 'spv'), port: 3082, installedSha: null },
      { project: 'tools/b', profile: 'superagent', stateDir: join(box.state, 'b'), queueDir: join(box.state, 'b', 'spv'), port: 3082, installedSha: null },
    ],
  }
  await writeFile(join(box.data, 'deployments.json'), `${JSON.stringify(broken, null, 2)}\n`, 'utf8')
  const listed = cli(box, ['deployment', 'list'])
  assert.equal(listed.status, 1)
  assert.match(listed.stderr, /assigns port 3082 to both "tools\/a" and "tools\/b"/)
  pass('add allocates ports, renders one instance per deployment, and rejects port conflicts')
}

async function testSlugCollisionIsRejected() {
  const box = await sandbox()
  await mkdir(box.data, { recursive: true })
  const colliding = {
    version: 1,
    deployments: [
      { project: 'tools/Foo', profile: 'superagent', stateDir: join(box.state, 'foo'), queueDir: join(box.state, 'foo', 'spv'), port: 3090, installedSha: null },
      { project: 'tools/foo', profile: 'superagent', stateDir: join(box.state, 'foo2'), queueDir: join(box.state, 'foo2', 'spv'), port: 3091, installedSha: null },
    ],
  }
  const file = join(box.data, 'deployments.json')
  await writeFile(file, `${JSON.stringify(colliding, null, 2)}\n`, 'utf8')
  const listed = cli(box, ['deployment', 'list'])
  assert.equal(listed.status, 1)
  assert.match(listed.stderr, /to the instance name "foo"/)
  assert.equal(await readFile(file, 'utf8'), `${JSON.stringify(colliding, null, 2)}\n`)
  pass('two projects that map to one instance name are rejected without rewriting the registry')
}

async function testServiceProjectSelector() {
  const box = await sandbox()
  const added = cli(box, ['deployment', 'add', 'tools/alpha'])
  assert.equal(added.status, 0, added.stderr)

  const missingValue = cli(box, ['service', 'status', '--project'])
  assert.equal(missingValue.status, 2)
  assert.match(missingValue.stderr, /--project needs a project name/)

  const unknown = cli(box, ['service', 'status', '--project', 'tools/nope'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /no deployment for project "tools\/nope"/)
  assert.match(unknown.stderr, /wheelchair-agent deployment add tools\/nope/)

  // 没有端口的条目不能启动，也不去猜端口。
  const entry = JSON.parse(await readFile(join(box.data, 'deployments.json'), 'utf8')).deployments[0]
  entry.port = null
  await writeFile(join(box.data, 'deployments.json'), `${JSON.stringify({ version: 1, deployments: [entry] }, null, 2)}\n`, 'utf8')
  const portless = cli(box, ['service', 'status', '--project', 'tools/alpha'])
  assert.equal(portless.status, 1)
  assert.match(portless.stderr, /has no port/)
  pass('service --project names the missing deployment/port instead of starting anything')
}

async function testInstanceSelectorIsExact() {
  const box = await sandbox()
  const alpha = instancePath('tools/alpha', { env: envFor(box) })
  const beta = instancePath('tools/beta', { env: envFor(box) })
  const table = [
    { pid: 100, argv: ['dsh', '--profile', 'superagent', '--patch', alpha] },
    { pid: 200, argv: ['dsh', '--profile=superagent', `--patch=${beta}`] },
    { pid: 300, argv: ['dsh', '--profile', 'superagent'] },
    { pid: 400, argv: ['dsh', 'plugin', 'add', '@deepseek-ai/dsh-superagent', '--profile', 'superagent', '--patch', alpha] },
    { pid: 500, argv: ['dsh', '--profile', 'research', '--patch', alpha] },
  ]
  assert.deepEqual(selectInstanceProcesses(table, { profile: 'superagent', patch: alpha }).map(item => item.pid), [100])
  assert.deepEqual(selectInstanceProcesses(table, { profile: 'superagent', patch: beta }).map(item => item.pid), [200])
  assert.deepEqual(selectInstanceProcesses(table, { profile: 'superagent', patch: null }).map(item => item.pid), [300])
  assert.deepEqual(selectInstanceProcesses(table, { profile: 'superagent', patch: '/nonexistent.yml' }), [])
  pass('the instance selector matches profile and overlay exactly; legacy, plugin and other profiles do not match')
}

async function testProjectSessionPriority() {
  const box = await sandbox()
  const env = envFor(box)
  const stateDir = box.state
  const recorded = 'recorded-session'
  const dir = join(box.dsh, 'sessions', projectKey(stateDir), encodeSegment(recorded))
  await mkdir(dir, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(sessionRecordPath(stateDir), `${JSON.stringify({ version: 1, project: 'tools/alpha', sessionId: recorded })}\n`)

  const fromCommand = resolveProjectSession({ env, stateDir, session: 'command-session' })
  assert.equal(fromCommand.source, 'command')
  assert.equal(fromCommand.id, 'command-session')

  const fromRecord = resolveProjectSession({ env, stateDir })
  assert.equal(fromRecord.source, 'record')
  assert.equal(fromRecord.id, recorded)
  assert.equal(fromRecord.dir, dir)

  // The global resume pointer must never be a fallback, even when it names a session.
  await rm(sessionRecordPath(stateDir), { force: true })
  await mkdir(join(box.home, '.dsh-tui'), { recursive: true })
  await writeFile(join(box.home, '.dsh-tui', 'resume.txt'), 'global-sentinel\n')
  assert.equal(resolveProjectSession({ env, stateDir }), null)
  assert.equal(await readFile(join(box.home, '.dsh-tui', 'resume.txt'), 'utf8'), 'global-sentinel\n')
  assert.equal(readSessionRecord(stateDir), null)
  assert.equal(SESSION_RECORD, 'deployment-session.json')
  pass('a project restart uses --session first, then its own stateDir record, and never the global resume.txt')
}

async function testRestartProjectDryRunAndErrors() {
  const box = await sandbox()
  const added = cli(box, ['deployment', 'add', 'tools/alpha'])
  assert.equal(added.status, 0, added.stderr)

  const plan = cli(box, ['restart-all', '--project', 'tools/alpha', '--dry-run'])
  assert.equal(plan.status, 0, plan.stderr)
  assert.match(plan.stdout, /restart-all --project tools\/alpha plan \(dry run; nothing is changed\)/)
  assert.match(plan.stdout, /install:\s+skipped/)
  assert.match(plan.stdout, /other deployments untouched/)
  assert.match(plan.stdout, /none recorded/)

  const unknown = cli(box, ['restart-all', '--project', 'tools/nope', '--dry-run'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /wheelchair-agent deployment add tools\/nope/)

  const missingValue = cli(box, ['restart-all', '--project'])
  assert.equal(missingValue.status, 2)
  assert.match(missingValue.stderr, /--project needs a project name/)
  pass('restart-all --project plans only that instance, skips install, and names the missing deployment')
}

async function testRestartAllDryRun() {
  const box = await sandbox()
  assert.equal(cli(box, ['deployment', 'add', 'tools/alpha']).status, 0)
  assert.equal(cli(box, ['deployment', 'add', 'tools/beta']).status, 0)

  const plan = cli(box, ['restart-all', '--all', '--dry-run', '--project', 'tools/alpha'])
  assert.equal(plan.status, 0, plan.stderr)
  assert.match(plan.stdout, /restart-all --all plan \(dry run; nothing is changed\)/)
  assert.match(plan.stdout, /deployments: tools\/alpha, tools\/beta/)
  for (const project of ['tools/alpha', 'tools/beta']) {
    assert.match(plan.stdout, new RegExp(`stop:  wheelchair-agent service stop --project ${project}`))
    assert.match(plan.stdout, new RegExp(`start: wheelchair-agent service start --project ${project}`))
  }
  assert.match(plan.stdout, /3\. bash .*install\.sh --project tools\/alpha/)
  // The deleted single-deployment path must not reappear: every install/stop/start names a project.
  assert.doesNotMatch(plan.stdout, /install\.sh\s*$/m)
  assert.doesNotMatch(plan.stdout, /service (?:stop|start)\s*$/m)

  const unknownCheckout = cli(box, ['restart-all', '--all', '--dry-run'])
  assert.equal(unknownCheckout.status, 1)
  assert.match(unknownCheckout.stdout, /cannot tell which deployment this checkout installs/)
  assert.match(unknownCheckout.stdout, /--project <p>/)
  assert.match(unknownCheckout.stdout, /Registered deployments: tools\/alpha, tools\/beta/)
  pass('restart-all --all plans one install plus every project stop/start, and refuses without a project')
}

async function fakeProcEntry(root, pid, argv, ppid = 1) {
  const dir = join(root, String(pid))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'cmdline'), `${argv.join('\0')}\0`)
  await writeFile(join(dir, 'status'), `Name:\tfake\nPPid:\t${ppid}\n`)
}

async function testServiceStatusListsDeployments() {
  const box = await sandbox()
  assert.equal(cli(box, ['deployment', 'add', 'tools/alpha']).status, 0)
  assert.equal(cli(box, ['deployment', 'add', 'tools/beta']).status, 0)
  const alpha = instancePath('tools/alpha', { env: envFor(box) })
  const beta = instancePath('tools/beta', { env: envFor(box) })
  const procRoot = join(box.base, 'proc')
  await fakeProcEntry(procRoot, 100, ['dsh', '--profile', 'superagent', '--patch', alpha])
  await fakeProcEntry(procRoot, 300, ['dsh', '--profile', 'superagent'])

  const status = cli(box, ['service', 'status'], { WHEELCHAIR_PROC_ROOT: procRoot })
  assert.match(status.stdout, /profile: superagent/)
  assert.match(status.stdout, /^deployments:$/m)
  assert.match(status.stdout, /^  tools\/alpha  port 3082  running  100$/m)
  assert.match(status.stdout, /^  tools\/beta  port 3083  stopped  -$/m)
  assert.match(status.stdout, /note:.*--project <p>/)
  const alphaIndex = status.stdout.indexOf('  tools/alpha  port')
  const betaIndex = status.stdout.indexOf('  tools/beta  port')
  assert.ok(alphaIndex > 0 && betaIndex > alphaIndex, 'the deployment lines follow the old lines, ordered by project')

  const single = cli(box, ['service', 'status', '--project', 'tools/beta'], { WHEELCHAIR_PROC_ROOT: procRoot })
  assert.doesNotMatch(single.stdout, /^deployments:$/m)

  // The legacy service is a registry entry too: when it is already the process described by the old lines,
  // it is not reported a second time.
  assert.equal(cli(box, ['deployment', 'add', 'tools/wheelchair-agent']).status, 0)
  const legacyStatus = cli(box, ['service', 'status'], { WHEELCHAIR_PROC_ROOT: procRoot })
  assert.doesNotMatch(legacyStatus.stdout, /^  tools\/wheelchair-agent  port/m)
  assert.match(legacyStatus.stdout, /^  tools\/alpha  port 3082  running  100$/m)
  pass('service status keeps the legacy lines and adds one line per deployment, without duplicating the legacy service')
}

async function testRestartCommandPassesProject() {
  const box = await sandbox()
  const fake = join(box.base, 'fake-wheelchair-agent')
  await writeFile(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
  await chmod(fake, 0o755)
  let handler
  const ctx = { commands: { register: registration => { handler = registration.handler } } }
  applyRestartCommand(ctx, { executable: fake })
  assert.match(RESTART_COMMAND_USAGE, /--project <p>/)
  const ok = handler({ rawInput: '--project tools/alpha', agent: { session: { id: 'session-1' } } })
  assert.equal(ok.kind, 'success', ok.text)
  for (const expected of ['restart-all', '--detach', '--session', 'session-1', '--project', 'tools/alpha']) {
    assert.match(ok.text, new RegExp(`(^|\\n)${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n|$)`))
  }
  const bad = handler({ rawInput: '--project', agent: { session: { id: 'session-1' } } })
  assert.equal(bad.kind, 'error')

  // --all is the machine-wide entry point: the handler still names its own deployment as the install checkout.
  assert.equal(cli(box, ['deployment', 'add', 'tools/alpha']).status, 0)
  const saved = process.env.SPV_QUEUE_DIR
  const savedHome = process.env.WHEELCHAIR_AGENT_HOME
  process.env.WHEELCHAIR_AGENT_HOME = box.data
  process.env.SPV_QUEUE_DIR = join(box.state, 'alpha', 'spv')
  await mkdir(join(box.state, 'alpha', 'spv'), { recursive: true })
  try {
    const all = handler({ rawInput: '--all', agent: { session: { id: 'session-1' } } })
    assert.equal(all.kind, 'success', all.text)
    for (const expected of ['restart-all', '--detach', '--all', '--session', 'session-1', '--project', 'tools/alpha']) {
      assert.match(all.text, new RegExp(`(^|\\n)${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\n|$)`))
    }
  } finally {
    if (saved === undefined) delete process.env.SPV_QUEUE_DIR
    else process.env.SPV_QUEUE_DIR = saved
    if (savedHome === undefined) delete process.env.WHEELCHAIR_AGENT_HOME
    else process.env.WHEELCHAIR_AGENT_HOME = savedHome
  }
  pass('/restart-wheelchair-agent passes --project/--all through and still rejects malformed arguments')
}

try {
  testSlugRules()
  await testRenderAndWrite()
  testPortAllocation()
  await testAddAllocatesPortsAndRendersInstances()
  await testSlugCollisionIsRejected()
  await testServiceProjectSelector()
  await testInstanceSelectorIsExact()
  await testProjectSessionPriority()
  await testRestartProjectDryRunAndErrors()
  await testRestartAllDryRun()
  await testServiceStatusListsDeployments()
  await testRestartCommandPassesProject()
  process.stdout.write(`ok (${passed} passed)\n`)
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const dir of SANDBOXES) await rm(dir, { recursive: true, force: true })
}
