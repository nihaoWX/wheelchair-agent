/**
 * SPV agent 侧的工具从哪个目录读写文件队列。
 *
 * 队列是本包 `spv_*` 工具（SPV agent preset）与 superagent 侧（`src/superagent/spv.js`、`src/superagent/watch.js`）
 * 之间**唯一**的接口，两侧必须指同一个目录，所以这里的规则与 `src/superagent/spv.js` 刻意保持一致：
 *
 *   <stateDir>/spv          stateDir = $DSH_SUPERAGENT_STATE_DIR，缺省 ~/.dsh/state/superagent
 *
 * `$SPV_QUEUE_DIR` 与插件自身的 `queueDir` 设置可覆盖它。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 未指定时 superagent 部署的状态目录。 */
export const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'state', 'superagent')

/** SPV 工具读写的队列根目录（绝对路径）。 */
export function resolveRoot(config = {}) {
  const configured = String(config.queueDir ?? '').trim()
  if (configured) return configured
  const fromEnv = String(process.env.SPV_QUEUE_DIR ?? '').trim()
  if (fromEnv) return fromEnv
  const stateDir = String(process.env.DSH_SUPERAGENT_STATE_DIR ?? '').trim() || DEFAULT_STATE_DIR
  return join(stateDir, 'spv')
}

/**
 * 队列不存在时的错误：说清缺什么、为什么、以及能照抄的命令。
 * `pending/`、`done/`、`outbox/` 归 superagent 的 `spv` Source 所有，这里**不**代为创建——没有服务的空队列只会
 * 把任务悄悄吞掉。
 */
export function missingQueue(root) {
  return new Error(
    `no spv queue at ${root}: the superagent spv Source creates pending/, done/ and outbox/ when it starts, ` +
      'and until then a dispatched task would have nobody to read it. Start it with ' +
      '"wheelchair-agent service start", run "wheelchair-agent service status" until it reports runtime ' +
      'ready, confirm the superagent profile enables the spv Source, then call this tool again.',
  )
}
