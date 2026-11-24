/**
 * Install fingerprint and stamp: the semantic comparison behind `install.sh --check` and the
 * cold-install notice.
 *
 * `install.sh` installs a *rendered* copy of this checkout (the preset ymls, the webui package, the
 * thin bin scripts and the Rust core). Comparing that copy byte for byte reports "stale" for a
 * comment-only PR, so every merge queued a cold-install notice. This module defines the one
 * fingerprint both sides use:
 *
 *   - YAML files are compared after a canonical comment-insensitive normalization (the preset uses
 *     `!!js` tags and block scalars, so it is deliberately not parsed as YAML);
 *   - every other file is compared by raw bytes;
 *   - a component digest is sha256 over its sorted `relative-path NUL file-digest LF` lines;
 *   - the stamp (`<data root>/installed.json`) records the component digests of what was installed.
 *
 * Formatting-only YAML edits (indentation, quote style, key order) still change the digest: comments
 * cannot, because that is the class of merge this exists to silence. A comment inside a block scalar
 * *is* content and therefore does change the digest.
 *
 * Pure Node builtins, ESM, no dependencies: `install.sh` copies this file into the installed preset
 * (`src/shared/`) and the webui package (`lib/shared/`), where it must stand alone.
 *
 * CLI (when run as a script):
 *   node src/shared/install-stamp.js fingerprint --preset D --webui D --bin D --core F
 *   node src/shared/install-stamp.js component <preset|webui|bin|core> <path>
 *   node src/shared/install-stamp.js write --stamp F --preset D --webui D --bin D --core F \
 *        --preset-dir P --commit SHA
 *   node src/shared/install-stamp.js verify --stamp F --preset D --webui D --bin D --core F
 *
 * Exit codes: 0 ok; 1 verify found a difference; 2 bad arguments; 3 the stamp is unreadable;
 * 4 the stamp is missing. `fingerprint` prints one compact JSON line on stdout, because
 * `src/spv/inbox.js` parses it.
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Bumped when the stamp shape (not the file content) changes; a mismatch forces a reinstall once. */
export const INSTALL_STAMP_VERSION = 1
/** Stamp file name under the data root. */
export const INSTALL_STAMP_FILE = 'installed.json'
/** The fixed file name the core component always uses, so the artifact and installed names compare. */
export const CORE_COMPONENT_FILE = 'wheelchair-agent-core'
/** The fixed compatibility names an install places in BIN_DIR, in install order. */
export const BIN_COMPONENT_FILES = ['wheelchair-agent', 'spv', 'superagent-service', 'jobctl']
/** The components, in notice/report order. */
export const COMPONENT_NAMES = ['preset', 'webui', 'bin', 'core']

/** `sha256:<hex>` for a Buffer/string (text is hashed as UTF-8). */
export function sha256Text(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** `sha256:<hex>` for one file's raw bytes. Throws when the file cannot be read. */
export function sha256File(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`
}

/** The stamp path for a data root. */
export function installStampPath(root) {
  return join(String(root ?? ''), INSTALL_STAMP_FILE)
}

// ------------------------------------------------------------------ YAML normalization

/**
 * Remove a YAML comment from one physical line.
 *
 * A `#` starts a comment only at line start (after indentation) or after whitespace, and only when
 * it is outside a quoted scalar. Single quotes escape by doubling (`''`); double quotes escape with
 * a backslash. Everything else in the line is left untouched.
 */
function stripYamlComment(line) {
  let single = false
  let double = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (double) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '"') double = false
      continue
    }
    if (single) {
      if (char === "'") {
        if (line[index + 1] === "'") {
          index += 1
          continue
        }
        single = false
      }
      continue
    }
    if (char === '"') {
      double = true
      continue
    }
    if (char === "'") {
      single = true
      continue
    }
    if (char === '#') {
      if (index === 0) return ''
      const previous = line[index - 1]
      if (previous === ' ' || previous === '\t') return line.slice(0, index)
    }
  }
  return line
}

/** The indentation of a block-scalar header (`key: |`, `- >-`, ...), else null. */
function blockScalarHeaderIndent(content) {
  const trimmed = content.replace(/[ \t]+$/, '')
  const match = /([|>][-+]?)$/.exec(trimmed)
  if (match === null) return null
  const index = match.index
  if (index === 0) return null
  const previous = trimmed[index - 1]
  if (previous !== ' ' && previous !== '\t' && previous !== ':' && previous !== '-') return null
  return /^[ \t]*/.exec(content)[0].length
}

