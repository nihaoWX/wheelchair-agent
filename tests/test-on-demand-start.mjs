#!/usr/bin/env node
/**
 * tests/test-on-demand-start.mjs — 派活时按需拉起目标部署，且 `spv` 一个 backend 都不起。
 *
 * `spv` 曾经在进入会话前逐个 `service start` 所有注册部署；现在只打一行说明。真正的启动移到 dispatch
 * 路径，并且必须在写 `pending/<id>.json` **之前**完成：停止的队列没有读者，先写会让一次失败的派活
 * 看起来成功（本测试用假 manager 检查「start 时 pending 必须为空」，再断言之后恰好一份任务）。
 *
 * 实例已启动但 paused（manager 输出 `setup: waiting` 或 state 的 `setup.problem`）不是启动失败：错误要
 * 准确说明 paused 并指向 `deployment setup`，同样不写 pending。已在跑的实例也要先读 `setup.problem`——
 * 第二次 dispatch 不能因为实例活着就放行。
 *
 * 全程沙箱：HOME/DSH_HOME/WHEELCHAIR_AGENT_HOME 都在 mkdtemp 下；假 `python3` 记录 manager argv，并用
 * 一个后台 node HTTP 服务冒充实例的健康检查端点。不碰真实端口、真实服务或 `~/.wheelchair-agent`。
 *
 * 用法：node tests/test-on-demand-start.mjs（任一断言失败则 exit 1）
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const CLI = fileURLToPath(new URL('../bin/wheelchair-agent.mjs', import.meta.url))
const SANDBOXES = []
const SERVER_PIDS = []

async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'wheelchair-agent-on-demand-test-'))
  SANDBOXES.push(base)
  const box = {
    base,
    home: join(base, 'home'),
    dsh: join(base, 'dsh'),
    data: join(base, 'data'),
    state: join(base, 'state'),
    queue: join(base, 'state', 'spv'),
    bin: join(base, 'bin'),
    log: join(base, 'service-argv.log'),
    swallowed: join(base, 'queue-was-not-empty-at-start'),
    serverPid: join(base, 'server.pid'),
  }
  await mkdir(box.bin, { recursive: true })
  await mkdir(box.home, { recursive: true })
  await mkdir(box.dsh, { recursive: true })
  await mkdir(box.data, { recursive: true })
  await writeManager(box)
  return box
}

/**
 * 假 service manager：记录 argv；`start` 时若队列里已有 pending 文件就留下一个证据文件，然后用一个后台
 * node 服务冒充实例。`FAKE_SERVICE_START_STATUS` 让 start 失败，`FAKE_SERVICE_START_SERVER=0` 让失败的
 * start 不留下实例，`FAKE_SERVICE_START_OUTPUT` 让 start 打印管理器输出（paused 等分类靠它）。
 */
async function writeManager(box) {
  const file = join(box.bin, 'python3')
  await writeFile(
    file,
    `#!/bin/sh
action=$2
queue=''
port=''
prev=''
for arg in "$@"; do
  case "$prev" in
    --queue-dir) queue=$arg ;;
    --port) port=$arg ;;
  esac
  prev=$arg
done
printf '%s\\n' "$*" >> "$FAKE_SERVICE_LOG"
if [ "$action" = start ]; then
  if [ -n "$(ls -A "$queue/pending" 2>/dev/null)" ]; then : > "$FAKE_SWALLOWED"; fi
  if [ "\${FAKE_SERVICE_START_SERVER:-1}" = 1 ]; then
    node -e "require('http').createServer((q,s)=>{s.statusCode=200;s.end('{}')}).listen($port,'127.0.0.1')" >/dev/null 2>&1 &
    printf '%s\\n' "$!" > "$FAKE_SERVICE_PID"
    # 真 manager 的 start 会等到实例能答健康检查才返回（paused 也算 ready）；假 manager 照做，避免把
    # 「实例刚起还没监听」误当成启动失败。
    node -e "const p=$port;let n=0;(function w(){require('http').get({host:'127.0.0.1',port:p,timeout:100},r=>{r.resume();process.exit(0)}).on('error',()=>{if(++n>200)process.exit(1);setTimeout(w,5)})})()" >/dev/null 2>&1
  fi
  if [ -n "\${FAKE_SERVICE_START_OUTPUT:-}" ]; then printf '%s\\n' "$FAKE_SERVICE_START_OUTPUT"; fi
  if [ "\${FAKE_SERVICE_START_STATUS:-0}" != 0 ]; then exit "\${FAKE_SERVICE_START_STATUS}"; fi
fi
exit 0
`,
  )
  await chmod(file, 0o755)
}

