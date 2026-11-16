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
 *   - `--no-install` skips install.sh, and a service-start failure exits 1 **without** relaunching a TUI
 *     into a broken deployment;
 *   - the `spv` loop runs the launcher as a child, narrates a marked restart from the log (timestamps
 *     stripped, in order), skips internal `restart-all:` lines and relaunches in the same terminal; a failed
 *     install, a dead orchestrator, a pid-less marker and the narrator timeout exit non-zero without
 *     relaunching; a marker older than its launch (or two restarts in one loop) is handled per launch;
 *     the tmux fallback runs only when no terminal claims, and a fallback that later fails exits 1;
 *   - the relaunch and the tmux fallback resume the same SPV conversation from `~/.dsh-tui/resume.txt`
 *     (UUID-validated; the relaunch strips stale operator `--resume`/`-c`/`--continue` and uses the file); a
 *     missing/invalid file prints one note and starts fresh, and a resume dsh-tui rejects is retried once
 *     without the flag;
 *   - the launcher environment never sees the CLI's armed-chain seams, and tmux is only a fallback: a
 *     claimed run succeeds without tmux, an unclaimed run without tmux fails with a logged reason;
 *   - the kill set excludes the orchestrator's own pid, its ancestors and the service; an ancestor in the
 *     fake chain aborts before any command; an armed chain whose pid no longer carries the patch is refused
 *     before mutation in `--run`; the armed chain/patch env overrides are ignored outside `--run`, so a
 *     leaked stale pair cannot displace the real `/proc` scan; a zombie pid is treated as gone;
 *   - a restart claim counts only while its narrator pid is alive: a dead claim logs one note and takes the
 *     tmux fallback instead of waiting for a relaunch that will never happen;
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
      'if [ -n "${WHEELCHAIR_RESTART_CHAIN:-}" ]; then printf \'leaked\\n\' >> "$FAKE_LEAK"; fi\n' +
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
    FAKE_LEAK: join(box.base, 'leaked-seams'),
    FAKE_TMUX_MARKER: join(box.base, 'tmux-session'),
    // Every orchestrator run must decide "no claim" quickly; the fallback tests measure this window.
    WHEELCHAIR_RESTART_CLAIM_MS: '100',
    // The service that runs this suite may itself have been started by a restart, so its environment can
    // carry the detached orchestrator's seams. A test must never inherit a chain/preset from the live
    // deployment; every seam starts empty here and the explicit overrides below set what a case needs.
    WHEELCHAIR_RESTART_CHAIN: '',
    WHEELCHAIR_RESTART_PARENT_PID: '',
    WHEELCHAIR_RESTART_PRESET_PATCH: '',
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

/** Write the fake SPV launcher the CLI runs through `WHEELCHAIR_AGENT_LAUNCHER`; it runs under `sh`. */
async function writeLauncher(box, body) {
  const file = join(box.base, 'fake-launcher.sh')
  await writeFile(file, `#!/bin/sh\nset -u\n${body}`, 'utf8')
  await chmod(file, 0o755)
  return file
}

/** Write the sandbox `~/.dsh-tui/resume.txt`, the one source of the session id a relaunch resumes. */
async function writeResume(box, text) {
  await mkdir(join(box.home, '.dsh-tui'), { recursive: true })
  await writeFile(join(box.home, '.dsh-tui', 'resume.txt'), text, 'utf8')
}

/** A shell `cat >` marker write shared by the narrator fixtures; `extra` is a JSON fragment without braces. */
function markerJson({ checkout = '"$FAKE_CHECKOUT"', noInstall = 'false', pid = '$FAKE_MARKER_PID' } = {}) {
  return [
    'cat > "$DSH_SUPERAGENT_STATE_DIR/restart-armed.json" <<JSON',
    `{"pid": ${pid}, "armedPid": $$, "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "log": "$log", ` +
      `"logOffset": $offset, "checkout": ${checkout}, "tmux": "dsh-spv", ` +
      `"service": "http://127.0.0.1:3082", "force": false, "noInstall": ${noInstall}}`,
    'JSON',
  ].join('\n')
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
    assert.match(
      text,
      /resume: --resume unavailable \(no ~\/\.dsh-tui\/resume\.txt\); the fallback starts a fresh session/,
      'the plan says when it cannot resume',
    )
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

/** A service-start failure exits 1 and relaunches nothing: no TUI into a broken deployment. */
async function testServiceStartFailure() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const result = await cli(box, ['restart-all', '--run'], { env: { FAKE_SERVICE_START_STATUS: '1' } })
    assert.equal(result.status, 1)
    const lines = await calls(box)
    assert.ok(lines.includes('wheelchair-agent service start'))
    assert.ok(!lines.some(line => line.startsWith('tmux')), 'the TUI must not be relaunched')
    const joined = (await logLines(box)).join('\n')
    assert.match(joined, /the superagent service did not start/)
    assert.match(joined, /the TUI was not relaunched/)
    assert.match(joined, /fix the service and run "wheelchair-agent spv"/)
    assert.match(joined, /restart failed \(exit 1\)/)
    assert.doesNotMatch(joined, /step 5\/5/)
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
    // This detached CLI was not started by a supervising `spv` loop, so the one-time rollout note applies.
    assert.match(text, /no supervising "wheelchair-agent spv"/)
    assert.match(text, /comes back in tmux session "dsh-spv"/)

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

    // The marker is the handshake with the still-open terminal: it must name the log, the tail offset and
    // the fallback session, and the detached child re-asserts its own pid.
    const marker = JSON.parse(await readFile(join(box.state, 'restart-armed.json'), 'utf8'))
    assert.equal(marker.log, join(box.root, 'logs', LOG_NAME))
    assert.equal(typeof marker.logOffset, 'number')
    assert.equal(marker.tmux, TMUX_SESSION)
    assert.ok(Number.isInteger(marker.pid) && marker.pid > 0, `marker pid is the orchestrator, got ${marker.pid}`)
    assert.ok(Number.isInteger(marker.armedPid) && marker.armedPid > 0, 'the marker names the arming process')
    assert.equal(typeof marker.startedAt, 'string')
    assert.ok(Number.isFinite(Date.parse(marker.startedAt)), `startedAt is an ISO timestamp, got ${marker.startedAt}`)
    assert.ok(marker.logOffset > 0, 'the narrator starts after the arming lines, not at the beginning')
  })
}

