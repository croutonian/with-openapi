/**
 * JSON Schema validation against the document, on every runtime this package
 * targets.
 *
 * OpenAPI 3.1 schemas *are* JSON Schema 2020-12, so no translation layer is
 * needed — but the validator has to be one that works where `eval` and `new
 * Function` do not, which rules out the code-generating validators. `@cfworker
 * /json-schema` interprets rather than compiles, has no dependencies, and is
 * built for exactly this constraint.
 *
 * The one thing worth understanding here is the `lookup`. `dereference` walks
 * a document once and returns a map from absolute URI to node; `validate`
 * takes that map and resolves `$ref` through it. Because the map is a plain
 * argument, the whole document can be walked **once** at construction and every
 * subschema in it validated against the shared map afterwards. That is what
 * makes `#/components/schemas/…` resolve from a parameter schema buried in a
 * path item, recursive schemas included, without inlining anything.
 */

import { dereference, validate } from '@cfworker/json-schema'
import type { OutputUnit, Schema, SchemaDraft } from '@cfworker/json-schema'
import type {
  OpenAPIObject,
  ReferenceObject,
  SchemaObject,
} from 'openapi3-ts/oas31'

import { resolveRef } from './document.js'

export type { OutputUnit, SchemaDraft }

/**
 * Keywords whose only job is to say that something nested failed. The specific
 * errors always follow them, so repeating "a subschema had errors" above every
 * one of them just pads the response.
 */
const CONTAINER_KEYWORDS = new Set([
  '$ref',
  '$recursiveRef',
  'properties',
  'patternProperties',
  'additionalProperties',
  'unevaluatedProperties',
  'items',
  'prefixItems',
  'additionalItems',
  'unevaluatedItems',
  'allOf',
  'then',
  'else',
  'dependentSchemas',
  'contains',
])

/**
 * Reduce the validator's output to the errors worth showing a caller.
 *
 * Drops the container keywords above, then de-duplicates. The last step is a
 * workaround: with `shortCircuit: false`, `additionalProperties` is re-applied
 * to any property `properties` already *rejected* — the implementation only
 * marks a property evaluated when it passes — so an `additionalProperties:
 * false` schema reports a second, misleading "not allowed here" against a
 * property it does in fact declare. It never changes `valid`, only the error
 * list.
 *
 * Undoing it: drop a boolean-`false` error at a path that some *other* error
 * already accounts for, at that path or below it. A `false` schema never
 * recurses, so it can never be the reason for a deeper error — if there is
 * one, the `false` is the re-check and not the real complaint.
 */
export function normalizeErrors(units: readonly OutputUnit[]): OutputUnit[] {
  const kept: OutputUnit[] = []
  const seen = new Set<string>()
  const explained: string[] = []

  for (const unit of units) {
    if (CONTAINER_KEYWORDS.has(unit.keyword)) continue
    const id = `${unit.instanceLocation}\u0000${unit.keyword}`
    if (seen.has(id)) continue
    seen.add(id)
    kept.push(unit)
    if (unit.keyword !== 'false') explained.push(unit.instanceLocation)
  }

  return kept.filter(
    (unit) =>
      unit.keyword !== 'false' ||
      !explained.some(
        (at) =>
          at === unit.instanceLocation ||
          at.startsWith(`${unit.instanceLocation}/`),
      ),
  )
}

/** Validates any subschema of the document it was built from. */
export type SchemaValidator = (
  value: unknown,
  schema: SchemaObject | ReferenceObject,
) => OutputUnit[]

/**
 * Walk the document once and return a validator over it.
 *
 * `dereference` records each node's absolute URI on the node itself, as
 * non-enumerable properties (`__absolute_uri__`, `__absolute_ref__`). That
 * mutates the document object the consumer passed in, but invisibly:
 * non-enumerable properties do not appear in `Object.keys`, spreads, or
 * `JSON.stringify`, so the document served at the reference endpoint is
 * byte-for-byte the one that came in.
 */
