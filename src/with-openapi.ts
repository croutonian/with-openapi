/**
 * `withOpenApi` — match every request against an OpenAPI document, optionally
 * refuse the ones it does not describe, and optionally serve a Scalar
 * reference for it.
 *
 * The whole document is read at construction. A request then costs a segment
 * walk, a map lookup, and whatever validation was asked for.
 */

import { defineMiddleware } from '@supabase/middleware'
import type { Middleware } from '@supabase/middleware'
import type {
  OpenAPIObject,
  ReferenceObject,
  SchemaObject,
} from 'openapi3-ts/oas31'

import { readBody } from './body.js'
import { createCorsPolicy } from './cors.js'
import {
  indexDocument,
  isHttpMethod,
  resolveSchema,
  type IndexedOperation,
  type IndexedRoute,
} from './document.js'
import {
  coerceToSchema,
  parseCookies,
  readParameter,
  type ParameterSources,
} from './params.js'
import { createRouter } from './router.js'
import { resolveReference, type ScalarReferenceOptions } from './reference.js'
import {
  createSchemaValidator,
  describeFailure,
  draftFor,
  type OutputUnit,
  type SchemaValidator,
} from './schema.js'
import type {
  OpenApiContribution,
  OpenApiParams,
  OpenApiRejection,
  OpenApiUnmatched,
  OpenApiViolation,
  ParameterIn,
  WithOpenApiConfig,
} from './types.js'

const PARAMETER_LOCATIONS = ['path', 'query', 'header', 'cookie'] as const

const EMPTY_PARAMS: OpenApiParams = {
  path: {},
  query: {},
  header: {},
  cookie: {},
}

const REJECTION_MESSAGES: Record<OpenApiRejection['kind'], string> = {
  route_not_found: 'no operation in the API description matches this path',
  method_not_allowed: 'this path does not accept this method',
  unsupported_media_type: 'this operation does not accept this content type',
  validation_failed: 'the request does not match the API description',
}

interface ResolvedValidateOptions {
  readonly path: boolean
  readonly query: boolean
  readonly header: boolean
  readonly cookie: boolean
  readonly body: boolean
  readonly additionalQuery: 'allow' | 'reject'
  readonly status: number
  readonly describe: boolean
  readonly maxViolations: number
}

function resolveValidateOptions(
  validate: WithOpenApiConfig['validate'],
): ResolvedValidateOptions | undefined {
  if (validate === false) return undefined
  const given = validate === undefined || validate === true ? {} : validate
  return {
    path: given.path ?? true,
    query: given.query ?? true,
    header: given.header ?? true,
    cookie: given.cookie ?? true,
    body: given.body ?? true,
    additionalQuery: given.additionalQuery ?? 'allow',
    status: given.status ?? 400,
    describe: given.describe ?? true,
    maxViolations: given.maxViolations ?? 20,
  }
}

function normalizeBasePath(basePath: string | undefined): string | undefined {
  if (basePath === undefined || basePath === '' || basePath === '/')
    return undefined
  if (!basePath.startsWith('/')) {
    throw new Error(
      `withOpenApi: basePath must start with "/", got ${JSON.stringify(basePath)}`,
    )
  }
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
}

/** `undefined` when the pathname is outside the mount point entirely. */
function stripBasePath(
  pathname: string,
  basePath: string | undefined,
): string | undefined {
  if (basePath === undefined) return pathname
  if (pathname === basePath) return '/'
  return pathname.startsWith(`${basePath}/`)
    ? pathname.slice(basePath.length)
    : undefined
}

function toViolation(
  location: ParameterIn | 'body',
  name: string | undefined,
  unit: OutputUnit,
  description: string | undefined,
): OpenApiViolation {
  return {
    in: location,
    ...(name === undefined ? {} : { name }),
    location: unit.instanceLocation,
    keyword: unit.keyword,
    ...(description === undefined ? {} : { description }),
    // A boolean `false` schema is how `additionalProperties: false` refuses a
    // key. The validator's own wording for it ("False boolean schema.") says
    // nothing to whoever sent the request.
    message:
      unit.keyword === 'false' ? 'this value is not allowed here' : unit.error,
  }
}

