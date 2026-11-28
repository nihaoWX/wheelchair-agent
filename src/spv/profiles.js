/**
 * The two self-built dsh profiles.
 *
 * `wca` is the browser surface: dsh-web-app plus the dsh-superagent orchestrator, the Command Code
 * model route, the wheelchair-agent webui and the `spv` Source. The panel and every deployment
 * instance share this one profile; a deployment only overlays its port/stateDir/queueDir, and the
 * panel overlays the same profile with the deployment-only rows disabled (`deployments/panel.yml`).
 *
 * `wca-tui` is the terminal surface: the dsh-tui bundle over dsh-base, used by the `spv` session.
 * It is separate so SPV never shares state with the browser profile (or with the operator's own
 * dsh-tui profile).
 *
 * Both profiles are rendered from `preset/profiles/*.{package.json,patch.yml}`; the link targets are
 * resolved from the machine (an existing profile, `DSH_SUPERAGENT_PLUGIN_DIR`, `$HOME`), never
 * hardcoded. `profiles sync` is idempotent; `profiles check` is read-only and prints copy-paste fixes.
 *
 * The one-time migration is a whole-directory `mv`: `profiles/superagent` becomes `profiles/wca`, so
 * the dsh-superagent link, the wheelchair-agent link and the webui package move with it. Old
 * profiles (`superagent`, `wheelchair-agent`, `panel`) are never deleted here; `check` only reports
 * that no deployment uses them.
 *
 * Run `node src/spv/profiles.js sync|check --dsh-home ~/.dsh --data-root ~/.wheelchair-agent`.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The browser-surface profile that every deployment and the panel share. */
export const WCA_PROFILE_ID = 'wca'
/** The terminal-surface profile used by the `spv` session. */
export const WCA_TUI_PROFILE_ID = 'wca-tui'
/** Both self-built profiles, in migration/sync order. */
export const PROFILE_IDS = [WCA_PROFILE_ID, WCA_TUI_PROFILE_ID]
/** The single-deployment profile that `wca` replaces. */
export const LEGACY_SUPERAGENT_PROFILE_ID = 'superagent'
/** Profiles that only ever held a mirror/panel and are now unused. */
export const LEGACY_PANEL_PROFILE_IDS = ['wheelchair-agent', 'panel']
/** Per-profile patch file. */
export const PROFILE_PATCH_FILE = 'cordis.patch.yml'
/** Records which symlinks this module created, so a later sync can recycle them. */
export const PROFILE_LINKS_FILE = 'profile-links.json'
/** The panel overlay installed under `<data root>/deployments/`. */
export const PANEL_OVERLAY_FILE = 'panel.yml'
/** Rows the panel overlay must switch off. */
export const PANEL_DISABLED_IDS = [
  'dsh-superagent',
  'dsh-superagent-worker-preset',
  'dsh-superagent-router-preset',
  'wheelchair-spv',
]

