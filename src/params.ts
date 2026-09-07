/**
 * Turning a request's strings into the values a JSON Schema can be checked
 * against.
 *
 * Two jobs, in order. **Deserialization** undoes the OpenAPI `style`/`explode`
 * encoding — `?tags=a&tags=b` and `?tags=a|b` are both the array `['a','b']`,
 * depending on what the parameter declared. **Coercion** then reads the
 * parameter's schema and turns `"42"` into `42` where the schema asks for a
 * number, because otherwise every non-string parameter in every document would
 * fail its own type check.
 *
 * Coercion is deliberately conservative: it only ever converts a string, it
 * never converts when `string` is among the schema's allowed types, and when a
 * conversion would not round-trip it leaves the original text alone so the
 * validator can report a real type error instead of a silent `NaN`.
 */

import type {
  ReferenceObject,
  SchemaObject,
  SchemaObjectType,
} from 'openapi3-ts/oas31'

import type { IndexedParameter } from './document.js'

/** Where a parameter's raw text is read from. */
export interface ParameterSources {
  readonly pathValues: Readonly<Record<string, string>>
  readonly search: URLSearchParams
  readonly headers: Headers
  readonly cookies: Readonly<Record<string, string>>
}

/** The outcome of reading one parameter. `present: false` means "not sent". */
export interface ParameterRead {
  readonly present: boolean
  readonly value: unknown
}

const ABSENT: ParameterRead = { present: false, value: undefined }

/** Broad shape a schema describes, which is what picks the decoding rule. */
export type SchemaKind = 'array' | 'object' | 'primitive'

function typesOf(
  schema: SchemaObject | undefined,
): readonly SchemaObjectType[] {
  const type = schema?.type
  if (type === undefined) return []
  return Array.isArray(type) ? type : [type]
}

/** Classify a schema, falling back to its keywords when `type` is absent. */
export function schemaKind(schema: SchemaObject | undefined): SchemaKind {
  const types = typesOf(schema)
  if (types.includes('array')) return 'array'
  if (types.includes('object')) return 'object'
  if (types.length > 0) return 'primitive'
  if (schema?.items !== undefined || schema?.prefixItems !== undefined)
    return 'array'
  if (schema?.properties !== undefined) return 'object'
  return 'primitive'
}

/** `['a','1','b','2']` — the un-exploded object encoding. */
function pairsToObject(tokens: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const key = tokens[i]
    const value = tokens[i + 1]
    if (key !== undefined && value !== undefined) out[key] = value
  }
  return out
}

/** `['a=1','b=2']` — the exploded object encoding. */
function assignmentsToObject(
  tokens: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const token of tokens) {
    const at = token.indexOf('=')
    if (at > 0) out[token.slice(0, at)] = token.slice(at + 1)
  }
  return out
}

/** Split that treats the empty string as the empty list, not `['']`. */
function splitList(raw: string, delimiter: string): string[] {
  return raw === '' ? [] : raw.split(delimiter)
}