function defaultRejectionResponse(rejection: OpenApiRejection): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (rejection.allow !== undefined && rejection.allow.length > 0) {
    headers.set('allow', rejection.allow.join(', '))
  }
  return Response.json(
    {
      error: rejection.kind,
      message: rejection.message ?? REJECTION_MESSAGES[rejection.kind],
      ...(rejection.accepts === undefined
        ? {}
        : { accepts: rejection.accepts }),
      violations: rejection.violations,
    },
    { status: rejection.status, headers },
  )
}

function unmatched(
  document: OpenAPIObject,
  reason: OpenApiUnmatched['reason'],
  method: string,
  route: string | undefined,
): { openapi: OpenApiUnmatched } {
  return {
    openapi: {
      matched: false,
      reason,
      document,
      route,
      method,
      operation: undefined,
      operationId: undefined,
      security: undefined,
      params: EMPTY_PARAMS,
      body: undefined,
      mediaType: undefined,
      validated: false,
    },
  }
}

/**
 * Read every declared parameter off the request, coercing and checking as
 * configured. Mutates `params` and `violations` rather than allocating four
 * intermediate records per request.
 */
function collectParameters(
  document: OpenAPIObject,
  operation: IndexedOperation,
  sources: ParameterSources,
  options: ResolvedValidateOptions | undefined,
  coerce: boolean,
  resolve: (
    s: SchemaObject | ReferenceObject | undefined,
  ) => SchemaObject | undefined,
  validateSchema: SchemaValidator | undefined,
  params: Record<ParameterIn, Record<string, unknown>>,
  violations: OpenApiViolation[],
): void {
  const describe = options?.describe === true

  for (const location of PARAMETER_LOCATIONS) {
    const checking = options !== undefined && options[location]
    for (const param of operation.parameters[location]) {
      const read = readParameter(param, sources)

      if (!read.present) {
        if (checking && param.required) {
          violations.push({
            in: location,
            name: param.name,
            message: `required ${location} parameter "${param.name}" is missing`,
            ...(describe && param.description !== undefined
              ? { description: param.description }
              : {}),
          })
        }
        continue
      }

      const value = coerce
        ? coerceToSchema(read.value, param.resolved, resolve)
        : read.value
      params[location][param.name] = value

      if (
        checking &&
        param.schema !== undefined &&
        validateSchema !== undefined
      ) {
        for (const unit of validateSchema(value, param.schema)) {
          violations.push(
            toViolation(
              location,
              param.name,
              unit,
              describe
                ? (param.description ??
                    describeFailure(document, param.schema, unit))
                : undefined,
            ),
          )
        }
      }
    }
  }
}

/**
 * Middleware that holds an API to its own description.
 *
 * @example Reject anything the document does not describe, and serve the docs.
 * ```ts
 * import { pipeline } from '@supabase/middleware'
 * import { withOpenApi } from '@croutonian/with-openapi'
 * import document from './openapi.json' with { type: 'json' }
 *
 * export default {
 *   fetch: pipeline(
 *     [withOpenApi({ document, reference: true })],
 *     async (_req, ctx) => {
 *       if (!ctx.openapi.matched) return new Response(null, { status: 404 })
 *       return Response.json({ op: ctx.openapi.operationId })
 *     },
 *   ),
 * }
 * ```
 *
 * @example Describe and document, but do not enforce.
 * ```ts
 * withOpenApi({
 *   document,
 *   validate: false,
 *   onUnknownRoute: 'pass',
 *   reference: { path: '/docs' },
 * })
 * ```
 *
 * @category Middleware
 */
export const withOpenApi: Middleware<
  'openapi',
  WithOpenApiConfig,
  Record<never, never>,
  OpenApiContribution
> = defineMiddleware<
  // 1. Key — the slot this contributes to `ctx`.
  'openapi',
  // 2. Config — what the consumer passes to `withOpenApi(config, handler)`.
  WithOpenApiConfig,
  // 3. In — no upstream prerequisites, so this composes anywhere.
  Record<never, never>,
  // 4. Contribution — the shape that lands at `ctx.openapi`.
  OpenApiContribution
