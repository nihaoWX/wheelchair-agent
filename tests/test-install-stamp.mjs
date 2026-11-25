#!/usr/bin/env node
/**
 * tests/test-install-stamp.mjs — offline evidence for the install fingerprint and stamp.
 *
 * Covers the contract in `src/shared/install-stamp.js`:
 *   - `normalizeYaml` ignores comments (full-line and trailing) outside quotes, preserves quoted `#`,
 *     preserves block-scalar content verbatim, and still notices a value change;
 *   - formatting-only YAML edits (indentation) still change the digest: the documented residual;
 *   - `fingerprintComponents` compares a comment-only preset change as identical, a webui code change as
 *     different, and represents a missing bin file / core binary as a sentinel;
 *   - `compareFingerprints` reports changed/added/removed counts and file names per component;
 *   - `writeStamp`/`readStamp` round-trip atomically at 0644 and tolerate missing or corrupt files;
 *   - the CLI contract: `component`, `fingerprint`, `write`, `verify` exit codes 0/1/3/4 and bad
 *     arguments exit 2.
 *
 * Everything runs in `mkdtemp` sandboxes; no network, no dsh, no real install.
 *
 * Usage: node tests/test-install-stamp.mjs
 * Exit status: 0 when every check passes, 1 otherwise.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BIN_COMPONENT_FILES,
  CORE_COMPONENT_FILE,
  INSTALL_STAMP_FILE,
  INSTALL_STAMP_VERSION,
  compareFingerprints,
  fingerprintComponents,
  installStampPath,
  normalizeYaml,
  readStamp,
  sha256File,
  sha256Text,
  writeStamp,
} from '../src/shared/install-stamp.js'
import {
  CORE_STAMP_FILE,
  coreSourcesDigest,
  inspectCore,
  readCoreStamp,
} from '../src/shared/core-stamp.js'

const MODULE = fileURLToPath(new URL('../src/shared/install-stamp.js', import.meta.url))
const CORE_STAMP_CLI = fileURLToPath(new URL('../src/shared/core-stamp.js', import.meta.url))
const PRESET_YML = fileURLToPath(new URL('../preset/agent.cordis.yml', import.meta.url))

let pass = 0
let fail = 0

async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${name}`)
    console.log(`      ${String(error?.message ?? error).split('\n').join('\n      ')}`)
  }
}

/** One CLI invocation of the module itself; returns spawnSync's result. */
function cli(args) {
  return spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8' })
}

/** Write a synthetic preset tree: the two real preset file names, with `agent` as the YAML body. */
async function writePresetTree(dir, agent, preset = 'name: spv\n') {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'agent.cordis.yml'), agent)
  await writeFile(join(dir, 'preset.yml'), preset)
  return dir
}

/** A fabricated component (only `digest` + `files` matter for compareFingerprints). */
function component(files, extra = {}) {
  return { digest: `sha256:${Object.keys(files).sort().join('-') || 'empty'}`, files, ...extra }
}

function fingerprintOf(components, version = INSTALL_STAMP_VERSION) {
  return { version, components }
}

