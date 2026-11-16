/**
 * `wheelchair-agent check` 的四项运行时健康检查（`ARCHITECTURE/cli.md` 的「check 检查什么」）。
 *
 * 这里只返回结构化结果，由 `bin/wheelchair-agent.mjs` 打印并决定退出码：本文件不调用 `process.exit`，
 * 也不 import 任何 dsh 包（`tests/test-layout.sh` 的规则 3）。
 *
 * 与 `install.sh --check` 的分工：那个查「装进去的东西 == checkout」，这里查运行时是否健康，两者不重叠。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

/** 面板里 prepare 命令应有的值：命令名，不是绝对路径（`ARCHITECTURE/cli.md`）。 */
export const PANEL_PREPARE = 'wheelchair-agent prepare'

/**
 * preset 能被 dsh 挂载所需的文件（相对 preset 根）。
 *
 * 这是「能不能加载」的判据，不是安装白名单：`install.sh --check` 另外断言装进去的**恰好**是白名单。
 * 两份清单现在一致，但目的不同，所以各自写一份；改安装布局时两处都要改。
 */
export const PRESET_FILES = [
  'preset.yml',
  'agent.cordis.yml',
  'preset-default.patch.yml',
  'package.json',
  'cli.js',
  'prepare.sh',
  'spv-launcher.sh',
  'agentsmd-examples/proj-dev-agentsmd.md',
  'agentsmd-examples/research-task-agentsmd.md',
  'commands/jobctl.py',
  'commands/superagent-service.py',
  'src/shared/home.js',
  'src/shared/queue.js',
  'src/shared/schema.js',
  'src/shared/work.js',
  'src/spv/check.js',
  'src/spv/cron-plugin.js',
  'src/spv/cron.js',
  'src/spv/dispatch.js',
  'src/spv/health.js',
  'src/spv/inbox.js',
  'src/spv/injector.js',
  'src/spv/outbox.js',
  'src/spv/paths.js',
  'src/spv/tools.js',
]

/** 一条检查结果；`fix` 只在失败时有意义。 */
function result(name, ok, detail, fix) {
  return { name, ok, detail, ...(fix ? { fix } : {}) }
}

/** 子进程输出压成一行，避免把整段日志塞进检查结果。 */
function firstLine(value) {
  const text = String(value ?? '').trim()
  return text === '' ? 'no output' : text.split('\n')[0]
}