function envFor(box, extra = {}) {
  const env = { ...process.env }
  for (const key of [
    'SPV_QUEUE_DIR',
    'SPV_SUPERAGENT_URL',
    'SPV_SUPERAGENT_PORT',
    'DSH_SUPERAGENT_PORT',
    'SPV_SERVICE_PORT',
    'SPV_INBOX_DIR',
    'SPV_PROJECTS_ROOT',
  ]) delete env[key]
  return {
    ...env,
    HOME: box.home,
    DSH_HOME: box.dsh,
    WHEELCHAIR_AGENT_HOME: box.data,
    DSH_SUPERAGENT_STATE_DIR: box.state,
    PATH: `${box.bin}:${process.env.PATH}`,
    FAKE_SERVICE_LOG: box.log,
    FAKE_SWALLOWED: box.swallowed,
    FAKE_SERVICE_PID: box.serverPid,
    ...extra,
  }
}

async function cli(box, argv, extra = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...argv], {
      env: envFor(box, extra),
      encoding: 'utf8',
      cwd: box.base,
      timeout: 120_000,
    })
    return { status: 0, stdout, stderr }
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }
  }
}

async function serviceCalls(box) {
  try {
    return (await readFile(box.log, 'utf8')).trim().split('\n').filter(Boolean)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function pendingFiles(box) {
  try {
    return (await readdir(join(box.queue, 'pending'))).filter(name => name.endsWith('.json') && !name.startsWith('.'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function freePort() {
  const server = createServer()
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}

/** Serve one fixed `/orchestrator/api/state` body on the deployment port for the duration of `fn`. */
async function withStateServer(port, body, fn) {
  const server = createServer((_request, response) => {
    response.statusCode = 200
    response.setHeader('content-type', body.startsWith('{') ? 'application/json' : 'text/plain')
    response.end(body)
  })
  await new Promise(done => server.listen(port, '127.0.0.1', done))
  try {
    await fn()
  } finally {
    await new Promise(done => server.close(done))
  }
}

/** 注册一份部署；overlay 由 `deployment add` 渲染，manager 参数才完整。 */
function addDeployment(box, project, port) {
  execFileSync(
    process.execPath,
    [CLI, 'deployment', 'add', project, '--repo', 'test/alpha', '--state-dir', box.state, '--queue-dir', box.queue, '--port', String(port)],
    { env: envFor(box), encoding: 'utf8', cwd: box.base },
  )
}

async function stopServer(box) {
  try {
    const pid = Number((await readFile(box.serverPid, 'utf8')).trim())
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, 'SIGKILL')
      SERVER_PIDS.push(pid)
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
  }
}

// ------------------------------------------------------------ dispatch 的三条顺序约束

async function testDispatchStartsBeforeWriting() {
  const box = await sandbox()
  const port = await freePort()
  addDeployment(box, 'tools/alpha', port)
  try {
    const sent = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'add a test and run it'])
    assert.equal(sent.status, 0, sent.stderr)
    assert.match(sent.stdout, /dispatched [0-9a-f]+ on thread "main" for project tools\/alpha/)

    const calls = await serviceCalls(box)
    assert.equal(calls.length, 1, `exactly one on-demand start, got:\n${calls.join('\n')}`)
    assert.match(calls[0], /commands\/superagent-service\.py start --profile superagent --patch .*alpha.*\.yml/)
    assert.ok(calls[0].includes(`--queue-dir ${box.queue}`), `the start names the deployment queue: ${calls[0]}`)
    assert.equal(await exists(box.swallowed), false, 'the task was not queued before the instance started')

    const names = await pendingFiles(box)
    assert.equal(names.length, 1, `the task landed after the start: ${names.join(', ') || 'none'}`)
    const record = JSON.parse(await readFile(join(box.queue, 'pending', names[0]), 'utf8'))
    assert.equal(record.project, 'tools/alpha')
    assert.equal(record.text, 'add a test and run it')
  } finally {
    await stopServer(box)
  }
}

async function testFailedStartWritesNothing() {
  const box = await sandbox()
  const port = await freePort()
  addDeployment(box, 'tools/alpha', port)
  const sent = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'never lands'], {
    FAKE_SERVICE_START_STATUS: '1',
    FAKE_SERVICE_START_SERVER: '0',
  })
  assert.equal(sent.status, 1)
  assert.match(sent.stderr, /could not start the deployment instance for "tools\/alpha"/)
  assert.match(sent.stderr, /wheelchair-agent service status/)
  const calls = await serviceCalls(box)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/commands\/superagent-service\.py start /)
  assert.deepEqual(await pendingFiles(box), [], 'a failed start must not leave a task behind')
}

async function testPausedStartPointsAtDeploymentSetup() {
  const box = await sandbox()
  const port = await freePort()
  addDeployment(box, 'tools/alpha', port)
  try {
    const sent = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'never lands'], {
      FAKE_SERVICE_START_STATUS: '3',
      FAKE_SERVICE_START_SERVER: '1',
      FAKE_SERVICE_START_OUTPUT: 'setup:   waiting — repositoryUnset: tools/alpha has no GitHub repository',
    })
    assert.equal(sent.status, 1)
    assert.match(sent.stderr, /started but is paused/)
    assert.match(sent.stderr, /wheelchair-agent deployment setup --project tools\/alpha/)
    assert.doesNotMatch(sent.stderr, /could not start/)
    assert.deepEqual(await pendingFiles(box), [], 'a paused start must not leave a task behind')
  } finally {
    await stopServer(box)
  }
}

