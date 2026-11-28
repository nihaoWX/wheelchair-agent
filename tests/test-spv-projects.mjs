/**
 * spv 项目表：模型校验、CLI、与部署注册表的绑定/解绑，以及面板 `GET /wheelchair-projects`。
 *
 * 所有路径都在 mkdtemp 沙箱里：HOME/DSH_HOME/WHEELCHAIR_AGENT_HOME/DSH_SUPERAGENT_STATE_DIR/
 * SPV_PROJECTS_ROOT 全部指向临时目录，不触碰操作者真实的部署/spv 表，也不启动任何服务。
 * 面板路由的「正在跑」用两个真 node:http 假部署 API：一个正常返回，一个永不响应（验证 2s 超时）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  bindWorkerToSpvProject,
  listSpvProjects,
  removeSpvProject,
  resolveSpvRootForWorker,
  spvProjectsPath,
  unbindWorkerFromSpvProjects,
  upsertSpvProject,
} from '../src/shared/spv-projects.js'
import { projectCards as projectCardsDirect } from '../src/spv/projects-view.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'wheelchair-agent.mjs')
let pass = 0
let fail = 0

function check(name, actual, expected) {
  if (Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1
    process.stdout.write(`PASS ${name}\n`)
  } else {
    fail += 1
    process.stdout.write(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}\n`)
  }
}

function match(name, text, pattern) {
  if (pattern.test(String(text))) {
    pass += 1
    process.stdout.write(`PASS ${name}\n`)
  } else {
    fail += 1
    process.stdout.write(`FAIL ${name}\n  text: ${String(text).slice(0, 600)}\n  pattern: ${pattern}\n`)
  }
}

function makeBox() {
  const base = mkdtempSync(join(tmpdir(), 'wca-spv-projects-'))
  const box = {
    base,
    home: join(base, 'home'),
    dsh: join(base, 'dsh'),
    data: join(base, 'home', '.wheelchair-agent'),
    projects: join(base, 'home', 'bioagentforge'),
    state: join(base, 'dsh', 'state', 'superagent'),
    spvRoot: join(base, 'home', 'bioagentforge'),
  }
  for (const dir of [box.home, box.dsh, box.data, box.projects, box.state]) mkdirSync(dir, { recursive: true })
  return box
}

function envFor(box, extra = {}) {
  const env = { ...process.env, ...extra }
  for (const key of [
    'DSH_SUPERAGENT_URL', 'DSH_SUPERAGENT_PORT', 'SPV_SUPERAGENT_URL', 'SPV_SUPERAGENT_PORT',
    'SPV_SERVICE_PORT', 'DSH_SUPERAGENT_PROFILE', 'SPV_QUEUE_DIR', 'SPV_INSTALL_REPO',
    'SPV_INBOX_DIR', 'SPV_PREPARE_LOG', 'WHEELCHAIR_AGENT_LAUNCHER', 'WHEELCHAIR_AGENT_WEBUI',
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
      cwd: box.base,
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

function registry(box, entries) {
  mkdirSync(box.data, { recursive: true })
  writeFileSync(join(box.data, 'deployments.json'), `${JSON.stringify({ version: 1, deployments: entries }, null, 2)}\n`)
}

function deployment(project, port, extra = {}) {
  const stateDir = join(box_state(), project.replaceAll('/', '-'))
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

let BOX = null
function box_state() {
  return BOX.state
}

function worker(box, project) {
  const directory = join(box.projects, project)
  mkdirSync(directory, { recursive: true })
  return directory
}

function rootFor(box, name) {
  const root = join(box.home, name)
  mkdirSync(root, { recursive: true })
  return root
}

function readRegistry(box) {
  return JSON.parse(readFileSync(spvProjectsPath({ env: envFor(box) }), 'utf8'))
}

function mtime(path) {
  return statSync(path).mtimeMs
}

function testAbsentAndIdempotent() {
  BOX = makeBox()
  const box = BOX
  const file = spvProjectsPath({ env: envFor(box) })
  const absent = cli(box, ['spv-project', 'list'])
  check('absent list exit 0', absent.status, 0)
  match('absent list explains add', absent.stdout, /spv-project add <root>/)
  check('absent list creates nothing', existsSync(file), false)

  const root = rootFor(box, 'spv-a')
  mkdirSync(join(root, 'tools', 'alpha'), { recursive: true })
  // `spv-project add --worker` (the old flag, still supported) only binds a project a deployment already owns;
  // seed that registration first.
  registry(box, [deployment('tools/alpha', 3071)])
  const added = cli(box, ['spv-project', 'add', root, '--worker', 'tools/alpha'])
  check('add exit 0', added.status, 0)
  match('add prints registered', added.stdout, /registered spv-project .*orchestratorProjects=1/)
  const entry = readRegistry(box).spvProjects[0]
  check('file root', entry.root, root)
  check('file workers', entry.workers, ['tools/alpha'])

  const before = readFileSync(file, 'utf8')
  const beforeMtime = mtime(file)
  const again = cli(box, ['spv-project', 'add', root, '--worker', 'tools/alpha'])
  check('identical add exit 0', again.status, 0)
  match('identical add says nothing changed', again.stdout, /nothing changed/)
  check('identical add keeps bytes', readFileSync(file, 'utf8'), before)
  check('identical add keeps mtime', mtime(file), beforeMtime)

  const listed = cli(box, ['spv-project', 'list'])
  match('list shows root', listed.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  match('list shows worker', listed.stdout, /  tools\/alpha/)
  const json = JSON.parse(cli(box, ['spv-project', 'list', '--json']).stdout)
  check('json workers', json.spvProjects[0].workers, ['tools/alpha'])
}

function testFlagAliases() {
  BOX = makeBox()
  const box = BOX
  const root = rootFor(box, 'spv-aliases')
  for (const project of ['tools/alpha', 'tools/beta']) worker(box, project)
  registry(box, [deployment('tools/alpha', 3072), deployment('tools/beta', 3073)])
  const file = spvProjectsPath({ env: envFor(box) })

  const modern = cli(box, ['spv-project', 'add', root, '--orchestrator', 'tools/alpha', '--orchestrator', 'tools/beta'])
  check('--orchestrator add exit 0', modern.status, 0)
  const modernBytes = readFileSync(file, 'utf8')
  check('--orchestrator binds both projects', readRegistry(box).spvProjects[0].workers, ['tools/alpha', 'tools/beta'])

  rmSync(file)
  const legacy = cli(box, ['spv-project', 'add', root, '--worker', 'tools/alpha', '--worker', 'tools/beta'])
  check('--worker add exit 0', legacy.status, 0)
  check('--worker writes the same spv-projects.json as --orchestrator', readFileSync(file, 'utf8'), modernBytes)

  rmSync(file)
  const mixed = cli(box, ['spv-project', 'add', root, '--orchestrator', 'tools/alpha', '--worker', 'tools/beta'])
  check('mixed --orchestrator/--worker exit 0', mixed.status, 0)
  check('mixed flags write the same spv-projects.json', readFileSync(file, 'utf8'), modernBytes)

  const help = cli(box, ['spv-project', 'add', '--help'])
  check('spv-project help exit 0', help.status, 0)
  match('help shows the new flag in the usage line', help.stdout, /add <root> \[--orchestrator <project>\]\.\.\./)
  check('help usage line has no --worker', /\[--worker/.test(help.stdout), false)
  const helpLines = help.stdout.trimEnd().split('\n')
  match('help ends by naming --worker as the old flag', helpLines.at(-1), /old flag name --worker is still accepted and is exactly equivalent to --orchestrator/)
}

function testValidation() {
  const box = makeBox()
  BOX = box
  const env = envFor(box)
  const missing = rootFor(box, 'exists-root')
  const missingRoot = join(missing, 'not-there')
  assert.throws(() => upsertSpvProject(missingRoot, [], { env }), /does not exist/)

  const fileRoot = join(box.base, 'plain-file')
  writeFileSync(fileRoot, 'x')
  assert.throws(() => upsertSpvProject(fileRoot, [], { env }), /not a directory/)

  // 根不能是已登记 orchestrator 项目的 checkout。
  const checkout = worker(box, 'tools/alpha')
  registry(box, [deployment('tools/alpha', 3082)])
  assert.throws(() => upsertSpvProject(checkout, [], { env }), /registered orchestrator project "tools\/alpha"/)

  // 根不能嵌套。
  const outer = rootFor(box, 'outer')
  const inner = join(outer, 'inner')
  mkdirSync(inner, { recursive: true })
  upsertSpvProject(outer, [], { env })
  assert.throws(() => upsertSpvProject(inner, [], { env }), /nested roots/)

  // orchestrator 项目形态 / 重复绑定。
  const first = rootFor(box, 'spv-one')
  const second = rootFor(box, 'spv-two')
  upsertSpvProject(first, ['tools/alpha'], { env })
  assert.throws(() => upsertSpvProject(first, ['../escape'], { env }), /tools\/<name>/)
  assert.throws(() => upsertSpvProject(second, ['tools/alpha'], { env }), /already bound to spv project/)

  // 同一 worker 出现在两个根下（手写文件）读取时报错，不 first-wins。
  const dupFile = spvProjectsPath({ env })
  const dup = { version: 1, spvProjects: [{ root: first, workers: ['tools/alpha'] }, { root: second, workers: ['tools/alpha'] }] }
  writeFileSync(dupFile, `${JSON.stringify(dup, null, 2)}\n`)
  const dupBytes = readFileSync(dupFile, 'utf8')
  assert.throws(() => listSpvProjects({ env }), /binds orchestrator project "tools\/alpha" to both/)
  check('duplicate read leaves bytes', readFileSync(dupFile, 'utf8'), dupBytes)

  // 坏 JSON 一字不改。
  writeFileSync(dupFile, '{ not json\n')
  assert.throws(() => listSpvProjects({ env }), /is not valid JSON/)
  check('bad JSON unchanged', readFileSync(dupFile, 'utf8'), '{ not json\n')
  const bad = cli(box, ['spv-project', 'list'])
  check('bad JSON CLI exit 1', bad.status, 1)
  match('bad JSON CLI names file', bad.stderr, /is not valid JSON/)
  check('bad JSON CLI unchanged', readFileSync(dupFile, 'utf8'), '{ not json\n')
}

function testRemove() {
  const box = makeBox()
  const env = envFor(box)
  const root = rootFor(box, 'spv-remove')
  upsertSpvProject(root, ['tools/alpha'], { env })
  const refuse = cli(box, ['spv-project', 'remove', root])
  check('remove with workers exit 1', refuse.status, 1)
  match('remove lists unbinding', refuse.stderr, /still binds 1 orchestrator project/)
  match('remove names worker', refuse.stderr, /tools\/alpha/)
  assert.ok(listSpvProjects({ env }).spvProjects.some(entry => entry.root === root))
  const forced = cli(box, ['spv-project', 'remove', root, '--force'])
  check('remove --force exit 0', forced.status, 0)
  match('remove --force says unbound', forced.stdout, /unbound 1 orchestrator project/)
  check('remove leaves no root', listSpvProjects({ env }).spvProjects.length, 0)
}

function testDeploymentBinding() {
  const box = makeBox()
  const env = envFor(box)
  const root = rootFor(box, 'spv-bind')
  worker(box, 'tools/alpha')
  worker(box, 'tools/beta')
  upsertSpvProject(root, [], { env })
  const added = cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha', '--spv', root, '--port', '3901'])
  check('deployment add --spv exit 0', added.status, 0)
  match('deployment add prints spv', added.stdout, /spv-project .*spv-bind/)
  check('binding written', readRegistry(box).spvProjects[0].workers, ['tools/alpha'])
  const listed = cli(box, ['deployment', 'list'])
  match('deployment list shows spv', listed.stdout, new RegExp(`spv=${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  const json = JSON.parse(cli(box, ['deployment', 'list', '--json']).stdout)
  check('deployment json spv', json.deployments[0].spv, root)

  // 同一个 worker 不能再绑第二个根。
  const other = rootFor(box, 'spv-other')
  upsertSpvProject(other, [], { env })
  const conflict = cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha', '--spv', other, '--port', '3901'])
  check('second binding exit 1', conflict.status, 1)
  match('second binding explains', conflict.stderr, /already bound to spv project/)

  const removed = cli(box, ['deployment', 'remove', 'tools/alpha', '--force'])
  check('deployment remove exit 0', removed.status, 0)
  match('deployment remove unbinds', removed.stdout, /unbound tools\/alpha from spv project/)
  check('binding removed', readRegistry(box).spvProjects[0].workers, [])
}

function testInference() {
  const box = makeBox()
  const root = rootFor(box, 'spv-infer')
  // 让 orchestrator 项目 checkout 成为 spv 根的后代关系。
  box.projects = join(root, 'projects')
  worker(box, 'tools/alpha')
  const env = envFor(box)
  upsertSpvProject(root, [], { env })
  const inferred = cli(box, ['deployment', 'add', 'tools/alpha', '--repo', 'test/alpha', '--port', '3902'])
  check('inferred binding exit 0', inferred.status, 0)
  check('inferred binding written', readRegistry(box).spvProjects[0].workers, ['tools/alpha'])

  // 有 spv 项目、但没有任何根是 checkout 的祖先：必须要求显式 --spv。
  const other = makeBox()
  const otherRoot = rootFor(other, 'spv-nowhere')
  const otherEnv = envFor(other)
  upsertSpvProject(otherRoot, [], { env: otherEnv })
  worker(other, 'tools/orphan')
  const none = cli(other, ['deployment', 'add', 'tools/orphan', '--repo', 'test/orphan', '--port', '3903'])
  check('no ancestor exit 1', none.status, 1)
  match('no ancestor lists roots', none.stderr, /Pass --spv <root> explicitly/)
}

function fakeDeployment(port, mode, problem = null) {
  const server = createServer((req, res) => {
    if (mode === 'hang') return
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = body => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/orchestrator/api/state') {
      return send({ setup: { problem: mode === 'problem' ? problem : null, accounts: { repository: 'test/alpha' } } })
    }
    if (url.pathname === '/orchestrator/api/overview') return send({ executor: { running: 1, queued: 2, maxWorkers: 1, idle: 0 } })
    if (url.pathname === '/orchestrator/api/tickets') {
      return send({ items: [{ id: 't1', title: '正在跑的工单', stage: 'working', action: 'run' }] })
    }
    res.writeHead(404)
    res.end('{}')
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

async function testPanelRoute() {
  const box = makeBox()
  const root = rootFor(box, 'spv-panel')
  const alpha = worker(box, 'tools/alpha')
  const beta = worker(box, 'tools/beta')
  registry(box, [deployment('tools/alpha', 3911), deployment('tools/beta', 3912)])
  upsertSpvProject(root, ['tools/alpha', 'tools/beta'], { env: envFor(box) })
  const ok = await fakeDeployment(3911, 'ok')
  const hang = await fakeDeployment(3912, 'hang')
  try {
    const started = Date.now()
    const cards = await projectCardsDirect({ env: envFor(box) })
    const elapsed = Date.now() - started
    check('two spv cards', cards.spvProjects.length, 1)
    check('two workers', cards.spvProjects[0].workers.length, 2)
    const first = cards.spvProjects[0].workers.find(item => item.project === 'tools/alpha')
    const second = cards.spvProjects[0].workers.find(item => item.project === 'tools/beta')
    check('ok state kind', first.state.kind, 'ok')
    check('ok running title', first.state.running[0].title, '正在跑的工单')
    check('ok queued', first.state.queued, 2)
    check('timeout state kind', second.state.kind, 'unavailable')
    match('timeout reason', second.state.reason, /timed out after 2000ms/)
    check('path is projectsRoot/worker', first.path, join(box.projects, 'tools/alpha'))
    assert.ok(elapsed < 6000, `probes should be bounded; took ${elapsed}ms`)

    // The standalone route lives in the real dsh instance; tests/test-panel.mjs covers it end to end.
  } finally {
    ok.close()
    hang.closeAllConnections?.()
    hang.close()
  }
}

/**
 * The live orchestrator sends `setup.problem` as `{place, code, values, detail}`; older notes and fixtures used a
 * bare string. A card must show either, not only the string form.
 */
