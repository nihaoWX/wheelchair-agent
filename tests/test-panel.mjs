/**
 * The standalone panel: a real process on a throwaway data root. No dsh, no deployment, no live
 * service: the test only proves the same three routes answer and that the UI can act on them.
 *
 * Run with `node tests/test-panel.mjs`.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'bin', 'wheelchair-agent.mjs')
let PASS = 0
let FAIL = 0

function ok(name) {
  PASS += 1
  process.stdout.write(`ok ${name}\n`)
}
function no(name, detail) {
  FAIL += 1
  process.stdout.write(`not ok ${name}: ${detail}\n`)
}
function check(name, condition, detail = '') {
  if (condition) ok(name)
  else no(name, detail)
}

function makeBox() {
  const base = mkdtempSync(join(tmpdir(), 'wheelchair-panel-'))
  const box = { base, home: join(base, 'home'), dsh: join(base, 'dsh'), state: join(base, 'state') }
  for (const dir of [box.home, box.dsh, box.state]) mkdirSync(dir, { recursive: true })
  return box
}
function envFor(box, extra = {}) {
  const env = { ...process.env }
  for (const key of [
    'SPV_QUEUE_DIR', 'SPV_SUPERAGENT_URL', 'SPV_SUPERAGENT_PORT', 'DSH_SUPERAGENT_PORT',
    'SPV_SERVICE_PORT', 'DSH_SUPERAGENT_PROFILE', 'SPV_PANEL_PORT', 'WHEELCHAIR_AGENT_OPEN',
    'DSH_SUPERAGENT_URL', 'SPV_PROJECTS_ROOT',
  ]) delete env[key]
  return {
    ...env,
    HOME: box.home,
    DSH_HOME: box.dsh,
    WHEELCHAIR_AGENT_HOME: join(box.home, '.wheelchair-agent'),
    DSH_SUPERAGENT_STATE_DIR: box.state,
    ...extra,
  }
}
function cli(box, argv, extra = {}) {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    env: envFor(box, extra),
    encoding: 'utf8',
    timeout: 20_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

async function waitFor(read, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  return read()
}

async function startForeground(box, extraArgs = []) {
  const child = spawn(process.execPath, [CLI, 'panel', '--foreground', '--port', '0', ...extraArgs], {
    env: envFor(box),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const port = await waitFor(() => {
    const match = output.match(/panel listening on http:\/\/127\.0\.0\.1:(\d+)\//)
    return match === null ? null : Number(match[1])
  }, value => value !== null)
  assert.notEqual(port, null, `panel did not start: ${output}`)
  return { child, port, outputOf: () => output }
}

async function json(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { cache: 'no-store', ...options })
  const payload = await response.json().catch(() => ({}))
  return { status: response.status, payload }
}

async function closePanel(box, port) {
  cli(box, ['panel', 'stop'])
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) })
    } catch {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  return false
}

async function testPanelRoutes() {
  const box = makeBox()
  const { child, port } = await startForeground(box)
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`)
    const html = await page.text()
    check(
      'panel serves the bundle shell',
      page.ok && html.includes('id="root"') && html.includes('/client.js') && html.includes('/vendor/react.production.min.js') && !html.includes('@deepseek-ai/'),
      html.slice(0, 160),
    )
    const bundle = await fetch(`http://127.0.0.1:${port}/client.js`)
    const bundleText = await bundle.text()
    check(
      'panel serves the real dsh client bundle',
      bundle.ok && bundleText === readFileSync(join(ROOT, 'webui', 'lib', 'client.js'), 'utf8'),
      `status ${bundle.status} bytes ${bundleText.length}`,
    )
    for (const asset of ['react.production.min.js', 'react-dom.production.min.js', 'LICENSE.react', 'LICENSE.react-dom', 'README.md']) {
      const served = await fetch(`http://127.0.0.1:${port}/vendor/${asset}`)
      check(`panel serves vendor/${asset}`, served.ok && (await served.text()).length > 0, `status ${served.status}`)
    }

    const empty = await json(port, '/wheelchair-inbox/items')
    check('inbox starts empty', empty.status === 200 && Array.isArray(empty.payload.items) && empty.payload.items.length === 0, JSON.stringify(empty.payload))

    const add = cli(box, ['inbox', 'add', '--title', 'panel smoke', '--body', 'body from a test'])
    check('inbox add works beside the panel', add.status === 0, add.stderr)
    const listed = await json(port, '/wheelchair-inbox/items')
    check('panel lists the new letter', listed.payload.items?.length === 1 && listed.payload.items[0].title === 'panel smoke', JSON.stringify(listed.payload))
    const id = listed.payload.items[0].id
    const review = await json(port, '/wheelchair-inbox/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, kind: 'approve', text: 'reviewed from the standalone panel' }),
    })
    check('panel approves a letter', review.status === 200 && review.payload.ok === true, JSON.stringify(review.payload))

    const snapshot = await json(port, '/wheelchair-settings')
    check('settings expose the panel port default', snapshot.payload.effective?.['panel.port'] === 3080, JSON.stringify(snapshot.payload.values))
    const saved = await json(port, '/wheelchair-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: snapshot.payload.revision, values: { 'inbox.intervalSeconds': 15 } }),
    })
    check('settings write through the panel', saved.status === 200 && saved.payload.values?.['inbox.intervalSeconds'] === 15, JSON.stringify(saved.payload))
    const settingsFile = join(box.home, '.wheelchair-agent', 'settings.json')
    check('settings persist in the data root', existsSync(settingsFile) && JSON.parse(readFileSync(settingsFile, 'utf8')).values?.['inbox.intervalSeconds'] === 15, settingsFile)

    const hooksBefore = await json(port, '/wheelchair-settings')
    const firstRow = hooksBefore.payload.hookView?.items?.[0] ?? hooksBefore.payload.hookView?.builtin?.[0]
    check('hooks view is present in the panel', firstRow !== undefined, JSON.stringify(Object.keys(hooksBefore.payload.hookView ?? {})))
    if (firstRow !== undefined) {
      const renamed = await json(port, '/wheelchair-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: hooksBefore.payload.revision, hooks: { labels: { [firstRow.id]: 'Renamed by the panel test' } } }),
      })
      const row = [...(renamed.payload.hookView?.items ?? []), ...(renamed.payload.hookView?.builtin ?? [])]
        .find(item => item.id === firstRow.id)
      check('hooks rename writes through the panel', renamed.status === 200 && (row?.label === 'Renamed by the panel test' || row?.customLabel === 'Renamed by the panel test'), JSON.stringify(row))
    }

    const status = cli(box, ['panel', 'status'])
    check('panel status names the running port', status.status === 0 && status.stdout.includes(`running`) && status.stdout.includes(String(port)), status.stdout)

    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    const released = await closePanel(box, port)
    check('panel stop releases the port', released)
    check('panel stop removes the pid file', !existsSync(join(box.home, '.wheelchair-agent', 'panel.pid')))
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(box.base, { recursive: true, force: true })
  }
}

async function testServiceOpen() {
  const box = makeBox()
  try {
    const probe = await new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) }) })
    const opened = cli(box, ['service', 'open'], { WHEELCHAIR_AGENT_OPEN: 'true', SPV_PANEL_PORT: String(probe) })
    const url = opened.stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//)
    check('service open starts the panel and prints its URL', opened.status === 0 && url !== null, opened.stderr || opened.stdout)
    if (url !== null) {
      const port = Number(url[1])
      const page = await fetch(`http://127.0.0.1:${port}/`)
      check('service open leaves a serving panel', page.ok)
      const closed = cli(box, ['panel', 'stop'])
      check('panel stop closes what service open started', closed.status === 0, closed.stderr)
    }
    const status = cli(box, ['service', 'status'])
    const panelStatus = cli(box, ['panel', 'status'])
    check('panel status reports the standalone panel', panelStatus.status === 0 && /panel:\s+port \d+\s+stopped/.test(panelStatus.stdout), panelStatus.stderr || panelStatus.stdout)
    check('service status without a deployment or a registry is a usage error', status.status === 2 && /cannot infer a deployment/.test(status.stderr) && /Pass --project <p> or --all/.test(status.stderr), status.stderr || status.stdout)
  } finally {
    cli(box, ['panel', 'stop'])
    rmSync(box.base, { recursive: true, force: true })
  }
}

async function testInstalledLayout() {
  const box = makeBox()
  const preset = join(box.dsh, '.agent-presets', 'spv')
  const webui = join(box.dsh, 'profiles', 'superagent', 'node_modules', 'wheelchair-agent-webui')
  mkdirSync(preset, { recursive: true })
  writeFileSync(join(preset, 'preset.yml'), 'id: spv\n', 'utf8')
  cpSync(join(ROOT, 'bin', 'wheelchair-agent.mjs'), join(preset, 'cli.js'))
  cpSync(join(ROOT, 'src'), join(preset, 'src'), { recursive: true })
  mkdirSync(join(webui, 'lib'), { recursive: true })
  cpSync(join(ROOT, 'webui', 'lib', 'client.js'), join(webui, 'lib', 'client.js'))
  cpSync(join(ROOT, 'webui', 'vendor'), join(webui, 'vendor'), { recursive: true })
  const child = spawn(process.execPath, [join(preset, 'cli.js'), 'panel', '--foreground', '--port', '0'], {
    env: envFor(box),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { output += chunk })
  try {
    const port = await waitFor(() => output.match(/http:\/\/127\.0\.0\.1:(\d+)\//)?.[1], value => value !== undefined, 8000)
    check('installed preset runs the panel without a checkout', port !== undefined, output.slice(0, 200))
    if (port !== undefined) {
      const page = await fetch(`http://127.0.0.1:${port}/`)
      const html = await page.text()
      check('installed preset serves the bundle from the profile', page.ok && html.includes('/client.js'), html.slice(0, 120))
      const bundle = await fetch(`http://127.0.0.1:${port}/client.js`)
      check('installed preset serves client.js', bundle.ok && (await bundle.text()).includes('__ModuleLoader__'), `status ${bundle.status}`)
    }
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(box.base, { recursive: true, force: true })
  }
}

/** The core's import graph must not reach a dsh package; the panel has to run without one. */
function testCoreImportGraph() {
  const seen = new Set()
  const offenders = []
  const visit = file => {
    if (seen.has(file) || !existsSync(file)) return
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier.startsWith('@deepseek-ai/')) offenders.push(`${file} -> ${specifier}`)
      if (!specifier.startsWith('.')) continue
      const target = resolve(dirname(file), specifier)
      visit(target)
      if (!/\.js$/.test(target)) visit(`${target}.js`)
    }
  }
  visit(join(ROOT, 'src', 'spv', 'panel.js'))
  visit(join(ROOT, 'src', 'spv', 'panel-routes.js'))
  visit(join(ROOT, 'src', 'spv', 'panel-shell.js'))
  check('panel core never imports @deepseek-ai/*', offenders.length === 0, offenders.join(', '))
  check('panel core import graph is broader than the three files', seen.size > 5, `${seen.size} files`)
}

async function main() {
  testCoreImportGraph()
  await testInstalledLayout()
  await testPanelRoutes()
  await testServiceOpen()
  process.stdout.write(`\n${PASS} passed, ${FAIL} failed\n`)
  if (FAIL > 0) process.exitCode = 1
}

await main()
