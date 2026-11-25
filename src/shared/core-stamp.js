/**
 * Core artifact provenance: the stamp `build/build-core.sh` writes next to the Rust planner binary,
 * and the staleness check `install.sh` uses instead of only comparing checkout bytes with installed
 * bytes. Two stale artifacts that agree with each other used to look installed.
 *
 * The stamp records one digest over the Rust sources (`crates/**\/*.rs`, `Cargo.toml`, `Cargo.lock`,
 * sorted by path) plus the artifact digest. A checkout without a stamp (an older build) falls back to
 * comparing the artifact mtime with the newest source mtime, and says so; that fallback is a warning,
 * never the primary answer once a stamp exists.
 *
 * Pure Node builtins and ESM so `install.sh`, `build/build-core.sh` and the installed preset can use
 * the same code without dependencies or cargo.
 *
 * CLI:
 *   node src/shared/core-stamp.js write --root R --artifact F [--stamp S] [--commit SHA]
 *        [--cargo VERSION] [--built-at ISO]
 *   node src/shared/core-stamp.js check --root R --artifact F [--stamp S] [--json]
 *
 * `check` exits 0 fresh, 3 stale, 4 artifact missing, 2 bad arguments. Neither command writes outside
 * the stamp file, and `check` never builds anything.
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
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CORE_STAMP_FILE = 'core-stamp.json'
export const CORE_STAMP_VERSION = 1
export const CORE_ARTIFACT_FILE = 'wheelchair-agent-core-linux-x64'

/** `sha256:<hex>` over raw bytes (a string is hashed as UTF-8). */
export function sha256Of(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

/** Every regular file below `dir`, recursively; a missing directory yields an empty list. */
function walkFiles(dir) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walkFiles(full))
    else if (entry.isFile()) found.push(full)
  }
  return found
}

/** The Rust inputs whose contents can change the planner: every crate source plus the workspace manifests. */
export function coreSourceFiles(root) {
  const files = []
  for (const file of walkFiles(join(root, 'crates'))) {
    if (file.endsWith('.rs')) files.push(file)
  }
  for (const name of ['Cargo.toml', 'Cargo.lock']) {
    const file = join(root, name)
    if (existsSync(file)) files.push(file)
  }
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** One digest over sorted `relative-path NUL file-digest LF` lines, the install-stamp style. */
export function coreSourcesDigest(root) {
  const lines = []
  for (const file of coreSourceFiles(root)) {
    lines.push(`${relative(root, file).split(sep).join('/')}\u0000${sha256Of(readFileSync(file))}\n`)
  }
  return sha256Of(lines.join(''))
}

/** The newest mtime among the Rust inputs, used only when no stamp exists. */
export function newestSourceMtime(root) {
  let newest = 0
  let newestFile = ''
  for (const file of coreSourceFiles(root)) {
    const mtime = statSync(file).mtimeMs
    if (mtime > newest) {
      newest = mtime
      newestFile = file
    }
  }
  return { mtime: newest, file: newestFile }
}

/** A stamp object, or null when the file is missing/unreadable/not this version. */
export function readCoreStamp(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let stamp
  try {
    stamp = JSON.parse(text)
  } catch {
    return null
  }
  if (stamp === null || typeof stamp !== 'object') return null
  if (stamp.version !== CORE_STAMP_VERSION) return null
  if (typeof stamp.sources !== 'string' || !stamp.sources.startsWith('sha256:')) return null
  if (typeof stamp.artifact !== 'object' || stamp.artifact === null) return null
  if (typeof stamp.artifact.sha256 !== 'string') return null
  return stamp
}

/** Atomically write one stamp object (temp in the same directory, 0644, rename). */
export function writeCoreStamp(file, stamp) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp.${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o644 })
  chmodSync(temporary, 0o644)
  renameSync(temporary, file)
}

/**
 * Build and write the stamp for a finished artifact.
 *
 * `commit` defaults to `unknown` rather than throwing: a tarball checkout without `.git` still gets a
 * truthful stamp, and the commit is informational while `sources` is the load-bearing field.
 */
export function stampArtifact({ root, artifact, stampFile = join(dirname(artifact), CORE_STAMP_FILE), commit, cargo, builtAt }) {
  const sources = coreSourcesDigest(root)
  const stamp = {
    version: CORE_STAMP_VERSION,
    commit: typeof commit === 'string' && commit !== '' ? commit : 'unknown',
    builtAt: typeof builtAt === 'string' && builtAt !== '' ? builtAt : new Date().toISOString(),
    sources,
    cargo: typeof cargo === 'string' && cargo !== '' ? cargo : 'unknown',
    artifact: {
      file: basename(artifact),
      sha256: sha256Of(readFileSync(artifact)),
      size: statSync(artifact).size,
    },
  }
  if (typeof stampFile === 'string' && stampFile !== '' && stampFile !== '-') writeCoreStamp(stampFile, stamp)
  return { stamp, stampFile }
}