/** Template files, keyed by profile id. */
export const PROFILE_TEMPLATES = {
  [WCA_PROFILE_ID]: { package: 'wca.package.json', patch: 'wca.patch.yml' },
  [WCA_TUI_PROFILE_ID]: { package: 'wca-tui.package.json', patch: 'wca-tui.patch.yml' },
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(MODULE_DIR, '..', '..')
const DSH_SUPERAGENT_PLACEHOLDER = 'link:@DSH_SUPERAGENT@'

function homeOf(env) {
  return env.HOME || homedir()
}

function expandHome(value, env) {
  const home = homeOf(env)
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return value
}

/** Resolve the dsh home: explicit argument, `$DSH_HOME`, then `$HOME/.dsh`. */
export function resolveDshHome({ dshHome, env = process.env } = {}) {
  const value = dshHome ?? env.DSH_HOME ?? join(homeOf(env), '.dsh')
  return resolve(expandHome(String(value), env))
}

/** Resolve the operator's data root: explicit argument, `$WHEELCHAIR_AGENT_HOME`, then `$HOME/.wheelchair-agent`. */
export function resolveDataRoot({ dataRoot, env = process.env } = {}) {
  const value = dataRoot ?? env.WHEELCHAIR_AGENT_HOME ?? join(homeOf(env), '.wheelchair-agent')
  return resolve(expandHome(String(value), env))
}

function readText(file) {
  return readFileSync(file, 'utf8')
}

function readJson(file) {
  return JSON.parse(readText(file))
}

function writeIfChanged(file, text) {
  if (existsSync(file) && readText(file) === text) return false
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp.${process.pid}`
  try {
    writeFileSync(temporary, text, { mode: 0o644 })
    chmodSync(temporary, 0o644)
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The write may have failed before the temporary file existed.
    }
    throw error
  }
  return true
}

/** Stable JSON text: two-space indent and one trailing newline, like the rest of the data files. */
function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Find `<root>/preset/profiles` (checkout) or `<root>/profiles` (installed preset). */
export function resolveTemplateDir({ templateDir } = {}) {
  const candidates = templateDir
    ? [resolve(String(templateDir))]
    : [join(PACKAGE_ROOT, 'preset', 'profiles'), join(PACKAGE_ROOT, 'profiles')]
  for (const dir of candidates) {
    if (existsSync(join(dir, PROFILE_TEMPLATES[WCA_PROFILE_ID].package))) return dir
  }
  throw new Error(
    `the profile templates are missing: looked for ${candidates.join(', ')}. ` +
      'fix: run "bash install.sh" from the wheelchair-agent checkout',
  )
}

/** Find the panel overlay template next to the profile templates (installed) or in `preset/`. */
export function resolvePanelOverlayTemplate({ panelOverlay, templateDir } = {}) {
  const candidates = []
  if (panelOverlay) candidates.push(resolve(String(panelOverlay)))
  if (templateDir) candidates.push(join(dirname(resolve(String(templateDir))), 'panel.patch.yml'))
  candidates.push(join(PACKAGE_ROOT, 'preset', 'panel.patch.yml'), join(PACKAGE_ROOT, 'panel.patch.yml'))
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  throw new Error(
    `the panel overlay template is missing: looked for ${candidates.join(', ')}. ` +
      'fix: run "bash install.sh" from the wheelchair-agent checkout',
  )
}

/**
 * Read and validate the four profile templates. The patch text is returned verbatim; placeholders are
 * rendered per profile by {@link renderProfilePatch}.
 */
export function readProfileTemplates({ templateDir } = {}) {
  const dir = resolveTemplateDir({ templateDir })
  const profiles = {}
  for (const id of PROFILE_IDS) {
    const files = PROFILE_TEMPLATES[id]
    const packageFile = join(dir, files.package)
    const patchFile = join(dir, files.patch)
    if (!existsSync(packageFile)) throw new Error(`the ${id} profile template is missing at ${packageFile}`)
    if (!existsSync(patchFile)) throw new Error(`the ${id} profile patch template is missing at ${patchFile}`)
    let manifest
    try {
      manifest = readJson(packageFile)
    } catch (error) {
      throw new Error(`the ${id} profile template at ${packageFile} is not valid JSON (${error?.message ?? error})`)
    }
    const bundles = manifest?.dsh?.profile?.bundles
    if (typeof manifest?.name !== 'string' || !Array.isArray(bundles) || bundles.length === 0) {
      throw new Error(
        `the ${id} profile template at ${packageFile} must declare "name" and a non-empty ` +
          '"dsh.profile.bundles" list',
      )
    }
    profiles[id] = { id, manifest, bundles: [...bundles], patch: readText(patchFile), packageFile, patchFile }
  }
  return { dir, profiles }
}

function renderPatch(text, { stateDir, port }) {
  return text
    .replaceAll('@STATE_DIR@', () => stateDir)
    .replaceAll('@SERVICE_PORT@', () => String(port))
}

/**
 * Render one profile's `package.json`: the template name/private/dsh block, the machine's dependency
 * values (preserved from the profile being migrated) and the template bands.
 */
export function renderProfilePackage(template, dependencies) {
  const manifest = template.manifest
  return {
    name: manifest.name,
    private: manifest.private !== false,
    dependencies: { ...dependencies },
    dsh: {
      ...(manifest.dsh ?? {}),
      profile: {
        ...(manifest.dsh?.profile ?? {}),
        bundles: [...template.bundles],
      },
    },
  }
}

/** Where the dsh-superagent package lives: the existing link, the env seam, then the usual checkout. */
export function superagentSource({ env = process.env, profileDir } = {}) {
  if (profileDir) {
    const file = join(profileDir, 'package.json')
    if (existsSync(file)) {
      try {
        const spec = readJson(file)?.dependencies?.['dsh-superagent']
        if (typeof spec === 'string' && spec.startsWith('link:')) {
          const target = spec.slice('link:'.length)
          if (target !== DSH_SUPERAGENT_PLACEHOLDER && target !== '') return resolve(expandHome(target, env))
        }
      } catch {
        // A broken package.json is reported by the caller; fall through to the machine default.
      }
    }
  }
  const configured = env.DSH_SUPERAGENT_PLUGIN_DIR
  if (configured) return resolve(expandHome(String(configured), env))
  return join(homeOf(env), 'opt', 'dsh-plugins', 'dsh-superagent')
}

function templateDependencies(template, { env, profileDir }) {
  const source = template.manifest.dependencies ?? {}
  const rendered = {}
  for (const [name, spec] of Object.entries(source)) {
    rendered[name] = spec === DSH_SUPERAGENT_PLACEHOLDER ? `link:${superagentSource({ env, profileDir })}` : spec
  }
  return rendered
}

function existsAsSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function linkTarget(path) {
  return resolve(dirname(path), readlinkSync(path))
}

function readLinkRecord(dir) {
  const file = join(dir, PROFILE_LINKS_FILE)
  if (!existsSync(file)) return { profile: null, linked: [] }
  try {
    const value = readJson(file)
    const linked = Array.isArray(value?.linked) ? value.linked : []
    return {
      profile: typeof value?.profile === 'string' ? value.profile : null,
      linked: linked
        .filter(item => typeof item?.name === 'string' && typeof item?.target === 'string')
        .map(item => ({ name: item.name, target: resolve(String(item.target)) })),
    }
  } catch {
    return { profile: null, linked: [] }
  }
}

/**
 * The symlinks a profile needs. `wca` links each `link:` dependency (dsh-superagent and, on a
 * migrated profile, wheelchair-agent). `wca-tui` links the dsh-tui scope directory from the dsh-tui
 * profile (never copied, never network-installed) and borrows the provider/billion-context packages
 * from a donor profile when dsh cannot resolve them from its own node_modules.
 */
function desiredLinks({ id, dir, dshHome, dependencies }) {
  const links = []
  const problems = []
  let critical = false
  if (id === WCA_PROFILE_ID) {
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      const target = resolve(String(spec.slice('link:'.length)))
      if (existsSync(target)) links.push({ name, target })
      else {
        problems.push({
          problem: `profile "wca": ${name} links to ${target}, which does not exist`,
          fix: 'install that plugin (or set DSH_SUPERAGENT_PLUGIN_DIR) and rerun "wheelchair-agent profiles sync"',
        })
      }
    }
    return { links, problems, critical }
  }

  const scopeTarget = join(dshHome, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui')
  if (existsSync(scopeTarget)) {
    links.push({ name: '@deepseek-harness-tui', target: scopeTarget })
  } else if (!existsSync(join(dir, 'node_modules', '@deepseek-harness-tui'))) {
    critical = true
    problems.push({
      problem: `profile "wca-tui" cannot load dsh-tui: ${scopeTarget} does not exist`,
      fix: 'install the dsh-tui profile, then run "bash install.sh" (spv falls back to dsh-tui meanwhile)',
    })
  }
  for (const name of ['@mars-sea/dsh-commandcode-provider', 'billion-context']) {
    if (existsSync(join(dshHome, 'node_modules', name))) continue
    // A real package in the profile is itself the answer; a symlink is ours to keep pointing at a
    // donor. Without the symlink case a second sync would see the link as "already there", stop
    // wanting it, and prune it as a stale recorded link.
    const path = join(dir, 'node_modules', name)
    if (existsSync(path) && !existsAsSymlink(path)) continue
    const donors = ['wca', 'dsh-tui', 'superagent'].map(profile => join(dshHome, 'profiles', profile, 'node_modules', name))
    const donor = donors.find(candidate => existsSync(candidate))
    if (donor) links.push({ name, target: donor })
    else {
      critical = true
      problems.push({
        problem: `profile "wca-tui" is missing ${name}`,
        fix: 'install the wca profile first, then rerun "bash wheelchair-agent profiles sync"',
      })
    }
  }
  return { links, problems, critical }
}

function applyLinks({ profileId, dir, links, problems }) {
  const result = { linked: [], kept: [], pruned: [], linksManifestChanged: false }
  const record = readLinkRecord(dir)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  const desiredNames = new Set(links.map(link => link.name))
  for (const { name, target } of links) {
    const path = join(dir, 'node_modules', name)
    mkdirSync(dirname(path), { recursive: true })
    const recorded = record.linked.find(item => item.name === name)
    if (existsAsSymlink(path)) {
      const current = linkTarget(path)
      if (current === resolve(target)) {
        result.kept.push({ name, target })
        continue
      }
      if (recorded === undefined || recorded.target !== current) {
        problems.push({
          problem: `profile "${profileId}": ${path} points at ${current}, not ${target}`,
          fix: 'remove it and rerun "wheelchair-agent profiles sync"',
        })
        continue
      }
      unlinkSync(path)
    } else if (existsSync(path)) {
      problems.push({
        problem: `profile "${profileId}": ${path} exists and is not a symlink`,
        fix: 'remove it and rerun "wheelchair-agent profiles sync"',
      })
      continue
    }
    symlinkSync(target, path, 'dir')
    result.linked.push({ name, target })
  }
  for (const recorded of record.linked) {
    if (desiredNames.has(recorded.name)) continue
    const path = join(dir, 'node_modules', recorded.name)
    if (!existsAsSymlink(path) || linkTarget(path) !== recorded.target) continue
    unlinkSync(path)
    result.pruned.push(recorded)
  }
  const manifest = { profile: profileId, linked: links.map(link => ({ name: link.name, target: link.target })) }
  result.linksManifestChanged = writeIfChanged(join(dir, PROFILE_LINKS_FILE), jsonText(manifest))
  return result
}

function readPackageOrNull(file) {
  if (!existsSync(file)) return null
  try {
    return readJson(file)
  } catch {
    return null
  }
}

function syncOneProfile({ id, dshHome, env, template, stateDir, port, notes, problems }) {
  const dir = join(dshHome, 'profiles', id)
  const existed = existsSync(dir)
  const current = existed ? readPackageOrNull(join(dir, 'package.json')) : null
  const preservedDependencies =
    current?.dependencies !== null &&
    typeof current?.dependencies === 'object' &&
    !Array.isArray(current?.dependencies) &&
    Object.keys(current.dependencies).length > 0
      ? { ...current.dependencies }
      : null
  const dependencies = preservedDependencies ?? templateDependencies(template, { env, profileDir: existed ? dir : null })
  const desired = desiredLinks({ id, dir, dshHome, dependencies })

  if (!existed && desired.critical) {
    problems.push(...desired.problems)
    notes.push(`profile "${id}" was not created; fix the problem above and rerun the install`)
    return { id, dir, skipped: true, created: false, bundleCount: template.bundles.length, links: [] }
  }

  if (!existed) mkdirSync(join(dir, 'node_modules'), { recursive: true })

  const packageChanged = writeIfChanged(
    join(dir, 'package.json'),
    jsonText(renderProfilePackage(template, dependencies)),
  )
  const patchChanged = writeIfChanged(join(dir, PROFILE_PATCH_FILE), renderPatch(template.patch, { stateDir, port }))
  if (!existsSync(join(dir, 'cordis.yml'))) writeIfChanged(join(dir, 'cordis.yml'), '[]\n')

  problems.push(...desired.problems)
  const links = applyLinks({ profileId: id, dir, links: desired.links, problems })
  return {
    id,
    dir,
    skipped: false,
    created: !existed,
    packageChanged,
    patchChanged,
    bundleCount: template.bundles.length,
    links,
  }
}

/**
 * One-time move of the single-deployment profile: `profiles/superagent` becomes `profiles/wca` whole,
 * so every node_modules link and the webui package move with it. Both present is not an error: the
 * new profile is used and the old one is only reported.
 */
function migrateLegacySuperagent({ dshHome, report }) {
  const target = join(dshHome, 'profiles', WCA_PROFILE_ID)
  const legacy = join(dshHome, 'profiles', LEGACY_SUPERAGENT_PROFILE_ID)
  if (existsSync(target)) {
    if (existsSync(legacy)) {
      report.notes.push(
        `profiles/${LEGACY_SUPERAGENT_PROFILE_ID} still exists; the deployments now use "wca" and the old ` +
          'profile is unused (it can be deleted by hand)',
      )
    }
    return
  }
  if (!existsSync(legacy)) return
  renameSync(legacy, target)
  report.migratedFrom = LEGACY_SUPERAGENT_PROFILE_ID
}

/**
 * Align both profiles, the deployment registry and the panel overlay with the templates.
 * Always writes; the CLI and install.sh are the only callers.
 */
export function syncProfiles(options = {}) {
  const env = options.env ?? process.env
  const dshHome = resolveDshHome({ dshHome: options.dshHome, env })
  const dataRoot = resolveDataRoot({ dataRoot: options.dataRoot, env })
  const stateDir = resolve(
    String(options.stateDir ?? env.DSH_SUPERAGENT_STATE_DIR ?? join(dshHome, 'state', 'superagent')),
  )
  const port = Number(options.port ?? env.DSH_SUPERAGENT_PORT ?? 3082)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid service port ${JSON.stringify(port)}`)
  const templates = readProfileTemplates({ templateDir: options.templateDir })
  const report = {
    dshHome,
    dataRoot,
    stateDir,
    port,
    migratedFrom: null,
    profiles: {},
    registry: null,
    panelOverlay: null,
    problems: [],
    notes: [],
    changed: false,
  }
  migrateLegacySuperagent({ dshHome, report })
  for (const id of PROFILE_IDS) {
    report.profiles[id] = syncOneProfile({
      id,
      dshHome,
      env,
      template: templates.profiles[id],
      stateDir,
      port,
      notes: report.notes,
      problems: report.problems,
    })
  }
  report.registry = migrateDeploymentRegistry({ dataRoot })
  report.problems.push(...report.registry.problems)
  const panelSource = resolvePanelOverlayTemplate({ panelOverlay: options.panelOverlay, templateDir: templates.dir })
  report.panelOverlay = writePanelOverlay({ dataRoot, source: panelSource })
  report.changed =
    report.migratedFrom !== null ||
    report.registry.changed ||
    report.panelOverlay.changed ||
    report.profiles[WCA_PROFILE_ID].created ||
    report.profiles[WCA_TUI_PROFILE_ID].created ||
    report.profiles[WCA_PROFILE_ID].packageChanged ||
    report.profiles[WCA_PROFILE_ID].patchChanged ||
    report.profiles[WCA_TUI_PROFILE_ID].packageChanged ||
    report.profiles[WCA_TUI_PROFILE_ID].patchChanged ||
    report.profiles[WCA_PROFILE_ID].links?.linked.length > 0 ||
    report.profiles[WCA_TUI_PROFILE_ID].links?.linked.length > 0 ||
    report.profiles[WCA_PROFILE_ID].links?.pruned.length > 0 ||
    report.profiles[WCA_TUI_PROFILE_ID].links?.pruned.length > 0
  return report
}

