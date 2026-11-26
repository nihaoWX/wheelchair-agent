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
import { execFile as execFileCallback, spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

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
import { mergeNoticeText } from '../src/spv/inbox.js'
import { looksLikeLegacyPanelHost, probePanelHttp } from '../src/spv/panel-instance.js'
import { resolveRoots } from '../src/spv/paths.js'

const CLI = fileURLToPath(new URL('../bin/wheelchair-agent.mjs', import.meta.url))
const PYTHON = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim()
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

const execFile = promisify(execFileCallback)

/**
 * Same CLI run as `cli()`, but asynchronous. A synchronously blocked test process cannot reap a killed
 * child, so a zombie would still answer `kill(pid, 0)`; awaiting here keeps the event loop free while the
 * CLI stops the older panel host.
 */
async function cliAsync(box, argv, extra = {}, { timeoutMs } = {}) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [CLI, ...argv], {
      env: envFor(box, extra),
      encoding: 'utf8',
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    })
    return { status: 0, stdout, stderr }
  } catch (error) {
    return { status: typeof error?.code === 'number' ? error.code : 1, stdout: error?.stdout ?? '', stderr: error?.stderr ?? '' }
  }
}

function cli(box, argv, extra = {}, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...argv], { env: envFor(box, extra), cwd: options.cwd, encoding: 'utf8' })
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
  const first = cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha'])
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /registered project tools\/alpha/)
  assert.match(first.stdout, /instance .*deployments\/alpha\.yml/)
  const firstEntry = JSON.parse(await readFile(join(box.data, 'deployments.json'), 'utf8')).deployments[0]
  assert.equal(firstEntry.stateDir, join(box.state, 'alpha'))
  assert.equal(firstEntry.queueDir, join(box.state, 'alpha', 'spv'))
  assert.equal(firstEntry.port, 3082)
  assert.match(await readFile(join(box.data, 'deployments', 'alpha.yml'), 'utf8'), /port: 3082/)

  const second = cli(box, ['deployment', 'add', 'research/beta', '--repo', 'test/beta'])
  assert.equal(second.status, 0, second.stderr)
  const entries = JSON.parse(await readFile(join(box.data, 'deployments.json'), 'utf8')).deployments
  assert.deepEqual(entries.map(item => [item.project, item.port]), [['research/beta', 3083], ['tools/alpha', 3082]])

  // 显式端口冲突是用法错误，且不改注册表。
  const before = await readFile(join(box.data, 'deployments.json'), 'utf8')
  const clash = cli(box, ['deployment', 'add', 'tools/gamma', '--repo', 'test/gamma', '--port', '3082'])
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
  const added = cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha'])
  assert.equal(added.status, 0, added.stderr)
  const fake = await fakeServiceManager(box)
  const calls = async () => (await readFile(fake.log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)

  // `service` has no project selector at all: both spellings are rejected before the registry is read or
  // the manager is reached, and the error says where a deployment can be named from elsewhere.
  const missingValue = cli(box, ['service', 'status', '--project'])
  assert.equal(missingValue.status, 2)
  assert.match(missingValue.stderr, /service does not take "--project"/)
  assert.match(missingValue.stderr, /restart-all --project/)

  const unknown = cli(box, ['service', 'status', '--project=tools/nope'], { PATH: fake.path, FAKE_SERVICE_LOG: fake.log })
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /service does not take "--project"/)
  assert.match(unknown.stderr, /restart-all --project/)

  assert.deepEqual(await calls(), [], 'a rejected selector never reaches the service manager')

  // The top-level `status` (the queue view, not `service status`) keeps --project: it is about one queue.
  const queueStatus = cli(box, ['status', '--project', 'tools/alpha'])
  assert.equal(queueStatus.status, 0, queueStatus.stderr)
  assert.match(queueStatus.stdout, /queue: .*alpha[\\/]spv/)
  pass('service rejects every --project spelling while the top-level status keeps it')
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
  const added = cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha'])
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
  assert.equal(cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha']).status, 0)
  assert.equal(cli(box, ['deployment', 'add', 'tools/beta', '--repo', 'test/beta']).status, 0)

  const plan = cli(box, ['restart-all', '--all', '--dry-run', '--project', 'tools/alpha'])
  assert.equal(plan.status, 0, plan.stderr)
  assert.match(plan.stdout, /restart-all --all plan \(dry run; nothing is changed\)/)
  assert.match(plan.stdout, /deployments: tools\/alpha, tools\/beta/)
  assert.match(plan.stdout, /1\. stop:  wheelchair-agent service stop --all/)
  assert.match(plan.stdout, /4\. start: wheelchair-agent service start --all/)
  assert.match(plan.stdout, /3\. bash .*install\.sh --project tools\/alpha/)
  // The deleted single-deployment path must not reappear, and `service` has no per-project selector: the
  // one install names its project, both service steps aggregate with --all.
  assert.doesNotMatch(plan.stdout, /install\.sh\s*$/m)
  assert.doesNotMatch(plan.stdout, /service (?:stop|start)\s*$/m)
  assert.doesNotMatch(plan.stdout, /service (?:stop|start) --project/)

  const unknownCheckout = cli(box, ['restart-all', '--all', '--dry-run'])
  assert.equal(unknownCheckout.status, 1)
  assert.match(unknownCheckout.stdout, /cannot tell which deployment this checkout installs/)
  assert.match(unknownCheckout.stdout, /--project <p>/)
  assert.match(unknownCheckout.stdout, /Registered deployments: tools\/alpha, tools\/beta/)
  pass('restart-all --all plans one install plus every project stop/start, and refuses without a project')
}

