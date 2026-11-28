/**
 * The standalone panel is one instance of the shared `wca` profile: the profile carries dsh-web-app,
 * dsh-superagent, the Command Code route and the wheelchair-agent webui, and the installed overlay
 * `<data root>/deployments/panel.yml` switches every deployment-only row off. This test installs into
 * a throwaway DSH_HOME with the same seams `tests/test-install.sh` uses, then starts the real instance
 * on 3997 and checks the browser-facing facts: the harness page, the three wheelchair-agent routes,
 * no orchestrator state route, the status contract, and that stopping closes the port.
 *
 * The runtime section needs a machine with `dsh` and the dsh-tui/dsh-superagent packages already
 * installed (the same requirement the old panel test had for `dsh` itself); the profile assertions are
 * pure filesystem checks. No real profile is modified.
 *
 * Run with `node tests/test-panel.mjs`.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'bin', 'wheelchair-agent.mjs')
const PORT = 3997
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

function realPackage(name) {
  const home = userInfo().homedir
  const candidates = [
    join(home, '.dsh', 'profiles', 'superagent', 'node_modules', name),
    join(home, '.dsh', 'profiles', 'dsh-tui', 'node_modules', name),
    join(home, 'opt', 'dsh-plugins', name),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

function makeBox() {
  const base = mkdtempSync(join(tmpdir(), 'wheelchair-panel-'))
  const box = {
    base,
    home: join(base, 'home'),
    dsh: join(base, 'dsh'),
    data: join(base, 'home', '.wheelchair-agent'),
    tools: join(base, 'tools'),
    queue: join(base, 'queue'),
    bin: join(base, 'bin'),
  }
  for (const dir of [box.home, box.tools, box.queue, join(box.dsh, 'profiles', 'superagent'), box.data]) {
    mkdirSync(dir, { recursive: true })
  }
  // The migrated superagent profile borrows the machine's real plugin packages (read-only links):
  // the panel then boots the same dsh-superagent/provider/webui rows a real install would.
  const superagent = join(box.dsh, 'profiles', 'superagent')
  const dependencies = {}
  for (const name of [
    '@mars-sea/dsh-commandcode-provider',
    'billion-context',
    'dsh-context',
    'dsh-superagent',
  ]) {
    const target = realPackage(name)
    assert.ok(target, `the test needs the real package ${name} (dsh / dsh-tui / dsh-superagent installed)`)
    mkdirSync(join(superagent, 'node_modules', dirname(name)), { recursive: true })
    symlinkSync(target, join(superagent, 'node_modules', name), 'dir')
    dependencies[name] = name === 'dsh-superagent' ? `link:${target}` : '0.0.0-test'
  }
  writeFileSync(
    join(superagent, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-superagent', private: true, dependencies, dsh: { profile: { bundles: [] } } }, null, 2)}\n`,
  )
  const tuiScope = realPackage('@deepseek-harness-tui')
  assert.ok(tuiScope, 'the test needs the real @deepseek-harness-tui package (dsh-tui installed)')
  const tui = join(box.dsh, 'profiles', 'dsh-tui')
  mkdirSync(join(tui, 'node_modules'), { recursive: true })
  writeFileSync(join(tui, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-dsh-tui', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`)
  symlinkSync(tuiScope, join(tui, 'node_modules', '@deepseek-harness-tui'), 'dir')

  writeFileSync(join(box.tools, 'dsh-tui'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(
    join(box.tools, 'fake-probe'),
    '#!/bin/sh\nprintf "service_pids=\\nspv_pids=\\nservice_port=3082\\npreset_patch=/fake/preset-default.patch.yml\\n"\n',
    { mode: 0o755 },
  )
  return box
}

function envFor(box, extra = {}) {
  const env = { ...process.env }
  for (const key of [
    'SPV_QUEUE_DIR', 'SPV_SUPERAGENT_URL', 'SPV_SUPERAGENT_PORT', 'DSH_SUPERAGENT_PORT',
    'SPV_SERVICE_PORT', 'DSH_SUPERAGENT_PROFILE', 'SPV_PANEL_PORT', 'WHEELCHAIR_AGENT_OPEN',
    'DSH_SUPERAGENT_URL', 'SPV_PROJECTS_ROOT', 'DSH_BIN', 'DSH_SUPERAGENT_PLUGIN_DIR',
  ]) delete env[key]
  return {
    ...env,
    HOME: box.home,
    DSH_HOME: box.dsh,
    SPV_BIN_DIR: box.bin,
    SPV_QUEUE_DIR: box.queue,
    SPV_PROJECTS_ROOT: join(box.home, 'bioagentforge'),
    WHEELCHAIR_AGENT_HOME: box.data,
    DSH_SUPERAGENT_STATE_DIR: join(box.dsh, 'state', 'superagent'),
    SPV_INSTALL_PROBE: join(box.tools, 'fake-probe'),
    SPV_SERVICE_PORT: '3082',
    PATH: `${box.tools}:${process.env.PATH ?? ''}`,
    ...extra,
  }
}

function cli(box, argv, extra = {}) {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    env: envFor(box, extra),
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function install(box) {
  const artifact = join(ROOT, 'build', 'artifacts', 'wheelchair-agent-core-linux-x64')
  assert.ok(existsSync(artifact), `the core artifact is missing (run bash build/build-core.sh): ${artifact}`)
  const result = spawnSync('bash', [join(ROOT, 'install.sh'), '--project', 'tools/wheelchair-agent'], {
    cwd: ROOT,
    env: envFor(box, { SPV_INSTALL_CORE_ARTIFACT: artifact }),
    encoding: 'utf8',
    timeout: 120_000,
  })
  assert.equal(result.status, 0, `install.sh failed:\n${result.stdout}\n${result.stderr}`)
}

async function waitFor(read, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return read()
}

async function fetchWithCookie(url, cookie = '') {
  return fetch(url, {
    redirect: 'manual',
    cache: 'no-store',
    headers: cookie === '' ? {} : { cookie },
    signal: AbortSignal.timeout(5_000),
  })
}

function cookieOf(response) {
  const raw = response.headers.getSetCookie?.() ?? []
  const first = raw[0] ?? response.headers.get('set-cookie') ?? ''
  return first.split(';')[0]
}

async function startForeground(box) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(300) })
    throw new Error(`port ${PORT} is already in use`)
  } catch (error) {
    if (error.message === `port ${PORT} is already in use`) throw error
  }
  const child = spawn(process.execPath, [CLI, 'panel', '--foreground', '--port', String(PORT)], {
    env: envFor(box),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const token = await waitFor(
    () => {
      const match = output.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._-]+/)
      return match === null ? null : match[0]
    },
    value => value !== null,
  )
  assert.notEqual(token, null, `the panel did not print a token URL:\n${output}`)
  return { child, token, outputOf: () => output }
}

async function testLegacyDetection() {
  const { looksLikeLegacyPanelHost } = await import(new URL('../src/spv/panel-instance.js', import.meta.url))
  const legacy = ['node', '/home/u/.local/bin/cli.js', 'panel', '--foreground', '--port', '3080']
  check('the pre-#58 cli.js panel host is still recognised', looksLikeLegacyPanelHost(legacy) === true)
  check('a bare panel --foreground is still recognised', looksLikeLegacyPanelHost(['panel', '--foreground']) === true)
  const oldProfile = [
    'node', '/usr/local/bin/dsh', '--profile', 'wheelchair-agent',
    '--patch', '/home/u/.dsh/.agent-presets/spv/panel.patch.yml', '--no-open',
  ]
  check('the old wheelchair-agent profile instance is legacy', looksLikeLegacyPanelHost(oldProfile) === true)
  const current = [
    'node', '/usr/local/bin/dsh', '--profile', 'wca',
    '--patch', '/home/u/.wheelchair-agent/deployments/panel.yml', '--no-open',
  ]
  check('the current wca instance is not reported as legacy', looksLikeLegacyPanelHost(current) === false)
  const currentEquals = [
    'node', '/usr/local/bin/dsh', '--profile=wca',
    '--patch', '/home/u/.wheelchair-agent/deployments/panel.yml', '--no-open',
  ]
  check('the --profile=wca form is not reported as legacy', looksLikeLegacyPanelHost(currentEquals) === false)
  check(
    'a foreign port owner is never reported',
    looksLikeLegacyPanelHost(['node', '/x/panel-server.js', '--port', '3080']) === false,
  )
  check('an empty argv is never reported', looksLikeLegacyPanelHost([]) === false)
}

async function testProfile() {
  const box = makeBox()
  try {
    install(box)
    const profile = join(box.dsh, 'profiles', 'wca')
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles ?? []
    check('the wca profile exists', existsSync(profile))
    check('the legacy superagent profile was moved, not copied', !existsSync(join(box.dsh, 'profiles', 'superagent')))
    check('the browser profile bundles dsh-web-app', bundles.includes('@deepseek-ai/dsh-web-app'), bundles.join(','))
    check('the browser profile bundles dsh-superagent', bundles.includes('dsh-superagent'), bundles.join(','))
    check('the terminal profile exists', existsSync(join(box.dsh, 'profiles', 'wca-tui')))
    check(
      'the terminal profile links the installed dsh-tui package',
      existsSync(join(box.dsh, 'profiles', 'wca-tui', 'node_modules', '@deepseek-harness-tui')),
    )
    const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
    check('the browser patch mounts dsh-superagent', /id:\s*dsh-superagent\s*$/m.test(patch), patch)
    check('the browser patch mounts wheelchair-webui', /name:\s*['"]wheelchair-agent-webui['"]/.test(patch), patch)
    const overlay = join(box.data, 'deployments', 'panel.yml')
    check('the panel overlay is installed under the data root', existsSync(overlay))
    check('the panel overlay is not the preset template', overlay !== join(box.dsh, '.agent-presets', 'spv', 'panel.patch.yml'))
    const overlayText = readFileSync(overlay, 'utf8')
    for (const id of ['dsh-superagent', 'dsh-superagent-worker-preset', 'dsh-superagent-router-preset', 'wheelchair-spv']) {
      check(`the panel overlay disables ${id}`, new RegExp(`- id: ${id}\\n(?:.*\\n)*?\\s+disabled: true`).test(overlayText), overlayText)
    }
    const registry = JSON.parse(readFileSync(join(box.data, 'deployments.json'), 'utf8'))
    check('the deployment registry records the wca profile', registry.deployments.every(entry => entry.profile === 'wca'), JSON.stringify(registry))
    return box
  } catch (error) {
    no('profile setup', error.stack ?? error.message)
    return box
  }
}

async function testRunningPanel(box) {
  const before = cli(box, ['deployment', 'list'])
  const started = await startForeground(box)
  try {
    const tokenUrl = started.token
    const first = await fetchWithCookie(tokenUrl)
    const cookie = cookieOf(first)
    check('the token URL redirects into the harness', first.status === 303 || first.status === 302, String(first.status))
    const page = await fetchWithCookie(`http://127.0.0.1:${PORT}/`, cookie)
    const html = await page.text()
    check('the harness page answers 200', page.status === 200, `${page.status} ${html.slice(0, 120)}`)
    check('the page is the dsh web app mount point', html.includes('id="root"') || html.includes('__DSH_BOOT__'), html.slice(0, 300))
    check('the page loads our client bundle', html.includes('wheelchair-agent-webui'), html.slice(0, 500))

    const state = await fetchWithCookie(`http://127.0.0.1:${PORT}/orchestrator/api/state`, cookie)
    const stateText = await state.text()
    check(
      'the panel serves no orchestrator state route',
      state.status === 404 || state.status === 503,
      `${state.status} ${stateText.slice(0, 200)}`,
    )

    for (const [name, path] of [
      ['projects', '/wheelchair-projects'],
      ['inbox items', '/wheelchair-inbox/items'],
      ['settings', '/wheelchair-settings'],
    ]) {
      const response = await fetchWithCookie(`http://127.0.0.1:${PORT}${path}`, cookie)
      const text = await response.text()
      let payload = null
      try {
        payload = JSON.parse(text)
      } catch {
        // A non-JSON body is a failure for these three routes and is reported below.
      }
      check(`the ${name} route answers 200 JSON`, response.status === 200 && payload !== null, `${response.status} ${text.slice(0, 120)}`)
      check(`the ${name} route has no error field`, payload !== null && payload.error === undefined, text.slice(0, 200))
    }

    const status = cli(box, ['panel', 'status', '--port', String(PORT)])
    check('panel status exits 0 while running', status.status === 0, status.stderr)
    check('panel status names the port and pid', new RegExp(`panel: port ${PORT} running \\d+`).test(status.stdout), status.stdout)
    check('panel status prints the tokenised url', /^url: https?:\/\/127\.0\.0\.1:3997\/\?token=/m.test(status.stdout), status.stdout)
    check('panel status proves GET / answers 200', /check: http 200/.test(status.stdout), status.stdout)
    check('panel status names the shared profile', /^profile: wca$/m.test(status.stdout), status.stdout)
    check('panel status reports no drift', /^drift:\s+none$/m.test(status.stdout), status.stdout)
    check('panel status says there is no orchestrator', /no orchestrator:/.test(status.stdout), status.stdout)
    check('the running panel did not change the deployment registry', cli(box, ['deployment', 'list']).stdout === before.stdout)

    const stop = cli(box, ['panel', 'stop', '--port', String(PORT)])
    check('panel stop exits 0', stop.status === 0, stop.stderr)
    const { child } = started
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve()
      const timer = setTimeout(resolve, 15_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    const closed = await waitFor(
      async () => {
        try {
          await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(500) })
          return false
        } catch {
          return true
        }
      },
      value => value === true,
    )
    check('panel stop closes the port', closed === true)
    const after = cli(box, ['panel', 'status', '--port', String(PORT)])
    check('stopped status exits 0', after.status === 0, after.stderr)
    check('stopped status says stopped', /panel: port 3997 stopped/.test(after.stdout), after.stdout)
    check('stopped status prints no url line', !/^url:/m.test(after.stdout), after.stdout)
  } finally {
    if (started.child.exitCode === null) started.child.kill('SIGTERM')
  }
}

function installCheck(box) {
  return spawnSync('bash', [join(ROOT, 'install.sh'), '--check', '--project', 'tools/wheelchair-agent'], {
    cwd: ROOT,
    env: envFor(box),
    encoding: 'utf8',
    timeout: 120_000,
  })
}

async function testCheck(box) {
  const checkRun = installCheck(box)
  check('install.sh --check exits 0 after installing the panel', checkRun.status === 0, checkRun.stdout + checkRun.stderr)
  const overlay = join(box.data, 'deployments', 'panel.yml')
  writeFileSync(overlay, `${readFileSync(overlay, 'utf8')}\n# comment-only edit\n`)
  const commentOnly = installCheck(box)
  check('a comment-only overlay edit is not stale', commentOnly.status === 0, commentOnly.stdout + commentOnly.stderr)
  writeFileSync(
    overlay,
    readFileSync(overlay, 'utf8').replace(/\n\s+disabled: true\n/, '\n'),
  )
  const stale = installCheck(box)
  check('a panel overlay without a disabled row fails --check', stale.status === 2, stale.stdout)
  check('the overlay failure names the missing disabled row', /panel overlay .* does not disable/.test(stale.stdout), stale.stdout)
  check('the overlay failure prints a copy-paste fix', /profiles sync/.test(stale.stdout) || /bash install\.sh/.test(stale.stdout), stale.stdout)
  cli(box, ['profiles', 'sync', '--port', '3082'])
  check('profiles sync repairs the overlay', installCheck(box).status === 0)
}

async function main() {
  await testLegacyDetection()
  const box = await testProfile()
  if (FAIL === 0) {
    await testRunningPanel(box)
    await testCheck(box)
  }
  rmSync(box.base, { recursive: true, force: true })
  process.stdout.write(`\n${PASS} passed, ${FAIL} failed\n`)
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exit(1)
})