async function testReportedExitWithRunningInstance() {
  const box = await sandbox()
  const port = await freePort()
  addDeployment(box, 'tools/alpha', port)
  try {
    const sent = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'never lands'], {
      FAKE_SERVICE_START_STATUS: '3',
      FAKE_SERVICE_START_SERVER: '1',
      FAKE_SERVICE_START_OUTPUT: 'relay: ready | spv: paused | setup: ready',
    })
    assert.equal(sent.status, 1)
    assert.match(sent.stderr, /manager reported exit 3/)
    assert.doesNotMatch(sent.stderr, /could not start/)
    assert.deepEqual(await pendingFiles(box), [], 'a reported non-zero exit must not leave a task behind')
  } finally {
    await stopServer(box)
  }
}

async function testRunningDeploymentIsNotStartedAgain() {
  const box = await sandbox()
  const port = await freePort()
  addDeployment(box, 'tools/alpha', port)
  const server = createServer((_request, response) => {
    response.statusCode = 200
    response.end('{"ok":true}')
  })
  await new Promise(done => server.listen(port, '127.0.0.1', done))
  try {
    const sent = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'the instance is already up'])
    assert.equal(sent.status, 0, sent.stderr)
    assert.deepEqual(await serviceCalls(box), [], 'an already running instance is not started again')
    assert.equal((await pendingFiles(box)).length, 1)
  } finally {
    await new Promise(done => server.close(done))
  }
}

async function testRunningPausedDeploymentIsRejected() {
  const box = await sandbox()
  const port = await freePort()
  addDeployment(box, 'tools/alpha', port)
  await withStateServer(port, '{"setup":{"problem":"repositoryUnset: tools/alpha has no GitHub repository"}}', async () => {
    const sent = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', 'must not land'])
    assert.equal(sent.status, 1)
    assert.match(sent.stderr, /is paused/)
    assert.doesNotMatch(sent.stderr, /started but is paused/)
    assert.match(sent.stderr, /deployment setup --project tools\/alpha/)
    assert.doesNotMatch(sent.stderr, /could not start/)
    assert.deepEqual(await pendingFiles(box), [], 'a paused deployment must not get a task')
    assert.deepEqual(await serviceCalls(box), [], 'an already paused deployment is not started')
  })
}

async function testUnreadableDeploymentStateFailsOpen() {
  for (const [label, body] of [
    ['empty object', '{}'],
    ['null problem', '{"setup":{"problem":null}}'],
    ['non-JSON', 'not json'],
  ]) {
    const box = await sandbox()
    const port = await freePort()
    addDeployment(box, 'tools/alpha', port)
    await withStateServer(port, body, async () => {
      const sent = await cli(box, ['dispatch', '--project', 'tools/alpha', '--task', `task (${label})`])
      assert.equal(sent.status, 0, `${label}: ${sent.stderr}`)
      assert.deepEqual(await serviceCalls(box), [], `${label}: a running instance is not started again`)
      assert.equal((await pendingFiles(box)).length, 1, `${label}: the task is queued`)
    })
  }
}

// ------------------------------------------------------------ spv 不再起任何 backend

async function testSpvStartsNoBackend() {
  const box = await sandbox()
  addDeployment(box, 'tools/alpha', await freePort())
  const launcher = join(box.base, 'fake-launcher.sh')
  await writeFile(
    launcher,
    '#!/bin/sh\nprintf "ARGV=%s\\n" "$*" > "$FAKE_LAUNCHER_ENV"\nexit 0\n',
  )
  await chmod(launcher, 0o755)
  const recorded = join(box.base, 'launcher.txt')
  const run = await cli(box, ['spv'], {
    WHEELCHAIR_AGENT_LAUNCHER: launcher,
    FAKE_LAUNCHER_ENV: recorded,
  })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  const notes = run.stdout.split('\n').filter(line => line.startsWith('note: backends start on demand:'))
  assert.equal(notes.length, 1, `exactly one on-demand note, got:\n${run.stdout}`)
  assert.deepEqual(await serviceCalls(box), [], 'spv must not invoke the service manager')
  assert.match(await readFile(recorded, 'utf8'), /^ARGV=$/m)
}

// ------------------------------------------------------------ spv 不再起任何 backend

async function main() {
  try {
    await testDispatchStartsBeforeWriting()
    await testFailedStartWritesNothing()
    await testPausedStartPointsAtDeploymentSetup()
    await testReportedExitWithRunningInstance()
    await testRunningDeploymentIsNotStartedAgain()
    await testRunningPausedDeploymentIsRejected()
    await testUnreadableDeploymentStateFailsOpen()
    await testSpvStartsNoBackend()
    process.stdout.write('ok (8 passed)\n')
  } finally {
    for (const pid of SERVER_PIDS) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    for (const base of SANDBOXES) await rm(base, { recursive: true, force: true })
  }
}

await main()
