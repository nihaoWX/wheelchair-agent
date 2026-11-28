#!/usr/bin/env node
/**
 * `wheelchair-agent spv-project`：查看、登记、删除数据根下的 spv 项目。
 *
 * spv 项目是「一个 spv 会话 + 它下面的一组 orchestrator 项目 checkout」的记录，存在
 * `<data root>/spv-projects.json`（见 `src/shared/spv-projects.js`）。本子命令只维护这份记录：
 * 不创建目录、不安装 profile、不启停任何服务。orchestrator 项目与 spv 项目的绑定由
 * `wheelchair-agent deployment add … --spv <root>` 维护，这里也可以直接改 `workers`。
 *
 * 退出码约定与其他子命令一致：参数错误用 `.code = 'SPV_PROJECT_USAGE'`，由
 * `bin/wheelchair-agent.mjs` 转成 exit 2；文件内容/IO 错误是普通 Error，exit 1。
 */
import { resolve } from 'node:path'

import { listDeployments } from '../shared/deployments.js'
import {
  SPV_PROJECTS_VERSION,
  listSpvProjects,
  removeSpvProject,
  spvProjectsPath,
  upsertSpvProject,
} from '../shared/spv-projects.js'
import { checkProject } from './dispatch.js'

/** `spv-project --help` 与参数错误的固定文案。 */
export const SPV_PROJECT_USAGE = `usage: wheelchair-agent spv-project <list|add|remove> [options]

The spv project registry (~/.wheelchair-agent/spv-projects.json, moved by WHEELCHAIR_AGENT_HOME)
records each spv root and the orchestrator projects under it. It is the operator's file: every
inconsistency is reported and the file is never rewritten automatically.

commands:
  list [--json]                show the spv roots and their bound orchestrator projects
  add <root> [--orchestrator <project>]...
                               record an spv root and optionally bind orchestrator projects (repeat
                               --orchestrator); identical content prints "nothing changed" and does
                               not touch the file
  remove <root> [--force]      delete an spv root; while it still binds orchestrator projects,
                               --force is required and the error lists what would be unbound

An orchestrator project belongs to at most one spv root, and every --orchestrator must already be the
project of a registered deployment (run "wheelchair-agent deployment add <project> --repository
owner/name" first). "wheelchair-agent deployment add <project> --spv <root>" maintains the same binding,
and "deployment remove" unbinds the orchestrator project again.

The old flag name --worker is still accepted and is exactly equivalent to --orchestrator.`

function usageError(message) {
  const error = new Error(message)
  error.code = 'SPV_PROJECT_USAGE'
  return error
}

/** 手写解析：位置参数 + 取值选项（可重复）+ 布尔开关；未知/缺值/重复开关立即报错。 */
function parse(argv, { values = {}, repeat = [], booleans = [] } = {}) {
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
    if (repeat.includes(word) || values[word] !== undefined) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw usageError(`${word} needs a value`)
      if (repeat.includes(word)) {
        flags[word] = [...(flags[word] ?? []), value]
      } else {
        if (flags[word] !== undefined) throw usageError(`${word} was already given`)
        flags[word] = value
      }
      index += 1
      continue
    }
    if (word.startsWith('-')) throw usageError(`unknown option ${JSON.stringify(word)} for "spv-project"`)
    positionals.push(word)
  }
  return { help: false, positionals, flags }
}

function exactlyOne(positionals, example) {
  if (positionals.length === 0) throw usageError(`this command needs an spv root, e.g. ${example}`)
  if (positionals.length > 1) {
    throw usageError(
      `expected one spv root, got ${positionals.length} (${positionals.map(item => JSON.stringify(item)).join(', ')})`,
    )
  }
  return positionals[0]
}

function noPositionals(positionals, command) {
  if (positionals.length > 0) {
    throw usageError(`"spv-project ${command}" takes no positional argument, got ${JSON.stringify(positionals[0])}`)
  }
}

function describe(entry) {
  return `spv-project ${entry.root} orchestratorProjects=${entry.workers.length}`
}

function workerLines(entry) {
  return entry.workers.length === 0 ? ['  (no orchestrator projects bound)'] : entry.workers.map(worker => `  ${worker}`)
}

/** `spv-project list`：缺失/空表都只打印指路文案，不算错误。 */
function list({ env, json, out }) {
  const registry = listSpvProjects({ env })
  if (!registry.exists) {
    if (json) {
      out.write(`${JSON.stringify({ version: SPV_PROJECTS_VERSION, registry: registry.file, spvProjects: [] }, null, 2)}\n`)
      return 0
    }
    out.write(`registry: ${registry.file}\n`)
    out.write(
      'no spv projects recorded yet: add one with "wheelchair-agent spv-project add <root>" (the directory that ' +
        'contains orchestrator projects, e.g. ~/bioagentforge). "deployment add" can bind an orchestrator project to it with --spv.\n',
    )
    return 0
  }
  if (json) {
    out.write(`${JSON.stringify({ version: registry.version, registry: registry.file, spvProjects: registry.spvProjects }, null, 2)}\n`)
    return 0
  }
  out.write(`registry: ${registry.file}\n`)
  if (registry.spvProjects.length === 0) {
    out.write(
      'no spv projects recorded yet: add one with "wheelchair-agent spv-project add <root>" (the directory that ' +
        'contains orchestrator projects, e.g. ~/bioagentforge).\n',
    )
    return 0
  }
  for (const entry of registry.spvProjects) {
    out.write(`${describe(entry)}\n`)
    for (const line of workerLines(entry)) out.write(`${line}\n`)
  }
  return 0
}

