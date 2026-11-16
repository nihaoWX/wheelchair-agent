#!/usr/bin/env node
/**
 * tests/test-restart.mjs — offline evidence for `wheelchair-agent restart-all` and its dsh command.
 *
 * What it proves:
 *   - the load endpoint is read with `x-orchestrator-request: 1`; an unreachable service counts as idle, a
 *     truncated body still settles, and an answered-but-unreadable response (HTTP 500 or no `load`) is
 *     distinguished from idle and refused unless `--force`;
 *   - the guard refuses at `running: 1` and `queued: 1`, names the work, and runs no command or log before a
 *     dry-run refusal; `--force` overrides it and prints exactly what it interrupts (or says the amount of
 *     work is unknown when the load cannot be read);
 *   - `--dry-run` prints the service pid, the SPV chain, the checkout, the state dir, the log path, the tmux
 *     session and every command in order (including the absolute installed-preset CLI launch), and writes or
 *     signals nothing;
 *   - a run has exactly five `step N/5` log lines in the order service stop -> install -> service start ->
 *     tmux, verifies that the tmux session really came back, and launches the TUI from `<presetDir>/cli.js`
 *     rather than the invoking checkout CLI (whose `spv` command uses the unrendered launcher template);
 *   - a failing install aborts before starting the service again (including the exit-3 refusal and the
 *     by-hand recovery command);
 *   - `--no-install` skips install.sh, and a service-start failure still relaunches the TUI and exits 1;
 *   - the kill set excludes the orchestrator's own pid, its ancestors and the service; an ancestor in the
 *     fake chain aborts before any command; an armed chain whose pid no longer carries the patch is refused
 *     before mutation; a zombie pid is treated as gone;
 *   - the command module registers exactly one `/restart-wheelchair-agent` command without a dsh import, and
 *     its handler passes `restart-all --detach [--force]` to the executable;
 *   - the detached path arms a child that logs its success, and also logs a re-guard refusal; the parent
 *     wait exits 1 when the arming process is still alive.
 *
 * Offline by construction: a `mkdtemp` sandbox holds the state dir, a fake checkout with `install.sh`, fake
 * `wheelchair-agent` and `tmux` executables, and a fake `/proc` root. The service is a local HTTP server on
 * `127.0.0.1:0`. Fake SPV/service pids are asserted unused when the fixture is written; they live in a high
 * range, so reuse before the signal is vanishingly unlikely. The only signals sent are SIGTERM/SIGKILL to
 * those fake (nonexistent) pids, and the restart steps themselves always target sandbox executables.
 *
 * Usage: node tests/test-restart.mjs
 * Exit status: 0 when every case passes, 1 otherwise.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_URL,
  LOG_NAME,
  TMUX_SESSION,
  killTargets,
  readLoad,
} from '../src/spv/restart.js'

const CLI = fileURLToPath(new URL('../bin/wheelchair-agent.mjs', import.meta.url))
const COMMAND_MODULE = new URL('../src/spv/restart-command.js', import.meta.url)
const SANDBOXES = []
const SERVERS = new Set()

const sleep = ms => new Promise(done => setTimeout(done, ms))
const exists = async file => readFile(file, 'utf8').then(() => true, () => false)

/** Wait until `predicate()` is true, polling a bounded number of times. */
async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(25)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** Whether a pid currently exists (including one we may not signal). */
function pidInUse(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Find `count` pids that are guaranteed unused right now. */
function freePids(count, start = 900_000) {
  const pids = []
  let pid = start
  while (pids.length < count) {
    if (!pidInUse(pid)) pids.push(pid)
    pid += 1
  }
  return pids
}

/**
 * The fake /proc entry must not describe a live process when the fixture is written. The restart later sends
 * its signals to these pids, so the assertion is a fixture-time guard, not a promise that the numbers stay
 * unused forever; the high start range makes reuse before then vanishingly unlikely.
 */
function assertUnused(pid) {
  assert.throws(
    () => process.kill(pid, 0),
    error => error?.code === 'ESRCH',
    `refusing to write a fake /proc entry for live pid ${pid}`,
  )
}

/**
 * One local HTTP server that plays the superagent management API; `state` is mutable between requests.
 * `afterResponse` runs after a body is serialized, which lets a test flip the load between two requests
 * (arming sees 0/0, the detached child's re-guard sees 1/0) without racing the response body.
 */
async function withServer(initial, fn, afterResponse) {
  const state = { running: 0, queued: 0, maxWorkers: 2, ...initial }
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url, header: request.headers['x-orchestrator-request'] })
    const body = JSON.stringify({
      health: { runtime: { state: 'ready' } },
      load: { running: state.running, queued: state.queued, maxWorkers: state.maxWorkers },
    })
    response.setHeader('content-type', 'application/json')
    response.end(body)
    if (typeof afterResponse === 'function') afterResponse({ state, requests })
  })
  SERVERS.add(server)
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn({ url, requests, state })
  } finally {
    SERVERS.delete(server)
    await new Promise(done => server.close(done))
  }
}

