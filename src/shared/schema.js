/**
 * The tiny validator from this module's previous JavaScript implementation, now evaluated by
 * `wheelchair-agent-core schema-check`.
 *
 * The exports and their signatures are unchanged: `text`, `integer` and `records` return a validator
 * function, `object` returns `{ parse, safeParse }`. The wrappers only serialize the validator shape
 * plus one value; defaults, coercion and **the exact rejection messages** live in Rust. `SchemaError`
 * stays a JavaScript class so callers keep their `instanceof`/name contract.
 */
import { coreHint, runCore } from './queue.js'

/** Raised by `parse` when a value does not fit a schema. */
export class SchemaError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SchemaError'
  }
}

const SPEC = Symbol('wca-schema-spec')

/** Call the binary for one validator/value pair and turn its rejection into `SchemaError`. */
function evaluate(spec, value) {
  let data
  try {
    const request = value === undefined ? { validator: spec } : { validator: spec, value }
    data = runCore(['schema-check'], JSON.stringify(request))
  } catch (error) {
    if (error?.code === 'schema_error') throw new SchemaError(error.message)
    throw error
  }
  if (data === null || typeof data !== 'object' || typeof data.defined !== 'boolean') {
    throw coreHint('returned an invalid schema-check result')
  }
  return data.defined ? data.value : undefined
}

function validator(spec) {
  const check = value => evaluate(spec, value)
  Object.defineProperty(check, SPEC, { value: spec })
  return check
}

function specOf(reader, where) {
  if (typeof reader !== 'function' || reader[SPEC] === undefined) {
    throw new TypeError(`${where} must be a validator from src/shared/schema.js`)
  }
  return reader[SPEC]
}

/** A string field; `fallback` fills a missing or blank value. */
export function text({ fallback = '', min = 0, max = Infinity } = {}) {
  const spec = { kind: 'text', fallback, fallbackPresent: true }
  if (Number.isFinite(min)) spec.min = min
  if (Number.isFinite(max)) spec.max = max
  return validator(spec)
}

/** An integer field, clamped only for type errors; out-of-range values are refused so a typo is not silently fixed. */
export function integer({ fallback, min = -Infinity, max = Infinity } = {}) {
  const spec = { kind: 'integer' }
  if (fallback !== undefined) {
    spec.fallback = fallback
    spec.fallbackPresent = true
  }
  if (Number.isFinite(min)) spec.min = min
  if (Number.isFinite(max)) spec.max = max
  return validator(spec)
}

/** An array of records, each with one required `id` key and optional extra keys. */
export function records({ fallback = [], optional = false, extra = {} } = {}) {
  const spec = { kind: 'records', fallback, optional }
  const fields = Object.entries(extra).map(([key, reader]) => ({
    key,
    validator: specOf(reader, `records extra field ${JSON.stringify(key)}`),
  }))
  if (fields.length > 0) spec.extra = fields
  return validator(spec)
}

/**
 * Build an object schema from per-key readers. Every reader must be one of this module's validators;
 * the values are serialized and the object itself is validated in Rust.
 */
export function object(shape) {
  const fields = Object.entries(shape).map(([key, reader]) => ({
    key,
    validator: specOf(reader, `object field ${JSON.stringify(key)}`),
  }))
  const parse = validator({ kind: 'object', shape: fields })
  return {
    parse,
    safeParse(value) {
      try {
        return { success: true, data: parse(value) }
      } catch (error) {
        return {
          success: false,
          error: { message: error instanceof Error ? error.message : String(error) },
        }
      }
    },
  }
}
