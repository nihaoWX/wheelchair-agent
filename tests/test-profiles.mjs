/**
 * Two self-built profiles, one shared implementation.
 *
 * `src/spv/profiles.js` owns both profiles (`wca` for the browser surface, `wca-spv-tui` for the SPV
 * session), the one-time move of `profiles/superagent`, the deployment registry profile field and the
 * panel overlay. This test runs it against throwaway DSH_HOME/data-root pairs only: it never reads or
 * writes the machine's real `~/.dsh`, never starts dsh, and never deletes a profile.
 *
 * Run with `node tests/test-profiles.mjs`.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as profiles from '../src/spv/profiles.js'
import * as spvHost from '../src/spv/spv-host.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TEMPLATE_DIR = join(ROOT, 'preset', 'profiles')
const PANEL_TEMPLATE = join(ROOT, 'preset', 'panel.patch.yml')
const SPV_WEB_TEMPLATE = join(ROOT, 'preset', 'spv-web.patch.yml')
const CLI = join(ROOT, 'src', 'spv', 'profiles.js')
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

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
function symlinkDir(target, path) {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, 'dir')
}

const WCA_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsh-superagent',
  '@mars-sea/dsh-commandcode-provider',
  'dsh-context',
  'billion-context',
]
const TUI_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-harness-tui/dsh-tui',
  '@mars-sea/dsh-commandcode-provider',
  'billion-context',
]
const REGISTRY = {
  version: 1,
  deployments: [
    {
      project: 'tools/manuscripts_skills',
      profile: 'superagent',
      stateDir: '/fixture/state/superagent/manuscripts_skills',
      queueDir: '/fixture/state/superagent/manuscripts_skills/spv',
      port: 3083,
      installedSha: null,
      repository: 'nihaoWX/manuscripts_skills',
    },
    {
      project: 'tools/wheelchair-agent',
      profile: 'superagent',
      stateDir: '/fixture/state/superagent',
      queueDir: '/fixture/state/superagent/spv',
      port: 3082,
      installedSha: '0487980a775cc2faaa97edc795eadcd90fe08db7',
      repository: 'nihaoWX/wheelchair-agent',
    },
  ],
}

function makeBox({ legacy = true, dshTui = true, registry = true, panelProfiles = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'wheelchair-profiles-'))
  const box = {
    base,
    home: join(base, 'home'),
    dsh: join(base, 'dsh'),
    data: join(base, 'data'),
    plugin: join(base, 'home', 'opt', 'dsh-plugins', 'dsh-superagent'),
  }
  mkdirSync(box.plugin, { recursive: true })
  writeJson(join(box.plugin, 'package.json'), { name: 'dsh-superagent', version: '0.1.0', type: 'module' })

  if (legacy) {
    const dir = join(box.dsh, 'profiles', 'superagent')
    writeJson(join(dir, 'package.json'), {
      name: 'dsh-profile-superagent',
      private: true,
      dependencies: {
        '@mars-sea/dsh-commandcode-provider': '0.17.6',
        'billion-context': '^0.1.216',
        'dsh-context': '^0.84.1',
        'dsh-superagent': `link:${box.plugin}`,
      },
      dsh: { profile: { bundles: [...WCA_BUNDLES] } },
    })
    for (const name of ['@mars-sea/dsh-commandcode-provider', 'billion-context', 'dsh-context']) {
      const target = join(box.base, 'packages', name)
      mkdirSync(target, { recursive: true })
      symlinkDir(target, join(dir, 'node_modules', name))
    }
    symlinkDir(box.plugin, join(dir, 'node_modules', 'dsh-superagent'))
    mkdirSync(join(dir, 'node_modules', 'wheelchair-agent-webui'), { recursive: true })
  }

  if (dshTui) {
    const dir = join(box.dsh, 'profiles', 'dsh-tui')
    writeJson(join(dir, 'package.json'), {
      name: 'dsh-profile-dsh-tui',
      private: true,
      dependencies: { '@deepseek-harness-tui/dsh-tui': '^0.19.0', 'billion-context': '^0.1.216' },
      dsh: { profile: { bundles: TUI_BUNDLES } },
    })
    symlinkDir(
      join(box.base, 'packages', 'dsh-tui'),
      join(dir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui'),
    )
    mkdirSync(join(dir, 'node_modules', '@mars-sea', 'dsh-commandcode-provider'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'billion-context'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'wheelchair-agent'), { recursive: true })
    writeJson(join(dir, 'node_modules', 'wheelchair-agent', 'package.json'), { name: 'wheelchair-agent', version: '0.1.0' })
  }

  if (panelProfiles) {
    for (const name of ['wheelchair-agent', 'panel']) {
      mkdirSync(join(box.dsh, 'profiles', name), { recursive: true })
      writeFileSync(join(box.dsh, 'profiles', name, 'keep-me'), 'leftover\n')
    }
  }

  if (registry) writeJson(join(box.data, 'deployments.json'), structuredClone(REGISTRY))
  return box
}

function envFor(box) {
  const env = { ...process.env, HOME: box.home, DSH_HOME: box.dsh, WHEELCHAIR_AGENT_HOME: box.data }
  for (const key of ['DSH_SUPERAGENT_PROFILE', 'DSH_SUPERAGENT_PLUGIN_DIR', 'DSH_SUPERAGENT_PORT']) delete env[key]
  return env
}

function sync(box, extra = {}) {
  return profiles.syncProfiles({
    dshHome: box.dsh,
    dataRoot: box.data,
    stateDir: join(box.dsh, 'state', 'superagent'),
    port: 3082,
    templateDir: TEMPLATE_DIR,
    panelOverlay: PANEL_TEMPLATE,
    spvWebOverlay: SPV_WEB_TEMPLATE,
    env: envFor(box),
    ...extra,
  })
}

function checkProfiles(box, extra = {}) {
  return profiles.checkProfiles({
    dshHome: box.dsh,
    dataRoot: box.data,
    stateDir: join(box.dsh, 'state', 'superagent'),
    port: 3082,
    templateDir: TEMPLATE_DIR,
    spvWebOverlay: SPV_WEB_TEMPLATE,
    env: envFor(box),
    ...extra,
  })
}

function linkTarget(path) {
  return readlinkSync(path)
}

function assertDisabled(text, id) {
  const lines = text.split('\n')
  const index = lines.findIndex(line => new RegExp(`^-\\s*id:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(line))
  if (index === -1) return false
  for (let next = index + 1; next < lines.length && !/^- /.test(lines[next]); next += 1) {
    if (/^\s+disabled:\s*true\s*$/.test(lines[next])) return true
  }
  return false
}

function testMigration() {
  const box = makeBox()
  try {
    const registryBefore = structuredClone(REGISTRY.deployments)
    const report = sync(box)
    const files = profiles.formatSyncReport(report)
    check('migration exits without problems', report.problems.length === 0, files)
    check('sync reports the whole-profile move', /migrated: superagent -> wca/.test(files), files)
    check('the old profile directory is gone', !existsSync(join(box.dsh, 'profiles', 'superagent')))
    const wca = join(box.dsh, 'profiles', 'wca')
    const manifest = JSON.parse(readFileSync(join(wca, 'package.json'), 'utf8'))
    check('the new profile is named dsh-profile-wca', manifest.name === 'dsh-profile-wca', manifest.name)
    check('the bundle order matches the template exactly', JSON.stringify(manifest.dsh.profile.bundles) === JSON.stringify(WCA_BUNDLES), JSON.stringify(manifest.dsh.profile.bundles))
    check('the node_modules links moved with the directory', linkTarget(join(wca, 'node_modules', 'dsh-superagent')) === box.plugin)
    check('the webui package moved with the directory', existsSync(join(wca, 'node_modules', 'wheelchair-agent-webui')))
    check('the profile records the links it owns', JSON.parse(readFileSync(join(wca, 'profile-links.json'), 'utf8')).linked.some(link => link.name === 'dsh-superagent'))
    const patch = readFileSync(join(wca, 'cordis.patch.yml'), 'utf8')
    check('the patch renders the state directory', patch.includes(join(box.dsh, 'state', 'superagent')), patch)
    check('the patch renders the service port', /port: 3082/.test(patch), patch)
    check('no template placeholder survives', !/@STATE_DIR@|@SERVICE_PORT@/.test(patch), patch)
    check('the wca patch mounts dsh-superagent', /id:\s*dsh-superagent\s*$/m.test(patch), patch)
    check('the account row is in the wca patch', /activeAccount:\s*COMMANDCODE_API_KEY_3/.test(patch), patch)
    check('the model row is in the wca patch', /model:\s*deepseek\/deepseek-v4.1-flash/.test(patch), patch)

    const tui = join(box.dsh, 'profiles', 'wca-spv-tui')
    const tuiManifest = JSON.parse(readFileSync(join(tui, 'package.json'), 'utf8'))
    check('the terminal profile is named dsh-profile-wca-spv-tui', tuiManifest.name === 'dsh-profile-wca-spv-tui', tuiManifest.name)
    check('the terminal bundle order matches the template', JSON.stringify(tuiManifest.dsh.profile.bundles) === JSON.stringify(TUI_BUNDLES), JSON.stringify(tuiManifest.dsh.profile.bundles))
    check(
      'the terminal profile links the dsh-tui package from the dsh-tui profile',
      linkTarget(join(tui, 'node_modules', '@deepseek-harness-tui')) ===
        join(box.dsh, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui'),
    )
    check('the terminal patch has no webserver row', !/id:\s*webserver/.test(readFileSync(join(tui, 'cordis.patch.yml'), 'utf8')))
    check('the terminal patch has no wheelchair-spv row', !/wheelchair-spv/.test(readFileSync(join(tui, 'cordis.patch.yml'), 'utf8')))

    const registry = JSON.parse(readFileSync(join(box.data, 'deployments.json'), 'utf8'))
    check('every deployment now names the wca profile', registry.deployments.every(entry => entry.profile === 'wca'), JSON.stringify(registry))
    check(
      'the registry keeps port/stateDir/queueDir/repository/installedSha byte-identical',
      registry.deployments.length === registryBefore.length &&
        registry.deployments.every((entry, index) => {
          const { profile, ...rest } = entry
          const { profile: oldProfile, ...oldRest } = registryBefore[index]
          return profile === 'wca' && oldProfile === 'superagent' && JSON.stringify(rest) === JSON.stringify(oldRest)
        }),
      JSON.stringify(registry),
    )
    const overlay = readFileSync(join(box.data, 'deployments', 'panel.yml'), 'utf8')
    check('the panel overlay is installed under the data root', existsSync(join(box.data, 'deployments', 'panel.yml')))
    check('the panel overlay carries the panel port', /port:\s*!!js Number\(process\.env\.WHEELCHAIR_PANEL_PORT \?\? 3080\)/.test(overlay), overlay)
    for (const id of profiles.PANEL_DISABLED_IDS) {
      check(`the panel overlay disables ${id}`, assertDisabled(overlay, id), overlay)
    }
    check('the panel overlay keeps the webui background off', /background:\s*false/.test(overlay), overlay)
    check('the second sync is a no-op', sync(box).changed === false)
    check('check passes after the sync', checkProfiles(box).ok, profiles.formatCheckReport(checkProfiles(box)))
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
}

function testBothProfilesAndLeftovers() {
  const box = makeBox({ panelProfiles: true })
  try {
    sync(box)
    mkdirSync(join(box.dsh, 'profiles', 'superagent'), { recursive: true })
    writeFileSync(join(box.dsh, 'profiles', 'superagent', 'keep-me'), 'old\n')
    const report = sync(box)
    const text = profiles.formatSyncReport(report)
    check('both names: the new profile is used', existsSync(join(box.dsh, 'profiles', 'wca')))
    check('both names: the old profile is kept', existsSync(join(box.dsh, 'profiles', 'superagent', 'keep-me')))
    check('both names: the report says the old profile is unused', /profiles\/superagent still exists/.test(text), text)
    const status = checkProfiles(box)
    check('check passes with the leftover directory present', status.ok, profiles.formatCheckReport(status))
    const notes = status.notes.join('\n')
    check('the check note says the old profile is deletable', /profiles\/superagent is unused by any deployment and can be deleted by hand/.test(notes), notes)
    check('the check note says the old panel profile is deletable', /profiles\/wheelchair-agent is unused/.test(notes), notes)
    check('the check note says the legacy panel profile is deletable', /profiles\/panel is unused/.test(notes), notes)
    check('the check note keeps dsh-tui for wca-spv-tui', /profiles\/dsh-tui is not used by any deployment, but wca-spv-tui links/.test(notes), notes)
    check('the leftover dsh-tui wheelchair-agent copy is reported', /profiles\/dsh-tui\/node_modules\/wheelchair-agent is an early leftover/.test(notes), notes)
    check('no leftover directory is deleted', existsSync(join(box.dsh, 'profiles', 'wheelchair-agent', 'keep-me')) && existsSync(join(box.dsh, 'profiles', 'panel', 'keep-me')))
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
}

function testOnlyOldProfileChecksRed() {
  const box = makeBox()
  try {
    const status = checkProfiles(box)
    const text = profiles.formatCheckReport(status)
    check('check fails while only profiles/superagent exists', status.ok === false, text)
    check('check says the wca profile is missing', /profile "wca" is missing; the old "superagent" profile is still installed/.test(text), text)
    check('check prints the copy-paste fix', /fix: run "bash install.sh" from the wheelchair-agent checkout to move it/.test(text), text)
    const result = spawnSync(process.execPath, [CLI, 'check', '--dsh-home', box.dsh, '--data-root', box.data], {
      env: envFor(box),
      encoding: 'utf8',
    })
    check('the check CLI exits 1', result.status === 1, `${result.status}\n${result.stdout}\n${result.stderr}`)
    check('the CLI fix line is copy-pasteable', /bash install\.sh/.test(result.stdout), result.stdout)
    check('the check wrote nothing', !existsSync(join(box.dsh, 'profiles', 'wca')))
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
}

function testDriftRepair() {
  const box = makeBox()
  try {
    sync(box)
    const wca = join(box.dsh, 'profiles', 'wca')
    const manifestFile = join(wca, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'dsh-context')
    writeJson(manifestFile, manifest)
    rmSync(join(box.dsh, 'profiles', 'wca-spv-tui', 'node_modules', '@deepseek-harness-tui'), { recursive: true, force: true })
    const overlayFile = join(box.data, 'deployments', 'panel.yml')
    writeFileSync(overlayFile, readFileSync(overlayFile, 'utf8').replace(/\n\s+disabled: true/, '\n      enabled: true'))
    const status = checkProfiles(box)
    check('check reports the drifted bundle list', status.problems.some(problem => /bundles/.test(problem.problem)), profiles.formatCheckReport(status))
    check('check reports the missing dsh-tui link', status.problems.some(problem => /wca-spv-tui/.test(problem.problem)), profiles.formatCheckReport(status))
    check('check reports the overlay drift', status.problems.some(problem => /panel overlay/.test(problem.problem)), profiles.formatCheckReport(status))
    const report = sync(box)
    check('sync repairs the drift', report.problems.length === 0, profiles.formatSyncReport(report))
    const repaired = JSON.parse(readFileSync(manifestFile, 'utf8'))
    check('sync restored the template bundles', JSON.stringify(repaired.dsh.profile.bundles) === JSON.stringify(WCA_BUNDLES))
    check(
      'sync restored the dsh-tui link',
      existsSync(join(box.dsh, 'profiles', 'wca-spv-tui', 'node_modules', '@deepseek-harness-tui')),
    )
    check('sync restored the overlay', checkProfiles(box).ok, profiles.formatCheckReport(checkProfiles(box)))
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
}

function testLinkRecordAndPrune() {
  const box = makeBox()
  try {
    sync(box)
    const wca = join(box.dsh, 'profiles', 'wca')
    const recordFile = join(wca, 'profile-links.json')
    const obsoleteTarget = join(box.base, 'packages', 'obsolete')
    mkdirSync(obsoleteTarget, { recursive: true })
    symlinkDir(obsoleteTarget, join(wca, 'node_modules', 'obsolete-package'))
    const record = JSON.parse(readFileSync(recordFile, 'utf8'))
    record.linked.push({ name: 'obsolete-package', target: obsoleteTarget })
    writeJson(recordFile, record)
    const userTarget = join(box.base, 'packages', 'user-owned')
    mkdirSync(userTarget, { recursive: true })
    symlinkDir(userTarget, join(wca, 'node_modules', 'user-owned'))
    const report = sync(box)
    const text = profiles.formatSyncReport(report)
    check('sync prunes the recorded obsolete link', !existsSync(join(wca, 'node_modules', 'obsolete-package')), text)
    check('sync keeps a link it never created', existsSync(join(wca, 'node_modules', 'user-owned')), text)
    check('sync reports one pruned link', /1 pruned/.test(text), text)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
}

function testMissingDshTuiDonor() {
  const box = makeBox({ dshTui: false })
  try {
    const report = sync(box)
    const text = profiles.formatSyncReport(report)
    check('a missing dsh-tui profile is a reported problem', report.problems.some(problem => /cannot load dsh-tui/.test(problem.problem)), text)
    check('the browser profile is still created', existsSync(join(box.dsh, 'profiles', 'wca')))
    check('wca-spv-tui is not created from nothing', !existsSync(join(box.dsh, 'profiles', 'wca-spv-tui')))
    check('sync carries the fallback note', /profile "wca-spv-tui" was not created/.test(text), text)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
}

function testTerminalProfileRename() {
  const oldName = 'wca-tui'
  const newName = 'wca-spv-tui'
  const box = makeBox()
  try {
    const old = join(box.dsh, 'profiles', oldName)
    writeJson(join(old, 'package.json'), {
      name: 'dsh-profile-wca-tui',
      private: true,
      dependencies: { '@mars-sea/dsh-commandcode-provider': '0.17.7', 'billion-context': '^0.1.216' },
      dsh: { profile: { bundles: [...TUI_BUNDLES] } },
    })
    writeJson(join(old, 'profile-links.json'), { profile: oldName, linked: [] })
    const report = sync(box)
    const text = profiles.formatSyncReport(report)
    const moved = join(box.dsh, 'profiles', newName)
    check('the old terminal profile is moved whole', !existsSync(old) && existsSync(moved), text)
    check(
      'sync prints the one-line rename note',
      /note: moved the spv terminal profile from wca-tui to wca-spv-tui/.test(text),
      text,
    )
    check('the link record moved with the directory', existsSync(join(moved, 'profile-links.json')))
    check(
      'the moved terminal profile is named dsh-profile-wca-spv-tui',
      JSON.parse(readFileSync(join(moved, 'package.json'), 'utf8')).name === 'dsh-profile-wca-spv-tui',
    )
    check(
      'the second sync does not move the profile again',
      !/moved the spv terminal profile/.test(profiles.formatSyncReport(sync(box))),
    )

    mkdirSync(join(box.dsh, 'profiles', oldName), { recursive: true })
    writeFileSync(join(box.dsh, 'profiles', oldName, 'keep-me'), 'old\n')
    const both = profiles.formatSyncReport(sync(box))
    check('both names: the new terminal profile is used', existsSync(moved))
    check('both names: the old terminal profile is kept', existsSync(join(box.dsh, 'profiles', oldName, 'keep-me')))
    check('both names: the report says the old profile is unused', /profiles\/wca-tui still exists/.test(both), both)
    const status = checkProfiles(box)
    check(
      'check treats the old terminal profile as an unused note',
      status.ok && status.notes.some(note => /profiles\/wca-tui is unused; it was replaced by wca-spv-tui/.test(note)),
      profiles.formatCheckReport(status),
    )
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }

  const onlyOld = makeBox()
  try {
    sync(onlyOld)
    const current = join(onlyOld.dsh, 'profiles', newName)
    const legacy = join(onlyOld.dsh, 'profiles', oldName)
    renameSync(current, legacy)
    const status = checkProfiles(onlyOld)
    const text = profiles.formatCheckReport(status)
    check(
      'check names the missing terminal profile and the old directory',
      status.problems.some(problem => /profile "wca-spv-tui" is missing; the old "wca-tui" profile is still installed/.test(problem.problem)),
      text,
    )
    check('check does not silently rewrite the old directory', existsSync(legacy) && !existsSync(current), text)
  } finally {
    rmSync(onlyOld.base, { recursive: true, force: true })
  }
}

function testSpvWebSurface() {
  const tui = makeBox()
  try {
    sync(tui)
    check(
      'tui surface does not render the browser SPV profile',
      !existsSync(join(tui.dsh, 'profiles', 'wca-spv-web')),
    )
    check(
      'tui surface does not write the SPV browser overlay',
      !existsSync(join(tui.data, 'deployments', 'spv.yml')),
    )
    check('tui check says so', /spv.surface=tui/.test(profiles.formatCheckReport(checkProfiles(tui))))
  } finally {
    rmSync(tui.base, { recursive: true, force: true })
  }

  const web = makeBox()
  try {
    const env = { ...envFor(web), WHEELCHAIR_AGENT_SPV_SURFACE: 'web' }
    const report = sync(web, { env })
    const text = profiles.formatSyncReport(report)
    const dir = join(web.dsh, 'profiles', 'wca-spv-web')
    check('web surface renders the browser SPV profile', existsSync(dir), text)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    check('the profile is named dsh-profile-wca-spv-web', manifest.name === 'dsh-profile-wca-spv-web', manifest.name)
    check(
      'the browser SPV profile bundles web-app but no deployment plugins',
      manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app') &&
        !manifest.dsh.profile.bundles.includes('dsh-superagent') &&
        !manifest.dsh.profile.bundles.includes('wheelchair-agent-webui'), JSON.stringify(manifest.dsh.profile.bundles))
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    check('the browser SPV patch has the webserver row', /-\s*id:\s*webserver/.test(patch), patch)
    check('the browser SPV patch has the commandcode row', /-\s*id:\s*llm-commandcode/.test(patch), patch)
    check('the browser SPV patch has the SPV tools row', /-\s*id:\s*spv-tools/.test(patch), patch)
    check('the browser SPV patch has no deployment-only dsh-superagent row', !/-\s*id:\s*dsh-superagent\s*$/m.test(patch), patch)
    check(
      'the browser SPV patch watches no deployment queue',
      !/-\s*id:\s*wheelchair-spv\b/.test(patch) &&
        !/name:\s*['"]?wheelchair-agent\/spv-watch['"]?/.test(patch) &&
        !/@QUEUE_DIR@/.test(patch), patch,
    )
    const sourceNames = pluginNames(readFileSync(join(ROOT, 'preset', 'agent.cordis.yml'), 'utf8'))
    const mirroredNames = pluginNames(readFileSync(join(TEMPLATE_DIR, 'wca-spv-web.patch.yml'), 'utf8'))
    for (const id of ['spv-tools', 'spv-cron', 'restart-command']) {
      check(
        `the browser SPV patch mirrors ${id} verbatim`,
        sourceNames[id] !== undefined && sourceNames[id] === mirroredNames[id],
        `preset/agent.cordis.yml is the source; preset/profiles/wca-spv-web.patch.yml is the mirror ` +
          `(${id}: source=${sourceNames[id]} mirror=${mirroredNames[id]})`,
      )
    }
    const overlay = readFileSync(join(web.data, 'deployments', 'spv.yml'), 'utf8')
    check('the SPV browser overlay names the default port', /WHEELCHAIR_SPV_WEB_PORT \?\? 3081/.test(overlay), overlay)
    const status = checkProfiles(web, { env })
    check(
      'web check is clean',
      status.ok && /spv.surface=web/.test(profiles.formatCheckReport(status)),
      profiles.formatCheckReport(status),
    )
    assert.throws(
      () => sync(web, { env: { ...envFor(web), WHEELCHAIR_AGENT_SPV_SURFACE: 'browser' } }),
      /invalid spv\.surface "browser"/,
    )
  } finally {
    rmSync(web.base, { recursive: true, force: true })
  }
}

function pluginNames(text) {
  const names = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const found = /^\s*- id:\s*(spv-tools|spv-cron|restart-command)\s*$/.exec(lines[i])
    if (found === null) continue
    const next = lines.slice(i + 1).find(line => /^\s*name:/.test(line))
    names[found[1]] = next === undefined ? null : next.replace(/^\s*name:\s*/, '').trim()
  }
  return names
}