/** One local HTTP server with a raw request handler, for malformed/refusing/truncated responses. */
async function withRawServer(handler, fn) {
  const server = createServer(handler)
  SERVERS.add(server)
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn({ url })
  } finally {
    SERVERS.delete(server)
    await new Promise(done => server.close(done))
  }
}

/** A URL nothing listens on, to prove the unreachable-service path. */
async function closedUrl() {
  const server = createServer((_request, response) => response.end('{}'))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}`
  await new Promise(done => server.close(done))
  return url
}

/** The argv of one fake SPV-session process; `--patch` and `--patch=` both appear. */
function chainArgv(presetPatch, index) {
  if (index % 3 === 0) return ['node', '/opt/dsh-tui/bin.js', '--patch', presetPatch]
  if (index % 3 === 1) {
    return ['node', '/opt/dsh-tui/lib/index.js', `--patch=${presetPatch}`, '--profile', 'dsh-tui']
  }
  return ['node', '/opt/dsh/bin.js', '--profile', 'dsh-tui', '--patch', presetPatch]
}

/** A throwaway sandbox with fake executables and a fake checkout. */
async function makeSandbox() {
  const base = await mkdtemp(join(tmpdir(), 'spv-restart-test.'))
  SANDBOXES.push(base)
  const box = {
    base,
    home: join(base, 'home'),
    dshHome: join(base, 'home', '.dsh'),
    state: join(base, 'state'),
    root: join(base, 'data'),
    proc: join(base, 'proc'),
    bin: join(base, 'bin'),
    checkout: join(base, 'checkout'),
    tuiCwd: join(base, 'tui-cwd'),
    calls: join(base, 'calls'),
    url: DEFAULT_URL,
  }
  box.presetDir = join(box.dshHome, '.agent-presets', 'spv')
  box.presetPatch = join(box.presetDir, 'preset-default.patch.yml')
  box.presetCli = join(box.presetDir, 'cli.js')
  for (const dir of [
    box.home,
    box.state,
    box.root,
    box.proc,
    box.bin,
    box.checkout,
    box.tuiCwd,
    join(box.checkout, 'bin'),
    box.presetDir,
  ]) {
    await mkdir(dir, { recursive: true })
  }
  // A real deployment always has the installed preset CLI next to the patch the chain was found through.
  // The launch must use this file, not the invoking checkout's bin/wheelchair-agent.mjs.
  await writeFile(box.presetCli, '// fake installed preset CLI\n', 'utf8')
  await writeFile(
    join(box.checkout, 'install.sh'),
    '#!/bin/sh\n' +
      'printf \'install\\n\' >> "$FAKE_CALLS"\n' +
      'if [ "${FAKE_INSTALL_STATUS:-0}" != 0 ]; then echo "fake install failed: $FAKE_INSTALL_STATUS" >&2; fi\n' +
      'exit "${FAKE_INSTALL_STATUS:-0}"\n',
    'utf8',
  )
  await chmod(join(box.checkout, 'install.sh'), 0o755)
  await writeFile(join(box.checkout, 'bin', 'wheelchair-agent.mjs'), '// fake checkout marker\n', 'utf8')
  await writeFile(
    join(box.bin, 'wheelchair-agent'),
    '#!/bin/sh\n' +
      'printf \'wheelchair-agent %s\\n\' "$*" >> "$FAKE_CALLS"\n' +
      'case "$1 $2" in\n' +
      '  "service stop") exit "${FAKE_SERVICE_STOP_STATUS:-0}" ;;\n' +
      '  "service start") exit "${FAKE_SERVICE_START_STATUS:-0}" ;;\n' +
      'esac\n' +
      'exit 0\n',
    'utf8',
  )
  await chmod(join(box.bin, 'wheelchair-agent'), 0o755)
  await writeFile(
    join(box.bin, 'tmux'),
    '#!/bin/sh\n' +
      'printf \'tmux %s\\n\' "$*" >> "$FAKE_CALLS"\n' +
      'case "$1" in\n' +
      '  has-session)\n' +
      '    if [ -n "$FAKE_TMUX_MARKER" ] && [ -f "$FAKE_TMUX_MARKER" ]; then exit 0; fi\n' +
      '    exit "${FAKE_TMUX_HAS_SESSION:-1}" ;;\n' +
      '  new-session|new-window)\n' +
      '    if [ -n "$FAKE_TMUX_MARKER" ]; then : > "$FAKE_TMUX_MARKER"; fi\n' +
      '    exit "${FAKE_TMUX_LAUNCH_STATUS:-0}" ;;\n' +
      'esac\n' +
      'exit 0\n',
    'utf8',
  )
  await chmod(join(box.bin, 'tmux'), 0o755)
  return box
}

/** Write one fake /proc entry; `check` is false only for the test process's own pid. */
async function addProc(box, pid, argv, { ppid = 1, cwd, check = true } = {}) {
  if (check) assertUnused(pid)
  const dir = join(box.proc, String(pid))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'cmdline'), `${argv.join('\0')}\0`, 'utf8')
  await writeFile(join(dir, 'status'), `Name:\tfake\nPPid:\t${ppid}\n`, 'utf8')
  if (cwd !== undefined) await symlink(cwd, join(dir, 'cwd'))
}

/** A sandbox with a fake SPV chain and (unless disabled) a fake service process. */
async function makeBox({ chainCount = 2, service = true, startPid = 900_000 } = {}) {
  const box = await makeSandbox()
  box.chainPids = freePids(chainCount, startPid)
  for (const [index, pid] of box.chainPids.entries()) {
    await addProc(box, pid, chainArgv(box.presetPatch, index), {
      cwd: index % 3 === 1 ? box.tuiCwd : undefined,
    })
  }
  if (service) {
    box.servicePid = freePids(1, Math.max(...box.chainPids) + 10)[0]
    await addProc(box, box.servicePid, ['node', '/opt/dsh/bin.js', '--profile', 'superagent'])
  }
  return box
}

/** The environment the CLI child sees; HOME, DSH_HOME and every target point inside the sandbox. */
function cliEnv(box, overrides = {}) {
  // A test run may itself be a detached restart child (that is how the deployment runs the worker);
  // its WHEELCHAIR_RESTART_* variables would turn every CLI call into a re-guard. Cases that need them
  // pass them through `overrides`.
  const env = { ...process.env }
  for (const key of ['WHEELCHAIR_RESTART_CHAIN', 'WHEELCHAIR_RESTART_PARENT_PID', 'WHEELCHAIR_RESTART_PRESET_PATCH']) {
    delete env[key]
  }
  return {
    ...env,
    HOME: box.home,
    DSH_HOME: box.dshHome,
    WHEELCHAIR_AGENT_HOME: box.root,
    DSH_SUPERAGENT_STATE_DIR: box.state,
    DSH_SUPERAGENT_URL: box.url,
    WHEELCHAIR_PROC_ROOT: box.proc,
    WHEELCHAIR_AGENT_CHECKOUT: box.checkout,
    FAKE_CALLS: box.calls,
    FAKE_TMUX_MARKER: join(box.base, 'tmux-session'),
    PATH: `${box.bin}:${process.env.PATH}`,
    ...overrides,
  }
}

/** Run the CLI asynchronously: the HTTP fake lives in this process, so `spawnSync` would deadlock it. */
function cli(box, args, { env = {}, cwd } = {}) {
  return new Promise(done => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: cwd ?? box.base,
      env: cliEnv(box, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => {
      clearTimeout(timer)
      done({ status: null, signal: null, stdout, stderr, error })
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      done({ status, signal, stdout, stderr })
    })
  })
}

/** The calls file as lines; a missing file is no calls. */
async function calls(box) {
  const text = await readFile(box.calls, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return text.split('\n').filter(Boolean)
}

/** The restart log as lines; a missing file is no log. */
async function logLines(box) {
  const text = await readFile(join(box.root, 'logs', LOG_NAME), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return text.split('\n').filter(Boolean)
}

const output = result => `${result.stdout}${result.stderr}`

// ------------------------------------------------------------------- cases

async function testReadLoad() {
  await withServer({ running: 2, queued: 3 }, async ({ url, requests }) => {
    const load = await readLoad({ url, timeoutMs: 1000 })
    assert.equal(load.reachable, true)
    assert.equal(load.readable, true)
    assert.equal(load.running, 2)
    assert.equal(load.queued, 3)
    assert.equal(load.maxWorkers, 2)
    assert.equal(requests[0].url, '/orchestrator/api/state')
    assert.equal(requests[0].header, '1', 'the load request carries x-orchestrator-request: 1')

    const dead = await closedUrl()
    const down = await readLoad({ url: dead, timeoutMs: 1000 })
    assert.equal(down.reachable, false)
    assert.equal(down.readable, false)
    assert.equal(down.running, 0, 'an unreachable service counts as nothing running')
    assert.equal(down.queued, 0)
    assert.ok(down.reason.includes(dead), 'the reason names the URL that did not answer')
  })
}

/** An HTTP error and a 200 without `load` are "answered but unreadable", never idle. */
async function testReadLoadUnreadable() {
  await withRawServer(
    (_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('boom')
    },
    async ({ url }) => {
      const load = await readLoad({ url, timeoutMs: 1000 })
      assert.equal(load.reachable, true, 'an HTTP 500 still proves the service is up')
      assert.equal(load.readable, false)
      assert.match(load.reason, /HTTP 500/)
    },
  )
  await withRawServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ health: { runtime: { state: 'ready' } } }))
    },
    async ({ url }) => {
      const load = await readLoad({ url, timeoutMs: 1000 })
      assert.equal(load.reachable, true)
      assert.equal(load.readable, false)
      assert.match(load.reason, /no load object/)
    },
  )
}

/** A server that writes half a body and destroys the socket must not leave the promise pending. */
async function testReadLoadTruncated() {
  await withRawServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' })
      response.write('{"load":{"running":1')
      response.destroy()
    },
    async ({ url }) => {
      const started = Date.now()
      const load = await Promise.race([
        readLoad({ url, timeoutMs: 500 }),
        sleep(2000).then(() => {
          throw new Error('readLoad did not settle within 2s on a truncated body')
        }),
      ])
      assert.ok(Date.now() - started < 2000)
      assert.equal(load.reachable, false, 'a truncated body is a transport failure, not a readable load')
      assert.equal(load.readable, false)
    },
  )
}

async function testGuardRefusesRunning() {
  await withServer({ running: 1, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const result = await cli(box, ['restart-all', '--dry-run'])
    assert.equal(result.status, 1)
    assert.match(output(result), /refusing to restart/)
    assert.match(output(result), /1 worker running/)
    assert.deepEqual(await calls(box), [], 'the refusal runs no command')
    assert.equal(await exists(join(box.root, 'logs', LOG_NAME)), false, 'the refusal writes no log')
  })
}

async function testGuardRefusesQueued() {
  await withServer({ running: 0, queued: 1 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const result = await cli(box, ['restart-all', '--dry-run'])
    assert.equal(result.status, 1)
    assert.match(output(result), /1 ticket queued/)
    assert.deepEqual(await calls(box), [])
    assert.equal(await exists(join(box.root, 'logs', LOG_NAME)), false)
  })
}

async function testGuardRefusesUnreadable() {
  await withRawServer(
    (_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('boom')
    },
    async ({ url }) => {
      const box = await makeBox()
      box.url = url
      const refused = await cli(box, ['restart-all', '--dry-run'])
      assert.equal(refused.status, 1)
      assert.match(output(refused), /answered at .* but its load could not be read/)
      assert.match(output(refused), /may be running work/)
      assert.deepEqual(await calls(box), [], 'the unreadable-load refusal runs no command')
      assert.equal(await exists(join(box.root, 'logs', LOG_NAME)), false, 'the dry-run refusal writes no log')

      const forced = await cli(box, ['restart-all', '--dry-run', '--force'])
      assert.equal(forced.status, 0)
      assert.match(output(forced), /amount of running work is unknown/)
      assert.match(output(forced), /restart-all plan \(dry run; nothing is changed\)/)
      assert.deepEqual(await calls(box), [], '--force --dry-run still runs nothing')
      assert.equal(await exists(join(box.root, 'logs', LOG_NAME)), false)
    },
  )
}

async function testForceOverridesGuard() {
  await withServer({ running: 2, queued: 1 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const result = await cli(box, ['restart-all', '--dry-run', '--force'])
    assert.equal(result.status, 0)
    assert.match(
      output(result),
      /note: --force: interrupting 2 workers running and 1 ticket queued now\./,
    )
    assert.match(output(result), /restart-all plan \(dry run; nothing is changed\)/)
    assert.deepEqual(await calls(box), [], '--dry-run --force still runs nothing')
    assert.equal(await exists(join(box.root, 'logs', LOG_NAME)), false)
  })
}

async function testDryRunPlan() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox({ chainCount: 3 })
    box.url = url
    const result = await cli(box, ['restart-all', '--dry-run'])
    assert.equal(result.status, 0)
    const text = output(result)
    assert.match(text, new RegExp(`service:\\s+${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(text, new RegExp(`pid ${box.servicePid}`), 'the plan names the service pid')
    for (const pid of box.chainPids) assert.ok(text.includes(String(pid)), `the plan names SPV pid ${pid}`)
    assert.ok(text.includes(TMUX_SESSION), 'the plan names the tmux session')
    assert.ok(text.includes(join(box.root, 'logs', LOG_NAME)), 'the plan names the log path')
    assert.ok(text.includes(box.checkout), 'the plan names the checkout')
    assert.ok(text.includes('wheelchair-agent service stop'), 'the plan shows service stop')
    assert.ok(text.includes(`bash ${join(box.checkout, 'install.sh')}`), 'the plan shows install.sh')
    assert.ok(text.includes('wheelchair-agent service start'), 'the plan shows service start')
    assert.ok(text.includes(`tmux new-session -d -s ${TMUX_SESSION}`), 'the plan shows the tmux relaunch')
    assert.ok(
      text.includes(`${process.execPath} ${box.presetCli} spv`),
      'the plan shows the absolute installed-preset CLI launch command, not the checkout CLI',
    )
    const order = [
      text.indexOf('wheelchair-agent service stop'),
      text.indexOf(`bash ${join(box.checkout, 'install.sh')}`),
      text.indexOf('wheelchair-agent service start'),
      text.indexOf(`tmux new-session -d -s ${TMUX_SESSION}`),
    ]
    assert.deepEqual([...order].sort((left, right) => left - right), order, 'the commands are in order')
    assert.deepEqual(await calls(box), [], 'the dry run runs no command')
    assert.equal(await exists(join(box.root, 'logs', LOG_NAME)), false, 'the dry run creates no log')
  })
}

