/**
 * Reading an OpenAPI 3.1 document into the shape the middleware needs at
 * request time.
 *
 * Everything here runs **once**, when the consumer constructs the middleware:
 * `$ref`s are followed, path-item and operation `parameters` are merged, and
 * every path template is split into segments. A request then costs a segment
 * walk and a map lookup, with no document traversal at all.
 *
 * Anything unresolvable is a misconfiguration, not a bad request, so it throws
 * here rather than turning into a 4xx later (authoring guide, rule 8).
 */

import type {
  OpenAPIObject,
  OperationObject,
  ParameterLocation,
  ParameterObject,
  ParameterStyle,
  PathItemObject,
  ReferenceObject,
  RequestBodyObject,
  SchemaObject,
  SecurityRequirementObject,
} from 'openapi3-ts/oas31'

/** The HTTP methods an OpenAPI Path Item Object may declare an operation for. */
export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const

/** One of the eight methods {@link HTTP_METHODS} lists. */
export type HttpMethod = (typeof HTTP_METHODS)[number]

const METHOD_SET = new Set<string>(HTTP_METHODS)

/** Narrow an arbitrary lowercase method string to an {@link HttpMethod}. */
export function isHttpMethod(value: string): value is HttpMethod {
  return METHOD_SET.has(value)
}

/** True when a node is a Reference Object rather than the thing it points at. */
export function isRef(node: unknown): node is ReferenceObject {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (node as ReferenceObject).$ref === 'string'
  )
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

function pointerGet(document: OpenAPIObject, ref: string): unknown {
  if (!ref.startsWith('#/') && ref !== '#') {
    throw new Error(
      `withOpenApi: only local $refs are supported, got ${JSON.stringify(ref)}. ` +
        'Bundle external references into the document before passing it in.',
    )
  }
  if (ref === '#') return document

  let node: unknown = document
  for (const raw of ref.slice(2).split('/')) {
    const token = unescapePointerToken(decodeURIComponent(raw))
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[token]
  }
  return node
}

/**
 * Follow a `$ref` chain to the node it names.
 *
 * Structural nodes only — Path Items, Operations, Parameters, Request Bodies.
 * Schemas are deliberately **not** resolved before validation: the validator
 * resolves `$ref` itself against the whole document, which is what lets a
 * recursive schema work. {@link resolveSchema} is the exception, and exists
 * only so coercion can see a schema's `type`.
 */
export function resolveRef<T>(
  document: OpenAPIObject,
  node: T | ReferenceObject,
  seen: Set<string> = new Set(),
): T {
  let current: unknown = node
  while (isRef(current)) {
    const ref = current.$ref
    if (seen.has(ref)) {
      throw new Error(`withOpenApi: circular $ref chain at ${ref}`)
    }
    seen.add(ref)
    const target = pointerGet(document, ref)
    if (target === undefined) {
      throw new Error(
        `withOpenApi: $ref ${JSON.stringify(ref)} does not resolve`,
      )
    }
    current = target
  }
  return current as T
}

/**
 * Resolve a schema's `$ref` chain far enough to read its `type`, `items` and
 * `properties`. Used only to decide how to deserialize and coerce a parameter;
 * the *unresolved* schema is what gets handed to the validator.
 *
 * Returns `undefined` rather than throwing on a dangling ref, because a schema
 * the validator can still report on is more useful than a crash.
 */
export function resolveSchema(
  document: OpenAPIObject,
  schema: SchemaObject | ReferenceObject | undefined,
): SchemaObject | undefined {
  if (schema === undefined) return undefined
  try {
    return resolveRef<SchemaObject>(document, schema)
  } catch {
    return undefined
  }
}

/** One segment of a path template: a literal, or a `{name}` placeholder. */
export type Segment =
  | { readonly kind: 'static'; readonly value: string }
  | { readonly kind: 'param'; readonly name: string }

