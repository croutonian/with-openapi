/**
 * Matching a request body to a Media Type Object and parsing it.
 *
 * Reading the body here is safe: the framework hands every layer a buffered
 * request whose body is cached after the first read, so the handler can still
 * call `req.json()` afterwards.
 *
 * Only bodies the middleware can turn into JSON values get schema-checked.
 * `multipart/form-data` is parsed but not validated — its parts are `File`
 * objects, which no JSON Schema describes — and binary media types are neither
 * read nor validated, so a large upload is not buffered just to be ignored.
 */

import type { SchemaObject } from 'openapi3-ts/oas31'

import type { IndexedContent } from './document.js'
import { coerceToSchema, schemaKind, type SchemaResolver } from './params.js'

/** How the bytes of a body should be read. */
export type BodyForm = 'json' | 'urlencoded' | 'multipart' | 'text' | 'opaque'

/** Lowercase `type/subtype` of a content-type header, parameters dropped. */
export function essenceOf(contentType: string | null): string | undefined {
  if (contentType === null) return undefined
  const essence = contentType.split(';')[0]?.trim().toLowerCase()
  return essence === undefined || essence === '' ? undefined : essence
}

/**
 * Find the Media Type Object covering a request's content type.
 *
 * Exact match first, then a `type` wildcard range, then the
 * catch-all range — the precedence the spec gives for `content` map keys.
 */
export function matchMediaType(
  contents: readonly IndexedContent[],
  essence: string,
): IndexedContent | undefined {
  const type = essence.split('/')[0] ?? ''
  return (
    contents.find((entry) => entry.mediaType === essence) ??
    contents.find((entry) => entry.mediaType === `${type}/*`) ??
    contents.find((entry) => entry.mediaType === '*/*')
  )
}

/**
 * Decide how to read the body from what the *request* says it is, not from
 * what the document declared — a catch-all range matches anything, and the
 * request is the only thing that knows what was actually sent.
 */
export function bodyFormFor(essence: string): BodyForm {
  if (essence === 'application/json' || essence.endsWith('+json')) return 'json'
  if (essence.endsWith('/json')) return 'json'
  if (essence === 'application/x-www-form-urlencoded') return 'urlencoded'
  if (essence === 'multipart/form-data') return 'multipart'
  if (essence.startsWith('text/') || essence.endsWith('+xml')) return 'text'
  return 'opaque'
}

/**
 * Flatten form entries into an object, consulting the schema to decide which
 * keys are arrays. `?tag=a&tag=b` is `['a','b']` only where the schema says so;
 * everywhere else a repeated key keeps its last value, as a form post would.
 */
function formEntriesToObject(
  entries: Iterable<[string, FormDataEntryValue]>,
  schema: SchemaObject | undefined,
  resolve: SchemaResolver,
): Record<string, unknown> {
  const collected = new Map<string, FormDataEntryValue[]>()
  for (const [key, value] of entries) {
    const existing = collected.get(key)
    if (existing) existing.push(value)
    else collected.set(key, [value])
  }

  const properties = schema?.properties
  const out: Record<string, unknown> = {}
  for (const [key, values] of collected) {
    const declared = properties?.[key]
    const propertySchema =
      declared === undefined ? undefined : resolve(declared)
    out[key] =
      schemaKind(propertySchema) === 'array'
        ? values
        : (values[values.length - 1] as unknown)
  }
  return out
}

/** What {@link readBody} concluded about a request body. */
export type BodyRead =
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'unsupported'; readonly essence: string | undefined }
  | {
      readonly outcome: 'malformed'
      readonly message: string
      readonly content: IndexedContent
    }
  | {
      readonly outcome: 'read'
      readonly content: IndexedContent
      /** `undefined` when the media type is binary and was left unread. */
      readonly value: unknown
      /** Whether {@link value} is worth checking against the schema. */
      readonly validatable: boolean
    }

/**
 * Read and parse the request body against an operation's Request Body Object.
 *
 * `absent` means no body was sent — whether that is an error is the caller's
 * call, since it depends on the Request Body Object's `required`.
 */
export async function readBody(
  req: Request,
  contents: readonly IndexedContent[],
  resolve: SchemaResolver,
): Promise<BodyRead> {
  // Nothing was sent at all. No content-type header can turn that into a
  // media-type problem, and whether an absent body is an error is the caller's
  // to decide from the Request Body Object's `required`.
  if (req.body === null) return { outcome: 'absent' }

  const essence = essenceOf(req.headers.get('content-type'))

  if (essence === undefined) {
    // No content type to match on. An empty body is simply absent; a body we
    // cannot identify is one we cannot validate.
    const raw = await req.text()
    return raw === ''
      ? { outcome: 'absent' }
      : { outcome: 'unsupported', essence }
  }

  const content = matchMediaType(contents, essence)
  if (content === undefined) return { outcome: 'unsupported', essence }

  const form = bodyFormFor(essence)
  const schema = content.resolved

  if (form === 'opaque') {
    // Never buffered: an image or an archive has no JSON shape to check, and
    // reading it would cost the whole payload for nothing.
    return { outcome: 'read', content, value: undefined, validatable: false }
  }

  if (form === 'multipart') {
    let parsed: FormData
    try {
      parsed = await req.formData()
    } catch {
      return {
        outcome: 'malformed',
        message: 'body is not valid multipart/form-data',
        content,
      }
    }
    return {
      outcome: 'read',
      content,
      value: formEntriesToObject(parsed, schema, resolve),
      // Parts arrive as `File`, which no JSON Schema describes.
      validatable: false,
    }
  }

  const raw = await req.text()
  if (raw === '') return { outcome: 'absent' }

  if (form === 'json') {
    try {
      return {
        outcome: 'read',
        content,
        value: JSON.parse(raw),
        validatable: true,
      }
    } catch {
      return {
        outcome: 'malformed',
        message: 'body is not valid JSON',
        content,
      }
    }
  }

  if (form === 'urlencoded') {
    const value = formEntriesToObject(new URLSearchParams(raw), schema, resolve)
    // Every value arrived as text, exactly like a query string.
    return {
      outcome: 'read',
      content,
      value: coerceToSchema(value, schema, resolve),
      validatable: true,
    }
  }

  return { outcome: 'read', content, value: raw, validatable: true }
}