async function testStepOrder() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const result = await cli(box, ['restart-all', '--run'])
    assert.equal(result.status, 0, output(result))
    const lines = await calls(box)
    const stop = lines.indexOf('wheelchair-agent service stop')
    const install = lines.indexOf('install')
    const start = lines.indexOf('wheelchair-agent service start')
    const tmux = lines.findIndex(line => line.startsWith('tmux new-session'))
    assert.ok(stop >= 0, 'service stop was called')
    assert.ok(install > stop, 'install runs after service stop')
    assert.ok(start > install, 'the service starts only after a successful install')
    assert.ok(tmux > start, 'the TUI is relaunched after the service starts')
    assert.ok(lines.some(line => line.startsWith('tmux has-session')), 'the tmux session is checked first')

    const log = await logLines(box)
    const stepLines = log.filter(line => /\] step \d\/5:/.test(line))
    assert.equal(stepLines.length, 5, `the log has exactly five step lines, got:\n${log.join('\n')}`)
    for (const line of log) assert.match(line, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] /, `timestamped log line: ${line}`)
    const joined = log.join('\n')
    assert.match(joined, /step 1\/5: wheelchair-agent service stop -> exit 0/)
    assert.match(joined, /step 2\/5: SIGTERM/)
    assert.match(joined, new RegExp(`step 3/5: bash .*install\\.sh -> exit 0`))
    assert.match(joined, /step 4\/5: wheelchair-agent service start -> exit 0/)
    assert.match(joined, /step 5\/5: tmux .* -> exit 0/)
    assert.match(joined, /note: tmux session dsh-spv is present after the relaunch/)
    assert.match(joined, /restart complete/)
    const relaunchIndex = lines.findIndex(line => line.startsWith('tmux new-session'))
    assert.ok(
      lines.findIndex((line, index) => index > relaunchIndex && line.startsWith('tmux has-session')) > relaunchIndex,
      'the session is verified after the relaunch',
    )
  })
}