/** A parameter, with its defaults filled in and its schema pre-resolved. */
export interface IndexedParameter {
  readonly name: string
  readonly in: ParameterLocation
  readonly required: boolean
  readonly style: ParameterStyle
  readonly explode: boolean
  readonly allowEmptyValue: boolean
  /** As written in the document — handed to the validator unresolved. */
  readonly schema: SchemaObject | ReferenceObject | undefined
  /** `$ref` chain followed, so deserialization can read `type`. */
  readonly resolved: SchemaObject | undefined
}

/** One entry of a Request Body Object's `content` map. */
export interface IndexedContent {
  readonly mediaType: string
  readonly schema: SchemaObject | ReferenceObject | undefined
  readonly resolved: SchemaObject | undefined
}

/** A Request Body Object, flattened. */
export interface IndexedRequestBody {
  readonly required: boolean
  readonly contents: readonly IndexedContent[]
}

/** Everything the middleware needs about one operation, resolved up front. */
export interface IndexedOperation {
  readonly method: HttpMethod
  readonly route: string
  readonly operation: OperationObject
  readonly operationId: string | undefined
  readonly security: SecurityRequirementObject[] | undefined
  readonly parameters: Readonly<
    Record<ParameterLocation, readonly IndexedParameter[]>
  >
  readonly requestBody: IndexedRequestBody | undefined
  /**
   * Query string names the declared parameters may legitimately consume —
   * a `form`/`explode` object contributes its property names, not its own.
   * Only read when `additionalQuery: 'reject'`.
   */
  readonly knownQueryNames: ReadonlySet<string>
  /** `deepObject` parameters consume anything starting with `name[`. */
  readonly knownQueryPrefixes: readonly string[]
}

/** A path template, its segments, and the operations declared under it. */
export interface IndexedRoute {
  readonly template: string
  readonly segments: readonly Segment[]
  readonly operations: ReadonlyMap<HttpMethod, IndexedOperation>
  /** Declared methods, upper-cased — the `Allow` header on a 405. */
  readonly allow: readonly string[]
}

const PARAM_PATTERN = /^\{(.+)\}$/

function parseTemplate(template: string): Segment[] {
  if (!template.startsWith('/')) {
    throw new Error(
      `withOpenApi: path template ${JSON.stringify(template)} must start with "/"`,
    )
  }
  return normalizePathname(template)
    .slice(1)
    .split('/')
    .map((raw): Segment => {
      const match = PARAM_PATTERN.exec(raw)
      return match?.[1]
        ? { kind: 'param', name: match[1] }
        : { kind: 'static', value: raw }
    })
}

/**
 * Drop a single trailing slash so `/users` and `/users/` are the same route.
 * Applied to both templates and request pathnames, so the two always agree.
 */
export function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname
}

/** The shape a template reduces to when parameter *names* are ignored. */
function templateShape(segments: readonly Segment[]): string {
  return segments.map((s) => (s.kind === 'static' ? s.value : '{}')).join('/')
}

function defaultStyleFor(location: ParameterLocation): ParameterStyle {
  switch (location) {
    case 'path':
    case 'header':
      return 'simple'
    default:
      return 'form'
  }
}

function indexParameter(
  document: OpenAPIObject,
  param: ParameterObject,
): IndexedParameter {
  const style = param.style ?? defaultStyleFor(param.in)
  return {
    name: param.name,
    in: param.in,
    // A path parameter is required by definition; the spec says so and a
    // document that omits the flag is still describing a required value.
    required: param.in === 'path' ? true : (param.required ?? false),
    style,
    // `form` and `deepObject` explode by default; every other style does not.
    explode: param.explode ?? (style === 'form' || style === 'deepObject'),
    allowEmptyValue: param.allowEmptyValue ?? false,
    schema: param.schema,
    resolved: resolveSchema(document, param.schema),
  }
}

