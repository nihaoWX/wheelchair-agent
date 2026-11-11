/**
 * Default entry of the `wheelchair-agent` package: the same plugin as `wheelchair-agent/spv-watch`.
 * The profile's `cordis.patch.yml` inserts `wheelchair-agent/spv-watch`; either specifier mounts this plugin.
 */
export { apply, inject, name, pollQueue, spvKind, SOURCE } from './spv-watch.js'