>({
  key: 'openapi',
  run: (config) => {
    // Outer stage — runs once, at construction. Every document read happens
    // here: nothing below depends on an environment value, so there is no
    // reason to defer it to the first request.
    const { document } = config
    const routes = indexDocument(document)
    const router = createRouter(routes)
    const options = resolveValidateOptions(config.validate)
    const coerce = config.coerce ?? true
    const basePath = normalizeBasePath(config.basePath)
    const onUnknownRoute = config.onUnknownRoute ?? 'reject'
    const onUnknownMethod = config.onUnknownMethod ?? 'reject'

    const resolve = (schema: SchemaObject | ReferenceObject | undefined) =>
      resolveSchema(document, schema)

    // Indexing the document for validation walks all of it, so only do it when
    // something is actually going to be validated.
    const validateSchema =
      options === undefined
        ? undefined
        : createSchemaValidator(
            document,
            config.schemaDraft ?? draftFor(document),
          )

    const reference =
      config.reference === undefined || config.reference === false
        ? undefined
        : resolveReference(
            document,
            config.reference === true
              ? {}
              : (config.reference as ScalarReferenceOptions),
            basePath,
          )
    // Serialized once — the document does not change between requests.
    const documentJson =
      reference === undefined ? undefined : JSON.stringify(document)

    const cors =
      config.cors === undefined
        ? undefined
        : createCorsPolicy(document, routes, config.cors)

    /**
     * One request, taken to the point where it either has an answer of its own
     * or a contribution to hand downstream.
     *
     * The matched route is reported alongside, because the CORS response phase
     * derives `Access-Control-Expose-Headers` from it and threading it out
     * here beats reaching for a side channel keyed on the request.
     */
    const handle = async (
      req: Request,
    ): Promise<{
      result: Response | { openapi: OpenApiContribution }
      route: IndexedRoute | undefined
    }> => {
      const respond = async (rejection: OpenApiRejection) => ({
        result:
          (await config.reject?.(rejection, req)) ??
          defaultRejectionResponse(rejection),
        route: undefined,
      })

      if (config.skip?.(req) === true) {
        return {
          result: unmatched(document, 'skipped', req.method, undefined),
          route: undefined,
        }
      }

      const url = new URL(req.url)
      const method = req.method.toLowerCase()

      if (reference !== undefined && (method === 'get' || method === 'head')) {
        const head = method === 'head'
        if (url.pathname === reference.path) {
          return {
            result: new Response(head ? null : reference.render(), {
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': reference.cacheControl,
              },
            }),
            route: undefined,
          }
        }
        if (url.pathname === reference.documentPath) {
          return {
            result: new Response(head ? null : documentJson, {
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': reference.cacheControl,
              },
            }),
            route: undefined,
          }
        }
      }

      const pathname = stripBasePath(url.pathname, basePath)
      const match = pathname === undefined ? undefined : router.match(pathname)

      if (match === undefined) {
        if (onUnknownRoute === 'pass') {
          return {
            result: unmatched(document, 'no_route', req.method, undefined),
            route: undefined,
          }
        }
        // Two very different mistakes share this status, and the stock
        // wording points at the document for both. A pathname that never
        // reached `basePath` is almost always the mount being wrong rather
        // than the document being incomplete, and saying which is the
        // difference between reading a response body and bisecting a deploy.
        return respond({
          kind: 'route_not_found',
          status: 404,
          method: req.method,
          pathname: url.pathname,
          message:
            pathname === undefined
              ? `the pathname ${JSON.stringify(url.pathname)} is outside basePath ${JSON.stringify(basePath)}`
              : `no operation in the API description matches ${JSON.stringify(pathname)}`,
          violations: [],
        })
      }

      // Answered here, before the operation lookup, because a preflight is an
      // `OPTIONS` that almost no document declares an operation for — the
      // lookup below would call it a 405 and the browser would report an
      // opaque CORS failure. The route is all a preflight needs: its declared
      // methods *are* `Access-Control-Allow-Methods`.
      if (cors !== undefined && cors.isPreflight(req)) {
        return { result: cors.preflight(req, match.route), route: match.route }
      }

      const operation = isHttpMethod(method)
        ? match.route.operations.get(method)
        : undefined

      if (operation === undefined) {
        if (onUnknownMethod === 'pass') {
          return {
            result: unmatched(
              document,
              'no_operation',
              req.method,
              match.route.template,
            ),
            route: match.route,
          }
        }
        return respond({
          kind: 'method_not_allowed',
          status: 405,
          method: req.method,
          pathname: url.pathname,
          route: match.route.template,
          allow: match.route.allow,
          violations: [],
        })
      }

      const violations: OpenApiViolation[] = []
      const params: Record<ParameterIn, Record<string, unknown>> = {
        path: {},
        query: {},
        header: {},
        cookie: {},
      }

      collectParameters(
        document,
        operation,
        {
          pathValues: match.pathValues,
          search: url.searchParams,
          headers: req.headers,
          // Only pay for cookie parsing when the operation declares one.
          cookies:
            operation.parameters.cookie.length > 0
              ? parseCookies(req.headers.get('cookie'))
              : {},
        },
        options,
        coerce,
        resolve,
        validateSchema,
        params,
        violations,
      )

      if (options?.additionalQuery === 'reject') {
        for (const name of new Set(url.searchParams.keys())) {
          if (operation.knownQueryNames.has(name)) continue
          if (
            operation.knownQueryPrefixes.some((prefix) =>
              name.startsWith(prefix),
            )
          ) {
            continue
          }
          violations.push({
            in: 'query',
            name,
            message: `query parameter "${name}" is not declared by this operation`,
          })
        }
      }

      let body: unknown
      let mediaType: string | undefined

      const requestBody = operation.requestBody
      if (requestBody !== undefined && options?.body === true) {
        const read = await readBody(req, requestBody.contents, resolve)

        if (read.outcome === 'unsupported') {
          return respond({
            kind: 'unsupported_media_type',
            status: 415,
            method: req.method,
            pathname: url.pathname,
            route: operation.route,
            accepts: requestBody.contents.map((entry) => entry.mediaType),
            violations: [
              {
                in: 'body',
                message:
                  read.essence === undefined
                    ? 'a content-type header is required for a request with a body'
                    : `content type "${read.essence}" is not accepted by this operation`,
              },
            ],
          })
        }

        if (read.outcome === 'absent') {
          if (requestBody.required) {
            violations.push({
              in: 'body',
              message: 'a request body is required',
              ...(options?.describe === true &&
              requestBody.description !== undefined
                ? { description: requestBody.description }
                : {}),
            })
          }
        } else if (read.outcome === 'malformed') {
          mediaType = read.content.mediaType
          violations.push({ in: 'body', message: read.message })
        } else {
          mediaType = read.content.mediaType
          body = read.value
          if (
            read.validatable &&
            read.content.schema !== undefined &&
            validateSchema
          ) {
            const schema = read.content.schema
            for (const unit of validateSchema(read.value, schema)) {
              violations.push(
                toViolation(
                  'body',
                  undefined,
                  unit,
                  options?.describe === true
                    ? describeFailure(document, schema, unit)
                    : undefined,
                ),
              )
            }
          }
        }
      }

      if (violations.length > 0) {
        return respond({
          kind: 'validation_failed',
          status: options?.status ?? 400,
          method: req.method,
          pathname: url.pathname,
          route: operation.route,
          // Capped: one bad array in a large body can fail thousands of times,
          // and nobody reads past the first few.
          violations: violations.slice(
            0,
            options?.maxViolations ?? violations.length,
          ),
        })
      }

      // Contribute: fall through with the matched operation on `ctx.openapi`.
      return {
        result: {
          openapi: {
            matched: true,
            document,
            route: operation.route,
            method: operation.method,
            operation: operation.operation,
            operationId: operation.operationId,
            security: operation.security,
            params,
            body,
            mediaType,
            validated: options !== undefined,
          },
        },
        route: match.route,
      }
    }

    // Plain request-side middleware unless CORS is on. The response seam exists
    // here only to stamp headers on the way out, and rule 5 says not to open it
    // for anything a request-side pass can already do.
    if (cors === undefined) {
      return async (req: Request) => (await handle(req)).result
    }

    return async function* (req: Request) {
      const { result, route } = await handle(req)

      // A rejection of ours is still a response a browser has to be allowed to
      // read — an unstamped 400 surfaces as an opaque CORS error instead of the
      // violations it carries. Returning here short-circuits: nothing runs
      // downstream, so there is no response phase to reach.
      if (result instanceof Response) return cors.stamp(result, req, route)

      const response = yield result
      return cors.stamp(response, req, route)
    }
  },
})