/**
 * Canonical, comment-insensitive text for a YAML file.
 *
 * Rules (documented in the module header):
 *   - comments are stripped (outside quotes; `#` at line start or after whitespace);
 *   - blank / whitespace-only lines are dropped;
 *   - trailing whitespace is stripped outside block scalars;
 *   - a block scalar's content lines (indentation greater than the header's) are kept verbatim;
 *   - indentation, quotes and key order are otherwise preserved as-is.
 *
 * This deliberately does not parse YAML: the preset uses `!!js` custom tags, which a dependency-free
 * parser would reject. The residual is that formatting-only edits still change the digest.
 */
export function normalizeYaml(text) {
  const source = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const kept = []
  let blockIndent = null
  for (const line of lines) {
    const trimmed = line.trim()
    const indent = /^[ \t]*/.exec(line)[0].length
    if (blockIndent !== null) {
      // A blank line inside a block scalar is dropped like any other blank line; the block keeps
      // going until a non-blank line is indented no deeper than its header.
      if (trimmed === '') continue
      if (indent > blockIndent) {
        kept.push(line)
        continue
      }
      blockIndent = null
    }
    if (trimmed === '') continue
    const content = stripYamlComment(line).replace(/[ \t]+$/, '')
    if (content.trim() === '') continue
    kept.push(content)
    const headerIndent = blockScalarHeaderIndent(content)
    if (headerIndent !== null) blockIndent = headerIndent
  }
  if (kept.length === 0) return ''
  return `${kept.join('\n')}\n`
}

// -------------------------------------------------------------------- fingerprinting

/** Per-file digest used for one preset file: normalization for YAML, raw bytes otherwise. */
function presetFileDigest(file) {
  if (/\.(?:ya?ml)$/i.test(file)) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return 'missing'
    }
    return sha256Text(normalizeYaml(text))
  }
  try {
    return sha256File(file)
  } catch {
    return 'missing'
  }
}

/** Every regular file under `dir`, recursively; a missing/unreadable directory yields none. */
function walkFiles(dir) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...walkFiles(full))
    } else if (entry.isFile()) {
      found.push(full)
    } else if (entry.isSymbolicLink()) {
      try {
        if (statSync(full).isFile()) found.push(full)
      } catch {
        // A broken link is not a file; a missing-input sentinel is the honest answer.
      }
    }
  }
  return found
}

/** The `relative-path -> digest` map for a directory; `/`-joined keys, sorted by the caller. */
function filesOfDir(dir, digestOf) {
  const files = {}
  if (typeof dir !== 'string' || dir === '') return files
  for (const file of walkFiles(dir)) {
    const key = relative(dir, file).split(sep).join('/')
    files[key] = digestOf(file)
  }
  return files
}

/** sha256 over sorted `name NUL digest LF` lines; the component digest. */
function digestOfFiles(files) {
  const names = Object.keys(files).sort()
  return sha256Text(names.map(name => `${name}\u0000${files[name]}\n`).join(''))
}

/** A component object with a digest over its sorted file map. */
function componentOf(files) {
  return { digest: digestOfFiles(files), files }
}

/**
 * Fingerprint the four install components.
 *
 * Missing directories and files never throw: the preset/webui/bin components hash their (possibly
 * empty) file map, `bin` records the literal string `missing`, and an absent core binary is a
 * `{digest: null, missing: true, files: {}}` sentinel.
 */
export function fingerprintComponents({ presetDir, webuiDir, binDir, coreBinary } = {}) {
  const preset = componentOf(filesOfDir(presetDir, presetFileDigest))
  const webui = componentOf(filesOfDir(webuiDir, sha256File))

  const binFiles = {}
  for (const name of BIN_COMPONENT_FILES) {
    const file = typeof binDir === 'string' && binDir !== '' ? join(binDir, name) : ''
    let digest = 'missing'
    if (file !== '') {
      try {
        if (statSync(file).isFile()) digest = sha256File(file)
      } catch {
        digest = 'missing'
      }
    }
    binFiles[name] = digest
  }
  const bin = componentOf(binFiles)

  let core
  let corePresent = false
  if (typeof coreBinary === 'string' && coreBinary !== '') {
    try {
      corePresent = statSync(coreBinary).isFile()
    } catch {
      corePresent = false
    }
  }
  if (corePresent) {
    const files = { [CORE_COMPONENT_FILE]: sha256File(coreBinary) }
    core = { digest: digestOfFiles(files), missing: false, files }
  } else {
    core = { digest: null, missing: true, files: {} }
  }

  return {
    version: INSTALL_STAMP_VERSION,
    components: { preset, webui, bin, core },
  }
}