/** The `spv` loop: narrated steps in order, timestamps stripped, relaunch in the same terminal. */
async function testSpvLoopNarratesAndRelaunches() {
  const box = await makeSandbox()
  const relaunched = join(box.base, 'relaunched')
  const launcher = await writeLauncher(
    box,
    `
if [ -f "$FAKE_RELAUNCHED" ]; then
  printf 'FAKE RELAUNCH\\n'
  printf 'launcher-relaunch\\n' >> "$FAKE_CALLS"
  exit 0
fi
printf 'launcher-first\\n' >> "$FAKE_CALLS"
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
printf '[2026-11-15T00:00:00.000Z] old line before the marker\\n' >> "$log"
offset=$(wc -c < "$log")
${markerJson()}
{
  printf '[2026-11-15T00:00:00.100Z] restart-all: pid 111, mode detached, force=no, install=yes, chain 1 2\\n'
  printf '[2026-11-15T00:00:00.200Z] restart-all: arming a detached orchestrator; internal line\\n'
  printf '[2026-11-15T00:00:01.000Z] step 1/5: wheelchair-agent service stop -> exit 0\\n'
  printf '[2026-11-15T00:00:01.100Z] step 2/5: SIGTERM 111 222 -> sent 2, survivors 0\\n'
  printf '[2026-11-15T00:00:01.200Z] step 3/5: bash $FAKE_CHECKOUT/install.sh -> exit 0\\n'
  printf '[2026-11-15T00:00:01.300Z] step 4/5: wheelchair-agent service start -> exit 0\\n'
  printf '[2026-11-15T00:00:01.400Z] step 5/5: skipped; the terminal claimed the restart and relaunches the TUI here\\n'
  printf '[2026-11-15T00:00:01.500Z] restart complete (exit 0)\\n'
} >> "$log"
: > "$FAKE_RELAUNCHED"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_MARKER_PID: String(process.pid),
      FAKE_RELAUNCHED: relaunched,
      FAKE_CHECKOUT: box.checkout,
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(result.status, 0, output(result))
  const text = output(result)
  assert.match(text, /^restart: stopping the service…$/m, 'the first line appears before any step')
  const order = [
    'step 1/5: wheelchair-agent service stop -> exit 0',
    'step 2/5: SIGTERM 111 222 -> sent 2, survivors 0',
    'step 3/5: bash ',
    'step 4/5: wheelchair-agent service start -> exit 0',
    'step 5/5: skipped; the terminal claimed the restart and relaunches the TUI here',
    'restart complete (exit 0)',
    'restart: done; starting the SPV session again…',
    'FAKE RELAUNCH',
  ]
  const positions = order.map(piece => {
    const index = text.indexOf(piece)
    assert.ok(index >= 0, `stdout contains ${JSON.stringify(piece)}:\n${text}`)
    return index
  })
  assert.deepEqual([...positions].sort((left, right) => left - right), positions, 'the steps are in log order')
  assert.ok(
    text.indexOf('restart: stopping the service…') < text.indexOf('step 1/5'),
    'the first line is printed before the first replayed step',
  )
  assert.doesNotMatch(text, /\[2026-/, 'the ISO timestamp prefix is stripped')
  assert.doesNotMatch(text, /restart-all:/, 'internal orchestrator lines stay in the log, not on the terminal')
  assert.doesNotMatch(text, /old line before the marker/, 'the narrator starts at the marker offset')
  assert.equal(await exists(join(box.state, 'restart-armed.json')), false, 'the marker is cleared after done')
  assert.equal(await exists(join(box.state, 'restart-claimed.json')), false, 'the claim is cleared after done')
  assert.deepEqual(await calls(box), ['launcher-first', 'launcher-relaunch'], 'the launcher ran twice')
}

/** Two completed marked restarts in one loop must relaunch twice (per-launch state, not a one-shot). */
async function testSpvTwoRestartsInOneLoop() {
  const box = await makeSandbox()
  const count = join(box.base, 'launch-count')
  const launcher = await writeLauncher(
    box,
    `
n=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0)
n=$((n+1))
printf '%s\\n' "$n" > "$FAKE_COUNT"
printf 'call:%s:%s\\n' "$n" "$*" >> "$FAKE_CALLS"
if [ "$n" -gt 2 ]; then exit 0; fi
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson()}
printf '[2026-11-15T00:00:01.000Z] restart complete (exit 0)\\n' >> "$log"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_MARKER_PID: String(process.pid),
      FAKE_CHECKOUT: box.checkout,
      FAKE_COUNT: count,
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(result.status, 0, output(result))
  assert.deepEqual(await calls(box), ['call:1:', 'call:2:', 'call:3:'], 'the launcher ran three times')
  assert.equal(
    output(result).split('restart: done; starting the SPV session again…').length - 1,
    2,
    'both marked restarts relaunched',
  )
}