async function testFailedInstallAborts() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const result = await cli(box, ['restart-all', '--run'], { env: { FAKE_INSTALL_STATUS: '1' } })
    assert.equal(result.status, 1)
    const lines = await calls(box)
    assert.ok(lines.includes('wheelchair-agent service stop'), 'the service was stopped first')
    assert.ok(lines.includes('install'), 'install.sh was called')
    assert.ok(!lines.includes('wheelchair-agent service start'), 'a failed install never starts the service')
    assert.ok(!lines.some(line => line.startsWith('tmux')), 'a failed install does not relaunch the TUI')
    const joined = (await logLines(box)).join('\n')
    assert.match(joined, /install failed; the superagent service is left stopped/)
    assert.match(joined, /not starting it back/)
    assert.match(joined, /install output: fake install failed: 1/, 'the install output tail is in the log')
    assert.match(
      joined,
      /fix: recover by hand: bash .*install\.sh && wheelchair-agent service start && wheelchair-agent spv/,
      'the recovery is the by-hand sequence; restart-all cannot identify a live session after the chain died',
    )
    assert.match(output(result), /install failed; the superagent service is left stopped/)
  })
}

/** Exit 3 from install.sh means the cold-install guard refused; the log must not suggest it is fixable. */
async function testInstallRefusedExit3() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const result = await cli(box, ['restart-all', '--run'], { env: { FAKE_INSTALL_STATUS: '3' } })
    assert.equal(result.status, 1)
    const joined = (await logLines(box)).join('\n')
    assert.match(joined, /install\.sh refused with exit 3 because a holder is still alive/)
    assert.match(joined, /nothing was installed/)
    assert.match(joined, /the superagent service is left stopped/)
    assert.doesNotMatch(joined, /Fix the install/)
    assert.match(joined, /fix: recover by hand:/)
    assert.ok(!(await calls(box)).includes('wheelchair-agent service start'))
  })
}

