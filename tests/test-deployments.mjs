#!/usr/bin/env node
/**
 * tests/test-deployments.mjs — 「一仓一部署」stage 1（路由脊梁）的离线证据。
 *
 * 覆盖 `ARCHITECTURE/deployments.md` 里 stage 1 的验收行：
 *   - 注册表有两条条目时，两个项目的 dispatch 各写自己的队列，互不串线（CLI 与 `spv_dispatch` 工具都验证）；
 *   - 项目没有条目时，错误里给出下一步 `wheelchair-agent deployment add <project>`，且不写任何队列；
 *   - 注册表不存在时完全走旧的单部署路径（`<stateDir>/spv`），`$SPV_QUEUE_DIR` 仍是最强覆盖；
 *   - `deployment list/add/remove/migrate` 的幂等与差异输出；
 *   - 坏注册表（非法 JSON / 不认识的版本）大声失败、一个字节都不改；
 *   - `migrate` 把当前单部署记成 `tools/wheelchair-agent`，带上 installed.json 的 commit。
 *
 * 全程沙箱：`mkdtemp` 的 HOME/DSH_HOME/WHEELCHAIR_AGENT_HOME/stateDir，加一个只回 200 的本地 HTTP
 * 服务充当 superagent 健康检查；不写真实 `~/.wheelchair-agent`，不碰 systemd、端口或 profile。
 *
 * 用法：node tests/test-deployments.mjs（任一断言失败则 exit 1）
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { installStampPath, writeStamp } from '../src/shared/install-stamp.js'
import { defineSpvTools } from '../src/spv/tools.js'

const CLI = fileURLToPath(new URL('../bin/wheelchair-agent.mjs', import.meta.url))
const SANDBOXES = []

/** 一个沙箱：HOME/DSH_HOME 与数据根、状态目录、几条互不相同的队列。 */
async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'wheelchair-agent-deployments-test-'))
  SANDBOXES.push(base)
  return {
    base,
    home: join(base, 'home'),
    dsh: join(base, 'dsh'),
    data: join(base, 'data'),
    state: join(base, 'state'),
    stateA: join(base, 'state-a'),
    stateB: join(base, 'state-b'),
    queueA: join(base, 'state-a', 'spv'),
    queueB: join(base, 'state-b', 'spv'),
    queueOverride: join(base, 'queue-override'),
  }
}

/** 健康检查只要求“有 HTTP 响应”，所以一个总是 200 的空服务就足够，且不碰真实端口。 */
const SERVICE = createServer((_request, response) => {
  response.statusCode = 200
  response.setHeader('content-type', 'application/json')
  response.end('{"ok":true}')
})
await new Promise(resolve => SERVICE.listen(0, '127.0.0.1', resolve))
const SERVICE_URL = `http://127.0.0.1:${SERVICE.address().port}`

/** 干净的环境：所有会改变路由的变量先删掉，再写入沙箱值；`extra` 最后覆盖。 */
function envFor(box, extra = {}) {
  const env = { ...process.env }
  for (const key of [
    'SPV_QUEUE_DIR',
    'SPV_SUPERAGENT_URL',
    'SPV_SUPERAGENT_PORT',
    'DSH_SUPERAGENT_PORT',
    'SPV_SERVICE_PORT',
    'DSH_SUPERAGENT_PROFILE',
    'SPV_INSTALL_REPO',
    'SPV_INBOX_DIR',
    'SPV_PREPARE_LOG',
    'SPV_PROJECTS_ROOT',
  ]) {
    delete env[key]
  }
  return {
    ...env,
    HOME: box.home,
    DSH_HOME: box.dsh,
    WHEELCHAIR_AGENT_HOME: box.data,
    DSH_SUPERAGENT_STATE_DIR: box.state,
    DSH_SUPERAGENT_URL: SERVICE_URL,
    ...extra,
  }
}