/** The launcher/TUI must not inherit the armed-chain seams or the launcher test override. */
async function testSpvLauncherEnvIsClean() {
  const box = await makeSandbox()
  const launcher = await writeLauncher(
    box,
    `
for name in WHEELCHAIR_RESTART_CHAIN WHEELCHAIR_RESTART_PARENT_PID WHEELCHAIR_RESTART_PRESET_PATCH WHEELCHAIR_AGENT_LAUNCHER; do
  if [ -n "$(printenv "$name" 2>/dev/null || true)" ]; then printf 'leaked:%s\\n' "$name" >> "$FAKE_LEAK"; fi
done
printf 'supervised:%s\\n' "\${WHEELCHAIR_AGENT_SUPERVISED:-unset}" >> "$FAKE_CALLS"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      WHEELCHAIR_RESTART_CHAIN: '111 222',
      WHEELCHAIR_RESTART_PARENT_PID: '1',
      WHEELCHAIR_RESTART_PRESET_PATCH: '/wrong/patch.yml',
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(result.status, 0, output(result))
  assert.equal(
    await exists(join(box.base, 'leaked-seams')),
    false,
    'the launcher must not see the CLI-private environment',
  )
  assert.deepEqual(await calls(box), ['supervised:1'], 'the supervised marker tells the slash command it is watched')
}

/** A marker without a pid cannot complete; fail after the short startup grace, not the full timeout. */
async function testSpvNarratorNoPidGrace() {
  const box = await makeSandbox()
  const launcher = await writeLauncher(
    box,
    `
printf 'launcher-first\\n' >> "$FAKE_CALLS"
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson({ pid: 'null', checkout: 'null', noInstall: 'true' })}
printf '[2026-11-15T00:00:01.000Z] step 1/5: wheelchair-agent service stop -> exit 0\\n' >> "$log"
exit 0
`,
  )
  const started = Date.now()
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_CHECKOUT: box.checkout,
      WHEELCHAIR_RESTART_NARRATE_MS: '10000',
    },
  })
  assert.equal(result.status, 1)
  assert.ok(Date.now() - started < 5000, 'the startup grace is short, not the full narrator timeout')
  const text = output(result)
  assert.match(text, /restart: failed — the orchestrator did not start \(the restart marker has no pid\)/)
  assert.ok(text.includes(`log: ${join(box.root, 'logs', LOG_NAME)}`), `the failure names the log:\n${text}`)
  assert.deepEqual(await calls(box), ['launcher-first'], 'no relaunch')
}

/** A failed install names the failure, the log and the by-hand fix, and never relaunches. */
async function testSpvNarratorFailureNoRelaunch() {
  const box = await makeSandbox()
  const launcher = await writeLauncher(
    box,
    `
printf 'launcher-first\\n' >> "$FAKE_CALLS"
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson()}
{
  printf '[2026-11-15T00:00:01.000Z] step 1/5: wheelchair-agent service stop -> exit 0\\n'
  printf '[2026-11-15T00:00:02.000Z] step 3/5: bash $FAKE_CHECKOUT/install.sh -> exit 1\\n'
  printf '[2026-11-15T00:00:02.100Z] install failed; the superagent service is left stopped; not starting it back (exit 1)\\n'
} >> "$log"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_MARKER_PID: String(process.pid),
      FAKE_CHECKOUT: box.checkout,
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(result.status, 1)
  const text = output(result)
  assert.match(text, /restart: failed — install failed; the superagent service is left stopped/)
  assert.ok(text.includes(`log: ${join(box.root, 'logs', LOG_NAME)}`), `the failure names the log:\n${text}`)
  assert.ok(
    text.includes(
      `fix: bash ${box.checkout}/install.sh && wheelchair-agent service start && wheelchair-agent spv`,
    ),
    `the failure names the by-hand recovery:\n${text}`,
  )
  assert.doesNotMatch(text, /restart: done/, 'a failure does not claim success')
  assert.deepEqual(await calls(box), ['launcher-first'], 'the launcher was not started again')
  assert.equal(await exists(join(box.state, 'restart-armed.json')), false, 'the marker is cleared')
}

