/**
 * Plugin parity between the standalone panel and the deployment webui instances.
 *
 * Unit: the pure planner (blacklist, link selection, stale pruning) with injected probes.
 * Integration: a throwaway DSH_HOME whose "superagent" profile has fake packages, installed with the
 * real install.sh; then `panel sync` after a package disappears, `install.sh --check` red/green, and a
 * missing source profile that must leave the panel running on its current bundles.
 *
 * Run with `node tests/test-panel-profile.mjs`.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'bin', 'wheelchair-agent.mjs')
const INSTALL = join(ROOT, 'install.sh')
const PANEL_PROFILE = await import(join(ROOT, 'src', 'spv', 'panel-profile.js'))

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
function test(name, run) {
  try {
    run()
    ok(name)
  } catch (error) {
    no(name, error.message)
  }
}
function writePackage(file, name) {
  mkdirSync(file, { recursive: true })
  writeFileSync(
    join(file, 'package.json'),
    `${JSON.stringify({ name, version: '0.0.0', main: 'index.js' }, null, 2)}\n`,
  )
  writeFileSync(join(file, 'index.js'), 'module.exports = {}\n')
}

test('the CLI setting is read without filling or migrating the settings file', () => {
  const home = mkdtempSync(join(tmpdir(), 'wheelchair-setting-'))
  try {
    const data = join(home, 'data')
    const state = join(home, 'state')
    mkdirSync(data, { recursive: true })
    mkdirSync(state, { recursive: true })
    const file = join(data, 'settings.json')
    const text = '{"version":1,"revision":4,"values":{"panel.profileFrom":"staging","webui.style":"minimal"}}\n'
    writeFileSync(file, text)
    assert.equal(
      PANEL_PROFILE.readPanelSourceProfileSetting({
        env: { WHEELCHAIR_AGENT_HOME: data, DSH_SUPERAGENT_STATE_DIR: state },
      }),
      'staging',
    )
    assert.equal(readFileSync(file, 'utf8'), text, 'the settings file is not rewritten')
    assert.equal(
      PANEL_PROFILE.readPanelSourceProfileSetting({
        env: { WHEELCHAIR_AGENT_HOME: join(home, 'absent'), DSH_SUPERAGENT_STATE_DIR: state },
      }),
      undefined,
    )
    writeFileSync(join(state, 'panel-settings.json'), '{"version":1,"revision":1,"values":{"panel.profileFrom":"legacy"}}\n')
    assert.equal(
      PANEL_PROFILE.readPanelSourceProfileSetting({
        env: { WHEELCHAIR_AGENT_HOME: join(home, 'absent'), DSH_SUPERAGENT_STATE_DIR: state },
      }),
      'legacy',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ unit

test('panel.profileFrom defaults to superagent and its settings value wins', () => {
  assert.equal(PANEL_PROFILE.panelSourceProfile({}), 'superagent')
  assert.equal(
    PANEL_PROFILE.panelSourceProfile({ settings: { effective: { 'panel.profileFrom': 'staging' } } }),
    'staging',
  )
  assert.equal(
    PANEL_PROFILE.panelSourceProfile({ settings: { effective: { 'panel.profileFrom': '  ' } } }),
    'superagent',
  )
})

test('panel.profileFrom rejects path-shaped profile names', () => {
  for (const bad of ['..', '../superagent', '/etc', 'a/b', 'Super Agent', 'super_agent']) {
    assert.throws(
      () => PANEL_PROFILE.panelSourceProfile({ settings: { effective: { 'panel.profileFrom': bad } } }),
      /panel\.profileFrom/,
      `accepted ${JSON.stringify(bad)}`,
    )
  }
})

test('the panel profile cannot be its own source profile', () => {
  assert.throws(
    () => PANEL_PROFILE.panelSourceProfile({ settings: { effective: { 'panel.profileFrom': 'panel' } } }),
    /cannot mirror itself/,
  )
  assert.throws(
    () => PANEL_PROFILE.planPanelProfile({ dshHome: mkdtempSync(join(tmpdir(), 'wheelchair-self-')), sourceProfile: 'panel', bundles: [] }),
    /cannot mirror itself/,
  )
})

function planFixture(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wheelchair-plan-'))
  mkdirSync(join(home, 'profiles', 'panel', 'node_modules'), { recursive: true })
  const plan = PANEL_PROFILE.planPanelProfile({
    dshHome: home,
    sourceProfile: 'superagent',
    bundles: [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'dsh-superagent',
      'billion-context',
      'dsh-context',
      '@mars-sea/dsh-commandcode-provider',
    ],
    resolves: name =>
      name.startsWith('@deepseek-ai/') || name === 'billion-context',
    bundlesNow: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    linkState: () => ({ state: 'missing', target: null }),
    targetExists: () => true,
    ...overrides,
  })
  return { home, plan }
}

test('planning keeps the source order minus dsh-superagent', () => {
  const { home, plan } = planFixture()
  try {
    assert.deepEqual(plan.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'billion-context',
      'dsh-context',
      '@mars-sea/dsh-commandcode-provider',
    ])
    assert.deepEqual(plan.excluded, ['dsh-superagent'])
    assert.equal(plan.sourceMissing, false)
    assert.equal(plan.changed, true)
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }
})

test('only packages the dsh installation cannot resolve are linked', () => {
  const { home, plan } = planFixture()
  try {
    assert.deepEqual(Object.keys(plan.links).sort(), [
      '@mars-sea/dsh-commandcode-provider',
      'dsh-context',
    ])
    assert.equal(
      plan.links['dsh-context'],
      join(home, 'profiles', 'superagent', 'node_modules', 'dsh-context'),
    )
    assert.equal(plan.missingTargets.length, 0)
    const problems = PANEL_PROFILE.verifyPanelProfile(plan)
    assert.ok(problems.length > 0)
    assert.ok(problems.every(item => item.fix.includes('panel sync')))
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }
})

test('a missing source profile plans nothing and does not throw', () => {
  const home = mkdtempSync(join(tmpdir(), 'wheelchair-plan-'))
  try {
    const plan = PANEL_PROFILE.planPanelProfile({
      dshHome: home,
      sourceProfile: 'superagent',
      bundles: null,
    })
    assert.equal(plan.sourceMissing, true)
    assert.deepEqual(plan.bundles, [])
    assert.deepEqual(plan.links, {})
    assert.deepEqual(PANEL_PROFILE.verifyPanelProfile(plan), [])
    assert.throws(() => PANEL_PROFILE.planPanelProfile({ dshHome: 'relative/path' }), /absolute/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('stale links are only the recorded ones that are no longer needed', () => {
  const home = mkdtempSync(join(tmpdir(), 'wheelchair-plan-'))
  try {
    const goneTarget = join(home, 'profiles', 'superagent', 'node_modules', 'gone')
    const plan = PANEL_PROFILE.planPanelProfile({
      dshHome: home,
      sourceProfile: 'superagent',
      bundles: ['dsh-context'],
      resolves: () => false,
      bundlesNow: ['dsh-context'],
      recorded: [
        { name: 'gone', target: goneTarget },
        { name: 'dsh-context', target: join(home, 'profiles', 'superagent', 'node_modules', 'dsh-context') },
      ],
      linkState: name =>
        name === 'gone'
          ? { state: 'symlink', target: goneTarget }
          : { state: 'symlink', target: join(home, 'profiles', 'superagent', 'node_modules', 'dsh-context') },
      targetExists: () => true,
    })
    assert.deepEqual(plan.stale.map(item => item.name), ['gone'])
    assert.equal(plan.changed, true, 'a recorded link that is no longer needed is drift')
    const codes = plan.preexisting.map(item => item.code)
    assert.ok(codes.includes('link-stale'))
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }
})

test('a wrong link and a non-symlink are reported, not hidden', () => {
  const home = mkdtempSync(join(tmpdir(), 'wheelchair-plan-'))
  try {
    const plan = PANEL_PROFILE.planPanelProfile({
      dshHome: home,
      sourceProfile: 'superagent',
      bundles: ['dsh-context', 'dsh-other'],
      resolves: () => false,
      bundlesNow: ['dsh-context', 'dsh-other'],
      linkState: name =>
        name === 'dsh-context'
          ? { state: 'symlink', target: '/somewhere/else/dsh-context' }
          : { state: 'other', target: null },
      targetExists: () => true,
    })
    assert.deepEqual(plan.preexisting.map(item => item.code).sort(), ['link-other', 'link-wrong'])
    rmSync(home, { recursive: true, force: true })
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }
})

function sourcePatch({ secret = false, mixedInsert = false } = {}) {
  const items = [
    "    - id: wheelchair-spv",
    "      name: 'wheelchair-agent/spv-watch'",
  ]
  if (mixedInsert) {
    items.push("    - id: other-plugin", "      name: 'other-plugin'")
  }
  return [
    '# source profile patch',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    '    port: 3082',
    '- id: dsh-superagent',
    '  config:',
    '    stateDir: /home/someone/.dsh/state/superagent',
    '- id: agent-default-model',
    '  config:',
    '    provider: commandcode',
    '    model: deepseek/deepseek-v4.1-flash',
    '- insert:',
    ...items,
    '- id: web',
    '  config:',
    '    searchProvider: commandcode',
    '- id: ui-settings-general',
    "  name: '@deepseek-ai/dsh-client-ui-settings-general'",
    '  config:',
    '    welcomeNoticeVersion: 2026-09-28.1',
    '- id: llm-commandcode',
    '  config:',
    '    apiKeyEnv: COMMANDCODE_API_KEY',
    '    activeAccount: COMMANDCODE_API_KEY_3',
    ...(secret ? ['    apiKey: sk-literal-secret'] : []),
    '- insert:',
    '    - id: wheelchair-webui',
    "      name: 'wheelchair-agent-webui'",
    '- id: permission',
    '  config:',
    '    defaultPreset: danger-full-access',
    '- id: ui-theme',
    '  config:',
    '    preference: dark',
    '',
  ].join('\n')
}

test('the patch mirror keeps plugin rows in order and drops webserver/dsh-superagent/spv rows', () => {
  const patch = PANEL_PROFILE.buildPanelPatch({ sourceProfile: 'superagent', patchText: sourcePatch() })
  assert.match(patch.content, /Generated by `wheelchair-agent panel sync` from profile "superagent"/)
  assert.doesNotMatch(patch.content, /id: webserver/)
  assert.doesNotMatch(patch.content, /id: dsh-superagent/)
  assert.doesNotMatch(patch.content, /wheelchair-agent\/spv-watch/)
  for (const id of ['agent-default-model', 'web', 'llm-commandcode', 'permission', 'ui-theme']) {
    assert.match(patch.content, new RegExp(`^- id: ${id}$`, 'm'), `${id} is mirrored`)
  }
  const positions = ['agent-default-model', 'web', 'llm-commandcode', 'permission', 'ui-theme'].map(id =>
    patch.content.indexOf(`- id: ${id}\n`),
  )
  assert.deepEqual([...positions].sort((left, right) => left - right), positions, 'source order is preserved')
  assert.equal(patch.content.match(/^- id: ui-settings-general$/gm).length, 1, 'the managed ui-settings row appears once')
  assert.equal(patch.content.match(/wheelchair-agent-webui/g).length, 1, 'the loader row is not duplicated')
  assert.match(patch.content, /name: 'wheelchair-agent-webui'/)
  assert.ok(patch.content.trimEnd().endsWith('welcomeNoticeVersion: 2026-09-28.1'), 'the managed row stays last')
  assert.deepEqual(patch.skipped.filter(item => item.kind === 'id').map(item => item.id), [
    'webserver',
    'dsh-superagent',
  ])
  assert.deepEqual(patch.skipped.filter(item => item.kind === 'insert').flatMap(item => item.names), [
    'wheelchair-agent/spv-watch',
  ])
})

test('literal secrets are skipped with a note while credential references stay', () => {
  const patch = PANEL_PROFILE.buildPanelPatch({ sourceProfile: 'superagent', patchText: sourcePatch({ secret: true }) })
  assert.doesNotMatch(patch.content, /sk-literal-secret/)
  assert.match(patch.content, /apiKeyEnv: COMMANDCODE_API_KEY/)
  assert.match(patch.content, /activeAccount: COMMANDCODE_API_KEY_3/)
  assert.ok(patch.notes.some(note => note === 'the source profile pins a literal secret in llm-commandcode; the panel keeps the default'))
})

test('a mixed insert keeps the non-spv item and an all-spv insert is omitted', () => {
  const mixed = PANEL_PROFILE.buildPanelPatch({
    sourceProfile: 'superagent',
    patchText: sourcePatch({ mixedInsert: true }),
  })
  assert.match(mixed.content, /other-plugin/)
  assert.doesNotMatch(mixed.content, /wheelchair-agent\/spv-watch/)
  const onlySpv = PANEL_PROFILE.buildPanelPatch({
    sourceProfile: 'superagent',
    patchText: [
      '- insert:',
      '    - id: wheelchair-spv',
      "      name: 'wheelchair-agent/spv-tools'",
      '',
    ].join('\n'),
  })
  assert.equal(onlySpv.content.match(/^- insert:$/gm).length, 1, 'only the managed loader insert remains')
  assert.doesNotMatch(onlySpv.content, /spv-tools/)
})

test('a missing source patch keeps the managed rows and a note', () => {
  const patch = PANEL_PROFILE.buildPanelPatch({ sourceProfile: 'superagent', patchText: null })
  assert.match(patch.content, /wheelchair-agent-webui/)
  assert.match(patch.content, /ui-settings-general/)
  assert.equal(patch.rows.length, 0)
  assert.ok(patch.notes.some(note => note.includes('has no cordis.patch.yml')))
})

test('sync writes the manifest, links and record, then prunes only its own stale link', () => {
  const home = mkdtempSync(join(tmpdir(), 'wheelchair-sync-'))
  try {
    const source = join(home, 'profiles', 'superagent')
    const panel = join(home, 'profiles', 'panel')
    mkdirSync(join(panel, 'node_modules'), { recursive: true })
    writePackage(join(source, 'node_modules', 'dsh-context'), 'dsh-context')
    writePackage(join(source, 'node_modules', 'extra-plugin'), 'extra-plugin')
    writeFileSync(
      join(source, 'package.json'),
      `${JSON.stringify({
        name: 'dsh-profile-superagent',
        private: true,
        dsh: { profile: { bundles: ['dsh-context', 'dsh-superagent', 'extra-plugin'] } },
      })}\n`,
    )
    const resolves = name => name === 'dsh-superagent'
    const first = PANEL_PROFILE.syncPanelProfile({ dshHome: home, sourceProfile: 'superagent', resolves })
    assert.deepEqual(first.bundles, ['dsh-context', 'extra-plugin'])
    assert.equal(first.linkCount, 2)
    assert.equal(
      readlinkSync(join(panel, 'node_modules', 'dsh-context')),
      join(source, 'node_modules', 'dsh-context'),
    )
    const record = JSON.parse(readFileSync(join(panel, 'panel-bundles.json'), 'utf8'))
    assert.deepEqual(record.linked.map(item => item.name), ['dsh-context', 'extra-plugin'])

    // A link this module did not create must survive a sync that no longer wants it.
    const foreign = join(panel, 'node_modules', 'foreign')
    symlinkSync(join(home, 'somewhere', 'foreign'), foreign)
    writeFileSync(
      join(source, 'package.json'),
      `${JSON.stringify({
        name: 'dsh-profile-superagent',
        private: true,
        dsh: { profile: { bundles: ['dsh-context'] } },
      })}\n`,
    )
    const second = PANEL_PROFILE.syncPanelProfile({ dshHome: home, sourceProfile: 'superagent', resolves })
    assert.deepEqual(second.pruned, ['extra-plugin'])
    assert.equal(existsSync(join(panel, 'node_modules', 'extra-plugin')), false)
    assert.deepEqual(JSON.parse(readFileSync(join(panel, 'panel-bundles.json'), 'utf8')).linked.map(item => item.name), [
      'dsh-context',
    ])
    assert.equal(readlinkSync(foreign), join(home, 'somewhere', 'foreign'))
    const third = PANEL_PROFILE.syncPanelProfile({ dshHome: home, sourceProfile: 'superagent', resolves })
    assert.equal(third.changed, false, 'a second sync is a no-op')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ----------------------------------------------------------- integration

function makeBox() {
  const base = mkdtempSync(join(tmpdir(), 'wheelchair-panel-profile-'))
  const box = {
    base,
    home: join(base, 'home'),
    dsh: join(base, 'dsh'),
    tools: join(base, 'tools'),
    queue: join(base, 'queue'),
    bin: join(base, 'bin'),
  }
  for (const dir of [box.home, box.tools, box.queue]) mkdirSync(dir, { recursive: true })
  const source = join(box.dsh, 'profiles', 'superagent')
  writePackage(join(source, 'node_modules', 'dsh-context'), 'dsh-context')
  writePackage(join(source, 'node_modules', '@mars-sea', 'dsh-commandcode-provider'), '@mars-sea/dsh-commandcode-provider')
  writePackage(join(box.dsh, 'node_modules', 'billion-context'), 'billion-context')
  writeFileSync(
    join(source, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-superagent',
        private: true,
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              '@deepseek-ai/dsh-web-app',
              'dsh-superagent',
              'billion-context',
              'dsh-context',
              '@mars-sea/dsh-commandcode-provider',
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(source, 'cordis.patch.yml'), sourcePatch({ secret: true }))
  writeFileSync(join(box.tools, 'dsh-tui'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(
    join(box.tools, 'fake-probe'),
    '#!/bin/sh\nprintf "service_pids=\\nspv_pids=\\nservice_port=3082\\npreset_patch=/fake/preset-default.patch.yml\\n"\n',
    { mode: 0o755 },
  )
  return box
}

function envFor(box, extra = {}) {
  const env = { ...process.env }
  for (const key of [
    'SPV_QUEUE_DIR', 'SPV_SUPERAGENT_URL', 'SPV_SUPERAGENT_PORT', 'DSH_SUPERAGENT_PORT',
    'SPV_SERVICE_PORT', 'DSH_SUPERAGENT_PROFILE', 'SPV_PANEL_PORT', 'WHEELCHAIR_AGENT_OPEN',
    'DSH_SUPERAGENT_URL', 'SPV_PROJECTS_ROOT', 'DSH_BIN',
  ]) delete env[key]
  return {
    ...env,
    HOME: box.home,
    DSH_HOME: box.dsh,
    SPV_BIN_DIR: box.bin,
    SPV_QUEUE_DIR: box.queue,
    SPV_PROJECTS_ROOT: join(box.home, 'bioagentforge'),
    WHEELCHAIR_AGENT_HOME: join(box.home, '.wheelchair-agent'),
    DSH_SUPERAGENT_STATE_DIR: join(box.dsh, 'state', 'superagent'),
    SPV_INSTALL_PROBE: join(box.tools, 'fake-probe'),
    SPV_SERVICE_PORT: '3082',
    PATH: `${box.tools}:${process.env.PATH ?? ''}`,
    ...extra,
  }
}

function run(file, argv, box, extra = {}) {
  const result = spawnSync(file, argv, { cwd: ROOT, env: envFor(box, extra), encoding: 'utf8', timeout: 120_000 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function install(box) {
  const artifact = join(ROOT, 'build', 'artifacts', 'wheelchair-agent-core-linux-x64')
  assert.ok(existsSync(artifact), `the core artifact is missing (run bash build/build-core.sh): ${artifact}`)
  const result = run('bash', [INSTALL, '--project', 'tools/wheelchair-agent'], box, {
    SPV_INSTALL_CORE_ARTIFACT: artifact,
  })
  assert.equal(result.status, 0, `install.sh failed:\n${result.stdout}\n${result.stderr}`)
}

function cli(box, argv) {
  return run(process.execPath, [CLI, ...argv], box)
}

function check(box) {
  const artifact = join(ROOT, 'build', 'artifacts', 'wheelchair-agent-core-linux-x64')
  return run('bash', [INSTALL, '--check', '--project', 'tools/wheelchair-agent'], box, {
    SPV_INSTALL_CORE_ARTIFACT: artifact,
  })
}

function panelManifest(box) {
  return JSON.parse(readFileSync(join(box.dsh, 'profiles', 'panel', 'package.json'), 'utf8'))
}
function panelRecord(box) {
  return JSON.parse(readFileSync(join(box.dsh, 'profiles', 'panel', 'panel-bundles.json'), 'utf8'))
}

let box = null
try {
  box = makeBox()
  install(box)
  const panel = join(box.dsh, 'profiles', 'panel')

  test('install mirrors the source bundles without dsh-superagent', () => {
    assert.deepEqual(panelManifest(box).dsh.profile.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'billion-context',
      'dsh-context',
      '@mars-sea/dsh-commandcode-provider',
    ])
    assert.equal(JSON.stringify(panelManifest(box)).includes('dsh-superagent'), false)
  })

  test('install links only the packages dsh does not resolve', () => {
    assert.deepEqual(panelRecord(box).linked.map(item => item.name), [
      '@mars-sea/dsh-commandcode-provider',
      'dsh-context',
    ])
    assert.equal(existsSync(join(panel, 'node_modules', 'billion-context')), false, 'dsh-resolvable package is not shadowed')
    assert.equal(
      readlinkSync(join(panel, 'node_modules', 'dsh-context')),
      join(box.dsh, 'profiles', 'superagent', 'node_modules', 'dsh-context'),
    )
  })

  test('panel sync is idempotent and reports its bundle/link counts', () => {
    const result = cli(box, ['panel', 'sync'])
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /^synced: 5 bundle\(s\), 2 link\(s\)$/m)
    assert.match(result.stdout, /literal secret in llm-commandcode/)
  })

  test('install mirrors the source patch and skips panel-owned rows', () => {
    const patch = readFileSync(join(panel, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /Generated by `wheelchair-agent panel sync` from profile "superagent"/)
    assert.doesNotMatch(patch, /id: webserver/)
    assert.doesNotMatch(patch, /id: dsh-superagent/)
    assert.doesNotMatch(patch, /wheelchair-agent\/spv-watch/)
    assert.doesNotMatch(patch, /sk-literal-secret/)
    for (const id of ['agent-default-model', 'web', 'llm-commandcode', 'permission', 'ui-theme']) {
      assert.match(patch, new RegExp(`^- id: ${id}$`, 'm'))
    }
    assert.match(patch, /apiKeyEnv: COMMANDCODE_API_KEY/)
    assert.equal(patch.match(/^- insert:$/gm).length, 1, 'only the panel loader insert remains')
    assert.equal(patch.match(/^- id: ui-settings-general$/gm).length, 1)
  })

  test('a source patch change is followed by panel sync', () => {
    const source = join(box.dsh, 'profiles', 'superagent', 'cordis.patch.yml')
    const before = readFileSync(source, 'utf8')
    writeFileSync(source, before.replace('preference: dark', 'preference: light'))
    try {
      const synced = cli(box, ['panel', 'sync'])
      assert.equal(synced.status, 0, `${synced.stdout}\n${synced.stderr}`)
      assert.match(readFileSync(join(panel, 'cordis.patch.yml'), 'utf8'), /preference: light/)
      assert.equal(check(box).status, 0)
    } finally {
      writeFileSync(source, before)
      assert.equal(cli(box, ['panel', 'sync']).status, 0)
    }
  })

  test('install.sh --check is red on patch drift and panel sync fixes it', () => {
    const file = join(panel, 'cordis.patch.yml')
    const before = readFileSync(file, 'utf8')
    writeFileSync(file, before.replace('preference: dark', 'preference: light'))
    const red = check(box)
    assert.equal(red.status, 2, `${red.stdout}\n${red.stderr}`)
    assert.match(red.stdout, /cordis\.patch\.yml differs from profile "superagent" at ui-theme/)
    assert.equal(cli(box, ['panel', 'sync']).status, 0)
    assert.equal(check(box).status, 0)
  })

  test('install.sh --check is green after install', () => {
    const result = check(box)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /panel plugins: mirrors profile "superagent"/)
  })

  test('a source package disappearing prunes its link and updates the record', () => {
    const source = join(box.dsh, 'profiles', 'superagent')
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(
      name => name !== '@mars-sea/dsh-commandcode-provider',
    )
    writeFileSync(join(source, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    rmSync(join(source, 'node_modules', '@mars-sea'), { recursive: true, force: true })
    const foreign = join(panel, 'node_modules', 'foreign')
    symlinkSync(join(box.home, 'somewhere', 'foreign'), foreign)
    const result = cli(box, ['panel', 'sync'])
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /^synced: 4 bundle\(s\), 1 link\(s\)$/m)
    assert.equal(existsSync(join(panel, 'node_modules', '@mars-sea', 'dsh-commandcode-provider')), false)
    assert.equal(existsSync(join(panel, 'node_modules', '@mars-sea')), true, 'the shared scope directory stays')
    assert.equal(readlinkSync(foreign), join(box.home, 'somewhere', 'foreign'))
    assert.deepEqual(panelRecord(box).linked.map(item => item.name), ['dsh-context'])
    rmSync(foreign, { force: true })
  })

  test('install.sh --check reports drift and panel sync fixes it', () => {
    const manifest = panelManifest(box)
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'dsh-context')
    writeFileSync(join(panel, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const red = check(box)
    assert.equal(red.status, 2, `${red.stdout}\n${red.stderr}`)
    assert.match(red.stdout, /bundles differ from profile "superagent"/)
    const synced = cli(box, ['panel', 'sync'])
    assert.equal(synced.status, 0, `${synced.stdout}\n${synced.stderr}`)
    const green = check(box)
    assert.equal(green.status, 0, `${green.stdout}\n${green.stderr}`)
  })

  test('a missing source profile keeps the current bundles and stays green', () => {
    const source = join(box.dsh, 'profiles', 'superagent', 'package.json')
    const before = readFileSync(join(panel, 'package.json'), 'utf8')
    const backup = `${source}.gone`
    writeFileSync(backup, readFileSync(source))
    rmSync(source)
    try {
      const synced = cli(box, ['panel', 'sync'])
      assert.equal(synced.status, 0, `${synced.stdout}\n${synced.stderr}`)
      assert.match(synced.stdout, /kept the current panel profile/)
      assert.equal(readFileSync(join(panel, 'package.json'), 'utf8'), before, 'the panel manifest is untouched')
      const green = check(box)
      assert.equal(green.status, 0, `${green.stdout}\n${green.stderr}`)
    } finally {
      writeFileSync(source, readFileSync(backup))
      rmSync(backup, { force: true })
    }
  })

  test('panel status prints the mirrored profile and no drift', () => {
    const result = cli(box, ['panel', 'status'])
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /plugins: mirrors profile "superagent" \(4 bundles; dsh-superagent excluded\)/)
    assert.match(
      result.stdout,
      /config:\s+mirrors 6 patch row\(s\) from "superagent" \(webserver, dsh-superagent, wheelchair-\* inserts skipped\)/,
    )
    assert.match(result.stdout, /drift:\s+none/)
  })
} finally {
  if (box !== null) rmSync(box.base, { recursive: true, force: true })
}

process.stdout.write(`\n${PASS} passed, ${FAIL} failed\n`)
process.exit(FAIL === 0 ? 0 : 1)