/** 子进程跑 CLI。必须异步：同进程里的健康检查服务要能在 CLI 等待期间应答。 */
async function cli(box, argv, extra = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...argv], {
      env: envFor(box, extra),
      encoding: 'utf8',
    })
    return { status: 0, stdout, stderr }
  } catch (error) {
    return { status: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

const registryFile = box => join(box.data, 'deployments.json')

/** `pending/` 里的任务文件名；目录不存在读成空，因为“没有队列”和“空队列”在路由测试里都是零条。 */
async function pendingFiles(queue) {
  try {
    return (await readdir(join(queue, 'pending'))).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function pendingRecord(queue) {
  const names = await pendingFiles(queue)
  assert.equal(names.length, 1, `exactly one task in ${queue}/pending, got ${names.join(', ') || 'none'}`)
  return readJson(join(queue, 'pending', names[0]))
}

// ------------------------------------------------------------ 注册表与 CLI 契约

async function testNoRegistryKeepsSingleDeployment() {
  const box = await sandbox()

  const listed = await cli(box, ['deployment', 'list'])
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /no deployments recorded yet/)
  assert.match(listed.stdout, /wheelchair-agent deployment migrate/)
  assert.equal(await exists(registryFile(box)), false, 'listing does not create the registry')

  const json = await cli(box, ['deployment', 'list', '--json'])
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout), { version: 1, registry: registryFile(box), deployments: [] })

  // 注册表不存在 = 旧路径：dispatch 写 <stateDir>/spv，行为与升级前一致。
  const dispatched = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'old path'])
  assert.equal(dispatched.status, 0, dispatched.stderr)
  assert.equal((await pendingFiles(join(box.state, 'spv'))).length, 1)
  assert.equal(await exists(registryFile(box)), false, 'dispatch never creates the registry')
}