/** The narrator must not wait forever: the timeout path prints the log and the recovery commands. */
async function testSpvNarratorTimeout() {
  const box = await makeSandbox()
  const launcher = await writeLauncher(
    box,
    `
printf 'launcher-first\\n' >> "$FAKE_CALLS"
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson({ checkout: 'null', noInstall: 'true' })}
printf '[2026-11-15T00:00:01.000Z] step 1/5: wheelchair-agent service stop -> exit 0\\n' >> "$log"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_MARKER_PID: String(process.pid),
      FAKE_CHECKOUT: box.checkout,
      WHEELCHAIR_RESTART_NARRATE_MS: '200',
    },
  })
  assert.equal(result.status, 1)
  const text = output(result)
  assert.match(text, /restart: timed out after 200ms waiting for the orchestrator to finish/)
  assert.ok(text.includes(`log: ${join(box.root, 'logs', LOG_NAME)}`), `the timeout names the log:\n${text}`)
  assert.match(text, /fix: wheelchair-agent service start && wheelchair-agent spv/)
  assert.doesNotMatch(text, /install\.sh &&/, '--no-install omits the install step from the recovery')
  assert.deepEqual(await calls(box), ['launcher-first'], 'no relaunch after a timeout')
  assert.equal(await exists(join(box.state, 'restart-armed.json')), false, 'the marker is cleared')
}

/** A marker from an older run (older `startedAt`) is ignored, so a normal exit stays normal. */
async function testSpvStaleMarkerIgnored() {
  const box = await makeSandbox()
  await writeFile(
    join(box.state, 'restart-armed.json'),
    JSON.stringify({
      pid: process.pid,
      startedAt: '2020-01-01T00:00:00.000Z',
      log: join(box.root, 'logs', LOG_NAME),
      logOffset: 0,
    }),
    'utf8',
  )
  await writeFile(join(box.state, 'restart-claimed.json'), '{"pid":1}', 'utf8')
  const launcher = await writeLauncher(
    box,
    `
[ -f "$DSH_SUPERAGENT_STATE_DIR/restart-armed.json" ] && printf 'marker-present\\n' >> "$FAKE_CALLS"
printf 'launcher-first\\n' >> "$FAKE_CALLS"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: { WHEELCHAIR_AGENT_LAUNCHER: launcher, WHEELCHAIR_RESTART_NARRATE_MS: '3000' },
  })
  assert.equal(result.status, 0)
  assert.equal(output(result), '', 'a normal exit produces no narrator output')
  assert.deepEqual(
    await calls(box),
    ['marker-present', 'launcher-first'],
    'the launcher ran once; the stale marker was still there during the launch',
  )
  assert.equal(await exists(join(box.state, 'restart-armed.json')), false, 'the stale marker is cleared')
  assert.equal(await exists(join(box.state, 'restart-claimed.json')), false)
}

/** A normal TUI exit still ends the CLI with the child's status (with a stale marker cleared first). */
async function testSpvNormalExitKeepsStatus() {
  const box = await makeSandbox()
  await writeFile(
    join(box.state, 'restart-armed.json'),
    JSON.stringify({ pid: 1, startedAt: '2020-01-01T00:00:00.000Z' }),
    'utf8',
  )
  const launcher = await writeLauncher(
    box,
    `
printf 'launcher-first\\n' >> "$FAKE_CALLS"
exit 7
`,
  )
  const result = await cli(box, ['spv'], {
    env: { WHEELCHAIR_AGENT_LAUNCHER: launcher, WHEELCHAIR_RESTART_NARRATE_MS: '3000' },
  })
  assert.equal(result.status, 7, 'the child status becomes the CLI status')
  assert.equal(output(result), '')
  assert.deepEqual(await calls(box), ['launcher-first'])
}

/** The orchestrator already took tmux: the CLI prints the session and must not start a second TUI. */
async function testSpvFallbackAlreadyLaunched() {
  const box = await makeSandbox()
  const launcher = await writeLauncher(
    box,
    `
printf 'launcher-first\\n' >> "$FAKE_CALLS"
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson()}
printf '[2026-11-15T00:00:01.000Z] restart complete (exit 0)\\n' >> "$log"
printf '{"pid":1,"at":"2026-11-15T00:00:00.000Z","tmux":"dsh-spv"}\\n' > "$DSH_SUPERAGENT_STATE_DIR/restart-fallback.json"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_MARKER_PID: String(process.pid),
      FAKE_CHECKOUT: box.checkout,
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(result.status, 0)
  const text = output(result)
  assert.match(text, /restart: the terminal did not claim the restart; the TUI is in tmux session dsh-spv/)
  assert.match(text, /restart: attach with: tmux attach -t =dsh-spv/)
  assert.ok(text.includes(`log: ${join(box.root, 'logs', LOG_NAME)}`), `the fallback names the log:\n${text}`)
  assert.ok(!text.includes('restart: done'), 'the fallback path does not relaunch')
  assert.deepEqual(await calls(box), ['launcher-first'])
  assert.equal(await exists(join(box.state, 'restart-fallback.json')), true, 'the fallback record stays')
}

/** A tmux launch that reported success and then failed is a failure, not a success message. */
async function testSpvFallbackFailureIsNotSuccess() {
  const box = await makeSandbox()
  const launcher = await writeLauncher(
    box,
    `
printf 'launcher-first\\n' >> "$FAKE_CALLS"
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson()}
{
  printf '[2026-11-15T00:00:01.000Z] note: no terminal claim within 100ms; taking the tmux fallback\\n'
  printf '[2026-11-15T00:00:01.100Z] FAIL: tmux session dsh-spv is not present 2s after the relaunch; the TUI did not come back\\n'
  printf '[2026-11-15T00:00:01.200Z] restart failed (exit 1); the log above says which step failed\\n'
} >> "$log"
printf '{"pid":1,"at":"2026-11-15T00:00:00.000Z","tmux":"dsh-spv"}\\n' > "$DSH_SUPERAGENT_STATE_DIR/restart-fallback.json"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_MARKER_PID: String(process.pid),
      FAKE_CHECKOUT: box.checkout,
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(result.status, 1)
  const text = output(result)
  assert.match(text, /restart: failed — FAIL: tmux session dsh-spv is not present/)
  assert.doesNotMatch(text, /restart: attach with/, 'a failed tmux fallback is not reported as a live session')
  assert.doesNotMatch(text, /restart: done/, 'no relaunch line on failure')
  assert.ok(text.includes(`log: ${join(box.root, 'logs', LOG_NAME)}`), `the failure names the log:\n${text}`)
  assert.deepEqual(await calls(box), ['launcher-first'], 'no relaunch')
}