/** `spv-project add`：根必须是绝对路径；orchestrator 项目可以多次给出，`--orchestrator` 与旧名 `--worker` 等价。 */
function add(positionals, flags, { env, out }) {
  const root = exactlyOne(positionals, '~/bioagentforge')
  const workers = [...(flags['--orchestrator'] ?? []), ...(flags['--worker'] ?? [])]
  const registry = workers.length === 0 ? null : listDeployments({ env })
  for (const worker of workers) {
    checkProject(worker)
    if (!registry.deployments.some(entry => entry.project === worker)) {
      throw new Error(
        `cannot bind ${JSON.stringify(worker)} to spv project ${JSON.stringify(resolve(root))}: it is not the ` +
          'project of a registered deployment, so no instance would run it. Register it first with ' +
          `"wheelchair-agent deployment add ${worker} --repository owner/name", then rerun this command.`,
      )
    }
  }
  const result = upsertSpvProject(root, workers, { env })
  if (result.created) {
    out.write(`registered ${describe(result.entry)}\n`)
    for (const line of workerLines(result.entry)) out.write(`${line}\n`)
  } else if (!result.changed) {
    out.write(`spv project ${result.entry.root} is already registered with these orchestrator projects; nothing changed\n`)
  } else {
    const before = new Set(result.before?.workers ?? [])
    const added = result.entry.workers.filter(worker => !before.has(worker))
    const removed = (result.before?.workers ?? []).filter(worker => !result.entry.workers.includes(worker))
    const changes = [
      added.length === 0 ? '' : `added ${added.join(', ')}`,
      removed.length === 0 ? '' : `removed ${removed.join(', ')}`,
    ].filter(Boolean)
    out.write(`updated ${result.entry.root}: ${changes.join('; ')}\n`)
    for (const line of workerLines(result.entry)) out.write(`${line}\n`)
  }
  return 0
}

/** `spv-project remove <root>`：还有 orchestrator 项目时必须 `--force`，错误里列出会被解绑的项目。 */
function remove(positionals, flags, { env, out }) {
  const root = exactlyOne(positionals, '~/bioagentforge')
  const result = removeSpvProject(root, { env, force: flags['--force'] === true })
  if (result === undefined) {
    throw new Error(
      `no spv project ${JSON.stringify(resolve(root))} in ${spvProjectsPath({ env })}. Run ` +
        '"wheelchair-agent spv-project list" to see the recorded roots.',
    )
  }
  out.write(`${describe(result.entry)}\n`)
  if (result.entry.workers.length > 0) {
    const count = result.entry.workers.length
    out.write(`unbound ${count} orchestrator project${count === 1 ? '' : 's'}: ${result.entry.workers.join(', ')}\n`)
  }
  out.write(`removed ${result.entry.root}; ${result.spvProjects.length} spv project(s) remain in ${result.file}.\n`)
  return 0
}

/** 执行一个 `spv-project` 子命令；`argv` 是 `spv-project` 之后的参数。 */
export function runSpvProjectCommand(argv, { env = process.env, out = process.stdout } = {}) {
  const [verb, ...rest] = argv
  if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
    out.write(`${SPV_PROJECT_USAGE}\n`)
    return 0
  }
  if (verb === 'list') {
    const parsed = parse(rest, { booleans: ['--json'] })
    if (parsed.help) {
      out.write(`${SPV_PROJECT_USAGE}\n`)
      return 0
    }
    noPositionals(parsed.positionals, 'list')
    return list({ env, json: parsed.flags['--json'] === true, out })
  }
  if (verb === 'add') {
    const parsed = parse(rest, { repeat: ['--orchestrator', '--worker'] })
    if (parsed.help) {
      out.write(`${SPV_PROJECT_USAGE}\n`)
      return 0
    }
    return add(parsed.positionals, parsed.flags, { env, out })
  }
  if (verb === 'remove' || verb === 'rm') {
    const parsed = parse(rest, { booleans: ['--force'] })
    if (parsed.help) {
      out.write(`${SPV_PROJECT_USAGE}\n`)
      return 0
    }
    return remove(parsed.positionals, parsed.flags, { env, out })
  }
  throw usageError(`unknown "spv-project" command ${JSON.stringify(verb)}; expected list, add or remove`)
}