async function testSpvHostState() {
  const base = mkdtempSync(join(tmpdir(), 'wca-spv-state-'))
  try {
    const log = join(base, 'wca-spv.log')
    writeFileSync(log, 'dsh web: http://127.0.0.1:3081/?token=abc-DEF_123\n')
    const noToken = join(base, 'no-token.log')
    writeFileSync(noToken, 'dsh web starting\n')
    const own = '127.0.0.1:3081/?token=abc-DEF_123'
    const running401 = await spvHost.spvHostState({
      port: 3081,
      logPath: log,
      probe: async () => 401,
      listenerPid: () => 700,
      cmdline: () => 'node /usr/bin/dsh --profile wca-spv-web --patch /tmp/spv.yml',
    })
    check('spvHostState treats a 401 as our running host', running401.state === 'running', JSON.stringify(running401))
    check('spvHostState uses the last token URL from the log', running401.url?.endsWith(own) === true, String(running401.url))
    const running303 = await spvHost.spvHostState({
      port: 3081,
      logPath: log,
      probe: async () => 303,
      listenerPid: () => 701,
      cmdline: () => 'node dsh --profile=wca-spv-web',
    })
    check('spvHostState treats a 303 token exchange as running', running303.state === 'running', JSON.stringify(running303))
    const unreadable = await spvHost.spvHostState({
      port: 3081,
      logPath: log,
      probe: async () => 200,
      listenerPid: () => 702,
      cmdline: () => '',
    })
    check('spvHostState trusts the token when the cmdline is unreadable', unreadable.state === 'running', JSON.stringify(unreadable))
    const occupied = await spvHost.spvHostState({
      port: 3081,
      logPath: noToken,
      probe: async () => 200,
      listenerPid: () => 4242,
      cmdline: () => 'node /usr/bin/other-server',
    })
    check('spvHostState reports a 200 without a token as occupied', occupied.state === 'occupied' && occupied.pid === 4242, JSON.stringify(occupied))
    const foreign = await spvHost.spvHostState({
      port: 3081,
      logPath: log,
      probe: async () => 401,
      listenerPid: () => 4343,
      cmdline: () => 'node /usr/bin/other-server',
    })
    check('spvHostState rejects a token with a foreign listener', foreign.state === 'occupied' && foreign.pid === 4343, JSON.stringify(foreign))
    const free = await spvHost.spvHostState({
      port: 3081,
      logPath: log,
      probe: async () => null,
      listenerPid: () => null,
    })
    check('spvHostState reports a refused probe as free', free.state === 'free', JSON.stringify(free))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

function testSpvServiceArgs() {
  const args = spvHost.spvServiceArgs({
    action: 'start',
    overlay: '/data/deployments/spv.yml',
    port: 3081,
    stateDir: '/data/spv',
    log: '/dsh/.artifacts/wca-spv.log',
  })
  check('spvServiceArgs selects the spv mode', args[0] === 'start' && args[2] === 'spv', args.join(' '))
  check('spvServiceArgs selects the browser SPV profile', args[args.indexOf('--profile') + 1] === 'wca-spv-web', args.join(' '))
  check('spvServiceArgs carries port, state dir and overlay', args.includes('3081') && args.includes('/data/spv') && args.includes('/data/deployments/spv.yml'), args.join(' '))
  check('spvServiceArgs uses the wca-spv session', args[args.indexOf('--session') + 1] === 'wca-spv', args.join(' '))
}

function testLauncherProfile() {
  const box = makeBox()
  try {
    sync(box)
    const preset = join(box.base, 'preset')
    mkdirSync(preset, { recursive: true })
    writeFileSync(join(preset, 'preset-default.patch.yml'), '[]\n')
    const launcher = join(box.base, 'spv-launcher.sh')
    cpSync(join(ROOT, 'preset', 'spv-launcher.sh'), launcher)
    writeFileSync(launcher, readFileSync(launcher, 'utf8').replaceAll('@SPV_HOME@', preset))
    const tools = join(box.base, 'tools')
    mkdirSync(tools, { recursive: true })
    const out = join(box.base, 'launcher.out')
    writeFileSync(
      join(tools, 'dsh-tui'),
      '#!/bin/sh\n{ echo "profile=${DSH_TUI_PROFILE-<unset>}"; echo "preset=${DSH_TUI_PRESET-<unset>}"; echo "argv=$*"; } > "$FAKE_OUT"\n',
      { mode: 0o755 },
    )
    const run = extra =>
      spawnSync('sh', [launcher], {
        env: {
          ...envFor(box),
          PATH: `${tools}:${process.env.PATH ?? ''}`,
          FAKE_OUT: out,
          WHEELCHAIR_AGENT_SUPERVISED: '1',
          ...extra,
        },
        encoding: 'utf8',
      })
    const present = run({})
    check('the launcher succeeds with wca-spv-tui installed', present.status === 0, present.stderr)
    const record = readFileSync(out, 'utf8')
    check('the launcher exports DSH_TUI_PROFILE=wca-spv-tui', /^profile=wca-spv-tui$/m.test(record), record)
    check('the launcher keeps DSH_TUI_PRESET=spv', /^preset=spv$/m.test(record), record)
    check('the launcher keeps the preset patch argument', /^argv=--patch .*preset-default\.patch\.yml$/m.test(record), record)
    rmSync(join(box.dsh, 'profiles', 'wca-spv-tui'), { recursive: true, force: true })
    const absent = run({})
    check('the launcher still starts without wca-spv-tui', absent.status === 0, absent.stderr)
    check('the fallback leaves DSH_TUI_PROFILE unset', /^profile=<unset>$/m.test(readFileSync(out, 'utf8')), readFileSync(out, 'utf8'))
    check('the fallback prints one note', /note: profile wca-spv-tui is missing; falling back to the dsh-tui profile/.test(absent.stderr), absent.stderr)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
}

function testTemplateHygiene() {
  for (const name of ['wca.package.json', 'wca.patch.yml', 'wca-spv-tui.package.json', 'wca-spv-tui.patch.yml', 'wca-spv-web.package.json', 'wca-spv-web.patch.yml', 'spv-web.patch.yml']) {
    const file = name === 'spv-web.patch.yml' ? join(ROOT, 'preset', name) : join(TEMPLATE_DIR, name)
    const text = readFileSync(file, 'utf8')
    check(`template ${name} has no machine-specific path`, !text.includes('/home/'), name)
  }
  const wca = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'wca.package.json'), 'utf8'))
  check('the wca template links dsh-superagent through a placeholder', wca.dependencies['dsh-superagent'] === 'link:@DSH_SUPERAGENT@')
  check('the wca template pins no account id', !JSON.stringify(wca).includes('COMMANDCODE_API_KEY_3'))
}

async function main() {
  assert.ok(existsSync(join(TEMPLATE_DIR, 'wca.patch.yml')), 'the wca template is missing')
  testTemplateHygiene()
  testMigration()
  testBothProfilesAndLeftovers()
  testOnlyOldProfileChecksRed()
  testDriftRepair()
  testLinkRecordAndPrune()
  testMissingDshTuiDonor()
  testTerminalProfileRename()
  testSpvWebSurface()
  await testSpvHostState()
  testSpvServiceArgs()
  testLauncherProfile()
  process.stdout.write(`\n${PASS} passed, ${FAIL} failed\n`)
  process.exit(FAIL === 0 ? 0 : 1)
}

await main()