/** `--no-install` restarts the service and TUI only; the plan says so and no install.sh runs. */
async function testNoInstall() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const plan = await cli(box, ['restart-all', '--dry-run', '--no-install'])
    assert.equal(plan.status, 0, output(plan))
    assert.match(output(plan), /3\. skipped \(--no-install\)/)
    assert.deepEqual(await calls(box), [])

    const result = await cli(box, ['restart-all', '--run', '--no-install'])
    assert.equal(result.status, 0, output(result))
    const lines = await calls(box)
    assert.ok(lines.includes('wheelchair-agent service stop'))
    assert.ok(lines.includes('wheelchair-agent service start'))
    assert.ok(lines.some(line => line.startsWith('tmux new-session')))
    assert.ok(!lines.includes('install'), '--no-install must not run install.sh')
    const joined = (await logLines(box)).join('\n')
    assert.match(joined, /step 3\/5: install\.sh skipped \(--no-install\)/)
    assert.equal(joined.split('\n').filter(line => /\] step \d\/5:/.test(line)).length, 5)
  })
}

/** A service-start failure still relaunches the TUI (the launcher retries) and exits 1. */
async function testServiceStartFailure() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const result = await cli(box, ['restart-all', '--run'], { env: { FAKE_SERVICE_START_STATUS: '1' } })
    assert.equal(result.status, 1)
    const lines = await calls(box)
    assert.ok(lines.includes('wheelchair-agent service start'))
    assert.ok(lines.some(line => line.startsWith('tmux new-session')), 'the TUI is relaunched anyway')
    const joined = (await logLines(box)).join('\n')
    assert.match(joined, /the superagent service did not start/)
    assert.match(joined, /note: tmux session dsh-spv is present after the relaunch/)
  })
}