async function testAddListUpdateAndRemove() {
  const box = await sandbox()

  const added = await cli(box, [
    'deployment', 'add', 'tools/alpha', '--state-dir', box.stateA, '--queue-dir', box.queueA, '--port', '3101',
  ])
  assert.equal(added.status, 0, added.stderr)
  assert.match(added.stdout, /registered project tools\/alpha/)
  let registry = await readJson(registryFile(box))
  assert.deepEqual(registry, {
    version: 1,
    deployments: [{
      project: 'tools/alpha',
      profile: 'superagent',
      stateDir: box.stateA,
      queueDir: box.queueA,
      port: 3101,
      installedSha: null,
    }],
  })

  // 完全相同的条目是幂等成功，且不重写文件（时间戳/字节都不变）。
  const before = await readFile(registryFile(box), 'utf8')
  const again = await cli(box, [
    'deployment', 'add', 'tools/alpha', '--state-dir', box.stateA, '--queue-dir', box.queueA, '--port', '3101',
  ])
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /already registered with these values; nothing changed/)
  assert.equal(await readFile(registryFile(box), 'utf8'), before)

  const updated = await cli(box, ['deployment', 'add', 'tools/alpha', '--state-dir', box.stateA, '--queue-dir', box.queueA, '--port', '3103'])
  assert.equal(updated.status, 0, updated.stderr)
  assert.match(updated.stdout, /updated tools\/alpha: port 3101 -> 3103/)
  registry = await readJson(registryFile(box))
  assert.equal(registry.deployments[0].port, 3103)

  const second = await cli(box, [
    'deployment', 'add', 'tools/beta', '--profile', 'superagent', '--state-dir', box.stateB,
    '--queue-dir', box.queueB, '--port', '3102',
  ])
  assert.equal(second.status, 0, second.stderr)

  const listed = await cli(box, ['deployment', 'list'])
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, new RegExp(`registry: ${registryFile(box).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(listed.stdout, /project tools\/alpha profile=superagent/)
  assert.match(listed.stdout, new RegExp(`project tools/beta profile=superagent stateDir=${box.stateB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

  const json = JSON.parse((await cli(box, ['deployment', 'list', '--json'])).stdout)
  assert.deepEqual(json.deployments.map(entry => entry.project), ['tools/alpha', 'tools/beta'])

  const removed = await cli(box, ['deployment', 'remove', 'tools/alpha'])
  assert.equal(removed.status, 0, removed.stderr)
  assert.match(removed.stdout, /^project tools\/alpha profile=superagent/m)
  assert.match(removed.stdout, /removed tools\/alpha; the deployment itself/)
  assert.match(removed.stdout, /1 deployment\(s\) remain/)
  assert.deepEqual((await readJson(registryFile(box))).deployments.map(entry => entry.project), ['tools/beta'])

  const missing = await cli(box, ['deployment', 'remove', 'tools/gamma'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no deployment for "tools\/gamma"/)
}

async function testAddDefaultsAndUsageErrors() {
  const box = await sandbox()

  // 省略 --state-dir/--queue-dir 时每部署一个 <base>/<slug>，队列必须等于 <stateDir>/spv；
  // 端口从 3082 起取注册表未用的第一个，实例 overlay 同时渲染出来。
  const added = await cli(box, ['deployment', 'add', 'tools/delta'])
  assert.equal(added.status, 0, added.stderr)
  const entry = (await readJson(registryFile(box))).deployments[0]
  assert.equal(entry.stateDir, join(box.state, 'delta'))
  assert.equal(entry.queueDir, join(box.state, 'delta', 'spv'))
  assert.equal(entry.port, 3082)
  assert.equal(entry.installedSha, null)
  assert.match(added.stdout, /instance .*deployments\/delta\.yml/)
  const instance = await readFile(join(box.data, 'deployments', 'delta.yml'), 'utf8')
  assert.match(instance, /- id: webserver/)
  assert.match(instance, /port: 3082/)
  assert.ok(instance.includes(JSON.stringify(join(box.state, 'delta'))))

  assert.equal((await cli(box, ['deployment', 'add'])).status, 2, 'add without a project is a usage error')
  assert.equal((await cli(box, ['deployment', 'add', 'tools/alpha', '--port', '70000'])).status, 2)
  assert.equal((await cli(box, ['deployment', 'add', 'tools/alpha', '--port', 'nope'])).status, 2)
  assert.equal((await cli(box, ['deployment', 'list', 'extra'])).status, 2)
  assert.equal((await cli(box, ['deployment', 'add', 'tools/alpha', '--bogus', 'x'])).status, 2)
  assert.equal((await cli(box, ['deployment', 'unknown'])).status, 2)

  const help = await cli(box, ['deployment', '--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /deployment <list|add|remove|migrate>/)

  const invalid = await cli(box, ['deployment', 'add', 'not-a-project'])
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /invalid project/)
}

// ---------------------------------------------------------------- 按项目路由

async function testDispatchRoutesEachProjectToItsOwnQueue() {
  const box = await sandbox()
  for (const [project, stateDir, queue, port] of [
    ['tools/alpha', box.stateA, box.queueA, '3101'],
    ['tools/beta', box.stateB, box.queueB, '3102'],
  ]) {
    const added = await cli(box, ['deployment', 'add', project, '--state-dir', stateDir, '--queue-dir', queue, '--port', port])
    assert.equal(added.status, 0, added.stderr)
  }

  const alpha = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'alpha only', '--thread', 't-alpha'])
  assert.equal(alpha.status, 0, alpha.stderr)
  assert.match(alpha.stdout, /dispatched [0-9a-f]+ on thread "t-alpha" for project tools\/alpha/)

  const alphaRecord = await pendingRecord(box.queueA)
  assert.equal(alphaRecord.project, 'tools/alpha')
  assert.equal(alphaRecord.text, 'alpha only')
  assert.equal(alphaRecord.thread, 't-alpha')
  assert.equal(alphaRecord.actor, 'operator')
  assert.equal(alphaRecord.source, 'spv_tools')
  assert.equal((await pendingFiles(box.queueB)).length, 0, 'alpha never wrote beta\'s queue')

  const beta = await cli(box, ['dispatch', '--project', 'tools/beta', '--task', 'beta only'])
  assert.equal(beta.status, 0, beta.stderr)
  assert.equal((await pendingRecord(box.queueB)).text, 'beta only')
  assert.equal((await pendingFiles(box.queueA)).length, 1, 'beta never wrote alpha\'s queue')

  // 旧的显式覆盖仍然最强：$SPV_QUEUE_DIR 指向别处时，注册表不参与路由。
  const overridden = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'override'], { SPV_QUEUE_DIR: box.queueOverride })
  assert.equal(overridden.status, 0, overridden.stderr)
  assert.equal((await pendingRecord(box.queueOverride)).text, 'override')
  assert.equal((await pendingFiles(box.queueA)).length, 1, 'the override wins over the registry')
}

