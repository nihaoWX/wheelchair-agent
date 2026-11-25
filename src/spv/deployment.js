#!/usr/bin/env node
/**
 * `wheelchair-agent deployment`：查看、登记、删除项目 → 部署的对应关系。
 *
 * 注册表（`~/.wheelchair-agent/deployments.json`，见 `src/shared/deployments.js`）是「哪个项目归哪份部署」的
 * 唯一真相；`dispatch`、`spv_dispatch` 都按它把任务写进对应部署的队列。本子命令维护注册表、分配端口并渲染
 * 每部署的实例 overlay（`<data root>/deployments/<slug>.yml`），但**不**安装 profile、不启停服务：
 * `deployment add` 之后用 `wheelchair-agent service start --project <p>` 显式启动那一份。
 *
 * 退出码约定与其他子命令一致：参数错误（未知选项、缺项目、端口非法）用 `.code = 'DEPLOYMENT_USAGE'`，
 * 由 `bin/wheelchair-agent.mjs` 转成 exit 2；注册表内容/IO 错误是普通 Error，exit 1。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DEFAULT_PROFILE,
  allocatePort,
  deploymentSlug,
  installedShaOf,
  listDeployments,
  removeDeployment,
  repositoryFromRemote,
  upsertDeployment,
  writeInstance,
} from '../shared/deployments.js'
import { resolveLegacyStateDir } from '../shared/home.js'
import { checkProject } from './dispatch.js'
import { setupDeployment } from './deployment-setup.js'

/** `deployment --help` 与参数错误的固定文案；命令本身不解释单个部署怎么安装。 */
export const DEPLOYMENT_USAGE = `usage: wheelchair-agent deployment <list|add|remove|migrate|setup> [options]

The registry (~/.wheelchair-agent/deployments.json, moved by WHEELCHAIR_AGENT_HOME) maps a project
to the deployment that reads its tasks. It is the only source of truth: dispatch writes into the
queue of the project's own deployment and never into another deployment's queue.

commands:
  list [--json]
                               show every registered deployment
  add <project> [--profile <id>] [--state-dir <dir>] [--queue-dir <dir>]
      [--port <n>] [--installed-sha <sha>] [--repo <owner/name>]
                               record a deployment and render its instance overlay;
                               defaults: stateDir <base>/<slug>, queueDir <stateDir>/spv,
                               port = first unused from 3082, repo inferred from the
                               project checkout's origin (or pass --repo)
  setup --project <p>          point that deployment's own dsh-superagent instance at the
                               repository recorded here, through its panel API; run it after
                               "service start --project <p>" (setup waits up to 90s)
  remove <project> [--force]   delete one deployment record (the deployment itself is not stopped);
                               removing the last one needs --force and prints a warning
  migrate                      adopt this machine's existing single deployment as tools/wheelchair-agent

A deployment is never created automatically: "add" records it and renders
<data root>/deployments/<slug>.yml; starting its service is the explicit next step
("wheelchair-agent service start --project <p>"). Every deployment must read <stateDir>/spv:
its wheelchair-spv Source resolves the queue from that instance's own stateDir/settings, so a
different registry value would dispatch into a queue the deployment never reads.
Run "wheelchair-agent --help" for the commands that use the registry.`

/** 参数错误：保持模块不依赖 bin 的 UsageError，由调用方按 code 转换。 */
function usageError(message) {
  const error = new Error(message)
  error.code = 'DEPLOYMENT_USAGE'
  return error
}

/** 手写解析：位置参数 + 取值选项 + 布尔开关；重复、未知、缺值都立即报错。 */
function parse(argv, { values = {}, booleans = [] } = {}) {
  const positionals = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]
    if (word === '--help' || word === '-h') return { help: true, positionals, flags }
    if (booleans.includes(word)) {
      if (flags[word] !== undefined) throw usageError(`${word} was already given`)
      flags[word] = true
      continue
    }
    const name = values[word]
    if (name === undefined) {
      if (word.startsWith('-')) throw usageError(`unknown option ${JSON.stringify(word)} for "deployment"`)
      positionals.push(word)
      continue
    }
    if (flags[word] !== undefined) throw usageError(`${word} was already given`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw usageError(`${word} needs a value`)
    flags[word] = value
    index += 1
  }
  return { help: false, positionals, flags }
}