/**
 * Is this artifact still the build of the current Rust sources?
 *
 * Returns `{stale, reason, stamp, sources, artifact, fallback, newest}`. `reason` is one of `fresh`,
 * `sources-changed`, `artifact-modified`, `mtime-fallback`, `mtime-newer`, `no-sources`, and is meant
 * for a human line, not an error code. `fallback` is true only for the no-stamp mtime comparison.
 */
export function inspectCore({ root, artifact, stampFile = join(dirname(artifact), CORE_STAMP_FILE) }) {
  const sources = coreSourcesDigest(root)
  let artifactSha = null
  try {
    artifactSha = sha256Of(readFileSync(artifact))
  } catch {
    return { stale: true, reason: 'artifact-missing', stamp: null, sources, artifact: null, fallback: false, newest: null }
  }
  const stamp = readCoreStamp(stampFile)
  if (stamp !== null) {
    if (stamp.sources !== sources) {
      return { stale: true, reason: 'sources-changed', stamp, sources, artifact: artifactSha, fallback: false, newest: null }
    }
    if (stamp.artifact.sha256 !== artifactSha) {
      return { stale: true, reason: 'artifact-modified', stamp, sources, artifact: artifactSha, fallback: false, newest: null }
    }
    return { stale: false, reason: 'fresh', stamp, sources, artifact: artifactSha, fallback: false, newest: null }
  }
  const newest = newestSourceMtime(root)
  const artifactMtime = statSync(artifact).mtimeMs
  if (newest.mtime > artifactMtime) {
    return { stale: true, reason: 'mtime-newer', stamp: null, sources, artifact: artifactSha, fallback: true, newest }
  }
  return { stale: false, reason: 'mtime-fallback', stamp: null, sources, artifact: artifactSha, fallback: true, newest }
}

/** One human line for a check result, naming the fix only when the artifact is actually stale. */
export function describeCoreResult(result) {
  switch (result.reason) {
    case 'fresh':
      return 'the Rust core artifact matches the current Rust sources'
    case 'sources-changed':
      return `the Rust core artifact was built from other Rust sources (${String(result.stamp?.sources).slice(0, 19)}…, now ${String(result.sources).slice(0, 19)}…); run "bash build/build-core.sh"`
    case 'artifact-modified':
      return 'the Rust core artifact changed after it was built; run "bash build/build-core.sh"'
    case 'mtime-fallback':
      return 'no core-stamp.json: the artifact is newer than every Rust source (mtime fallback)'
    case 'mtime-newer':
      return `no core-stamp.json: ${result.newest?.file ?? 'a Rust source'} is newer than the artifact (mtime fallback); run "bash build/build-core.sh"`
    case 'no-sources':
      return 'no Rust sources were found to compare against this artifact; run "bash build/build-core.sh"'
    case 'artifact-missing':
      return 'the Rust core artifact is missing; run "bash build/build-core.sh"'
    default:
      return 'the Rust core artifact could not be compared with the Rust sources'
  }
}

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
    if (arg === '--json') {
      flags.json = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`missing value for ${arg}`)
    flags[arg.slice(2)] = value
    index += 1
  }
  return flags
}

function runCli(argv) {
  const command = argv[0]
  try {
    const flags = parseFlags(argv.slice(1))
    if (typeof flags.root !== 'string' || typeof flags.artifact !== 'string') {
      throw new Error('both --root and --artifact are required')
    }
    const stampFile = typeof flags.stamp === 'string' ? flags.stamp : join(dirname(flags.artifact), CORE_STAMP_FILE)
    if (command === 'write') {
      const { stamp } = stampArtifact({
        root: flags.root,
        artifact: flags.artifact,
        stampFile,
        commit: flags.commit,
        cargo: flags.cargo,
        builtAt: flags['built-at'],
      })
      process.stdout.write(`${JSON.stringify({ stampFile, sources: stamp.sources, artifact: stamp.artifact.sha256 })}\n`)
      return 0
    }
    if (command === 'check') {
      const result = inspectCore({ root: flags.root, artifact: flags.artifact, stampFile })
      if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`)
      else process.stdout.write(`${describeCoreResult(result)}\n`)
      return result.reason === 'artifact-missing' ? 4 : result.stale ? 3 : 0
    }
    throw new Error(`unknown command ${JSON.stringify(command)}`)
  } catch (error) {
    process.stderr.write(`core-stamp: ${error?.message ?? error}\n`)
    return 2
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2))
}