/** A component value from a fingerprint/stamp, tolerating a hand-damaged file. */
function componentOfFingerprint(fingerprint, name) {
  const value = fingerprint?.components?.[name]
  return value !== null && typeof value === 'object' ? value : undefined
}

/**
 * Compare the installed stamp with a current fingerprint.
 *
 * `changed` are files present in both with different digests, `added` are only in the current tree,
 * `removed` are only in the installed tree. `count` is the sum; a core binary that is missing on one
 * side and present on the other counts as one change with `coreMissing: true`. `same` is true only
 * when the versions match and no component changed.
 */
export function compareFingerprints(stamp, current) {
  const versionMismatch = stamp?.version !== current?.version
  const changes = []
  for (const component of COMPONENT_NAMES) {
    const installed = componentOfFingerprint(stamp, component)
    const now = componentOfFingerprint(current, component)
    const installedFiles = installed?.files !== null && typeof installed?.files === 'object' ? installed.files : {}
    const nowFiles = now?.files !== null && typeof now?.files === 'object' ? now.files : {}
    const installedMissing = component === 'core' ? installed?.missing === true || installed?.digest === null : false
    const nowMissing = component === 'core' ? now?.missing === true || now?.digest === null : false

    if (component === 'core' && installedMissing !== nowMissing) {
      // A missing core is not a file map difference: name the fixed component file so the notice can
      // still say what differs, and mark it so callers can explain a "core appeared/disappeared" case.
      changes.push({
        component,
        count: 1,
        changed: [],
        added: nowMissing ? [] : [CORE_COMPONENT_FILE],
        removed: nowMissing ? [CORE_COMPONENT_FILE] : [],
        coreMissing: true,
      })
      continue
    }
    if (installedMissing && nowMissing) continue

    const names = new Set([...Object.keys(installedFiles), ...Object.keys(nowFiles)])
    const changed = []
    const added = []
    const removed = []
    for (const name of names) {
      const inInstalled = Object.hasOwn(installedFiles, name)
      const inCurrent = Object.hasOwn(nowFiles, name)
      if (inInstalled && inCurrent) {
        if (installedFiles[name] !== nowFiles[name]) changed.push(name)
      } else if (inCurrent) {
        added.push(name)
      } else {
        removed.push(name)
      }
    }
    changed.sort()
    added.sort()
    removed.sort()
    let count = changed.length + added.length + removed.length
    // The component digest is a hash of the file map, so a differing digest with no per-file
    // difference means a malformed stamp; report it rather than call it "same".
    if (count === 0 && (installed?.digest ?? null) !== (now?.digest ?? null)) count = 1
    if (count > 0) changes.push({ component, count, changed, added, removed, coreMissing: false })
  }
  return { versionMismatch, same: !versionMismatch && changes.length === 0, changes }
}

// ---------------------------------------------------------------------------- stamp i/o

/**
 * Atomically write the stamp: a pid-suffixed temporary file in the same directory, chmod 0644, then
 * rename over the target. Prints nothing; the temporary file is removed when the write fails.
 */
export function writeStamp(file, stamp) {
  const target = String(file)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.tmp.${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o644 })
    chmodSync(temporary, 0o644)
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Nothing to clean up: the write may have failed before the file existed.
    }
    throw error
  }
}

/**
 * Read a stamp, tolerating everything: a missing file, invalid JSON, a wrong shape or an unknown
 * version all return null. The caller decides whether that means "old machine" or "corrupt".
 */
export function readStamp(file) {
  let text
  try {
    text = readFileSync(String(file), 'utf8')
  } catch {
    return null
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.version !== INSTALL_STAMP_VERSION) return null
  if (value.components === null || typeof value.components !== 'object') return null
  for (const component of COMPONENT_NAMES) {
    const entry = value.components[component]
    if (entry === null || typeof entry !== 'object') return null
    if (entry.files === null || typeof entry.files !== 'object') return null
    if (!(entry.digest === null || typeof entry.digest === 'string')) return null
  }
  return value
}

// -------------------------------------------------------------------------------- CLI