async function testRestartAllDryRunFromInsideSession() {
  const box = await sandbox()
  assert.equal(cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha']).status, 0)
  assert.equal(cli(box, ['deployment', 'add', 'tools/beta', '--repo', 'test/beta']).status, 0)

  // This test process is the CLI child's real parent; a fake chain entry that names it makes the CLI see
  // itself as a descendant of the session it would replace, exactly like a prompt inside the SPV session.
  await mkdir(join(box.proc, String(process.pid)), { recursive: true })
  await writeFile(
    join(box.proc, String(process.pid), 'cmdline'),
    ['node', join(box.dsh, 'dsh'), '--patch', join(box.dsh, '.agent-presets', 'spv', 'preset-default.patch.yml')].join('\0') + '\0',
  )
  await writeFile(join(box.proc, String(process.pid), 'status'), 'Name:\tdsh\nPPid:\t1\n')

  const foreground = cli(box, ['restart-all', '--all', '--dry-run', '--project', 'tools/alpha'])
  assert.notEqual(foreground.status, 0, 'a bare dry run from inside the session still refuses to plan')
  const said = `${foreground.stdout}${foreground.stderr}`
  assert.match(said, /descendant of the SPV session it must replace/)
  assert.match(said, /add --detach to preview the whole --all plan from inside this session/)

  const detached = cli(box, ['restart-all', '--all', '--dry-run', '--detach', '--project', 'tools/alpha'])
  assert.equal(detached.status, 0, `${detached.stdout}${detached.stderr}`)
  assert.match(detached.stdout, /restart-all --all plan \(dry run; nothing is changed\)/)
  assert.match(detached.stdout, /1\. stop:  wheelchair-agent service stop --all/)
  assert.match(detached.stdout, /4\. start: wheelchair-agent service start --all/)
  assert.match(detached.stdout, /3\. bash .*install\.sh --project tools\/alpha/)
  assert.doesNotMatch(detached.stdout, /install\.sh\s*$/m)
  assert.doesNotMatch(detached.stdout, /service (?:stop|start)\s*$/m)
  assert.doesNotMatch(detached.stdout, /service (?:stop|start) --project/)
  pass('restart-all --all --dry-run --detach previews from inside the session; a bare dry run explains why')
}

async function fakeProcEntry(root, pid, argv, ppid = 1) {
  const dir = join(root, String(pid))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'cmdline'), `${argv.join('\0')}\0`)
  await writeFile(join(dir, 'status'), `Name:\tfake\nPPid:\t${ppid}\n`)
}

/**
 * 一个只记录 argv 的假 service manager。裸 `service status`/`start` 会真的拉起 python3 去探端口，
 * 这里换成记录器：测试既不碰真实服务，也能断言 CLI 究竟把哪份部署交给了 service manager。
 */