/** The parent wait must time out without touching anything; the log explains why. */
async function testReparentWait() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const result = await cli(box, ['restart-all', '--run'], {
      env: {
        WHEELCHAIR_RESTART_PARENT_PID: String(process.pid),
        WHEELCHAIR_RESTART_PARENT_MS: '100',
      },
    })
    assert.equal(result.status, 1)
    assert.match(output(result), /still alive after 100ms/)
    assert.deepEqual(await calls(box), [], 'the parent wait runs no command')
    const joined = (await logLines(box)).join('\n')
    assert.match(joined, /still alive after 100ms/)
    assert.match(joined, /nothing was stopped/)
  })
}

async function testKillTargetsAndAncestorAbort() {
  assert.deepEqual(
    killTargets({ chain: [900_004, 900_002, 900_003, 900_001], selfPid: 900_004, ancestors: [900_002], servicePids: [900_003] }),
    [900_001],
    'the kill set excludes self, ancestors and the service, and is sorted',
  )
  assert.deepEqual(killTargets({ chain: [], selfPid: 1 }), [])

  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox({ chainCount: 1 })
    box.url = url
    // The test process is an ancestor of the CLI child; a fake chain entry that names it must abort.
    await addProc(box, process.pid, chainArgv(box.presetPatch, 1), { check: false, cwd: box.tuiCwd })
    const result = await cli(box, ['restart-all', '--run'])
    assert.equal(result.status, 1)
    assert.match(output(result), /descendant of the SPV session it must replace/)
    assert.deepEqual(await calls(box), [], 'nothing runs before the ancestor check fails')
    const joined = (await logLines(box)).join('\n')
    assert.match(joined, /descendant of the SPV session it must replace/)
    assert.match(joined, /preflight failed, nothing was stopped \(exit 1\)/)
  })
}

