/**
 * 实例-orchestrator 项目保护机制：一个 orchestrator 项目路径最多属于一个实例（部署），也只能由那个实例来跑。
 *
 * 用 `node:test` 固化六条不变量：
 *   ① 同一真实路径不能被第二个项目登记成部署（符号链接别名也一样），错误点名已有实例名与端口；
 *   ② 同一项目重复 add 是幂等的；
 *   ③ `spv-project add --orchestrator`（旧名 --worker 等价）只接受已登记部署的项目；
 *   ④ 同一个 orchestrator 项目不能同时属于两个 spv 根，错误同时点名两个根；
 *   ⑤ `spv_dispatch` 找不到或多于一个认领该项目的部署时失败，且 `pending/` 一条都不写；
 *   ⑥ 正常路径仍然写进该项目自己部署的队列。
 *
 * 全程 mkdtemp 沙箱（HOME/DSH_HOME/WHEELCHAIR_AGENT_HOME/SPV_PROJECTS_ROOT），假实例只在本机动态端口
 * 上应答；不触碰真实 `~/.wheelchair-agent`、不启停任何部署。
 *
 * 用法：node --test tests/test-worker-binding.mjs（或经 npm test 串联）
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const CLI = join(ROOT, 'bin', 'wheelchair-agent.mjs')

/** 假实例的设置：spv 来源已允许 operator，派单的准入检查无需回写。 */
const SETTINGS = JSON.stringify({
  blocks: {
    policy: {
      revision: 1,
      value: { rules: [], sources: { spv: { allowed: [{ id: 'operator', name: 'local operator' }] } } },
    },
    executor: { revision: 1, value: { prepare: 'wheelchair-agent prepare' } },
  },
  sources: [],
})

function makeBox() {
  const base = mkdtempSync(join(tmpdir(), 'wca-worker-binding-'))
  const box = {
    base,
    home: join(base, 'home'),
    dsh: join(base, 'dsh'),
    data: join(base, 'data'),
    projects: join(base, 'projects'),
    state: join(base, 'state'),
  }
  for (const dir of [box.home, box.dsh, box.data, box.projects, box.state]) mkdirSync(dir, { recursive: true })
  return box
}

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
    SPV_PROJECTS_ROOT: box.projects,
    ...extra,
  }
}

function cli(box, argv, extra = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...argv], {
      env: envFor(box, extra),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    }
  }
}

function workerDirectory(box, project) {
  const directory = join(box.projects, project)
  mkdirSync(directory, { recursive: true })
  return directory
}

function entryFor(box, project, port, extra = {}) {
  const stateDir = join(box.state, project.replaceAll('/', '-'))
  return {
    project,
    profile: 'superagent',
    stateDir,
    queueDir: join(stateDir, 'spv'),
    port,
    installedSha: null,
    repository: null,
    ...extra,
  }
}

function writeRegistry(box, entries) {
  writeFileSync(join(box.data, 'deployments.json'), `${JSON.stringify({ version: 1, deployments: entries }, null, 2)}\n`)
}

function readRegistry(box) {
  return JSON.parse(readFileSync(join(box.data, 'deployments.json'), 'utf8'))
}

function pendingFiles(queue) {
  try {
    return readdirSync(join(queue, 'pending')).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** 在子进程里调用真实的 `spv_dispatch` 工具；必须异步，父进程里的假实例才能应答探活。 */
async function dispatch(box, project, extra = {}) {
  const script = `
import { defineSpvTools } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'spv', 'tools.js')).href)}
const tool = defineSpvTools('/', {}, {}).find(item => item.name === 'spv_dispatch')
try {
  const result = await tool.execute({ project: ${JSON.stringify(project)}, task: 'binding test task', thread: 'binding' }, {})
  console.log(JSON.stringify({ ok: true, project: result.project }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
`
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env: envFor(box, extra),
      encoding: 'utf8',
    })
    return { status: 0, stdout, stderr }
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    }
  }
}