/** 端口：显式整数 1-65535；null 表示 stage 1 还没有分配。 */
function parsePort(value) {
  if (value === undefined) return null
  const port = Number(value)
  if (!/^[0-9]+$/.test(String(value).trim()) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw usageError(`--port must be a whole number between 1 and 65535, got ${JSON.stringify(value)}`)
  }
  return port
}

/** 严格的位置参数个数：少给时给出可照抄的示例，多给时拒绝猜测。 */
function exactlyOne(positionals, example) {
  if (positionals.length === 0) throw usageError(`this command needs a project, e.g. ${example}`)
  if (positionals.length > 1) {
    throw usageError(`expected one project, got ${positionals.length} (${positionals.map(item => JSON.stringify(item)).join(', ')})`)
  }
  return positionals[0]
}

function noPositionals(positionals, command) {
  if (positionals.length > 0) {
    throw usageError(`"deployment ${command}" takes no project, got ${JSON.stringify(positionals[0])}`)
  }
}

/** 一条部署的稳定单行形式；null 打印成 `-`，方便脚本用空格切分。 */
function describe(entry) {
  return `project ${entry.project} profile=${entry.profile} stateDir=${entry.stateDir} ` +
    `queueDir=${entry.queueDir} port=${entry.port ?? '-'} installedSha=${entry.installedSha ?? '-'} ` +
    `repository=${entry.repository ?? '-'}`
}

function sameRepository(left, right) {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
}

/** 项目 checkout 的根：与 `prepare`/watcher 看的是同一层（`$SPV_PROJECTS_ROOT` 或 ~/bioagentforge）。 */
function projectsRoot(env) {
  return String(env.SPV_PROJECTS_ROOT ?? '').trim() || join(homedir(), 'bioagentforge')
}

/**
 * 从 `<projectsRoot>/<project>` 的 `remote.origin.url` 反推 `owner/name`。
 *
 * 这正是这份部署 clone 代码的那个仓库，所以 `deployment add` 不要求操作者再手抄一遍。没有 checkout、
 * 没有 origin、或 origin 不是 GitHub 时都报错并写出它读到的内容，要求显式 `--repo`；不猜。
 */