async function testSetupProblemShapes() {
  const box = makeBox()
  BOX = box
  const root = rootFor(box, 'spv-problem')
  worker(box, 'tools/alpha')
  worker(box, 'tools/beta')
  registry(box, [deployment('tools/alpha', 3913), deployment('tools/beta', 3914)])
  upsertSpvProject(root, ['tools/alpha', 'tools/beta'], { env: envFor(box) })
  const objectProblem = {
    place: 'github',
    code: 'repositoryUnset',
    values: {},
    detail: 'The GitHub Source names no repository.',
  }
  const alpha = await fakeDeployment(3913, 'problem', objectProblem)
  const beta = await fakeDeployment(3914, 'problem', 'repositoryUnset (legacy string fixture)')
  try {
    const cards = await projectCardsDirect({ env: envFor(box) })
    const workers = cards.spvProjects[0].workers
    const first = workers.find(item => item.project === 'tools/alpha')
    const second = workers.find(item => item.project === 'tools/beta')
    check('object problem card text', first.state.setupProblem, 'The GitHub Source names no repository.')
    check('string problem card text', second.state.setupProblem, 'repositoryUnset (legacy string fixture)')
  } finally {
    alpha.close()
    beta.close()
  }
}

async function main() {
  testAbsentAndIdempotent()
  testFlagAliases()
  testValidation()
  testRemove()
  testDeploymentBinding()
  testInference()
  await testPanelRoute()
  await testSetupProblemShapes()
  // projectCards is re-exported by panel-routes only through createPanelHandlers; this import keeps
  // the module graph honest (it must be free of dsh imports, like the rest of the panel core).
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

await main()