const USAGE = [
  'usage: node src/shared/install-stamp.js <command> [options]',
  '',
  '  fingerprint --preset D --webui D --bin D --core F',
  '      print the install fingerprint as one compact JSON line',
  '  component <preset|webui|bin|core> <path>',
  '      print one component digest ("missing" for an absent core)',
  '  write --stamp F --preset D --webui D --bin D --core F --preset-dir P --commit SHA',
  '      write the install stamp atomically (prints nothing)',
  '  verify --stamp F --preset D --webui D --bin D --core F',
  '      exit 0 "same"; exit 1 "changed <components>"; exit 3 unreadable; exit 4 missing',
].join('\n')

/** Parse `--name value` / `--name=value` flags; throws on a missing value or a bare word. */
function parseFlags(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--') || arg === '--') throw new Error(`unexpected argument ${JSON.stringify(arg)}`)
    const separator = arg.indexOf('=')
    if (separator !== -1) {
      flags[arg.slice(2, separator)] = arg.slice(separator + 1)
      continue
    }
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`missing value for ${arg}`)
    flags[arg.slice(2)] = value
    index += 1
  }
  return flags
}

/** Read the four required location flags. */
function locationsOf(flags) {
  const missing = ['preset', 'webui', 'bin', 'core'].filter(name => typeof flags[name] !== 'string')
  if (missing.length > 0) throw new Error(`missing ${missing.map(name => `--${name}`).join(', ')}`)
  return {
    presetDir: flags.preset,
    webuiDir: flags.webui,
    binDir: flags.bin,
    coreBinary: flags.core,
  }
}

/** Run one CLI command; returns an exit status (and writes to stdout/stderr). */
function runCli(argv) {
  const command = argv[0]
  if (command === undefined) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  try {
    if (command === 'component') {
      const name = argv[1]
      const target = argv[2]
      if (!COMPONENT_NAMES.includes(name) || typeof target !== 'string' || argv.length !== 3) {
        throw new Error('component needs <preset|webui|bin|core> <path>')
      }
      if (name === 'core') {
        let present = false
        try {
          present = statSync(target).isFile()
        } catch {
          present = false
        }
        if (!present) {
          process.stdout.write('missing\n')
          return 0
        }
      }
      const fingerprint = fingerprintComponents({
        presetDir: name === 'preset' ? target : undefined,
        webuiDir: name === 'webui' ? target : undefined,
        binDir: name === 'bin' ? target : undefined,
        coreBinary: name === 'core' ? target : undefined,
      })
      const component = fingerprint.components[name]
      if (component.digest === null) {
        process.stdout.write('missing\n')
      } else {
        process.stdout.write(`${component.digest}\n`)
      }
      return 0
    }

    if (command === 'fingerprint') {
      const fingerprint = fingerprintComponents(locationsOf(parseFlags(argv.slice(1))))
      process.stdout.write(`${JSON.stringify(fingerprint)}\n`)
      return 0
    }

    if (command === 'write') {
      const flags = parseFlags(argv.slice(1))
      if (typeof flags.stamp !== 'string') throw new Error('missing --stamp')
      const locations = locationsOf(flags)
      const fingerprint = fingerprintComponents(locations)
      const presetDir = typeof flags['preset-dir'] === 'string' ? flags['preset-dir'] : ''
      writeStamp(flags.stamp, {
        version: INSTALL_STAMP_VERSION,
        commit: typeof flags.commit === 'string' ? flags.commit : '',
        installedAt: new Date().toISOString(),
        targets: { presetDir },
        components: fingerprint.components,
      })
      return 0
    }

    if (command === 'verify') {
      const flags = parseFlags(argv.slice(1))
      if (typeof flags.stamp !== 'string') throw new Error('missing --stamp')
      const locations = locationsOf(flags)
      if (!existsSync(flags.stamp)) {
        process.stdout.write('missing\n')
        return 4
      }
      const stamp = readStamp(flags.stamp)
      if (stamp === null) {
        process.stdout.write('invalid\n')
        return 3
      }
      const comparison = compareFingerprints(stamp, fingerprintComponents(locations))
      if (comparison.same) {
        process.stdout.write('same\n')
        return 0
      }
      const names = comparison.changes.map(change => change.component)
      if (comparison.versionMismatch) names.unshift('version')
      process.stdout.write(`changed ${names.join(' ')}\n`)
      return 1
    }

    throw new Error(`unknown command ${JSON.stringify(command)}`)
  } catch (error) {
    process.stderr.write(`${USAGE}\n\n${error?.message ?? error}\n`)
    return 2
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2))
}