async function testCommandModule() {
  const source = await readFile(COMMAND_MODULE, 'utf8')
  assert.doesNotMatch(source, /@deepseek-ai\//, 'the command module imports no dsh package')
  assert.doesNotMatch(source, /from ['"].*restart\.js['"]/, 'the command module does not import the orchestrator')

  const module = await import(COMMAND_MODULE.href)
  assert.equal(module.name, 'spv-restart-command')
  assert.deepEqual(module.inject, ['commands'])
  assert.equal(module.COMMAND, 'restart-wheelchair-agent')

  const box = await makeSandbox()
  const argsFile = join(box.base, 'handler-args')
  const executable = join(box.base, 'fake-agent')
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsFile}'\nprintf 'armed: tmux session dsh-spv, log restarted\\n'\n`,
    'utf8',
  )
  await chmod(executable, 0o755)

  const registrations = []
  module.apply({ commands: { register: registration => registrations.push(registration) } }, { executable })
  assert.equal(registrations.length, 1, 'apply registers exactly one command')
  const registration = registrations[0]
  assert.equal(registration.name, 'restart-wheelchair-agent')
  assert.equal(registration.input.hint, '[--force]')
  assert.equal(typeof registration.handler, 'function')

  const forced = registration.handler({ rawInput: ' --force ' })
  assert.equal(forced.kind, 'success')
  assert.match(forced.text, /dsh-spv/)
  assert.equal((await readFile(argsFile, 'utf8')).trim(), 'restart-all --detach --force')

  await writeFile(argsFile, '', 'utf8')
  const plain = registration.handler({ rawInput: '' })
  assert.equal(plain.kind, 'success')
  assert.equal((await readFile(argsFile, 'utf8')).trim(), 'restart-all --detach')

  const unknown = registration.handler({ rawInput: '--nope' })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /Usage: \/restart-wheelchair-agent/)
  const duplicate = registration.handler({ rawInput: '--force --force' })
  assert.equal(duplicate.kind, 'error')
  assert.match(duplicate.text, /Usage: \/restart-wheelchair-agent/)

  const failing = join(box.base, 'failing-agent')
  await writeFile(failing, '#!/bin/sh\necho "the guard refused" >&2\nexit 1\n', 'utf8')
  await chmod(failing, 0o755)
  const failRegistrations = []
  module.apply({ commands: { register: registration => failRegistrations.push(registration) } }, { executable: failing })
  const failed = failRegistrations[0].handler({ rawInput: '' })
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /the guard refused/)

  const missingRegistrations = []
  module.apply(
    { commands: { register: registration => missingRegistrations.push(registration) } },
    { executable: join(box.base, 'definitely-missing') },
  )
  const missing = missingRegistrations[0].handler({ rawInput: '' })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /could not run/)
  assert.match(missing.text, /fix:/)
}

/**
 * The detached child re-runs the guard; when it refuses, the reason must be in the log the arming output
 * promised, and no command may run.
 */
async function testDetachedReguard() {
  await withServer(
    { running: 0, queued: 0 },
    async ({ url }) => {
      const box = await makeBox()
      box.url = url
      const result = await cli(box, ['restart-all', '--detach'])
      assert.equal(result.status, 0, output(result))
      await waitFor(
        async () => (await logLines(box)).some(line => line.includes('refusing to restart')),
        'the detached re-guard refusal to reach the log',
      )
      const joined = (await logLines(box)).join('\n')
      assert.match(joined, /refusing to restart/)
      assert.match(joined, /1 worker running/)
      assert.match(joined, /preflight failed, nothing was stopped \(exit 1\)/)
      assert.deepEqual(await calls(box), [], 'the refused re-guard runs no command')
    },
    ({ state, requests }) => {
      // The first request is the arming preflight (0/0); the detached child's re-guard must see 1/0.
      if (requests.length === 1) state.running = 1
    },
  )
}

/**
 * The TUI must be launched from the installed preset CLI, not the invoking checkout's bin script: the
 * checkout CLI's `spv` command runs the unrendered preset/spv-launcher.sh template and would not come back.
 */
async function testLaunchUsesInstalledCli() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const plan = await cli(box, ['restart-all', '--dry-run'])
    assert.equal(plan.status, 0, output(plan))
    assert.ok(
      output(plan).includes(`${process.execPath} ${box.presetCli} spv`),
      'the dry-run plan prints the installed preset CLI launch',
    )

    const result = await cli(box, ['restart-all', '--run'])
    assert.equal(result.status, 0, output(result))
    const launch = (await calls(box)).find(line => line.startsWith('tmux new-session'))
    assert.ok(launch !== undefined, 'the tmux launch was recorded')
    assert.ok(launch.includes(box.presetCli), `the launch uses the installed preset CLI:\n${launch}`)
    assert.ok(
      !launch.includes('bin/wheelchair-agent.mjs'),
      `the launch must not use the invoking checkout CLI:\n${launch}`,
    )
  })
}