function repositoryOfCheckout(project, env) {
  const checkout = join(projectsRoot(env), project)
  if (!existsSync(checkout)) {
    throw new Error(
      `cannot infer the GitHub repository for ${JSON.stringify(project)}: ${checkout} does not exist. ` +
        'Register the deployment with an explicit --repo <owner/name>, or check $SPV_PROJECTS_ROOT.',
    )
  }
  let remote = ''
  try {
    remote = execFileSync('git', ['-C', checkout, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim()
    throw new Error(
      `cannot infer the GitHub repository for ${JSON.stringify(project)}: "git -C ${checkout} config --get ` +
        `remote.origin.url" failed${detail === '' ? '' : ` (${detail})`}. Pass --repo <owner/name>.`,
    )
  }
  const repository = repositoryFromRemote(remote)
  if (repository === null) {
    throw new Error(
      `cannot infer the GitHub repository for ${JSON.stringify(project)}: its origin is ${JSON.stringify(remote)}, ` +
        'which is not a GitHub repository. Pass --repo <owner/name>.',
    )
  }
  return repository
}

/**
 * 单部署时代的基准状态目录（`$DSH_SUPERAGENT_STATE_DIR` → `$DSH_HOME/state/superagent`）。
 * `migrate` 把它当成已有部署的 stateDir；`add` 在它下面按实例名分目录，两个部署的会话/工单互不可见。
 */
function baseStateDir(env) {
  return resolveLegacyStateDir({ env })
}

/** 新部署的状态目录：`<base>/<slug>`。 */
function deploymentStateDir(project, env) {
  return join(baseStateDir(env), deploymentSlug(project))
}

/** migrate 写的端口：与 service/restart 的解析顺序一致，避免把 3082 记错。 */
function defaultPort(env) {
  for (const name of ['DSH_SUPERAGENT_PORT', 'SPV_SUPERAGENT_PORT', 'SPV_SERVICE_PORT']) {
    const value = String(env[name] ?? '').trim()
    if (value !== '') return parsePort(value)
  }
  return 3082
}

/** `deployment list`。注册表缺失/为空都不是错误：两种状态都只打印指路文案（注册表是唯一来源）。 */
function list({ env, json, out }) {
  const registry = listDeployments({ env })
  if (!registry.exists) {
    if (json) {
      out.write(`${JSON.stringify({ version: registry.version, registry: registry.file, deployments: [] }, null, 2)}\n`)
      return 0
    }
    out.write(`registry: ${registry.file}\n`)
    out.write(
      'no deployments recorded yet: the registry is the only source, so nothing can read a queue and no ' +
        'service can start. Adopt an old single-deployment install with "wheelchair-agent deployment ' +
        'migrate", or register a project with "wheelchair-agent deployment add tools/<name>" (a fresh install ' +
        'does this with "bash install.sh --project tools/<name>").\n',
    )
    return 0
  }
  if (json) {
    out.write(`${JSON.stringify({ version: registry.version, registry: registry.file, deployments: registry.deployments }, null, 2)}\n`)
    return 0
  }
  out.write(`registry: ${registry.file}\n`)
  if (registry.deployments.length === 0) {
    out.write(
      'no deployments recorded: the registry is the only source. Adopt an old install with ' +
        '"wheelchair-agent deployment migrate", or register a project with "wheelchair-agent deployment add ' +
        'tools/<name>" (a fresh install does this with "bash install.sh --project tools/<name>").\n',
    )
    return 0
  }
  for (const entry of registry.deployments) out.write(`${describe(entry)}\n`)
  return 0
}

/** `deployment add`：写注册表并渲染实例 overlay；完全相同的条目是成功的空操作。 */
function add(positionals, flags, { env, out }) {
  const project = checkProject(exactlyOne(positionals, 'tools/<name>'))
  const registry = listDeployments({ env })
  const existing = registry.deployments.find(entry => entry.project === project)
  const stateDir = String(flags['--state-dir'] ?? '').trim() || existing?.stateDir || deploymentStateDir(project, env)
  const expectedQueue = join(stateDir, 'spv')
  const requestedQueue = String(flags['--queue-dir'] ?? '').trim()
  if (requestedQueue !== '' && resolve(requestedQueue) !== expectedQueue) {
    throw usageError(
      `--queue-dir ${JSON.stringify(requestedQueue)} is not ${JSON.stringify(expectedQueue)}: a deployment reads ` +
        '<stateDir>/spv (its wheelchair-spv Source resolves the queue from that instance\'s own stateDir/settings), ' +
        'so a different value would dispatch into a queue the deployment never reads. Use ' +
        `${JSON.stringify(expectedQueue)}.`,
    )
  }
  const explicitPort = parsePort(flags['--port'])
  if (explicitPort !== null) {
    const owner = registry.deployments.find(entry => entry.project !== project && entry.port === explicitPort)
    if (owner !== undefined) {
      throw usageError(
        `--port ${explicitPort} is already registered for ${owner.project}; every deployment needs its own port. ` +
          'Pick another one, or remove that deployment first.',
      )
    }
  }
  const port = explicitPort ?? existing?.port ?? allocatePort(registry.deployments)
  const explicitRepository = String(flags['--repo'] ?? '').trim()
  let repository
  if (explicitRepository !== '') {
    repository = explicitRepository
  } else if (existing?.repository) {
    repository = existing.repository
  } else {
    try {
      repository = repositoryOfCheckout(project, env)
    } catch (error) {
      // 老注册表（版本 1，没有 repository）里的条目再 add 一次时，checkout 可能不在这台机器上：
      // 保留已有的 null，而不是让一次空操作失败。新部署仍然必须能推出仓库或显式给 --repo。
      if (existing === undefined) throw error
      repository = null
    }
  }
  if (existing?.repository && !sameRepository(existing.repository, repository)) {
    throw new Error(
      `deployment ${JSON.stringify(project)} already targets ${existing.repository}; refusing to change it to ` +
        `${repository} in place. Stop its service, remove it with "wheelchair-agent deployment remove ${project}", ` +
        `then add it again with --repo ${repository} (and --port ${port}).`,
    )
  }
  const result = upsertDeployment(
    {
      project,
      profile: String(flags['--profile'] ?? '').trim() || existing?.profile ||
        String(env.DSH_SUPERAGENT_PROFILE ?? '').trim() || DEFAULT_PROFILE,
      stateDir,
      queueDir: expectedQueue,
      port,
      installedSha: String(flags['--installed-sha'] ?? '').trim() || existing?.installedSha || '',
      repository,
    },
    { env },
  )
  const instance = writeInstance(result.entry, { env })
  if (result.created) {
    out.write(`registered ${describe(result.entry)}\n`)
  } else if (result.changed.length === 0) {
    out.write(`${project} is already registered with these values; nothing changed\n`)
  } else {
    const changes = result.changed
      .map(field => `${field} ${result.before[field] ?? '-'} -> ${result.entry[field] ?? '-'}`)
      .join(', ')
    out.write(`updated ${project}: ${changes}\n`)
  }
  if (instance.created) {
    out.write(`instance ${instance.file}\n`)
  } else {
    out.write(`instance ${instance.file} already exists; left unchanged\n`)
    if (result.changed.length > 0) {
      out.write(`note: the registry changed, but the existing instance file was not rewritten; remove it and rerun "deployment add" to render the new values\n`)
    }
  }
  return 0
}

/**
 * `deployment remove`：先打印将要删掉的那一条，再改写文件；只影响注册表，不停止部署。
 *
 * 删最后一条会让这台机器没有任何可用部署（`service`/`spv`/`restart-all` 都需要注册表），所以必须
 * `--force`，并且先把后果写出来。
 */
function remove(positionals, flags, { env, out }) {
  const project = checkProject(exactlyOne(positionals, 'tools/<name>'))
  const registry = listDeployments({ env })
  const entry = registry.deployments.find(item => item.project === project)
  if (entry === undefined) {
    if (!registry.exists) {
      throw new Error(
        `no deployment for ${JSON.stringify(project)}: ${registry.file} does not exist yet. Nothing to remove; ` +
          'run "wheelchair-agent deployment list" to see the registry.',
      )
    }
    throw new Error(
      `no deployment for ${JSON.stringify(project)} in ${registry.file}. Run "wheelchair-agent deployment list" ` +
        'to see the registered projects.',
    )
  }
  if (registry.deployments.length === 1) {
    if (flags['--force'] !== true) {
      throw new Error(
        `refusing to remove the last deployment ${JSON.stringify(project)}: this machine would have no usable ` +
          'deployment, so "wheelchair-agent service", "spv" and "restart-all" would all fail until one is ' +
          'registered again. Re-run with --force to remove it anyway.',
      )
    }
    out.write(
      'warning: removing the last deployment; this machine will have no usable deployment until ' +
        '"wheelchair-agent deployment add <project>" (or migrate) registers one again\n',
    )
  }
  // 先给人看一眼要删的是哪一条（与 list 同样的一行），再动文件。
  out.write(`${describe(entry)}\n`)
  const result = removeDeployment(project, { env })
  out.write(
    `removed ${project}; the deployment itself (profile, service, port) is untouched; it still reads its own queue. ` +
      `${result.remaining} deployment(s) remain in ${result.file}.\n`,
  )
  return 0
}

/**
 * `deployment migrate`：认领一台旧安装，把单部署时代的现状写成第一条条目。
 *
 * 只有在注册表不存在或为空时才写；已有条目时是幂等空操作，绝不重新覆盖操作者维护的值。项目名就是
 * `tools/wheelchair-agent`（`ARCHITECTURE/deployments.md`）；profile/stateDir/queue 从当前环境解析（即旧规则
 * 的基 stateDir 与 `<stateDir>/spv`），端口取 service 的解析顺序。注册表是唯一部署来源之后，本命令是旧安装
 * 进入分部署模式的唯一入口。
 */
function migrate(positionals, { env, out }) {
  noPositionals(positionals, 'migrate')
  const registry = listDeployments({ env })
  if (registry.exists && registry.deployments.length > 0) {
    out.write(
      `deployments are already recorded in ${registry.file} (${registry.deployments.length}); nothing changed\n`,
    )
    return 0
  }
  const stateDir = baseStateDir(env)
  // 注册表里的 queueDir 必须是 <stateDir>/spv（实例的 Source 只读这个目录）；$SPV_QUEUE_DIR 仍然是
  // 派单时的运行时覆盖，不写进注册表，否则注册表和部署实际读的队列会分叉。
  let repository = null
  try {
    repository = repositoryOfCheckout('tools/wheelchair-agent', env)
  } catch {
    // 旧安装可能没有 checkout（例如从别处运行 migrate）；空白 repository 允许，之后用 deployment add --repo 补。
  }
  const result = upsertDeployment(
    {
      project: 'tools/wheelchair-agent',
      profile: String(env.DSH_SUPERAGENT_PROFILE ?? '').trim() || DEFAULT_PROFILE,
      stateDir,
      queueDir: join(stateDir, 'spv'),
      port: defaultPort(env),
      installedSha: installedShaOf({ env }) ?? '',
      repository,
    },
    { env },
  )
  const instance = writeInstance(result.entry, { env })
  out.write(`registered ${describe(result.entry)}\n`)
  out.write(`${instance.created ? 'instance' : 'instance (already existed, left unchanged):'} ${instance.file}\n`)
  out.write(
    'adopted the existing installation: the running superagent service is unchanged, and dispatches for ' +
      'tools/wheelchair-agent go to that queue. Continue with "wheelchair-agent service start --project ' +
      'tools/wheelchair-agent" so the instance identifies itself, and register other projects with ' +
      '"deployment add" before dispatching to them.\n',
  )
  if (result.entry.repository === null) {
    out.write(
      'note: no GitHub repository was recorded (there is no checkout origin to infer it from); when the checkout ' +
        'exists, run "wheelchair-agent deployment add tools/wheelchair-agent --repo owner/name".\n',
    )
  }
  return 0
}

/**
 * 执行一个 `deployment` 子命令。`argv` 是 `deployment` 之后的参数；`--help` 打印本命令用法并返回 0。
 * 所有输出走 `out`（默认 stdout），便于测试替换。
 */
export async function runDeploymentCommand(argv, { env = process.env, out = process.stdout } = {}) {
  const [verb, ...rest] = argv
  if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
    out.write(`${DEPLOYMENT_USAGE}\n`)
    return 0
  }
  if (verb === 'list') {
    const parsed = parse(rest, { booleans: ['--json'] })
    if (parsed.help) {
      out.write(`${DEPLOYMENT_USAGE}\n`)
      return 0
    }
    noPositionals(parsed.positionals, 'list')
    return list({ env, json: parsed.flags['--json'] === true, out })
  }
  if (verb === 'add') {
    const parsed = parse(rest, {
      values: {
        '--repo': 'repo',
        '--profile': 'profile',
        '--state-dir': 'state-dir',
        '--queue-dir': 'queue-dir',
        '--port': 'port',
        '--installed-sha': 'installed-sha',
      },
    })
    if (parsed.help) {
      out.write(`${DEPLOYMENT_USAGE}\n`)
      return 0
    }
    return add(parsed.positionals, parsed.flags, { env, out })
  }
  if (verb === 'remove' || verb === 'rm') {
    const parsed = parse(rest, { booleans: ['--force'] })
    if (parsed.help) {
      out.write(`${DEPLOYMENT_USAGE}\n`)
      return 0
    }
    return remove(parsed.positionals, parsed.flags, { env, out })
  }
  if (verb === 'setup') {
    const parsed = parse(rest, { values: { '--project': 'project' } })
    if (parsed.help) {
      out.write(`${DEPLOYMENT_USAGE}\n`)
      return 0
    }
    noPositionals(parsed.positionals, 'setup')
    const project = String(parsed.flags['--project'] ?? '').trim()
    if (project === '') throw usageError('deployment setup needs --project <project>')
    return await setupDeployment(project, { env, out })
  }
  if (verb === 'migrate') {
    const parsed = parse(rest)
    if (parsed.help) {
      out.write(`${DEPLOYMENT_USAGE}\n`)
      return 0
    }
    return migrate(parsed.positionals, { env, out })
  }
  throw usageError(`unknown "deployment" command ${JSON.stringify(verb)}; expected list, add, remove or migrate`)
}