async function testToolDispatchUsesTheRegistry() {
  const box = await sandbox()
  for (const [project, stateDir, queue] of [
    ['tools/alpha', box.stateA, box.queueA],
    ['tools/beta', box.stateB, box.queueB],
  ]) {
    const added = await cli(box, ['deployment', 'add', project, '--state-dir', stateDir, '--queue-dir', queue])
    assert.equal(added.status, 0, added.stderr)
  }

  // 工具在进程内跑：临时把影响路由的环境变量指向沙箱，结束后原样恢复。
  const saved = {}
  const keys = ['WHEELCHAIR_AGENT_HOME', 'DSH_SUPERAGENT_STATE_DIR', 'DSH_SUPERAGENT_URL', 'SPV_QUEUE_DIR']
  for (const key of keys) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.WHEELCHAIR_AGENT_HOME = box.data
  process.env.DSH_SUPERAGENT_STATE_DIR = box.state
  process.env.DSH_SUPERAGENT_URL = SERVICE_URL
  try {
    const tools = defineSpvTools(join(box.state, 'spv'), {}, {})
    const dispatchTool = tools.find(tool => tool.name === 'spv_dispatch')
    assert.ok(dispatchTool, 'spv_dispatch is registered')

    const result = await dispatchTool.execute({ project: 'tools/beta', task: 'via the tool', thread: 'tool-thread' }, {})
    assert.equal(result.project, 'tools/beta')
    assert.equal((await pendingRecord(box.queueB)).text, 'via the tool')
    assert.equal((await pendingFiles(box.queueA)).length, 0)

    await assert.rejects(
      () => dispatchTool.execute({ project: 'tools/gamma', task: 'nobody reads this' }, {}),
      /deployment add tools\/gamma/,
    )
    assert.equal((await pendingFiles(box.queueA)).length, 0, 'a missing deployment writes nothing')
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

async function testMissingDeploymentIsActionable() {
  const box = await sandbox()
  const added = await cli(box, ['deployment', 'add', 'tools/alpha', '--state-dir', box.stateA, '--queue-dir', box.queueA])
  assert.equal(added.status, 0, added.stderr)

  const result = await cli(box, ['dispatch', '--project', 'tools/gamma', '--task', 'x'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no deployment for project "tools\/gamma"/)
  assert.match(result.stderr, /wheelchair-agent deployment add tools\/gamma/)
  assert.match(result.stderr, /never created automatically/)
  assert.equal((await pendingFiles(box.queueA)).length, 0, 'nothing was written into another deployment\'s queue')
  assert.equal(await exists(join(box.state, 'spv')), false, 'no fallback queue was created')
}

// --------------------------------------------------------------- 坏注册表

async function testCorruptRegistryIsNeverRewritten() {
  const box = await sandbox()
  await mkdir(box.data, { recursive: true })
  const broken = '{"version":1,"deployments":[\n'
  await writeFile(registryFile(box), broken, 'utf8')

  const listed = await cli(box, ['deployment', 'list'])
  assert.equal(listed.status, 1)
  assert.match(listed.stderr, /deployment registry/)
  assert.ok(listed.stderr.includes(registryFile(box)), 'the error names the file')
  assert.equal(await readFile(registryFile(box), 'utf8'), broken, 'list did not rewrite the file')

  const dispatched = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'x'])
  assert.equal(dispatched.status, 1)
  assert.equal(await readFile(registryFile(box), 'utf8'), broken, 'dispatch did not rewrite the file')
  assert.equal(await exists(join(box.state, 'spv')), false, 'a broken registry never falls back to a guessed queue')

  await writeFile(registryFile(box), '{"version":2,"deployments":[]}\n', 'utf8')
  const unknown = await cli(box, ['deployment', 'list'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /understands version 1/)
}

// -------------------------------------------------- 队列必须等于 <stateDir>/spv

async function testQueueDirMustMatchStateDir() {
  const box = await sandbox()
  const rejected = await cli(box, [
    'deployment', 'add', 'tools/alpha', '--state-dir', box.stateA, '--queue-dir', box.queueB,
  ])
  assert.equal(rejected.status, 2)
  assert.match(rejected.stderr, /a deployment reads <stateDir>\/spv/)
  assert.match(rejected.stderr, /never reads/)
  assert.equal(await exists(registryFile(box)), false, 'a rejected add wrote nothing')

  // 手改出来的不一致条目在读取时就报错，不静默使用，也不重写。
  const file = registryFile(box)
  await mkdir(box.data, { recursive: true })
  const broken = `${JSON.stringify({
    version: 1,
    deployments: [{
      project: 'tools/alpha',
      profile: 'superagent',
      stateDir: box.stateA,
      queueDir: box.queueB,
      port: 3101,
      installedSha: null,
    }],
  }, null, 2)}\n`
  await writeFile(file, broken, 'utf8')
  const listed = await cli(box, ['deployment', 'list'])
  assert.equal(listed.status, 1)
  assert.match(listed.stderr, /must read/)
  assert.equal(await readFile(file, 'utf8'), broken, 'the inconsistent registry was not rewritten')
  const dispatched = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'x'])
  assert.equal(dispatched.status, 1)
  assert.equal(await readFile(file, 'utf8'), broken)
}