/**
 * Point every deployment at `wca`. The entries are the operator's file, so this only rewrites the
 * `profile` field (all other values, including their order, stay byte-identical) and refuses to touch
 * a file it cannot parse.
 */
export function migrateDeploymentRegistry({ dataRoot }) {
  const file = join(dataRoot, 'deployments.json')
  if (!existsSync(file)) return { file, exists: false, changed: false, entries: 0, problems: [] }
  let value
  try {
    value = readJson(file)
  } catch (error) {
    return {
      file,
      exists: true,
      changed: false,
      entries: 0,
      problems: [
        {
          problem: `the deployment registry at ${file} is not valid JSON (${error?.message ?? error})`,
          fix: 'fix it by hand; profiles sync never rewrites a broken registry',
        },
      ],
    }
  }
  if (value === null || typeof value !== 'object' || !Array.isArray(value.deployments)) {
    return {
      file,
      exists: true,
      changed: false,
      entries: 0,
      problems: [
        {
          problem: `the deployment registry at ${file} must hold a "deployments" list`,
          fix: 'fix it by hand; profiles sync never rewrites a broken registry',
        },
      ],
    }
  }
  let changed = false
  for (const entry of value.deployments) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (typeof entry.profile === 'string' && entry.profile !== WCA_PROFILE_ID) {
      entry.profile = WCA_PROFILE_ID
      changed = true
    }
  }
  if (changed) writeIfChanged(file, jsonText(value))
  return { file, exists: true, changed, entries: value.deployments.length, problems: [] }
}