const sandbox = await mkdtemp(join(tmpdir(), 'wheelchair-agent-install-stamp-test-'))
try {
  // ------------------------------------------------------------------ normalizeYaml

  await check('normalizeYaml: appending a full-line comment to the real preset changes nothing', async () => {
    const base = await readFile(PRESET_YML, 'utf8')
    assert.equal(normalizeYaml(base), normalizeYaml(`${base}\n# a comment-only merge\n`))
  })

  await check('normalizeYaml: inserting a full-line comment between lines changes nothing', async () => {
    const base = await readFile(PRESET_YML, 'utf8')
    const lines = base.split('\n')
    const inserted = [...lines.slice(0, 5), '# inserted by a comment-only PR', ...lines.slice(5)].join('\n')
    assert.equal(normalizeYaml(base), normalizeYaml(inserted))
  })

  await check('normalizeYaml: a trailing comment is stripped but a quoted # is content', async () => {
    const text = [
      "name: 'has # hash'",
      'command: "quoted \\" # not a comment"',
      'plain: value # trailing comment',
      "single: 'a''b # stays'",
      '',
    ].join('\n')
    const normalized = normalizeYaml(text)
    assert.match(normalized, /name: 'has # hash'/)
    assert.match(normalized, /quoted \\" # not a comment/)
    assert.match(normalized, /plain: value\n/)
    assert.match(normalized, /single: 'a''b # stays'/)
  })

  await check('normalizeYaml: block-scalar content (including # lines) is preserved verbatim', async () => {
    const text = ['section: |', '  first # not a comment', '  # second, also content', 'next: 1', ''].join('\n')
    const normalized = normalizeYaml(text)
    assert.equal(normalized, 'section: |\n  first # not a comment\n  # second, also content\nnext: 1\n')
  })

  await check('normalizeYaml: blank lines inside a block scalar are content', async () => {
    const one = normalizeYaml('section: |\n  one\n  two\nnext: 1\n')
    const broken = normalizeYaml('section: |\n  one\n\n  two\nnext: 1\n')
    assert.equal(one, 'section: |\n  one\n  two\nnext: 1\n')
    assert.equal(broken, 'section: |\n  one\n\n  two\nnext: 1\n')
    assert.notEqual(one, broken)
  })

  await check('normalizeYaml: blank lines after a block scalar are not content', async () => {
    assert.equal(
      normalizeYaml('section: |\n  one\n\nnext: 1\n'),
      normalizeYaml('section: |\n  one\nnext: 1\n'),
    )
  })

  await check('normalizeYaml: an apostrophe in a plain scalar does not open a quote', async () => {
    assert.equal(normalizeYaml("note: it's fine # old\n"), normalizeYaml("note: it's fine # new\n"))
    assert.equal(
      normalizeYaml("note: 'quoted # content' # old\n"),
      normalizeYaml("note: 'quoted # content' # new\n"),
    )
  })

  await check('normalizeYaml: block headers with indicators call out their content', async () => {
    const indented = normalizeYaml('section: |2\n    one\n    # two\n')
    assert.equal(indented, 'section: |2\n    one\n    # two\n')
    assert.notEqual(indented, normalizeYaml('section: |2\n    one\n    # THREE\n'))
    assert.equal(normalizeYaml('section: |-2 # header note\n  one\n'), 'section: |-2\n  one\n')
    assert.equal(normalizeYaml('section: >+2\n  one\n'), 'section: >+2\n  one\n')
  })

  await check('normalizeYaml: a + chomping header keeps trailing blank lines', async () => {
    assert.equal(normalizeYaml('section: |+\n  one\n'), 'section: |+\n  one\n')
    assert.equal(normalizeYaml('section: |+\n  one\n\n'), 'section: |+\n  one\n\n')
    assert.notEqual(normalizeYaml('section: |+\n  one\n'), normalizeYaml('section: |+\n  one\n\n'))
    // A trailing comment after the block is not content, so it must not change the digest.
    assert.equal(normalizeYaml('section: |+\n  one\n'), normalizeYaml('section: |+\n  one\n# note\n'))
  })

  await check('normalizeYaml: a tag or anchor before a quoted scalar does not swallow its #', async () => {
    assert.equal(
      normalizeYaml("k: !!str 'a # b' # old\n"),
      normalizeYaml("k: !!str 'a # b' # new\n"),
    )
    assert.match(normalizeYaml("k: !!str 'a # b' # old\n"), /k: !!str 'a # b'\n/)
    assert.equal(
      normalizeYaml('k: &a "x # y" # old\n'),
      normalizeYaml('k: &a "x # y" # new\n'),
    )
  })

  await check('normalizeYaml: a tag right after a flow opener still opens its quote', async () => {
    assert.equal(
      normalizeYaml("k: [!!str 'a # b', x] # old\n"),
      normalizeYaml("k: [!!str 'a # b', x] # new\n"),
    )
    assert.match(normalizeYaml("k: [!!str 'a # b', x] # old\n"), /\[!!str 'a # b', x\]\n/)
  })

  await check('normalizeYaml: a block indicator must be separated from its key', async () => {
    // `k: a:|` is a plain scalar ("a:|"), so the indented line below is a comment, not content.
    assert.equal(normalizeYaml('k: a:|\n  # old\n'), normalizeYaml('k: a:|\n  # new\n'))
    assert.equal(normalizeYaml('k: a:|\n  # kept\n'), 'k: a:|\n')
    assert.equal(normalizeYaml('k: a:| # old\n'), normalizeYaml('k: a:| # new\n'))
  })

  await check('normalizeYaml: a paragraph break in the real preset changes the digest', async () => {
    const base = await readFile(PRESET_YML, 'utf8')
    const changed = base.replace(/(You are in plan mode\.[^\n]*\n)/, '$1\n')
    assert.notEqual(base, changed)
    assert.notEqual(normalizeYaml(base), normalizeYaml(changed))
  })

  await check('normalizeYaml: a value change differs', async () => {
    assert.notEqual(normalizeYaml('a: 1\n'), normalizeYaml('a: 2\n'))
  })

  await check('normalizeYaml: indentation-only change differs (documented residual)', async () => {
    // Formatting is preserved on purpose: only comments are canonically invisible. A re-indented file
    // is still a real diff in the installed copy, so --check may report it stale.
    assert.notEqual(normalizeYaml('a: 1\n'), normalizeYaml('a:  1\n'))
  })

  // --------------------------------------------------------- fingerprintComponents

  await check('fingerprint: a comment-only preset change has the same preset digest', async () => {
    const one = await writePresetTree(join(sandbox, 'preset-one'), 'a: 1 # old\nb: 2\n')
    const two = await writePresetTree(join(sandbox, 'preset-two'), 'a: 1 # new\n# a comment line\nb: 2\n')
    const first = fingerprintComponents({ presetDir: one })
    const second = fingerprintComponents({ presetDir: two })
    assert.equal(first.components.preset.digest, second.components.preset.digest)
  })

  await check('fingerprint: a value change has a different preset digest and names the file', async () => {
    const one = await writePresetTree(join(sandbox, 'preset-value-a'), 'a: 1\n')
    const two = await writePresetTree(join(sandbox, 'preset-value-b'), 'a: 2\n')
    const first = fingerprintComponents({ presetDir: one }).components.preset
    const second = fingerprintComponents({ presetDir: two }).components.preset
    assert.notEqual(first.digest, second.digest)
    assert.deepEqual(Object.keys(first.files), ['agent.cordis.yml', 'preset.yml'])
    assert.notEqual(first.files['agent.cordis.yml'], second.files['agent.cordis.yml'])
  })

  await check('fingerprint: preset digest does not depend on the absolute path', async () => {
    const one = await writePresetTree(join(sandbox, 'preset-path-a'), 'a: 1\n')
    const two = await writePresetTree(join(sandbox, 'preset-path-b'), 'a: 1\n')
    assert.equal(
      fingerprintComponents({ presetDir: one }).components.preset.digest,
      fingerprintComponents({ presetDir: two }).components.preset.digest,
    )
  })

  await check('fingerprint: a webui code change has a different digest', async () => {
    const one = join(sandbox, 'webui-a')
    const two = join(sandbox, 'webui-b')
    await mkdir(join(one, 'lib'), { recursive: true })
    await mkdir(join(two, 'lib'), { recursive: true })
    await writeFile(join(one, 'lib', 'index.js'), 'export const a = 1\n')
    await writeFile(join(two, 'lib', 'index.js'), '// a comment\n// a comment\nexport const a = 1\n')
    assert.notEqual(
      fingerprintComponents({ webuiDir: one }).components.webui.digest,
      fingerprintComponents({ webuiDir: two }).components.webui.digest,
    )
  })

  await check('fingerprint: bin records every fixed name and a "missing" sentinel', async () => {
    const bin = join(sandbox, 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'wheelchair-agent'), '#!/bin/sh\n')
    await writeFile(join(bin, 'unrelated'), 'ignored\n')
    const result = fingerprintComponents({ binDir: bin }).components.bin
    assert.deepEqual(Object.keys(result.files).sort(), [...BIN_COMPONENT_FILES].sort())
    assert.ok(result.files['wheelchair-agent'].startsWith('sha256:'))
    assert.equal(result.files.spv, 'missing')
    assert.equal(result.files['superagent-service'], 'missing')
    assert.equal(result.files.jobctl, 'missing')
    assert.ok(!Object.hasOwn(result.files, 'unrelated'))
    assert.ok(result.digest.startsWith('sha256:'))
  })

  await check('fingerprint: a missing core is a null-digest sentinel', async () => {
    const result = fingerprintComponents({ coreBinary: join(sandbox, 'no-such-core') }).components.core
    assert.deepEqual(result, { digest: null, missing: true, files: {} })
  })

  await check('fingerprint: the core component uses the fixed basename, not the artifact name', async () => {
    const artifact = join(sandbox, 'wheelchair-agent-core-linux-x64')
    await writeFile(artifact, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    const result = fingerprintComponents({ coreBinary: artifact }).components.core
    assert.equal(result.missing, false)
    assert.deepEqual(Object.keys(result.files), [CORE_COMPONENT_FILE])
    assert.equal(result.files[CORE_COMPONENT_FILE], await sha256File(artifact))
  })

  await check('fingerprint: missing directories do not throw', async () => {
    const result = fingerprintComponents({
      presetDir: join(sandbox, 'absent-preset'),
      webuiDir: join(sandbox, 'absent-webui'),
      binDir: join(sandbox, 'absent-bin'),
      coreBinary: join(sandbox, 'absent-core'),
    })
    assert.deepEqual(result.components.preset.files, {})
    assert.deepEqual(result.components.webui.files, {})
    assert.equal(result.version, INSTALL_STAMP_VERSION)
  })

  await check('sha256Text / installStampPath: documented shapes', async () => {
    assert.match(sha256Text('hello'), /^sha256:[0-9a-f]{64}$/)
    assert.equal(sha256Text('hello'), sha256Text('hello'))
    assert.notEqual(sha256Text('hello'), sha256Text('hello\n'))
    assert.equal(installStampPath('/data/root'), join('/data/root', INSTALL_STAMP_FILE))
  })

  // ------------------------------------------------------------ compareFingerprints

  await check('compare: changed/added/removed counts and sorted names', async () => {
    const installed = fingerprintOf({ preset: component({ 'a.yml': 'sha256:1', 'b.yml': 'sha256:2' }) })
    const current = fingerprintOf({ preset: component({ 'a.yml': 'sha256:9', 'c.yml': 'sha256:3' }) })
    const comparison = compareFingerprints(installed, current)
    assert.equal(comparison.same, false)
    assert.equal(comparison.versionMismatch, false)
    assert.equal(comparison.changes.length, 1)
    assert.deepEqual(comparison.changes[0], {
      component: 'preset',
      count: 3,
      changed: ['a.yml'],
      added: ['c.yml'],
      removed: ['b.yml'],
      coreMissing: false,
    })
  })

  await check('compare: identical fingerprints are same', async () => {
    const files = { 'a.yml': 'sha256:1' }
    const installed = fingerprintOf({ preset: component(files), core: component({ [CORE_COMPONENT_FILE]: 'sha256:c' }) })
    const current = fingerprintOf({ preset: component(files), core: component({ [CORE_COMPONENT_FILE]: 'sha256:c' }) })
    assert.equal(compareFingerprints(installed, current).same, true)
  })

  await check('compare: core missing-vs-present counts once and names the file', async () => {
    const installed = fingerprintOf({ core: { digest: null, missing: true, files: {} } })
    const current = fingerprintOf({ core: component({ [CORE_COMPONENT_FILE]: 'sha256:c' }) })
    const comparison = compareFingerprints(installed, current)
    assert.equal(comparison.changes.length, 1)
    assert.deepEqual(comparison.changes[0], {
      component: 'core',
      count: 1,
      changed: [],
      added: [CORE_COMPONENT_FILE],
      removed: [],
      coreMissing: true,
    })
  })

  await check('compare: a stamp version change is not "same"', async () => {
    const installed = fingerprintOf({}, 0)
    const current = fingerprintOf({}, INSTALL_STAMP_VERSION)
    const comparison = compareFingerprints(installed, current)
    assert.equal(comparison.same, false)
    assert.equal(comparison.versionMismatch, true)
  })

  // --------------------------------------------------------------- write/readStamp

  await check('stamp: round-trips at 0644 with no temporary file left behind', async () => {
    const file = join(sandbox, 'data', INSTALL_STAMP_FILE)
    const stamp = {
      version: INSTALL_STAMP_VERSION,
      commit: 'deadbeef',
      installedAt: '2026-01-02T03:04:05.000Z',
      targets: { presetDir: '/data/preset' },
      components: fingerprintComponents({ presetDir: sandbox }).components,
    }
    writeStamp(file, stamp)
    assert.deepEqual(readStamp(file), stamp)
    assert.equal((await stat(file)).mode & 0o777, 0o644)
    const names = await readdir(join(sandbox, 'data'))
    assert.deepEqual(names, [INSTALL_STAMP_FILE])
  })

  await check('stamp: missing, corrupt, wrong-shape and wrong-version files read as null', async () => {
    assert.equal(readStamp(join(sandbox, 'nope.json')), null)
    const corrupt = join(sandbox, 'corrupt.json')
    await writeFile(corrupt, '{not json')
    assert.equal(readStamp(corrupt), null)
    const shape = join(sandbox, 'shape.json')
    await writeFile(shape, JSON.stringify({ version: 1, components: { preset: 'nope' } }))
    assert.equal(readStamp(shape), null)
    const version = join(sandbox, 'version.json')
    await writeFile(version, JSON.stringify({ version: 99, components: {} }))
    assert.equal(readStamp(version), null)
  })

  // -------------------------------------------------------------------- CLI

  const presetDir = await writePresetTree(join(sandbox, 'cli-preset'), 'a: 1 # comment\n')
  const webuiDir = join(sandbox, 'cli-webui')
  await mkdir(webuiDir, { recursive: true })
  await writeFile(join(webuiDir, 'index.js'), 'export const one = 1\n')
  const binDir = join(sandbox, 'cli-bin')
  await mkdir(binDir, { recursive: true })
  for (const name of BIN_COMPONENT_FILES) await writeFile(join(binDir, name), `# ${name}\n`)
  const core = join(sandbox, 'cli-core-artifact')
  await writeFile(core, Buffer.from('elf'))
  const stampFile = join(sandbox, 'cli-data', INSTALL_STAMP_FILE)
  const locationArgs = ['--preset', presetDir, '--webui', webuiDir, '--bin', binDir, '--core', core]

  await check('core stamp: source digest changes with a Rust file and the stamp detects it', async () => {
    const root = join(sandbox, 'core-root')
    await mkdir(join(root, 'crates', 'wca-core', 'src'), { recursive: true })
    await writeFile(join(root, 'Cargo.toml'), '[workspace]\n')
    await writeFile(join(root, 'Cargo.lock'), '# lock\n')
    await writeFile(join(root, 'crates', 'wca-core', 'src', 'lib.rs'), 'pub fn one() {}\n')
    const artifact = join(root, 'core-artifact')
    await writeFile(artifact, Buffer.from('elf-one'))
    const stampFile = join(root, CORE_STAMP_FILE)
    const written = spawnSync(process.execPath, [CORE_STAMP_CLI, 'write', '--root', root, '--artifact', artifact, '--stamp', stampFile], { encoding: 'utf8' })
    assert.equal(written.status, 0, written.stderr)
    const stamp = readCoreStamp(stampFile)
    assert.equal(stamp.sources, coreSourcesDigest(root))
    assert.equal(stamp.artifact.file, 'core-artifact')
    assert.equal(spawnSync(process.execPath, [CORE_STAMP_CLI, 'check', '--root', root, '--artifact', artifact, '--stamp', stampFile], { encoding: 'utf8' }).status, 0)

    await writeFile(join(root, 'crates', 'wca-core', 'src', 'lib.rs'), 'pub fn two() {}\n')
    const stale = inspectCore({ root, artifact, stampFile })
    assert.equal(stale.stale, true)
    assert.equal(stale.reason, 'sources-changed')
    const check = spawnSync(process.execPath, [CORE_STAMP_CLI, 'check', '--root', root, '--artifact', artifact, '--stamp', stampFile], { encoding: 'utf8' })
    assert.equal(check.status, 3)
    assert.match(check.stdout, /build\/build-core\.sh/)
  })

  await check('core stamp: install fingerprint includes the stamp source digest', async () => {
    const root = join(sandbox, 'core-fingerprint-root')
    await mkdir(join(root, 'crates', 'inner', 'src'), { recursive: true })
    await writeFile(join(root, 'Cargo.toml'), '[workspace]\n')
    await writeFile(join(root, 'crates', 'inner', 'src', 'lib.rs'), 'pub fn a() {}\n')
    const artifact = join(root, 'core')
    await writeFile(artifact, Buffer.from('elf'))
    const stampFile = join(root, CORE_STAMP_FILE)
    const write = spawnSync(process.execPath, [CORE_STAMP_CLI, 'write', '--root', root, '--artifact', artifact, '--stamp', stampFile], { encoding: 'utf8' })
    assert.equal(write.status, 0, write.stderr)
    const withStamp = fingerprintComponents({ coreBinary: artifact, coreStamp: stampFile }).components.core
    const without = fingerprintComponents({ coreBinary: artifact }).components.core
    assert.notEqual(withStamp.digest, without.digest)
    assert.ok(Object.hasOwn(withStamp.files, CORE_STAMP_FILE))
    await writeFile(join(root, 'crates', 'inner', 'src', 'lib.rs'), 'pub fn b() {}\n')
    const rewritten = spawnSync(process.execPath, [CORE_STAMP_CLI, 'write', '--root', root, '--artifact', artifact, '--stamp', stampFile], { encoding: 'utf8' })
    assert.equal(rewritten.status, 0, rewritten.stderr)
    const changed = fingerprintComponents({ coreBinary: artifact, coreStamp: stampFile }).components.core
    assert.notEqual(changed.digest, withStamp.digest)
    assert.equal(changed.files[CORE_COMPONENT_FILE], withStamp.files[CORE_COMPONENT_FILE])
  })

  await check('core stamp: mtime fallback still judges a pre-stamp artifact', async () => {
    const root = join(sandbox, 'core-mtime-root')
    await mkdir(join(root, 'crates', 'inner'), { recursive: true })
    await writeFile(join(root, 'Cargo.toml'), '[workspace]\n')
    await writeFile(join(root, 'crates', 'inner', 'lib.rs'), 'pub fn x() {}\n')
    const artifact = join(root, 'core')
    await writeFile(artifact, Buffer.from('elf'))
    const old = new Date('2000-01-01T00:00:00Z')
    await utimes(artifact, old, old)
    const result = inspectCore({ root, artifact, stampFile: join(root, 'no-stamp.json') })
    assert.equal(result.stale, true)
    assert.equal(result.reason, 'mtime-newer')
    assert.equal(result.fallback, true)
  })

  await check('cli: fingerprint prints one compact JSON line on stdout', async () => {
    const result = cli(['fingerprint', ...locationArgs])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.trim().split('\n').length, 1)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.version, INSTALL_STAMP_VERSION)
    assert.deepEqual(Object.keys(parsed.components), ['preset', 'webui', 'bin', 'core'])
    assert.equal(parsed.components.preset.digest, fingerprintComponents({ presetDir }).components.preset.digest)
  })

  await check('cli: component prints the same digest as fingerprint', async () => {
    const result = cli(['component', 'preset', presetDir])
    assert.equal(result.status, 0, result.stderr)
    const expected = fingerprintComponents({ presetDir }).components.preset.digest
    assert.equal(result.stdout.trim(), expected)
    assert.equal(cli(['component', 'core', join(sandbox, 'absent')]).stdout.trim(), 'missing')
    assert.equal(cli(['component', 'nope', presetDir]).status, 2)
    assert.equal(cli(['component', 'preset']).status, 2)
  })

  await check('cli: write creates a versioned stamp with targets and commit', async () => {
    const result = cli(['write', '--stamp', stampFile, ...locationArgs, '--preset-dir', '/opt/preset', '--commit', 'abc123'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    const stamp = readStamp(stampFile)
    assert.notEqual(stamp, null)
    assert.equal(stamp.version, 1)
    assert.equal(stamp.commit, 'abc123')
    assert.equal(stamp.targets.presetDir, '/opt/preset')
    assert.ok(!Number.isNaN(Date.parse(stamp.installedAt)), 'installedAt is an ISO timestamp')
    assert.deepEqual(Object.keys(stamp.components), ['preset', 'webui', 'bin', 'core'])
  })

  await check('cli: verify exits 0 when everything matches, comments included', async () => {
    const same = cli(['verify', '--stamp', stampFile, ...locationArgs])
    assert.equal(same.status, 0, same.stdout + same.stderr)
    assert.equal(same.stdout.trim(), 'same')
    await writeFile(join(presetDir, 'agent.cordis.yml'), 'a: 1 # rewritten comment\n')
    const commented = cli(['verify', '--stamp', stampFile, ...locationArgs])
    assert.equal(commented.status, 0, commented.stdout + commented.stderr)
  })

  await check('cli: verify exits 1 and names the changed component', async () => {
    await writeFile(join(webuiDir, 'index.js'), 'export const one = 2\n')
    const result = cli(['verify', '--stamp', stampFile, ...locationArgs])
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.equal(result.stdout.trim(), 'changed webui')
  })

  await check('cli: verify exits 3 for an unreadable stamp and 4 when it is missing', async () => {
    const corrupt = join(sandbox, 'cli-data', 'corrupt-stamp.json')
    await writeFile(corrupt, 'garbage')
    const unreadable = cli(['verify', '--stamp', corrupt, ...locationArgs])
    assert.equal(unreadable.status, 3, unreadable.stdout + unreadable.stderr)
    assert.equal(unreadable.stdout.trim(), 'invalid')
    const missing = cli(['verify', '--stamp', join(sandbox, 'cli-data', 'absent.json'), ...locationArgs])
    assert.equal(missing.status, 4, missing.stdout + missing.stderr)
    assert.equal(missing.stdout.trim(), 'missing')
  })

  await check('cli: bad or missing arguments exit 2 with usage on stderr', async () => {
    for (const args of [[], ['nope'], ['fingerprint', '--preset', presetDir], ['verify', '--stamp', stampFile]]) {
      const result = cli(args)
      assert.equal(result.status, 2, `args ${JSON.stringify(args)} -> ${result.status}`)
      assert.match(result.stderr, /usage:/)
      assert.equal(result.stdout, '')
    }
  })
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
