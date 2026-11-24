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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  return {
    base,
    home: join(base, 'home'),
    dsh: join(base, 'dsh'),
    data: join(base, 'data'),
    state: join(base, 'dsh', 'state', 'superagent'),
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

try {
  testSlugRules()
  await testRenderAndWrite()
  testPortAllocation()
  await testAddAllocatesPortsAndRendersInstances()
  await testSlugCollisionIsRejected()
  await testServiceProjectSelector()
  process.stdout.write(`ok (${passed} passed)\n`)
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  for (const dir of SANDBOXES) await rm(dir, { recursive: true, force: true })
}