/** Install `<data root>/deployments/panel.yml` (the panel overlay) from its template, write-if-changed. */
export function writePanelOverlay({ dataRoot, source }) {
  const file = join(dataRoot, 'deployments', PANEL_OVERLAY_FILE)
  const changed = writeIfChanged(file, readText(source))
  return { file, changed }
}

function compareProfile({ id, dir, dshHome, template, stateDir, port }) {
  const problems = []
  const fix = 'run "wheelchair-agent profiles sync"'
  if (!existsSync(dir)) {
    problems.push({ problem: `profile "${id}" is missing at ${dir}`, fix: 'run "bash install.sh" from the wheelchair-agent checkout' })
    return problems
  }
  const packageFile = join(dir, 'package.json')
  const current = readPackageOrNull(packageFile)
  if (current === null) {
    problems.push({ problem: `profile "${id}" has no readable package.json at ${packageFile}`, fix })
  } else {
    if (current.name !== template.manifest.name) {
      problems.push({ problem: `profile "${id}" is named ${JSON.stringify(current.name)}, expected ${JSON.stringify(template.manifest.name)}`, fix })
    }
    const bundles = current?.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || bundles.join('\n') !== template.bundles.join('\n')) {
      problems.push({ problem: `profile "${id}" bundles do not match the template`, fix })
    }
  }
  const patchFile = join(dir, PROFILE_PATCH_FILE)
  if (!existsSync(patchFile)) {
    problems.push({ problem: `profile "${id}" has no ${PROFILE_PATCH_FILE}`, fix })
  } else if (readText(patchFile).trimEnd() !== renderPatch(template.patch, { stateDir, port }).trimEnd()) {
    problems.push({ problem: `profile "${id}" patch does not match the template`, fix })
  }
  if (!existsSync(join(dir, 'cordis.yml'))) problems.push({ problem: `profile "${id}" has no cordis.yml`, fix })

  const currentDependencies = current?.dependencies ?? {}
  const desired = desiredLinks({ id, dir, dshHome, dependencies: currentDependencies })
  problems.push(...desired.problems)
  const record = readLinkRecord(dir)
  for (const link of desired.links) {
    const path = join(dir, 'node_modules', link.name)
    if (!existsAsSymlink(path)) {
      problems.push({ problem: `profile "${id}": ${path} is missing`, fix })
      continue
    }
    if (linkTarget(path) !== resolve(link.target)) {
      problems.push({ problem: `profile "${id}": ${path} points elsewhere`, fix })
    }
    if (!record.linked.some(item => item.name === link.name && item.target === resolve(link.target))) {
      problems.push({
        problem: `profile "${id}": ${PROFILE_LINKS_FILE} does not record ${link.name}`,
        fix,
      })
    }
  }
  return problems
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function overlayDisables(text, id) {
  const lines = text.split('\n')
  const header = new RegExp(`^-\\s*id:\\s*${escapeRegExp(id)}\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    if (!header.test(lines[index])) continue
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^- /.test(lines[next])) break
      if (/^\s+disabled:\s*true\s*(?:#.*)?$/.test(lines[next])) return true
    }
  }
  return false
}

function checkPanelOverlay({ dataRoot }) {
  const file = join(dataRoot, 'deployments', PANEL_OVERLAY_FILE)
  const fix = 'run "bash install.sh" from the wheelchair-agent checkout'
  if (!existsSync(file)) {
    return [{ problem: `the panel overlay is missing at ${file}`, fix }]
  }
  const text = readText(file)
  const problems = []
  for (const id of PANEL_DISABLED_IDS) {
    if (!overlayDisables(text, id)) {
      problems.push({ problem: `the panel overlay at ${file} does not disable ${JSON.stringify(id)}`, fix })
    }
  }
  return problems
}

function checkDeploymentRegistry({ dataRoot }) {
  const problems = []
  const notes = []
  const file = join(dataRoot, 'deployments.json')
  if (!existsSync(file)) {
    notes.push(`${file} does not exist yet; the first install registers the deployments`)
    return { problems, notes }
  }
  let value
  try {
    value = readJson(file)
  } catch (error) {
    problems.push({
      problem: `the deployment registry at ${file} is not valid JSON (${error?.message ?? error})`,
      fix: 'fix it by hand; profiles sync never rewrites a broken registry',
    })
    return { problems, notes }
  }
  const deployments = Array.isArray(value?.deployments) ? value.deployments : null
  if (deployments === null) {
    problems.push({ problem: `the deployment registry at ${file} must hold a "deployments" list`, fix: 'fix it by hand' })
    return { problems, notes }
  }
  const stale = deployments
    .filter(entry => entry !== null && typeof entry === 'object' && entry.profile !== WCA_PROFILE_ID)
    .map(entry => `${entry.project ?? '<unknown>'} (${JSON.stringify(entry.profile)})`)
  if (stale.length > 0) {
    problems.push({
      problem: `deployments.json still points at a legacy profile: ${stale.join(', ')}`,
      fix: 'run "wheelchair-agent profiles sync"',
    })
  }
  return { problems, notes }
}

/** Read-only check: both profiles match the templates, the registry uses `wca`, the overlay disables the four rows. */
export function checkProfiles(options = {}) {
  const env = options.env ?? process.env
  const dshHome = resolveDshHome({ dshHome: options.dshHome, env })
  const dataRoot = resolveDataRoot({ dataRoot: options.dataRoot, env })
  const stateDir = resolve(
    String(options.stateDir ?? env.DSH_SUPERAGENT_STATE_DIR ?? join(dshHome, 'state', 'superagent')),
  )
  const port = Number(options.port ?? env.DSH_SUPERAGENT_PORT ?? 3082)
  const templates = readProfileTemplates({ templateDir: options.templateDir })
  const problems = []
  const notes = []
  const wcaDir = join(dshHome, 'profiles', WCA_PROFILE_ID)
  const tuiDir = join(dshHome, 'profiles', WCA_TUI_PROFILE_ID)
  const legacy = join(dshHome, 'profiles', LEGACY_SUPERAGENT_PROFILE_ID)

  if (!existsSync(wcaDir) && existsSync(legacy)) {
    problems.push({
      problem: 'profile "wca" is missing; the old "superagent" profile is still installed',
      fix: 'run "bash install.sh" from the wheelchair-agent checkout to move it',
    })
  } else if (!existsSync(wcaDir)) {
    problems.push({
      problem: 'profile "wca" is missing',
      fix: 'run "bash install.sh" from the wheelchair-agent checkout',
    })
  } else {
    problems.push(...compareProfile({ id: WCA_PROFILE_ID, dir: wcaDir, dshHome, template: templates.profiles[WCA_PROFILE_ID], stateDir, port }))
  }
  if (!existsSync(tuiDir)) {
    problems.push({
      problem: 'profile "wca-tui" is missing',
      fix: 'run "bash install.sh" from the wheelchair-agent checkout',
    })
  } else {
    problems.push(
      ...compareProfile({ id: WCA_TUI_PROFILE_ID, dir: tuiDir, dshHome, template: templates.profiles[WCA_TUI_PROFILE_ID], stateDir, port }),
    )
  }

  if (existsSync(legacy) && existsSync(wcaDir)) {
    notes.push(`profiles/${LEGACY_SUPERAGENT_PROFILE_ID} is unused by any deployment and can be deleted by hand`)
  }
  for (const id of LEGACY_PANEL_PROFILE_IDS) {
    if (existsSync(join(dshHome, 'profiles', id))) {
      notes.push(`profiles/${id} is unused by any deployment and can be deleted by hand`)
    }
  }
  if (existsSync(join(dshHome, 'profiles', 'dsh-tui'))) {
    notes.push(
      'profiles/dsh-tui is not used by any deployment, but wca-tui links its dsh-tui package; keep it ' +
        'while wca-tui exists',
    )
    const leftover = join(dshHome, 'profiles', 'dsh-tui', 'node_modules', 'wheelchair-agent')
    if (existsSync(leftover)) {
      notes.push(
        'profiles/dsh-tui/node_modules/wheelchair-agent is an early leftover (version 0.1.0, not a ' +
          'declared dependency); it is unused and deletable',
      )
    }
  }

  const registry = checkDeploymentRegistry({ dataRoot })
  problems.push(...registry.problems)
  notes.push(...registry.notes)
  problems.push(...checkPanelOverlay({ dataRoot }))

  return { ok: problems.length === 0, dshHome, dataRoot, problems, notes }
}

/** Human-readable sync report; `changed` lines only when something was written. */
export function formatSyncReport(report) {
  const lines = []
  if (report.migratedFrom !== null) lines.push(`migrated: ${report.migratedFrom} -> ${WCA_PROFILE_ID}`)
  for (const id of PROFILE_IDS) {
    const profile = report.profiles[id]
    if (profile.skipped) continue
    const links = profile.links.linked.length + profile.links.kept.length
    lines.push(
      `synced: ${id} (${profile.bundleCount} bundles, ${links} link${links === 1 ? '' : 's'}` +
        `${profile.links.pruned.length > 0 ? `, ${profile.links.pruned.length} pruned` : ''})`,
    )
  }
  if (report.registry.exists) {
    lines.push(`${report.registry.changed ? 'updated' : 'ok'}: deployments.json (${report.registry.entries} entries)`)
  }
  lines.push(`${report.panelOverlay.changed ? 'updated' : 'ok'}: deployments/${PANEL_OVERLAY_FILE}`)
  for (const note of report.notes) lines.push(`note: ${note}`)
  for (const problem of report.problems) lines.push(`problem: ${problem.problem}\n  fix: ${problem.fix}`)
  return lines.join('\n')
}

export function formatCheckReport(report) {
  const lines = []
  for (const problem of report.problems) lines.push(`problem: ${problem.problem}\n  fix: ${problem.fix}`)
  for (const note of report.notes) lines.push(`note: ${note}`)
  if (report.ok) lines.unshift('ok: the wca and wca-tui profiles, deployments and panel overlay match')
  return lines.join('\n')
}

function cliValue(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

function main(argv) {
  const action = argv[0]
  if (action !== 'sync' && action !== 'check') {
    process.stderr.write('usage: node src/spv/profiles.js <sync|check> [--dsh-home <dir>] [--data-root <dir>] [--template-dir <dir>] [--panel-overlay <file>] [--state-dir <dir>] [--port <n>]\n')
    return 2
  }
  const options = {
    dshHome: cliValue(argv, '--dsh-home'),
    dataRoot: cliValue(argv, '--data-root'),
    templateDir: cliValue(argv, '--template-dir'),
    panelOverlay: cliValue(argv, '--panel-overlay'),
    stateDir: cliValue(argv, '--state-dir'),
    port: cliValue(argv, '--port'),
  }
  try {
    if (action === 'sync') {
      const report = syncProfiles(options)
      process.stdout.write(`${formatSyncReport(report)}\n`)
      return report.problems.length === 0 ? 0 : 1
    }
    const report = checkProfiles(options)
    process.stdout.write(`${formatCheckReport(report)}\n`)
    return report.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`profiles: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}