/** 假实例：settings 里允许 operator，其余路径回 200。 */
async function openInstance() {
  const server = createServer((request, response) => {
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.end(request.url === '/orchestrator/api/settings' ? SETTINGS : '{"ok":true}')
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

async function closeInstance(instance) {
  await new Promise(resolve => {
    instance.server.closeAllConnections()
    instance.server.close(resolve)
  })
}

function cleanup(box) {
  rmSync(box.base, { recursive: true, force: true })
}

test('① another project name at the same real path is rejected', async () => {
  const box = makeBox()
  try {
    workerDirectory(box, 'tools/alpha')
    const first = cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha', '--port', '3401'])
    assert.equal(first.status, 0, first.stderr)

    symlinkSync(join(box.projects, 'tools', 'alpha'), join(box.projects, 'tools', 'alpha-link'))
    const second = cli(box, ['deployment', 'add', 'tools/alpha-link', '--repo', 'test/alpha-link', '--port', '3402'])
    assert.notEqual(second.status, 0, 'the alias must not become a second deployment')
    assert.match(second.stderr, /is already the deployment "alpha" \(port 3401\)/)
    assert.match(second.stderr, /belongs to exactly one instance/)
    assert.deepEqual(readRegistry(box).deployments.map(entry => entry.project), ['tools/alpha'])
  } finally {
    cleanup(box)
  }
})

test('② re-adding the same project is still idempotent', async () => {
  const box = makeBox()
  try {
    workerDirectory(box, 'tools/alpha')
    const first = cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha', '--port', '3401'])
    assert.equal(first.status, 0, first.stderr)
    const again = cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha', '--port', '3401'])
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /nothing changed/)
    assert.deepEqual(readRegistry(box).deployments.map(entry => entry.project), ['tools/alpha'])
  } finally {
    cleanup(box)
  }
})

test('③ spv-project add refuses an orchestrator project with no registered deployment', async () => {
  const box = makeBox()
  try {
    const root = join(box.home, 'spv-a')
    mkdirSync(join(root, 'tools', 'orphan'), { recursive: true })
    const added = cli(box, ['spv-project', 'add', root, '--worker', 'tools/orphan'])
    assert.notEqual(added.status, 0)
    assert.match(added.stderr, /is not the project of a registered deployment/)
    assert.match(added.stderr, /deployment add tools\/orphan --repository owner\/name/)
  } finally {
    cleanup(box)
  }
})

test('④ one orchestrator project cannot belong to two spv roots, and both roots are named', async () => {
  const box = makeBox()
  try {
    workerDirectory(box, 'tools/alpha')
    const registered = cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha', '--port', '3401'])
    assert.equal(registered.status, 0, registered.stderr)

    const firstRoot = join(box.home, 'spv-a')
    const secondRoot = join(box.home, 'spv-b')
    mkdirSync(join(firstRoot, 'tools', 'alpha'), { recursive: true })
    mkdirSync(join(secondRoot, 'tools', 'alpha'), { recursive: true })
    assert.equal(cli(box, ['spv-project', 'add', firstRoot, '--worker', 'tools/alpha']).status, 0)

    const second = cli(box, ['spv-project', 'add', secondRoot, '--worker', 'tools/alpha'])
    assert.notEqual(second.status, 0)
    assert.match(second.stderr, /already bound to spv project/)
    assert.ok(second.stderr.includes(firstRoot), second.stderr)
    assert.ok(second.stderr.includes(secondRoot), second.stderr)
    assert.match(second.stderr, /only one spv project/)
  } finally {
    cleanup(box)
  }
})

test('⑤ dispatch with no claiming deployment fails without writing pending/', async () => {
  const box = makeBox()
  try {
    const beta = entryFor(box, 'tools/beta', 3402)
    writeRegistry(box, [beta])
    const result = await dispatch(box, 'tools/alpha')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no deployment for project "tools\/alpha"/)
    assert.match(result.stderr, /deployment list/)
    assert.deepEqual(pendingFiles(beta.queueDir), [])
  } finally {
    cleanup(box)
  }
})

test('⑤ dispatch with two deployments claiming one path fails and writes nothing', async () => {
  const box = makeBox()
  try {
    workerDirectory(box, 'tools/alpha')
    symlinkSync(join(box.projects, 'tools', 'alpha'), join(box.projects, 'tools', 'alpha-link'))
    const alpha = entryFor(box, 'tools/alpha', 3401)
    const alias = entryFor(box, 'tools/alpha-link', 3402)
    writeRegistry(box, [alpha, alias])

    const result = await dispatch(box, 'tools/alpha')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /more than one deployment claims the orchestrator project "tools\/alpha"/)
    assert.match(result.stderr, /deployment list/)
    assert.deepEqual(pendingFiles(alpha.queueDir), [])
    assert.deepEqual(pendingFiles(alias.queueDir), [])

    const listed = cli(box, ['deployment', 'list'])
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /warning: .*more than one deployment/)
    const json = JSON.parse(cli(box, ['deployment', 'list', '--json']).stdout)
    assert.equal(json.warnings.length, 1)
    assert.match(json.warnings[0], /tools\/alpha \(port 3401\).*tools\/alpha-link \(port 3402\)/)
  } finally {
    cleanup(box)
  }
})

test('⑥ a uniquely owned project dispatches into its own queue', async () => {
  const box = makeBox()
  const instance = await openInstance()
  try {
    workerDirectory(box, 'tools/alpha')
    // `deployment add` renders the per-deployment instance overlay that `ensureDeploymentStarted` requires.
    const added = cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha', '--port', String(instance.port)])
    assert.equal(added.status, 0, added.stderr)
    const alpha = readRegistry(box).deployments.find(entry => entry.project === 'tools/alpha')
    const result = await dispatch(box, 'tools/alpha')
    assert.equal(result.status, 0, result.stderr)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.project, 'tools/alpha')
    assert.equal(pendingFiles(alpha.queueDir).length, 1)
  } finally {
    await closeInstance(instance)
    cleanup(box)
  }
})