/** A dead orchestrator pid with no completion line fails with the log path, instead of hanging. */
async function testSpvNarratorDeathPath() {
  const box = await makeSandbox()
  const deadPid = freePids(1, 950_000)[0]
  const launcher = await writeLauncher(
    box,
    `
printf 'launcher-first\\n' >> "$FAKE_CALLS"
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson()}
printf '[2026-11-15T00:00:01.000Z] step 1/5: wheelchair-agent service stop -> exit 0\\n' >> "$log"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_MARKER_PID: String(deadPid),
      FAKE_CHECKOUT: box.checkout,
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(result.status, 1)
  const text = output(result)
  assert.match(text, /restart: failed — the orchestrator exited without completing/)
  assert.ok(text.includes(`log: ${join(box.root, 'logs', LOG_NAME)}`), `the death path names the log:\n${text}`)
  assert.match(text, /fix: bash .*install\.sh && wheelchair-agent service start && wheelchair-agent spv/)
  assert.deepEqual(await calls(box), ['launcher-first'], 'no relaunch after a dead orchestrator')
}

/** Step 5: tmux is the fallback only when no terminal claims; a claim skips it entirely. */
async function testOrchestratorClaimVsFallback() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const fallbackRun = await cli(box, ['restart-all', '--run'], {
      env: { WHEELCHAIR_RESTART_CLAIM_MS: '100' },
    })
    assert.equal(fallbackRun.status, 0, output(fallbackRun))
    const fallbackCalls = await calls(box)
    assert.ok(fallbackCalls.some(line => line.startsWith('tmux new-session')), 'tmux is launched')
    const fallbackLog = (await logLines(box)).join('\n')
    assert.match(fallbackLog, /note: no terminal claim within 100ms; taking the tmux fallback/)
    assert.match(fallbackLog, /step 5\/5: tmux .* -> exit 0/)
    assert.match(fallbackLog, /restart complete \(exit 0\)/)
    const record = JSON.parse(await readFile(join(box.state, 'restart-fallback.json'), 'utf8'))
    assert.equal(record.tmux, TMUX_SESSION)

    const claimed = await makeBox()
    claimed.url = url
    await writeFile(
      join(claimed.state, 'restart-claimed.json'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      'utf8',
    )
    const claimedRun = await cli(claimed, ['restart-all', '--run'], {
      env: { WHEELCHAIR_RESTART_CLAIM_MS: '100' },
    })
    assert.equal(claimedRun.status, 0, output(claimedRun))
    const claimedCalls = await calls(claimed)
    assert.ok(claimedCalls.includes('wheelchair-agent service stop'), 'the run still happens')
    assert.ok(!claimedCalls.some(line => line.startsWith('tmux')), 'a claimed restart runs no tmux command')
    const claimedLog = (await logLines(claimed)).join('\n')
    assert.match(
      claimedLog,
      /step 5\/5: skipped; the terminal claimed the restart and relaunches the TUI here/,
    )
    assert.match(claimedLog, /restart complete \(exit 0\)/)
    assert.equal(claimedLog.split('\n').filter(line => /\] step \d\/5:/.test(line)).length, 5)
    assert.equal(await exists(join(claimed.state, 'restart-fallback.json')), false, 'no fallback record')
  })
}

/**
 * A claim whose narrator is dead must not suppress tmux: that would leave the operator with no TUI at all.
 * The claim is only written by the CLI before the relaunch, so a dead pid means the terminal died with it.
 */
async function testDeadClaimTakesFallback() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const deadPid = freePids(1, 970_000)[0]
    await writeFile(
      join(box.state, 'restart-claimed.json'),
      JSON.stringify({ pid: deadPid, at: new Date().toISOString() }),
      'utf8',
    )
    const result = await cli(box, ['restart-all', '--run'], {
      env: { WHEELCHAIR_RESTART_CLAIM_MS: '1000' },
    })
    assert.equal(result.status, 0, output(result))
    const lines = await calls(box)
    assert.ok(lines.some(line => line.startsWith('tmux new-session')), 'the tmux fallback runs')
    const log = (await logLines(box)).join('\n')
    assert.match(log, /note: the terminal that claimed the restart is gone; taking the tmux fallback/)
    assert.doesNotMatch(log, /step 5\/5: skipped/, 'a dead claim is not treated as a live relaunch')
    assert.match(log, /step 5\/5: tmux .* -> exit 0/)
    assert.match(log, /restart complete \(exit 0\)/)
  })
}

/** Remove the sandbox tmux fake and add the shells the steps need, for the "no tmux" cases. */
async function removeTmux(box) {
  await rm(join(box.bin, 'tmux'), { force: true })
  await symlink('/bin/sh', join(box.bin, 'sh'))
  await symlink('/bin/bash', join(box.bin, 'bash'))
  return { PATH: box.bin }
}

/** tmux is only the fallback: a terminal that claimed the restart succeeds with no tmux at all. */
async function testClaimedRunWithoutTmux() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const env = await removeTmux(box)
    await writeFile(
      join(box.state, 'restart-claimed.json'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      'utf8',
    )
    const result = await cli(box, ['restart-all', '--run'], {
      env: { ...env, WHEELCHAIR_RESTART_CLAIM_MS: '1000' },
    })
    assert.equal(result.status, 0, output(result))
    assert.ok(!(await calls(box)).some(line => line.startsWith('tmux')), 'no tmux command is run')
    const log = (await logLines(box)).join('\n')
    assert.match(log, /step 5\/5: skipped; the terminal claimed the restart and relaunches the TUI here/)
    assert.match(log, /note: tmux is not on PATH/)
    assert.match(log, /restart complete \(exit 0\)/)
  })
}

/** Without a claim and without tmux there is no way back: exit 1 with a logged failure. */
async function testUnclaimedRunWithoutTmuxFails() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const env = await removeTmux(box)
    const result = await cli(box, ['restart-all', '--run'], {
      env: { ...env, WHEELCHAIR_RESTART_CLAIM_MS: '100' },
    })
    assert.equal(result.status, 1)
    assert.match(output(result), /FAIL: tmux is not on PATH; the fallback TUI was not started/)
    assert.ok(!(await calls(box)).some(line => line.startsWith('tmux')), 'no tmux command is run')
    const log = (await logLines(box)).join('\n')
    assert.match(log, /FAIL: tmux is not on PATH; the fallback TUI was not started/)
    assert.match(log, /restart failed \(exit 1\)/)
    assert.doesNotMatch(log, /restart complete/)
  })
}

/**
 * The armed chain/patch env overrides exist only for the detached `--run` child. A dry run carrying a stale
 * leaked pair must still scan `/proc` instead of trusting (and refusing) the stale chain.
 */
async function testDryRunIgnoresArmedOverrides() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox({ chainCount: 2 })
    box.url = url
    const stale = freePids(2, 960_000)
    const result = await cli(box, ['restart-all', '--dry-run', '--force'], {
      env: {
        WHEELCHAIR_RESTART_CHAIN: stale.join(' '),
        WHEELCHAIR_RESTART_PRESET_PATCH: '/wrong/preset-default.patch.yml',
      },
    })
    assert.equal(result.status, 0, output(result))
    const text = output(result)
    assert.match(text, /restart-all plan \(dry run; nothing is changed\)/)
    for (const pid of box.chainPids) {
      assert.ok(text.includes(String(pid)), `the plan names the real /proc chain pid ${pid}:\n${text}`)
    }
    for (const pid of stale) {
      assert.ok(!text.includes(String(pid)), `the stale armed pid ${pid} is not treated as a target:\n${text}`)
    }
    assert.doesNotMatch(text, /armed SPV chain is stale/)
    assert.doesNotMatch(text, /\/wrong\/preset-default\.patch\.yml/)
  })
}

/** The same-terminal relaunch resumes the conversation named by ~/.dsh-tui/resume.txt. */
async function testSpvRelaunchResumesSession() {
  const box = await makeSandbox()
  const uuid = '10b21e9f-7e77-40f3-9d1e-d2ee931f6ff6'
  await writeResume(box, `${uuid}\n`)
  const launcher = await writeLauncher(
    box,
    `
printf 'call:%s\\n' "$*" >> "$FAKE_CALLS"
if [ -f "$FAKE_RELAUNCHED" ]; then exit 0; fi
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson()}
printf '[2026-11-15T00:00:01.000Z] restart complete (exit 0)\\n' >> "$log"
: > "$FAKE_RELAUNCHED"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_MARKER_PID: String(process.pid),
      FAKE_CHECKOUT: box.checkout,
      FAKE_RELAUNCHED: join(box.base, 'relaunched'),
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(result.status, 0, output(result))
  assert.deepEqual(
    await calls(box),
    ['call:', `call:--resume ${uuid}`],
    'the operator start has no flag; the relaunch resumes the recorded session',
  )
  assert.doesNotMatch(output(result), /cannot resume/, 'a usable resume file prints no note')

  // The first launch keeps the operator's argv, but the relaunch must not repeat their old id: it takes
  // resume.txt instead, because an old id can reopen the wrong conversation.
  const chosen = await makeSandbox()
  await writeResume(chosen, `${uuid}\n`)
  const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const chosenLauncher = await writeLauncher(
    chosen,
    `
printf 'call:%s\\n' "$*" >> "$FAKE_CALLS"
if [ -f "$FAKE_RELAUNCHED" ]; then exit 0; fi
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson()}
printf '[2026-11-15T00:00:01.000Z] restart complete (exit 0)\\n' >> "$log"
: > "$FAKE_RELAUNCHED"
exit 0
`,
  )
  const chosenResult = await cli(chosen, ['spv', '--resume', other], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: chosenLauncher,
      FAKE_MARKER_PID: String(process.pid),
      FAKE_CHECKOUT: chosen.checkout,
      FAKE_RELAUNCHED: join(chosen.base, 'relaunched'),
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(chosenResult.status, 0, output(chosenResult))
  assert.deepEqual(
    await calls(chosen),
    [`call:--resume ${other}`, `call:--resume ${uuid}`],
    'the first launch keeps the operator argv; the relaunch uses resume.txt, not the stale id',
  )
}

/** With no resume.txt the relaunch still happens, but it prints one note and starts a fresh session. */
async function testSpvCannotResumeStartsFresh() {
  const box = await makeSandbox()
  const launcher = await writeLauncher(
    box,
    `
printf 'call:%s\\n' "$*" >> "$FAKE_CALLS"
if [ -f "$FAKE_RELAUNCHED" ]; then printf 'fresh-started\\n'; exit 0; fi
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson()}
printf '[2026-11-15T00:00:01.000Z] restart complete (exit 0)\\n' >> "$log"
: > "$FAKE_RELAUNCHED"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_MARKER_PID: String(process.pid),
      FAKE_CHECKOUT: box.checkout,
      FAKE_RELAUNCHED: join(box.base, 'relaunched'),
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(result.status, 0, output(result))
  const text = output(result)
  const note = 'restart: cannot resume the previous SPV session (no ~/.dsh-tui/resume.txt); starting a fresh one.'
  const noteIndex = text.indexOf(note)
  assert.ok(noteIndex >= 0, `the missing-resume note is printed:\n${text}`)
  assert.ok(noteIndex < text.indexOf('fresh-started'), 'the note comes before the fresh session starts')
  assert.deepEqual(await calls(box), ['call:', 'call:'], 'the relaunch runs without a resume flag')
}

/**
 * A stale operator flag must not be repeated on the relaunch: a bare `-c` with an empty resume.txt makes
 * dsh-tui exit 1, and an old explicit id can reopen the wrong conversation.
 */
async function testSpvRelaunchDropsStaleOperatorFlags() {
  const box = await makeSandbox()
  await writeResume(box, '')
  const launcher = await writeLauncher(
    box,
    `
printf 'call:%s\\n' "$*" >> "$FAKE_CALLS"
if [ -f "$FAKE_RELAUNCHED" ]; then printf 'fresh-started\\n'; exit 0; fi
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson()}
printf '[2026-11-15T00:00:01.000Z] restart complete (exit 0)\\n' >> "$log"
: > "$FAKE_RELAUNCHED"
exit 0
`,
  )
  const result = await cli(box, ['spv', '-c'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_MARKER_PID: String(process.pid),
      FAKE_CHECKOUT: box.checkout,
      FAKE_RELAUNCHED: join(box.base, 'relaunched'),
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(result.status, 0, output(result))
  const text = output(result)
  assert.match(
    text,
    /restart: cannot resume the previous SPV session \(~\/\.dsh-tui\/resume\.txt does not contain a session id\); starting a fresh one\./,
  )
  assert.deepEqual(await calls(box), ['call:-c', 'call:'], 'the relaunch drops the stale -c flag')
  assert.match(text, /fresh-started/, 'the fresh session still starts')
}

/** dsh-tui rejecting the resume is not fatal: one note, then one retry without the flag. */
async function testSpvResumeRefusedRetriesFresh() {
  const box = await makeSandbox()
  const uuid = '10b21e9f-7e77-40f3-9d1e-d2ee931f6ff6'
  await writeResume(box, uuid)
  const launcher = await writeLauncher(
    box,
    `
printf 'call:%s\\n' "$*" >> "$FAKE_CALLS"
case "$*" in
  *--resume*) exit 3 ;;
esac
if [ -f "$FAKE_RELAUNCHED" ]; then printf 'fresh-started\\n'; exit 0; fi
log="$WHEELCHAIR_AGENT_HOME/logs/restart-all.log"
mkdir -p "$WHEELCHAIR_AGENT_HOME/logs"
: > "$log"
offset=$(wc -c < "$log")
${markerJson()}
printf '[2026-11-15T00:00:01.000Z] restart complete (exit 0)\\n' >> "$log"
: > "$FAKE_RELAUNCHED"
exit 0
`,
  )
  const result = await cli(box, ['spv'], {
    env: {
      WHEELCHAIR_AGENT_LAUNCHER: launcher,
      FAKE_MARKER_PID: String(process.pid),
      FAKE_CHECKOUT: box.checkout,
      FAKE_RELAUNCHED: join(box.base, 'relaunched'),
      WHEELCHAIR_RESTART_NARRATE_MS: '3000',
    },
  })
  assert.equal(result.status, 0, output(result))
  const text = output(result)
  assert.match(
    text,
    /restart: the resumed SPV session did not start \(dsh-tui exited 3\); starting a fresh one\./,
  )
  assert.match(text, /fresh-started/)
  assert.deepEqual(
    await calls(box),
    ['call:', `call:--resume ${uuid}`, 'call:'],
    'the rejected resume is retried exactly once without the flag',
  )
}

/** The tmux fallback resumes the same conversation, and logs one note when it cannot. */
async function testTmuxFallbackResumes() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const uuid = '10b21e9f-7e77-40f3-9d1e-d2ee931f6ff6'
    const withResume = await makeBox()
    withResume.url = url
    await writeResume(withResume, `${uuid}\n`)
    const resumed = await cli(withResume, ['restart-all', '--run'], {
      env: { WHEELCHAIR_RESTART_CLAIM_MS: '100' },
    })
    assert.equal(resumed.status, 0, output(resumed))
    const resumedLaunch = (await calls(withResume)).find(line => line.startsWith('tmux new-session'))
    assert.ok(resumedLaunch !== undefined, 'the fallback launched tmux')
    assert.ok(
      resumedLaunch.includes(`spv --resume ${uuid}`),
      `the tmux fallback resumes the session:\n${resumedLaunch}`,
    )

    const fresh = await makeBox()
    fresh.url = url
    const freshRun = await cli(fresh, ['restart-all', '--run'], {
      env: { WHEELCHAIR_RESTART_CLAIM_MS: '100' },
    })
    assert.equal(freshRun.status, 0, output(freshRun))
    const freshLaunch = (await calls(fresh)).find(line => line.startsWith('tmux new-session'))
    assert.ok(freshLaunch !== undefined, 'the fallback launched tmux')
    assert.ok(!freshLaunch.includes('--resume'), 'no resume flag when the file is missing')
    const freshLog = (await logLines(fresh)).join('\n')
    assert.match(
      freshLog,
      /note: cannot resume the previous SPV session \(no ~\/\.dsh-tui\/resume\.txt\); the tmux fallback starts a fresh SPV session/,
    )
  })
}

/** The detached child's private seams must not reach the service it starts. */
async function testOrchestratorDoesNotLeakSeams() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const box = await makeBox()
    box.url = url
    const result = await cli(box, ['restart-all', '--run'], {
      env: {
        WHEELCHAIR_RESTART_CHAIN: box.chainPids.join(' '),
        WHEELCHAIR_RESTART_CLAIM_MS: '100',
      },
    })
    assert.equal(result.status, 0, output(result))
    assert.ok((await calls(box)).includes('wheelchair-agent service start'), 'the service was started')
    assert.equal(
      await exists(join(box.base, 'leaked-seams')),
      false,
      'the armed-chain env must not reach the service process',
    )
  })
}

/** The dry-run plan names the resume id and the tmux fallback for step 5. */
async function testDryRunPlanMentionsResume() {
  await withServer({ running: 0, queued: 0 }, async ({ url }) => {
    const uuid = '10b21e9f-7e77-40f3-9d1e-d2ee931f6ff6'
    const box = await makeBox()
    box.url = url
    await writeResume(box, `${uuid}\n`)
    const result = await cli(box, ['restart-all', '--dry-run'])
    assert.equal(result.status, 0, output(result))
    const text = output(result)
    assert.match(text, new RegExp(`resume: --resume ${uuid}`))
    assert.ok(
      text.includes(`${process.execPath} ${box.presetCli} spv --resume ${uuid}`),
      `the plan shows the resumed fallback launch:\n${text}`,
    )
    assert.match(text, /tmux new-session -d -s dsh-spv/)
    assert.deepEqual(await calls(box), [], 'a dry run still runs nothing')
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
  await test('a service-start failure exits 1 without relaunching the TUI', testServiceStartFailure)
  await test('the parent wait times out without running a command', testReparentWait)
  await test('the kill set excludes self/ancestors/service and an ancestor aborts first', testKillTargetsAndAncestorAbort)
  await test('an armed chain whose pid no longer carries the patch is refused before mutation', testStaleArmedChain)
  await test('the command module registers one honest /restart-wheelchair-agent', testCommandModule)
  await test('the detached child logs a re-guard refusal and runs nothing', testDetachedReguard)
  await test('--detach arms a child that logs restart complete', testDetach)
  await test('the spv loop narrates the log in order and relaunches in the same terminal', testSpvLoopNarratesAndRelaunches)
  await test('two marked restarts in one loop relaunch twice', testSpvTwoRestartsInOneLoop)
  await test('the launcher environment carries no CLI-private seams', testSpvLauncherEnvIsClean)
  await test('a marker with no pid fails after the short startup grace', testSpvNarratorNoPidGrace)
  await test('a failed install makes the narrator exit 1 and never relaunch', testSpvNarratorFailureNoRelaunch)
  await test('the narrator timeout prints the log and the by-hand recovery', testSpvNarratorTimeout)
  await test('a stale marker is cleared so a normal exit stays normal', testSpvStaleMarkerIgnored)
  await test('a normal launcher exit keeps the child status', testSpvNormalExitKeepsStatus)
  await test('the tmux fallback is already launched: print it and do not relaunch', testSpvFallbackAlreadyLaunched)
  await test('a failed tmux fallback exits 1 instead of printing success', testSpvFallbackFailureIsNotSuccess)
  await test('a dead orchestrator fails the narrator with the log path', testSpvNarratorDeathPath)
  await test('the orchestrator takes tmux only when the terminal does not claim', testOrchestratorClaimVsFallback)
  await test('a claim whose narrator died still takes the tmux fallback', testDeadClaimTakesFallback)
  await test('a claimed run needs no tmux', testClaimedRunWithoutTmux)
  await test('an unclaimed run without tmux fails with a logged reason', testUnclaimedRunWithoutTmuxFails)
  await test('a dry run ignores the armed chain/patch overrides and scans /proc', testDryRunIgnoresArmedOverrides)
  await test('the same-terminal relaunch resumes the recorded SPV session', testSpvRelaunchResumesSession)
  await test('a missing resume file prints one note and starts a fresh session', testSpvCannotResumeStartsFresh)
  await test('the relaunch drops stale operator session flags', testSpvRelaunchDropsStaleOperatorFlags)
  await test('a rejected resume is retried once without the flag', testSpvResumeRefusedRetriesFresh)
  await test('the tmux fallback resumes the same conversation, or logs one note', testTmuxFallbackResumes)
  await test('the detached seams do not leak into the service it starts', testOrchestratorDoesNotLeakSeams)
  await test('the dry-run plan names the resume id and the tmux fallback', testDryRunPlanMentionsResume)
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