// ------------------------------------------------------------------- migrate

async function testMigrateRecordsTheCurrentDeployment() {
  const box = await sandbox()
  const commit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
  writeStamp(installStampPath(box.data), {
    version: 1,
    commit,
    installedAt: '2026-11-24T00:00:00.000Z',
    targets: { presetDir: join(box.dsh, '.agent-presets', 'spv') },
    components: Object.fromEntries(['preset', 'webui', 'bin', 'core'].map(name => [name, { files: {}, digest: 'x' }])),
  })

  const migrated = await cli(box, ['deployment', 'migrate'], { DSH_SUPERAGENT_PROFILE: 'superagent', SPV_SERVICE_PORT: '3082' })
  assert.equal(migrated.status, 0, migrated.stderr)
  assert.match(migrated.stdout, /registered project tools\/wheelchair-agent/)
  const registry = await readJson(registryFile(box))
  assert.deepEqual(registry.deployments, [{
    project: 'tools/wheelchair-agent',
    profile: 'superagent',
    stateDir: box.state,
    queueDir: join(box.state, 'spv'),
    port: 3082,
    installedSha: commit,
  }])

  // 幂等：已有条目时一个字节都不改。
  const before = await readFile(registryFile(box), 'utf8')
  const again = await cli(box, ['deployment', 'migrate'])
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /already recorded/)
  assert.equal(await readFile(registryFile(box), 'utf8'), before)

  // migrate 之后旧路径变成一条真实路由：dispatch tools/wheelchair-agent 写 <stateDir>/spv。
  const dispatched = await cli(box, ['dispatch', '--project', 'tools/wheelchair-agent', '--task', 'migrated'])
  assert.equal(dispatched.status, 0, dispatched.stderr)
  assert.equal((await pendingRecord(join(box.state, 'spv'))).text, 'migrated')

  // migrate 只记录恒等式队列 <stateDir>/spv；$SPV_QUEUE_DIR 是运行期的派单覆盖，不进注册表。
  const other = await sandbox()
  const custom = await cli(other, ['deployment', 'migrate'], { SPV_QUEUE_DIR: other.queueOverride })
  assert.equal(custom.status, 0, custom.stderr)
  assert.equal((await readJson(registryFile(other))).deployments[0].queueDir, join(other.state, 'spv'))
  assert.equal(
    (await cli(other, ['dispatch', '--project', 'tools/wheelchair-agent', '--task', 'override'], { SPV_QUEUE_DIR: other.queueOverride })).status,
    0,
  )
  assert.equal((await pendingRecord(other.queueOverride)).text, 'override')
}

// -------------------------------------------------------------------- main

try {
  await testNoRegistryKeepsSingleDeployment()
  await testAddListUpdateAndRemove()
  await testAddDefaultsAndUsageErrors()
  await testDispatchRoutesEachProjectToItsOwnQueue()
  await testToolDispatchUsesTheRegistry()
  await testMissingDeploymentIsActionable()
  await testCorruptRegistryIsNeverRewritten()
  await testQueueDirMustMatchStateDir()
  await testMigrateRecordsTheCurrentDeployment()
  process.stdout.write('ok\n')
} catch (error) {
  process.stderr.write(`not ok: ${error?.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  SERVICE.close()
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true }).catch(() => {})
}
