/**
 * superagent 服务是否真的在跑。
 *
 * 为什么需要这个检查：队列目录（`pending/`、`done/`、`outbox/`）由 superagent 的 `spv` Source 在**启动时**创建，
 * 但它在服务停止后**不会消失**。于是"队列目录存在"只能证明服务曾经跑过，不能证明现在有人在读 `pending/`。
 * 缺了这个检查，服务停着时 `spv_dispatch` 依然返回成功，任务在目录里躺着直到有人发现——用户会以为任务在跑。
 *
 * 判据不靠进程名：WSL2 下 node 的 `/proc/<pid>/comm` 是 `MainThread`，上游 `scripts/dsh-superagent` 正是因此失效。
 * 这里查的是健康端点本身——只有运行时真的在服务，它才会应答。
 */
import { request } from 'node:http'

/** 健康端点；与 superagent 面板同端口。 */
const HEALTH_PATH = '/orchestrator/api/state'

/** 单次探测的超时（毫秒）。本机回环，失败也应当立刻返回。 */
const PROBE_TIMEOUT = 2500

/** 部署地址：沿用 `dispatch` 的健康探测环境，兼容服务管理器的 `DSH_SUPERAGENT_URL`。 */
export function serviceBaseUrl(env = process.env) {
  const configured = String(env.SPV_SUPERAGENT_URL ?? env.DSH_SUPERAGENT_URL ?? '').trim()
  if (configured) return configured.replace(/\/+$/, '')
  const port = String(env.SPV_SUPERAGENT_PORT ?? '').trim() || '3082'
  return `http://127.0.0.1:${port}`
}

/**
 * The management headers the panel expects: same-origin Host plus the explicit opt-in header. The Host must be
 * the loopback address the deployment was registered with, not whatever a proxy would send.
 */
function stateHeaders(url) {
  let host
  try {
    host = new URL(url).host
  } catch {
    host = undefined
  }
  return {
    accept: 'application/json',
    'x-orchestrator-request': '1',
    ...(host === undefined ? {} : { host }),
  }
}

/**
 * 探测一次健康端点。
 *
 * 返回 `{ alive: true, statusCode, state }` 或 `{ alive: false, reason, url }`；`state` 是解析后的应答
 * body（不是 JSON 或读不到时为 null），`reason` 直接说清观察到了什么，供错误文案引用。
 * 不抛异常：调用方要的是"能不能派活"，不是"探测本身有没有出错"。
 */
export function probe(url = serviceBaseUrl()) {
  return new Promise(resolve => {
    let settled = false
    const settle = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = request(`${url}${HEALTH_PATH}`, { method: 'GET', timeout: PROBE_TIMEOUT, headers: stateHeaders(url) }, res => {
      // 任何 HTTP 应答都说明进程在监听。401 也算活着——它只是要求面板 token，不影响 Source 消费队列。
      let body = ''
      let bytes = 0
      res.setEncoding('utf8')
      res.on('data', chunk => {
        bytes += Buffer.byteLength(chunk, 'utf8')
        // The state document is small; never let a misbehaving instance grow this without bound.
        if (bytes <= 4 * 1024 * 1024) body += chunk
      })
      res.on('end', () => {
        let state = null
        try {
          state = body === '' ? null : JSON.parse(body)
        } catch {
          state = null
        }
        settle({ alive: true, statusCode: res.statusCode, state })
      })
      res.on('aborted', () => settle({ alive: true, statusCode: res.statusCode, state: null }))
      res.on('error', () => settle({ alive: true, statusCode: res.statusCode, state: null }))
    })
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', error => {
      const reason = error.code === 'ECONNREFUSED'
        ? `nothing is listening on ${url}`
        : error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN'
          ? `the host in ${url} cannot be resolved`
          : error.message === 'timeout'
            ? `${url} did not answer within ${PROBE_TIMEOUT}ms`
            : `probing ${url} failed: ${error.message}`
      settle({ alive: false, reason, url })
    })
    req.end()
  })
}

/**
 * Whether a reachable deployment can accept a task right now.
 *
 * `setup.problem`非空表示实例在跑但 paused（`repositoryUnset` 等），此时派单会写进一个没人消费的队列，
 * 所以必须拒绝。读不到状态、body 不是 JSON、或没有 `setup` 字段都属于 unknown：放行（fail open）——
 * 旧式队列没有注册部署，测试假实例也只回 `{}`；不能因为解析不出就谎报 paused。
 */