/** Parse a `Cookie` header into a name/value record. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 1) continue
    const name = part.slice(0, at).trim()
    const raw = part.slice(at + 1).trim()
    try {
      out[name] = decodeURIComponent(raw)
    } catch {
      out[name] = raw
    }
  }
  return out
}

function readPath(param: IndexedParameter, raw: string): ParameterRead {
  const kind = schemaKind(param.resolved)

  if (param.style === 'matrix') {
    const body = raw.startsWith(';') ? raw.slice(1) : raw
    if (kind === 'object') {
      return param.explode
        ? { present: true, value: assignmentsToObject(splitList(body, ';')) }
        : {
            present: true,
            value: pairsToObject(splitList(afterName(body, param.name), ',')),
          }
    }
    if (kind === 'array') {
      if (param.explode) {
        const values = splitList(body, ';').flatMap((token) => {
          const at = token.indexOf('=')
          return at > 0 ? [token.slice(at + 1)] : []
        })
        return { present: true, value: values }
      }
      return {
        present: true,
        value: splitList(afterName(body, param.name), ','),
      }
    }
    return { present: true, value: afterName(body, param.name) }
  }

  if (param.style === 'label') {
    const body = raw.startsWith('.') ? raw.slice(1) : raw
    const delimiter = param.explode ? '.' : ','
    if (kind === 'object') {
      return {
        present: true,
        value: param.explode
          ? assignmentsToObject(splitList(body, '.'))
          : pairsToObject(splitList(body, ',')),
      }
    }
    if (kind === 'array')
      return { present: true, value: splitList(body, delimiter) }
    return { present: true, value: body }
  }

  // `simple` — the default, and the only style most documents use.
  if (kind === 'object') {
    return {
      present: true,
      value: param.explode
        ? assignmentsToObject(splitList(raw, ','))
        : pairsToObject(splitList(raw, ',')),
    }
  }
  if (kind === 'array') return { present: true, value: splitList(raw, ',') }
  return { present: true, value: raw }
}

function afterName(body: string, name: string): string {
  const prefix = `${name}=`
  return body.startsWith(prefix) ? body.slice(prefix.length) : body
}

function readDeepObject(
  param: IndexedParameter,
  search: URLSearchParams,
): ParameterRead {
  const prefix = `${param.name}[`
  const out: Record<string, string> = {}
  let present = false
  for (const [key, value] of search) {
    if (!key.startsWith(prefix) || !key.endsWith(']')) continue
    out[key.slice(prefix.length, -1)] = value
    present = true
  }
  return present ? { present, value: out } : ABSENT
}

function readExplodedObject(
  param: IndexedParameter,
  lookup: (key: string) => string | undefined,
): ParameterRead {
  // An exploded object is spelled one property per key, so the only way to
  // know which keys belong to it is to read the schema's declared properties.
  const properties = param.resolved?.properties
  if (properties === undefined) return ABSENT
  const out: Record<string, string> = {}
  let present = false
  for (const key of Object.keys(properties)) {
    const value = lookup(key)
    if (value === undefined) continue
    out[key] = value
    present = true
  }
  return present ? { present, value: out } : ABSENT
}

function readQuery(
  param: IndexedParameter,
  search: URLSearchParams,
): ParameterRead {
  const kind = schemaKind(param.resolved)

  if (param.style === 'deepObject') {
    return kind === 'object' ? readDeepObject(param, search) : ABSENT
  }

  const delimiter =
    param.style === 'spaceDelimited'
      ? ' '
      : param.style === 'pipeDelimited'
        ? '|'
        : ','

  if (kind === 'object' && param.explode && param.style === 'form') {
    return readExplodedObject(param, (key) => search.get(key) ?? undefined)
  }

  if (kind === 'array' && param.explode) {
    return search.has(param.name)
      ? { present: true, value: search.getAll(param.name) }
      : ABSENT
  }

  const raw = search.get(param.name)
  if (raw === null) return ABSENT
  if (kind === 'array')
    return { present: true, value: splitList(raw, delimiter) }
  if (kind === 'object') {
    return { present: true, value: pairsToObject(splitList(raw, delimiter)) }
  }
  return { present: true, value: raw }
}

function readSimpleString(param: IndexedParameter, raw: string): ParameterRead {
  const kind = schemaKind(param.resolved)
  if (kind === 'array') {
    return { present: true, value: splitList(raw, ',').map((v) => v.trim()) }
  }
  if (kind === 'object') {
    const tokens = splitList(raw, ',').map((v) => v.trim())
    return {
      present: true,
      value: param.explode
        ? assignmentsToObject(tokens)
        : pairsToObject(tokens),
    }
  }
  return { present: true, value: raw }
}

function readCookie(
  param: IndexedParameter,
  cookies: Readonly<Record<string, string>>,
): ParameterRead {
  const kind = schemaKind(param.resolved)
  if (kind === 'object' && param.explode) {
    return readExplodedObject(param, (key) => cookies[key])
  }
  const raw = cookies[param.name]
  if (raw === undefined) return ABSENT
  if (kind === 'array') return { present: true, value: splitList(raw, ',') }
  if (kind === 'object')
    return { present: true, value: pairsToObject(splitList(raw, ',')) }
  return { present: true, value: raw }
}

/** Read one parameter out of the request, undoing its `style`/`explode`. */
export function readParameter(
  param: IndexedParameter,
  sources: ParameterSources,
): ParameterRead {
  switch (param.in) {
    case 'path': {
      const raw = sources.pathValues[param.name]
      return raw === undefined ? ABSENT : readPath(param, raw)
    }
    case 'query':
      return readQuery(param, sources.search)
    case 'header': {
      const raw = sources.headers.get(param.name)
      return raw === null ? ABSENT : readSimpleString(param, raw)
    }
    case 'cookie':
      return readCookie(param, sources.cookies)
  }
}

/** Resolves a possibly-`$ref`d schema to something with readable keywords. */
export type SchemaResolver = (
  schema: SchemaObject | ReferenceObject | undefined,
) => SchemaObject | undefined

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coerceScalar(value: string, schema: SchemaObject): unknown {
  const types = typesOf(schema)

  if (types.length === 0) {
    // No `type`, but a numeric `enum` still tells us what the author meant.
    const values = schema.enum
    if (
      Array.isArray(values) &&
      values.length > 0 &&
      values.every((v) => typeof v === 'number')
    ) {
      const parsed = toNumber(value)
      return parsed === undefined ? value : parsed
    }
    return value
  }

  // When the schema would accept the text as-is, leave it as text. This is
  // what keeps `type: ['string', 'number']` from silently becoming a number.
  if (types.includes('string')) return value

  if (types.includes('boolean')) {
    if (value === 'true') return true
    if (value === 'false') return false
  }
  if (types.includes('integer')) {
    const parsed = toNumber(value)
    if (parsed !== undefined && Number.isInteger(parsed)) return parsed
  }
  if (types.includes('number')) {
    const parsed = toNumber(value)
    if (parsed !== undefined) return parsed
  }
  if (types.includes('null') && value === 'null') return null

  // Nothing applied — hand the original text to the validator so the error it
  // reports names the real problem.
  return value
}

function toNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Recursively convert a deserialized value into the JSON types its schema
 * describes. Non-string leaves and unknown properties are passed through
 * untouched.
 */
export function coerceToSchema(
  value: unknown,
  schema: SchemaObject | undefined,
  resolve: SchemaResolver,
): unknown {
  if (schema === undefined) return value

  if (Array.isArray(value)) {
    const prefixItems = schema.prefixItems
    const items = resolve(schema.items)
    return value.map((entry, index) => {
      const prefix = prefixItems?.[index]
      const itemSchema = prefix !== undefined ? resolve(prefix) : items
      return coerceToSchema(entry, itemSchema, resolve)
    })
  }

  if (isPlainObject(value)) {
    const properties = schema.properties
    const additional =
      typeof schema.additionalProperties === 'object'
        ? resolve(schema.additionalProperties)
        : undefined
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      const declared = properties?.[key]
      const propertySchema =
        declared !== undefined ? resolve(declared) : additional
      out[key] = coerceToSchema(entry, propertySchema, resolve)
    }
    return out
  }

  return typeof value === 'string' ? coerceScalar(value, schema) : value
}