async function fakeServiceManager(box) {
  const bin = join(box.base, 'bin')
  await mkdir(bin, { recursive: true })
  const log = join(box.base, 'service-argv.log')
  await writeFile(join(bin, 'python3'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_SERVICE_LOG"\nexit 0\n')
  await chmod(join(bin, 'python3'), 0o755)
  return { log, path: `${bin}:${process.env.PATH}` }
}

async function writeFakeManager(box, { panelBody = ':', panelExit = 0 } = {}) {
  const bin = join(box.base, 'bin')
  await mkdir(bin, { recursive: true })
  const log = join(box.base, 'service-argv.log')
  await writeFile(
    join(bin, 'python3'),
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$FAKE_SERVICE_LOG"',
      'case "$*" in',
      `  *--mode\\ panel*) ${panelBody}; exit ${panelExit} ;;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  )
  await chmod(join(bin, 'python3'), 0o755)
  return { log, path: `${bin}:${process.env.PATH}` }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** One machine-wide round also covers the panel, which is not a deployment: stop last/start last, never fail. */
async function testLegacyPanelShapes() {
  // Pure shapes: the old host is `cli.js panel --foreground` without the panel profile overlay; a
  // current instance always loads `panel.patch.yml`. Everything else is not ours.
  assert.equal(
    looksLikeLegacyPanelHost(['node', '/home/nihao/.local/bin/cli.js', 'panel', '--foreground', '--port', '3080']),
    true,
  )
  assert.equal(
    looksLikeLegacyPanelHost(['node', '/usr/bin/dsh', '--profile', 'panel', '--patch', '/h/.agent-presets/spv/panel.patch.yml']),
    false,
  )
  assert.equal(looksLikeLegacyPanelHost(['vim', 'panel']), false)
  assert.equal(looksLikeLegacyPanelHost(['node', '/x/panel-server.js', '--port', '3080']), false)
  assert.equal(looksLikeLegacyPanelHost([]), false)

  // The HTTP half: a closed port has no answer, a serving one does. No /proc and no real process.
  const closed = await probePanelHttp(30999, { timeoutMs: 300 })
  assert.equal(closed, null)
  const { createServer } = await import('node:http')
  const server = createServer((_, response) => response.end('ok'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    assert.equal(await probePanelHttp(port, { timeoutMs: 800 }), 200)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
  pass('legacy panel detection is a pure, injectable shape plus an HTTP liveness probe')
}

async function testServiceAllIncludesThePanel() {
  const box = await sandbox()
  assert.equal(cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha']).status, 0)
  assert.equal(cli(box, ['deployment', 'add', 'tools/beta', '--repo', 'test/beta']).status, 0)
  let fake = await writeFakeManager(box)
  const env = { PATH: fake.path, FAKE_SERVICE_LOG: fake.log }
  const calls = async () => {
    try {
      return (await readFile(fake.log, 'utf8')).trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  const reset = async () => { await rm(fake.log, { force: true }) }

  // No overlay: the panel is optional; the round stays successful and only touches deployments.
  const missing = cli(box, ['service', 'start', '--all'], env)
  assert.equal(missing.status, 0, missing.stderr)
  assert.equal((await calls()).length, 2)
  assert.match(missing.stdout, /panel: not configured \(no panel overlay at .*panel\.patch\.yml\)/)

  // Installed overlay: the panel starts last, after the deployments whose registry it reads.
  const overlay = join(box.dsh, '.agent-presets', 'spv', 'panel.patch.yml')
  await mkdir(dirname(overlay), { recursive: true })
  await writeFile(overlay, '- id: webserver\n  config: {}\n')
  await reset()
  const start = cli(box, ['service', 'start', '--all'], env)
  assert.equal(start.status, 0, start.stderr)
  const startLines = await calls()
  assert.equal(startLines.length, 3)
  assert.match(startLines[0], /start --profile superagent --patch .*alpha\.yml/)
  assert.match(startLines[1], /start --profile superagent --patch .*beta\.yml/)
  assert.match(startLines[2], /start --mode panel --profile panel --patch .*panel\.patch\.yml/)
  assert.match(startLines[2], /--port 3080/)
  assert.match(start.stdout, /panel: started/)

  // A broken panel prints the manager's reason and fix, but never changes the deployments' exit code.
  fake = await writeFakeManager(box, {
    panelBody: 'echo "FAIL: port 3080 is already in use by pid 4910, which is not profile panel" >&2; echo "fix: stop that process first: kill -INT 4910" >&2',
    panelExit: 1,
  })
  await reset()
  const failedStart = cli(box, ['service', 'start', '--all'], { PATH: fake.path, FAKE_SERVICE_LOG: fake.log })
  assert.equal(failedStart.status, 0, failedStart.stderr)
  assert.equal((await calls()).length, 3)
  assert.match(failedStart.stdout, /panel: FAIL: port 3080 is already in use by pid 4910/)
  assert.match(failedStart.stdout, /kill -INT 4910/)

  // The manager cannot see a pre-#58 `cli.js panel --foreground` host: stop --all stops that one too.
  fake = await writeFakeManager(box, { panelBody: 'echo "OK: not running; nothing to stop"' })
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true })
  try {
    await mkdir(join(box.proc, String(holder.pid)), { recursive: true })
    await writeFile(
      join(box.proc, String(holder.pid), 'cmdline'),
      ['node', join(box.base, 'cli.js'), 'panel', '--foreground', '--port', '3080'].join('\0') + '\0',
    )
    await reset()
    const stop = await cliAsync(box, ['service', 'stop', '--all'], {
      PATH: fake.path, FAKE_SERVICE_LOG: fake.log, SPV_INSTALL_PANEL_HOLDER: String(holder.pid),
    })
    assert.equal(stop.status, 0, stop.stderr)
    assert.match(stop.stdout, new RegExp(`panel: stopped \\(older panel host pid ${holder.pid}\\)`))
    assert.equal(processAlive(holder.pid), false, 'the older panel host was stopped')
  } finally {
    try { process.kill(holder.pid, 'SIGKILL') } catch { /* already gone */ }
  }

  // A host that refuses SIGINT is reported with the exact command; we never escalate to SIGKILL.
  fake = await writeFakeManager(box, { panelBody: 'echo "OK: not running; nothing to stop"' })
  const stubborn = spawn(
    process.execPath,
    ['-e', "process.on('SIGINT', () => {}); setInterval(() => {}, 1000)"],
    { stdio: 'ignore', detached: true },
  )
  try {
    await mkdir(join(box.proc, String(stubborn.pid)), { recursive: true })
    await writeFile(
      join(box.proc, String(stubborn.pid), 'cmdline'),
      ['node', join(box.base, 'stubborn-cli.js'), 'panel', '--foreground', '--port', '3080'].join('\0') + '\0',
    )
    await reset()
    const refused = await cliAsync(
      box,
      ['service', 'stop', '--all'],
      { PATH: fake.path, FAKE_SERVICE_LOG: fake.log, SPV_INSTALL_PANEL_HOLDER: String(stubborn.pid) },
      { timeoutMs: 30_000 },
    )
    assert.equal(refused.status, 0, refused.stderr)
    assert.match(
      refused.stdout,
      new RegExp(`panel: pid ${stubborn.pid} \\(older panel host\\) did not exit; stop it with "kill -INT ${stubborn.pid}"`),
    )
  } finally {
    try { process.kill(stubborn.pid, 'SIGKILL') } catch { /* already gone */ }
  }

  // Nothing of ours on the port: the line says so, and a panel stop failure still keeps exit 0.
  fake = await writeFakeManager(box, { panelBody: 'echo "OK: not running; nothing to stop"' })
  await reset()
  const idle = cli(box, ['service', 'stop', '--all'], { PATH: fake.path, FAKE_SERVICE_LOG: fake.log })
  assert.equal(idle.status, 0, idle.stderr)
  assert.match(idle.stdout, /panel: not running/)

  fake = await writeFakeManager(box, { panelBody: 'echo "FAIL: panel stop exploded" >&2', panelExit: 3 })
  await reset()
  const brokenStop = cli(box, ['service', 'stop', '--all'], { PATH: fake.path, FAKE_SERVICE_LOG: fake.log })
  assert.equal(brokenStop.status, 0, brokenStop.stderr)
  assert.match(brokenStop.stdout, /panel: FAIL: panel stop exploded/)
  pass('service --all includes the standalone panel without letting it change the deployments result')
}

async function testServiceTargetsOwnDeployment() {
  const box = await sandbox()
  assert.equal(cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha']).status, 0)
  assert.equal(cli(box, ['deployment', 'add', 'tools/beta', '--repo', 'test/beta']).status, 0)
  const alpha = instancePath('tools/alpha', { env: envFor(box) })
  const alphaQueue = join(box.state, 'alpha', 'spv')
  const betaQueue = join(box.state, 'beta', 'spv')
  const fake = await fakeServiceManager(box)
  const calls = async () => (await readFile(fake.log, 'utf8')).trim().split('\n').filter(Boolean)

  // 一个知道自己属于 tools/alpha 的进程（`wheelchair-agent spv` 导出给启动器的 SPV_QUEUE_DIR）裸跑
  // start：落在 alpha 的实例上，而不是"没有 project 的基服务"，也不再是 `--project` 缺失的错误。
  const start = cli(box, ['service', 'start'], { SPV_QUEUE_DIR: alphaQueue, PATH: fake.path, FAKE_SERVICE_LOG: fake.log })
  assert.equal(start.status, 0)
  assert.doesNotMatch(start.stderr, /needs --project/)
  const [startLine] = await calls()
  assert.match(startLine, /superagent-service\.py start --profile superagent --patch /)
  assert.ok(startLine.includes(`--patch ${alpha}`), `start targets the alpha overlay: ${startLine}`)
  assert.ok(startLine.includes(`--queue-dir ${alphaQueue}`), `start carries the alpha queue: ${startLine}`)

  // 裸 status 同样只看自己那份部署，不再打"所有部署"的总表。
  const status = cli(box, ['service', 'status'], { SPV_QUEUE_DIR: alphaQueue, PATH: fake.path, FAKE_SERVICE_LOG: fake.log })
  assert.equal(status.status, 0)
  assert.doesNotMatch(status.stdout, /^deployments:$/m)
  assert.doesNotMatch(status.stdout, /profile: superagent/)
  assert.match((await calls()).at(-1), /superagent-service\.py status --profile superagent /)

  // `--project` is not a service selector any more: it is rejected before the manager runs.
  const rejected = cli(box, ['service', 'status', '--project', 'tools/beta'], {
    SPV_QUEUE_DIR: alphaQueue, PATH: fake.path, FAKE_SERVICE_LOG: fake.log,
  })
  assert.equal(rejected.status, 2)
  assert.match(rejected.stderr, /service does not take "--project"/)
  assert.match(rejected.stderr, /restart-all --project/)

  // 既没有 cwd 身份也没有 SPV_QUEUE_DIR 时，裸命令不再回退到旧式无 patch 服务。
  const anonymous = cli(box, ['service', 'start'], { PATH: fake.path, FAKE_SERVICE_LOG: fake.log })
  assert.equal(anonymous.status, 2)
  assert.match(anonymous.stderr, /cannot infer a deployment from /)
  assert.match(anonymous.stderr, /Registered deployments: tools\/alpha, tools\/beta/)
  assert.match(anonymous.stderr, /use --all for every deployment/)
  assert.equal((await calls()).length, 2, 'an anonymous start never reaches the service manager')
  pass('a process that knows its deployment targets itself; a bare command outside every checkout is a usage error')
}

async function testSpvHasNoDeploymentSelectorAndAggregatesEveryQueue() {
  const box = await sandbox()
  assert.equal(cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha']).status, 0)
  assert.equal(cli(box, ['deployment', 'add', 'tools/beta', '--repo', 'test/beta']).status, 0)

  const help = cli(box, ['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /spv \[dsh-tui args\.\.\.\]/)
  assert.doesNotMatch(help.stdout, /spv \[--project/)

  const rejected = cli(box, ['spv', '--project', 'tools/alpha'])
  assert.equal(rejected.status, 2)
  assert.match(rejected.stderr, /spv does not take "--project"/)
  assert.match(rejected.stderr, /global SPV session, not a deployment/)

  // A fake launcher records exactly what `spv` hands the supervised child. `spv` starts no backend at all,
  // so PATH holds only python3 and sh: nothing can reach the real service manager.
  const bin = join(box.base, 'path-bin')
  await mkdir(bin, { recursive: true })
  await symlink(PYTHON, join(bin, 'python3'))
  await symlink('/bin/sh', join(bin, 'sh'))
  const launcher = join(box.base, 'fake-launcher.sh')
  const recorded = join(box.base, 'launcher-env.txt')
  await writeFile(
    launcher,
    '#!/bin/sh\n{\n  printf "SPV_QUEUE_DIR=%s\\n" "${SPV_QUEUE_DIR-}"\n' +
      '  printf "DSH_SUPERAGENT_STATE_DIR=%s\\n" "${DSH_SUPERAGENT_STATE_DIR-}"\n' +
      '  printf "ARGV=%s\\n" "$*"\n} > "$FAKE_LAUNCHER_ENV"\nexit 0\n',
  )
  await chmod(launcher, 0o755)
  const run = cli(box, ['spv'], {
    WHEELCHAIR_AGENT_LAUNCHER: launcher,
    FAKE_LAUNCHER_ENV: recorded,
    SPV_QUEUE_DIR: join(box.state, 'alpha', 'spv'),
    DSH_SUPERAGENT_STATE_DIR: join(box.state, 'alpha'),
    PATH: bin,
  })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  const notes = run.stdout.split('\n').filter(line => line.startsWith('note: backends start on demand:'))
  assert.equal(notes.length, 1, `spv prints exactly one on-demand note: ${run.stdout}`)
  assert.match(notes[0], /the deployment a task targets is started when the task is dispatched/)
  const seen = await readFile(recorded, 'utf8')
  assert.match(seen, /^SPV_QUEUE_DIR=$/m, `spv must not export a queue identity:\n${seen}`)
  assert.match(seen, /^DSH_SUPERAGENT_STATE_DIR=$/m, `spv must not export a deployment state dir:\n${seen}`)

  // With no override the same registry must aggregate every deployment into the injector/status roots.
  const saved = { home: process.env.WHEELCHAIR_AGENT_HOME, state: process.env.DSH_SUPERAGENT_STATE_DIR, queue: process.env.SPV_QUEUE_DIR }
  try {
    process.env.WHEELCHAIR_AGENT_HOME = box.data
    process.env.DSH_SUPERAGENT_STATE_DIR = box.state
    delete process.env.SPV_QUEUE_DIR
    const roots = resolveRoots({})
    assert.deepEqual(
      roots.map(item => item.root).sort(),
      [join(box.state, 'alpha', 'spv'), join(box.state, 'beta', 'spv')].sort(),
      'a registry-only session watches both deployment queues',
    )
  } finally {
    if (saved.home === undefined) delete process.env.WHEELCHAIR_AGENT_HOME; else process.env.WHEELCHAIR_AGENT_HOME = saved.home
    if (saved.state === undefined) delete process.env.DSH_SUPERAGENT_STATE_DIR; else process.env.DSH_SUPERAGENT_STATE_DIR = saved.state
    if (saved.queue === undefined) delete process.env.SPV_QUEUE_DIR; else process.env.SPV_QUEUE_DIR = saved.queue
  }
  pass('spv takes no deployment selector, exports no queue/state identity, and aggregation still sees both queues')
}

async function testStaleSingleDeploymentTextIsGone() {
  const box = await sandbox()
  const notice = mergeNoticeText({
    item: { id: 'acme-beta-7', pr: 7, title: 'thing' },
    repo: 'acme/beta',
    project: 'tools/beta',
    localPath: '/tmp/checkout',
    pulledSha: 'deadbeef',
    pending: { kind: 'unknown' },
  })
  assert.match(notice, /cd '?\/tmp\/checkout'? && wheelchair-agent service stop/)
  assert.match(notice, /install\.sh --project '?tools\/beta'?/)
  assert.match(notice, /cd '?\/tmp\/checkout'? && wheelchair-agent service start/)
  assert.match(notice, /^  wheelchair-agent spv$/m)
  assert.doesNotMatch(notice, /service (?:stop|start) --project/)
  assert.doesNotMatch(notice, /^  wheelchair-agent service (?:stop|start)$/m)

  await mkdir(box.data, { recursive: true })
  await writeFile(join(box.data, 'deployments.json'), JSON.stringify({ version: 1, deployments: [] }))
  const listed = cli(box, ['deployment', 'list'])
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /the registry is the only source/)
  assert.match(listed.stdout, /deployment migrate/)
  assert.match(listed.stdout, /install\.sh --project tools\/<name>/)
  assert.doesNotMatch(listed.stdout, /single-deployment default/)
  pass('cold-install notice and the empty-registry list name every project and no longer invent a base deployment')
}

async function testServiceStatusInfersFromCwd() {
  const box = await sandbox()
  assert.equal(cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha', '--port', '3904']).status, 0)
  const projectsRoot = join(box.home, 'bioagentforge')
  const checkout = join(projectsRoot, 'tools', 'alpha')
  const nested = join(checkout, 'src', 'deep')
  await mkdir(nested, { recursive: true })
  const fake = await fakeServiceManager(box)
  const calls = async () => (await readFile(fake.log, 'utf8')).trim().split('\n').filter(Boolean)
  // The fake manager prints the fields the real manager would print; the argv proves which overlay it was
  // pointed at, so this covers "the right pid/runtime for this instance" without touching a real service.
  await writeFile(join(box.base, 'bin', 'python3'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_SERVICE_LOG"\ncase "$*" in *status*) printf \'pids:    4242\\nruntime: ready\\n\';; esac\nexit 0\n')
  await chmod(join(box.base, 'bin', 'python3'), 0o755)

  const status = cli(box, ['service', 'status'], { PATH: fake.path, FAKE_SERVICE_LOG: fake.log }, { cwd: nested })
  assert.equal(status.status, 0)
  const line = (await calls()).at(-1)
  assert.ok(line.includes(`--patch ${instancePath('tools/alpha', { env: envFor(box) })}`), `cwd picks alpha: ${line}`)
  assert.ok(line.includes('status'))
  assert.match(status.stdout, /^pids:    4242$/m)
  assert.match(status.stdout, /^runtime: ready$/m)
  assert.doesNotMatch(status.stdout, /pids:    \(none\)/)

  // A selector is not accepted as a way to override cwd; it is a usage error before the manager runs.
  const rejected = cli(box, ['service', 'status', '--project', 'tools/alpha'], {
    PATH: fake.path, FAKE_SERVICE_LOG: fake.log,
  }, { cwd: box.base })
  assert.equal(rejected.status, 2)
  assert.match(rejected.stderr, /service does not take "--project"/)
  assert.ok((await calls()).every(line => !line.includes('--project')), 'the manager never receives --project')
  pass('a bare service status inside a project checkout (even nested) targets that deployment')
}

async function testServiceStatusListsDeployments() {
  const box = await sandbox()
  assert.equal(cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha']).status, 0)
  assert.equal(cli(box, ['deployment', 'add', 'tools/beta', '--repo', 'test/beta']).status, 0)
  const alpha = instancePath('tools/alpha', { env: envFor(box) })
  const beta = instancePath('tools/beta', { env: envFor(box) })
  const procRoot = join(box.base, 'proc')
  await fakeProcEntry(procRoot, 100, ['dsh', '--profile', 'superagent', '--patch', alpha])
  await fakeProcEntry(procRoot, 300, ['dsh', '--profile', 'superagent'])

  // `--all` keeps the old aggregate: legacy lines, one line per deployment, ordered by project.
  const status = cli(box, ['service', 'status', '--all'], { WHEELCHAIR_PROC_ROOT: procRoot })
  assert.ok([0, 1].includes(status.status), `status is a view, not a health gate: ${status.status}`)
  assert.match(status.stdout, /^panel:/m)
  assert.match(status.stdout, /^== tools\/alpha ==$/m)
  assert.match(status.stdout, /^== tools\/beta ==$/m)
  assert.match(status.stdout, /profile: superagent/)
  assert.match(status.stdout, /url:     http:\/\/127\.0\.0\.1:3082/)

  // Bare `status` outside every checkout cannot guess a deployment any more: exit 2, list, no legacy view.
  const outside = cli(box, ['service', 'status'], { WHEELCHAIR_PROC_ROOT: procRoot }, { cwd: box.base })
  assert.equal(outside.status, 2)
  assert.doesNotMatch(outside.stdout, /profile: superagent/)
  assert.match(outside.stderr, /cannot infer a deployment from /)
  assert.match(outside.stderr, /Registered deployments: tools\/alpha, tools\/beta/)
  assert.match(outside.stderr, /use --all for every deployment/)

  const single = cli(box, ['service', 'status', '--project', 'tools/beta'], { WHEELCHAIR_PROC_ROOT: procRoot })
  assert.equal(single.status, 2)
  assert.match(single.stderr, /service does not take "--project"/)
  assert.doesNotMatch(single.stdout, /^deployments:$/m)

  pass('service status --all keeps the old per-deployment aggregate; bare status outside a checkout is a usage error')
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
  assert.equal(cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha']).status, 0)
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
  await testRestartAllDryRunFromInsideSession()
  await testSpvHasNoDeploymentSelectorAndAggregatesEveryQueue()
  await testStaleSingleDeploymentTextIsGone()
  await testServiceStatusInfersFromCwd()
  await testServiceStatusListsDeployments()
  await testServiceTargetsOwnDeployment()
  await testLegacyPanelShapes()
  await testServiceAllIncludesThePanel()
  await testRestartCommandPassesProject()
  process.stdout.write(`ok (${passed} passed)\n`)
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const dir of SANDBOXES) await rm(dir, { recursive: true, force: true })
}