export async function deploymentState(url = serviceBaseUrl()) {
  const result = await probe(url)
  if (!result.alive) return { ...result, paused: false, problem: null }
  const setup = result.state !== null && typeof result.state === 'object' ? result.state.setup : null
  const problem =
    setup !== null && typeof setup === 'object' && typeof setup.problem === 'string' ? setup.problem.trim() : ''
  return { ...result, paused: problem !== '', problem: problem === '' ? null : problem }
}

/**
 * Ask the running service which Tickets are still open. `work gc` uses this to keep a live ticket's clone even when
 * its worker has no process cwd inside it between tool calls.
 *
 * Never throws: the caller must distinguish "nothing is listening" (nothing can be working, so reclamation may
 * proceed) from every other outcome (malformed body, unexpected shape, HTTP error, timeout), which must keep
 * everything. The management route trusts only a same-origin request carrying `x-orchestrator-request: 1`.
 */
export function fetchOpenTickets(url = serviceBaseUrl(), timeout = PROBE_TIMEOUT) {
  const target = `${url}/orchestrator/api/tickets?state=open`
  return new Promise(resolve => {
    let settled = false
    let timer
    const settle = value => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    let req
    try {
      req = request(target, {
        method: 'GET',
        timeout,
        headers: { 'x-orchestrator-request': '1' },
      })
    } catch (error) {
      settle({ error: `cannot request ${target}: ${error.message}` })
      return
    }
    // A socket timeout only fires while the socket is alive; this deadline also covers a body that aborts mid-stream.
    timer = setTimeout(() => {
      req.destroy(new Error(`no answer within ${timeout}ms`))
      settle({ error: `requesting ${target} failed: no answer within ${timeout}ms` })
    }, timeout + 50)
    timer.unref?.()
    req.on('response', res => {
      let body = ''
      let bytes = 0
      res.setEncoding('utf8')
      res.on('data', chunk => {
        body += chunk
        bytes += Buffer.byteLength(chunk, 'utf8')
        if (bytes > 4 * 1024 * 1024) {
          req.destroy(new Error('response too large'))
          settle({ error: 'the service response exceeded 4 MiB' })
        }
      })
      res.on('aborted', () => settle({ error: 'the service aborted the response' }))
      res.on('error', error => settle({ error: `reading the service response failed: ${error.message}` }))
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          settle({ error: `the service answered HTTP ${res.statusCode}` })
          return
        }
        let value
        try {
          value = JSON.parse(body)
        } catch {
          settle({ error: 'the service answered with invalid JSON' })
          return
        }
        if (!value || !Array.isArray(value.items)) {
          settle({ error: 'the response has no items list' })
          return
        }
        settle({ tickets: value.items })
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error(`no answer within ${timeout}ms`))
      settle({ error: `requesting ${target} failed: no answer within ${timeout}ms` })
    })
    req.on('error', error => {
      if (error.code === 'ECONNREFUSED') settle({ down: true, reason: `nothing is listening on ${url}` })
      else settle({ error: `requesting ${target} failed: ${error.message}` })
    })
    // A reset before/while responding can emit only 'close'; never leave the promise unsettled.
    req.on('close', () => {
      if (!settled) settle({ error: `the connection closed before ${target} answered` })
    })
    req.end()
  })
}

/**
 * 服务没在跑时的错误：说清缺什么、为什么这件事必须挡住、以及能照抄的命令。
 *
 * 刻意**不**返回成功——把任务写进一个没人读的目录，比直接报错糟得多：用户会以为活已经在干了。
 */
export function serviceDown(result) {
  const where = result.url ?? serviceBaseUrl()
  return new Error(
    `the superagent service is not running (${result.reason}), so nothing would read the task you are about to ` +
      'dispatch. Its spv queue directory survives a stop, which is why this is checked against the health ' +
      `endpoint and not against the directory. Start it with "wheelchair-agent service start", run ` +
      `"wheelchair-agent service status" until it reports runtime ready at ${where}, then dispatch again. ` +
      'This repo wraps the upstream launcher at `~/opt/dsh-plugins/dsh-superagent/scripts/dsh-superagent`: ' +
      'upstream process detection uses `ps -o ucomm=`, which reports `MainThread` instead of `node` for a ' +
      'Node process on WSL2, so it sees no process and `restart` refuses while claiming the service already ' +
      'answers. `commands/superagent-service.py` keeps the upstream semantics (same exit codes, same tmux ' +
      'session, graceful SIGINT) but finds the process through the listening socket and `/proc/<pid>/cmdline`.',
  )
}