/**
 * A pid from a stale or reused armed chain must abort before any mutation, even though the chain was
 * trusted by the arming process.
 */
async function testStaleArmedChain() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const stalePid = box.servicePid
    const result = await cli(box, ['restart-all', '--run'], {
      env: { WHEELCHAIR_RESTART_CHAIN: String(stalePid) },
    })
    assert.equal(result.status, 1)
    assert.match(
      output(result),
      new RegExp(`armed SPV chain is stale or changed \\(pid ${stalePid} no longer carries --patch`),
    )
    assert.deepEqual(await calls(box), [], 'a stale chain runs no command')
    const joined = (await logLines(box)).join('\n')
    assert.match(joined, /armed SPV chain is stale or changed/)
    assert.match(joined, /preflight failed, nothing was stopped \(exit 1\)/)
  })
}

async function testDetach() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const result = await cli(box, ['restart-all', '--detach'])
    assert.equal(result.status, 0, output(result))
    const text = output(result)
    assert.ok(text.includes(TMUX_SESSION), 'the command names the tmux session it comes back in')
    assert.ok(text.includes(join(box.root, 'logs', LOG_NAME)), 'the command names the log path')
    assert.match(text, /has not restarted anything itself/)
    assert.match(text, /about to end/)

    await waitFor(
      async () => (await exists(join(box.root, 'logs', LOG_NAME))) && (await readFile(join(box.root, 'logs', LOG_NAME), 'utf8')).includes('restart complete'),
      'the detached orchestrator to log restart complete',
    )
    const log = (await logLines(box)).join('\n')
    assert.match(log, /mode detach/)
    assert.match(log, /arming a detached orchestrator/)
    assert.match(log, /step 1\/5: wheelchair-agent service stop/)
    assert.match(log, /note: tmux session dsh-spv is present after the relaunch/)
    assert.match(log, /restart complete/)
    assert.equal(log.split('\n').filter(line => /\] step \d\/5:/.test(line)).length, 5)
    const lines = await calls(box)
    assert.ok(lines.indexOf('wheelchair-agent service start') > lines.indexOf('install'))
    assert.ok(lines.some(line => line.startsWith('tmux new-session')))
  })
}

// -------------------------------------------------------------------- main

let passed = 0
let failed = 0
const errors = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`PASS  ${name}\n`)
  } catch (error) {
    failed += 1
    errors.push(error)
    process.stdout.write(`FAIL  ${name}\n      ${error?.message ?? error}\n`)
  }
}

try {
  await test('readLoad sends the orchestrator header and handles an unreachable service', testReadLoad)
  await test('readLoad marks answered-but-unreadable responses as reachable but not readable', testReadLoadUnreadable)
  await test('readLoad settles on a truncated response body', testReadLoadTruncated)
  await test('the guard refuses at running: 1 and names the worker', testGuardRefusesRunning)
  await test('the guard refuses at queued: 1 and names the ticket', testGuardRefusesQueued)
  await test('the guard refuses an unreadable load, and --force reports unknown work', testGuardRefusesUnreadable)
  await test('--force overrides a counted guard and prints what it interrupts', testForceOverridesGuard)
  await test('--dry-run prints the whole plan and writes nothing', testDryRunPlan)
  await test('the TUI launch uses the installed preset CLI, not the checkout CLI', testLaunchUsesInstalledCli)
  await test('--run has exactly five steps in order and verifies the tmux session', testStepOrder)
  await test('a failed install leaves the service stopped and logs the by-hand recovery', testFailedInstallAborts)
  await test('install.sh exit 3 is reported as a refusal, not a fixable failure', testInstallRefusedExit3)
  await test('--no-install skips install.sh and still restarts service and TUI', testNoInstall)
  await test('a service-start failure still relaunches the TUI and exits 1', testServiceStartFailure)
  await test('the parent wait times out without running a command', testReparentWait)
  await test('the kill set excludes self/ancestors/service and an ancestor aborts first', testKillTargetsAndAncestorAbort)
  await test('an armed chain whose pid no longer carries the patch is refused before mutation', testStaleArmedChain)
  await test('the command module registers one honest /restart-wheelchair-agent', testCommandModule)
  await test('the detached child logs a re-guard refusal and runs nothing', testDetachedReguard)
  await test('--detach arms a child that logs restart complete', testDetach)
} finally {
  for (const server of SERVERS) {
    await new Promise(done => server.close(done)).catch(() => {})
  }
  for (const base of SANDBOXES) await rm(base, { recursive: true, force: true })
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error?.stack ?? error}\n`)
}
process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
process.exitCode = failed === 0 ? 0 : 1