function mergeParameters(
  document: OpenAPIObject,
  pathLevel: readonly (ParameterObject | ReferenceObject)[] | undefined,
  operationLevel: readonly (ParameterObject | ReferenceObject)[] | undefined,
): Record<ParameterLocation, IndexedParameter[]> {
  const byIdentity = new Map<string, IndexedParameter>()
  for (const list of [pathLevel ?? [], operationLevel ?? []]) {
    for (const entry of list) {
      const param = resolveRef<ParameterObject>(document, entry)
      // Operation-level parameters override path-level ones with the same
      // (name, in) pair — later writes win because the operation list is second.
      byIdentity.set(
        `${param.in}:${param.name}`,
        indexParameter(document, param),
      )
    }
  }

  const grouped: Record<ParameterLocation, IndexedParameter[]> = {
    path: [],
    query: [],
    header: [],
    cookie: [],
  }
  for (const param of byIdentity.values()) grouped[param.in].push(param)
  return grouped
}

function indexRequestBody(
  document: OpenAPIObject,
  node: RequestBodyObject | ReferenceObject | undefined,
): IndexedRequestBody | undefined {
  if (node === undefined) return undefined
  const body = resolveRef<RequestBodyObject>(document, node)
  const contents: IndexedContent[] = Object.entries(body.content ?? {}).map(
    ([mediaType, media]) => ({
      mediaType: mediaType.toLowerCase(),
      schema: media?.schema,
      resolved: resolveSchema(document, media?.schema),
    }),
  )
  return { required: body.required ?? false, contents }
}

function queryConsumption(params: readonly IndexedParameter[]): {
  names: Set<string>
  prefixes: string[]
} {
  const names = new Set<string>()
  const prefixes: string[] = []
  for (const param of params) {
    if (param.style === 'deepObject') {
      prefixes.push(`${param.name}[`)
      continue
    }
    // An exploded `form` object is spelled out one property per query key, so
    // the parameter's own name never appears in the query string.
    const properties = param.resolved?.properties
    if (param.style === 'form' && param.explode && properties) {
      for (const key of Object.keys(properties)) names.add(key)
      continue
    }
    names.add(param.name)
  }
  return { names, prefixes }
}

/**
 * Read a document into a flat list of routes, outermost work done once.
 *
 * Throws on anything that cannot be made sense of — a dangling `$ref`, a path
 * template that does not start with `/`, or two templates that differ only in
 * the *names* of their parameters (`/a/{id}` and `/a/{key}` are one path, and
 * the spec forbids declaring both).
 */
export function indexDocument(document: OpenAPIObject): IndexedRoute[] {
  const routes: IndexedRoute[] = []
  const shapes = new Map<string, string>()

  for (const [template, node] of Object.entries(document.paths ?? {})) {
    if (node === undefined || node === null) continue
    const pathItem = resolveRef<PathItemObject>(document, node)
    const segments = parseTemplate(template)

    const shape = templateShape(segments)
    const clash = shapes.get(shape)
    if (clash !== undefined) {
      throw new Error(
        `withOpenApi: path templates ${JSON.stringify(clash)} and ` +
          `${JSON.stringify(template)} are the same path — they differ only in ` +
          'parameter names.',
      )
    }
    shapes.set(shape, template)

    const declared = new Set(
      segments.flatMap((s) => (s.kind === 'param' ? [s.name] : [])),
    )
    const operations = new Map<HttpMethod, IndexedOperation>()

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      if (operation === undefined) continue

      const parameters = mergeParameters(
        document,
        pathItem.parameters,
        operation.parameters,
      )

      for (const param of parameters.path) {
        if (!declared.has(param.name)) {
          throw new Error(
            `withOpenApi: ${method.toUpperCase()} ${template} declares a path ` +
              `parameter "${param.name}" that the template does not contain.`,
          )
        }
      }

      const { names, prefixes } = queryConsumption(parameters.query)
      operations.set(method, {
        method,
        route: template,
        operation,
        operationId: operation.operationId,
        security: operation.security ?? document.security,
        parameters,
        requestBody: indexRequestBody(document, operation.requestBody),
        knownQueryNames: names,
        knownQueryPrefixes: prefixes,
      })
    }

    routes.push({
      template,
      segments,
      operations,
      allow: [...operations.keys()].map((m) => m.toUpperCase()),
    })
  }

  return routes
}