/** 服务在跑吗：`superagent-service status` 的退出码就是答案（0 正常）。 */
export function checkService({ serviceScript }) {
  const name = 'service is running'
  if (!existsSync(serviceScript)) {
    return result(name, false, `the service manager is not installed at ${serviceScript}`, 'run: bash install.sh')
  }
  try {
    execFileSync('python3', [serviceScript, 'status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    return result(name, true, 'superagent-service status exited 0')
  } catch (error) {
    const detail = firstLine(error?.stderr || error?.stdout || error?.message)
    return result(name, false, detail, 'start it with: wheelchair-agent service start')
  }
}

/** preset 能被 dsh 加载吗：文件齐全，且 `agent.cordis.yml` 的 `file://` URL 都指向存在的文件。 */
export function checkPreset({ presetDir }) {
  const name = 'preset can be loaded'
  const missing = PRESET_FILES.filter(file => !existsSync(join(presetDir, file)))
  if (missing.length > 0) {
    return result(name, false, `missing under ${presetDir}: ${missing.join(', ')}`, 'run: bash install.sh')
  }
  let cordis
  try {
    cordis = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
  } catch (error) {
    return result(name, false, `cannot read agent.cordis.yml: ${error.message}`, 'run: bash install.sh')
  }
  // Only `name:` lines carry a real module URL. The file also *documents* the placeholder form
  // (`file://<安装目录>/src/spv/tools.js`) in a comment, and matching that would report a false failure.
  const urls = [...cordis.matchAll(/^\s*name:\s*['"]?(file:\/\/[^\s'"`]+)/gm)].map(match => match[1])
  const broken = urls.filter(url => {
    try {
      return !existsSync(fileURLToPath(url))
    } catch {
      return true
    }
  })
  if (broken.length > 0) {
    return result(name, false, `agent.cordis.yml points at missing files: ${broken.join(', ')}`, 'run: bash install.sh')
  }
  return result(name, true, `${PRESET_FILES.length} files present; ${urls.length} file:// URL(s) resolve`)
}

/** 面板的 prepare 值正确吗：读 `orchestrator.sqlite` 里最新的 `settings-version:<N>`。 */
export function checkPanel({ stateDir }) {
  const name = 'panel prepare value'
  const file = join(stateDir, 'orchestrator.sqlite')
  if (!existsSync(file)) {
    return result(name, false, `no orchestrator database at ${file}`, 'start the service once so it creates its database')
  }
  let database
  try {
    database = new DatabaseSync(file, { readOnly: true })
  } catch (error) {
    return result(name, false, `cannot open ${file}: ${error.message}`, 'check that the service user can read it')
  }
  try {
    const rows = database.prepare("select key, value from kv where key like 'settings-version:%'").all()
    if (rows.length === 0) {
      return result(name, false, 'the database holds no settings version', 'save the executor settings once in the panel')
    }
    const latest = rows
      .map(row => ({ row, revision: Number(String(row.key).slice('settings-version:'.length)) }))
      .sort((a, b) => a.revision - b.revision)
      .at(-1).row
    let settings
    try {
      settings = JSON.parse(latest.value).settings ?? {}
    } catch (error) {
      return result(name, false, `settings-version:${latest.key} is not valid JSON: ${error.message}`, 'save the executor settings again in the panel')
    }
    const prepare = String(settings.executor?.prepare ?? '')
    if (prepare === PANEL_PREPARE) return result(name, true, `executor.prepare = ${PANEL_PREPARE}`)
    return result(
      name,
      false,
      `executor.prepare is ${JSON.stringify(prepare)}, expected ${JSON.stringify(PANEL_PREPARE)}`,
      `set Settings -> Execution -> Prepare command to: ${PANEL_PREPARE}`,
    )
  } finally {
    database.close()
  }
}

/** 挑一个能跑 dry run 的项目：优先 wheelchair-agent 自己，否则 `tools/` 下第一个目录。 */
function pickProject(projectsRoot) {
  const preferred = join(projectsRoot, 'tools', 'wheelchair-agent')
  if (existsSync(preferred)) return 'tools/wheelchair-agent'
  let names
  try {
    names = readdirSync(join(projectsRoot, 'tools'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return undefined
  }
  return names.length > 0 ? `tools/${names[0]}` : undefined
}

/**
 * `prepare` 能跑吗：`SPV_PREPARE_DRY_RUN=1` 跑一次。
 *
 * 只读：dry run 不建仓库、不改远端；日志与工单目录都指向临时目录，跑完删掉。
 */
export function checkPrepare({ prepareScript, projectsRoot }) {
  const name = 'prepare can run'
  if (!existsSync(prepareScript)) {
    return result(name, false, `the prepare command is not installed at ${prepareScript}`, 'run: bash install.sh')
  }
  const project = pickProject(projectsRoot)
  if (project === undefined) {
    return result(name, false, `no project under ${join(projectsRoot, 'tools')} to prepare`, 'create a tools/<name> project, or set SPV_PROJECTS_ROOT')
  }
  const sandbox = mkdtempSync(join(tmpdir(), 'wheelchair-agent-check-'))
  try {
    execFileSync('sh', [prepareScript], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      env: {
        ...process.env,
        SPV_PREPARE_DRY_RUN: '1',
        SPV_PREPARE_LOG: join(sandbox, 'prepare.log'),
        SPV_PROJECTS_ROOT: projectsRoot,
        DSH_SUPERAGENT_DIR: join(sandbox, 'ticket'),
        DSH_SUPERAGENT_SPV_PROJECT: project,
      },
    })
    return result(name, true, `dry run exited 0 (project ${project})`)
  } catch (error) {
    const detail = firstLine(error?.stderr || error?.stdout || error?.message)
    return result(name, false, detail, 'run it by hand to see the full output: SPV_PREPARE_DRY_RUN=1 wheelchair-agent prepare --project <p> --dir /tmp/t')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

/** 四项检查，按 `ARCHITECTURE/cli.md` 的顺序。 */
export function runChecks(options) {
  return [
    checkService(options),
    checkPreset(options),
    checkPanel(options),
    checkPrepare(options),
  ]
}
