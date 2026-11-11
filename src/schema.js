/**
 * A tiny subset of zod: just what `SourceKind.schema` and `SourcePolicyPart.schema` need, which is
 * `parse(value)` and `safeParse(value)`, filling defaults and rejecting what the settings form cannot express.
 *
 * The plugin does not import zod on purpose. dsh-superagent has its own copy of zod, and a schema built with a second
 * copy would throw a `ZodError` that its HTTP layer does not recognise (`instanceof` fails across copies), turning a
 * refused settings save into a 500. A plain `SchemaError` keeps this package free of that trap.
 */

/** Raised by `parse` when a value does not fit a schema. */
export class SchemaError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SchemaError'
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A string field; `fallback` fills a missing or blank value. */
export function text({ fallback = '', min = 0, max = Infinity } = {}) {
  return value => {
    const text = value === undefined || value === null ? '' : String(value).trim()
    if (!text) {
      if (fallback !== '') return fallback
      if (min > 0) throw new SchemaError(`a non-empty string of at least ${min} characters is required`)
      return ''
    }
    if (text.length < min) throw new SchemaError(`must be at least ${min} characters`)
    if (text.length > max) throw new SchemaError(`must be at most ${max} characters`)
    return text
  }
}

/** An integer field, clamped only for type errors; out-of-range values are refused so a typo is not silently fixed. */
export function integer({ fallback, min = -Infinity, max = Infinity } = {}) {
  return value => {
    if (value === undefined || value === null || value === '') {
      if (fallback === undefined) throw new SchemaError('a number is required')
      return fallback
    }
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(number)) throw new SchemaError('must be an integer')
    if (number < min || number > max) throw new SchemaError(`must be between ${min} and ${max}`)
    return number
  }
}

/** An array of records, each with one required `id` key and optional extra keys; `fallback` fills a missing array. */
export function records({ fallback = [], optional = false, extra = {} } = {}) {
  return value => {
    if (value === undefined || value === null) {
      if (optional) return undefined
      if (fallback === undefined) throw new SchemaError('a list is required')
      return fallback.map(item => ({ ...item }))
    }
    if (!Array.isArray(value)) throw new SchemaError('must be a list')
    return value.map(item => {
      if (!isObject(item)) throw new SchemaError('every entry must be an object')
      const id = text({ min: 1, max: 200 })(item.id)
      const result = { ...item, id }
      for (const [key, check] of Object.entries(extra)) if (key in result) result[key] = check(result[key])
      return result
    })
  }
}

/**
 * Build an object schema from per-key readers; `defaults` supplies the value of a missing or non-object input, and
 * keys not listed in `shape` are dropped rather than refused, so an older configuration never disables the Source.
 */
export function object(shape) {
  const parse = value => {
    const input = isObject(value) ? value : {}
    const result = {}
    for (const [key, read] of Object.entries(shape)) {
      try {
        result[key] = read(input[key])
      } catch (error) {
        if (error instanceof SchemaError) throw new SchemaError(`${key}: ${error.message}`)
        throw error
      }
    }
    return result
  }
  return {
    parse,
    safeParse(value) {
      try {
        return { success: true, data: parse(value) }
      } catch (error) {
        return { success: false, error: { message: error instanceof Error ? error.message : String(error) } }
      }
    },
  }
}