export function createSchemaValidator(
  document: OpenAPIObject,
  draft: SchemaDraft,
): SchemaValidator {
  let lookup: Record<string, Schema | boolean>
  try {
    lookup = dereference(document as unknown as Schema)
  } catch (cause) {
    throw new Error(
      `withOpenApi: could not index the document for validation — ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    )
  }
  addPointerAliases(lookup, document)

  return (value, schema) => {
    // `shortCircuit: false` — a request that gets rejected should be told
    // everything that is wrong with it, not just the first thing.
    const result = validate(value, schema as Schema, draft, lookup, false)
    return result.valid ? [] : normalizeErrors(result.errors)
  }
}

/**
 * Register every node under its bare JSON pointer as well as its absolute URI.
 *
 * `dereference` stamps each node it walks with the absolute URI its `$ref`
 * resolves to, and `validate` prefers that stamp. But the walk only descends
 * through *JSON Schema* keywords, and an OpenAPI `parameters` list is a plain
 * array under a key it does not recognise — so a parameter whose schema is
 * `{ $ref: '#/components/schemas/Foo' }` is never stamped, and resolving it
 * falls back to looking up the raw `'#/components/schemas/Foo'`, which is not
 * a key the lookup has.
 *
 * Aliasing each `<root>#<pointer>` key to its bare `<pointer>` closes that,
 * for parameters and for anything else the walk does not reach.
 */
function addPointerAliases(
  lookup: Record<string, Schema | boolean>,
  document: OpenAPIObject,
): void {
  const root = (document as { __absolute_uri__?: string }).__absolute_uri__
  if (root === undefined) return

  for (const [uri, schema] of Object.entries(lookup)) {
    if (uri === root) {
      lookup['#'] ??= schema
      continue
    }
    if (!uri.startsWith(`${root}#`)) continue
    const pointer = uri.slice(root.length)
    lookup[pointer] ??= schema
  }
}

/**
 * The `description` of the schema the failing keyword belongs to.
 *
 * A validator says what is mechanically wrong — `"-3 is less than 0."` — while
 * the document says what the field is *for*. The second is the half a caller
 * can usually act on, and it is already written; this goes and gets it.
 *
 * `keywordLocation` is a JSON pointer into the schema in which `$ref` appears
 * as a literal segment, meaning "the validator followed the reference here",
 * so walking it means resolving those hops as they come. The final segment is
 * the keyword itself, so the node before it is the schema that failed.
 *
 * Never throws. A description is a nicety, and a walk that does not land is
 * simply one violation without one.
 */
export function describeFailure(
  document: OpenAPIObject,
  rootSchema: SchemaObject | ReferenceObject,
  unit: OutputUnit,
): string | undefined {
  const node = schemaAt(document, rootSchema, unit.keywordLocation)
  if (node === undefined) return undefined

  // `required` fails against the *object*, but the thing worth describing is
  // the property that is missing. The validator names it only inside its
  // message, so read it from there — and fall back to the object's own prose
  // if that wording ever changes, rather than losing the description.
  if (unit.keyword === 'required') {
    const missing = /required property "([^"]+)"/.exec(unit.error)?.[1]
    const property =
      missing === undefined ? undefined : node.properties?.[missing]
    if (property !== undefined && typeof property !== 'boolean') {
      const described = descriptionOf(follow(document, property))
      if (described !== undefined) return described
    }
  }

  return descriptionOf(node)
}

/** Walk a schema-side JSON pointer to the schema holding the failing keyword. */
function schemaAt(
  document: OpenAPIObject,
  rootSchema: SchemaObject | ReferenceObject,
  keywordLocation: string,
): SchemaObject | undefined {
  if (!keywordLocation.startsWith('#')) return undefined

  const segments = keywordLocation
    .slice(1)
    .split('/')
    .filter((part) => part !== '')
  // Drop the keyword: what failed is the schema holding it.
  segments.pop()

  let node: unknown = rootSchema
  for (const raw of segments) {
    if (typeof node !== 'object' || node === null) return undefined
    if (raw === '$ref') {
      node = follow(document, node)
      continue
    }
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    node = (node as Record<string, unknown>)[key]
  }

  // The landing node can itself be a bare reference — a property spelled
  // `{ $ref: '#/components/schemas/Email' }` keeps its prose over there.
  return follow(document, node)
}

function descriptionOf(schema: SchemaObject | undefined): string | undefined {
  const description = schema?.description
  return typeof description === 'string' && description !== ''
    ? description
    : undefined
}

function follow(
  document: OpenAPIObject,
  node: unknown,
): SchemaObject | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  try {
    return resolveRef<SchemaObject>(document, node as SchemaObject)
  } catch {
    return undefined
  }
}

/**
 * Pick the schema draft matching the document's `openapi` version.
 *
 * 3.1 aligned with JSON Schema 2020-12; 3.0 used a bespoke subset closer to
 * draft 4. Neither the `nullable` keyword nor 3.0's other divergences are
 * translated, so a 3.0 document is best converted to 3.1 before it gets here.
 */
export function draftFor(document: OpenAPIObject): SchemaDraft {
  return document.openapi?.startsWith('3.0') ? '4' : '2020-12'
}
