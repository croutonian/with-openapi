/**
 * CORS, derived from the document.
 *
 * An OpenAPI document already knows most of a CORS policy. Which methods a
 * path accepts is exactly its declared operations. Which request headers to
 * allow is its `in: header` parameters, plus `Content-Type` where it takes a
 * body, plus whatever its security schemes carry credentials in. Which
 * response headers to expose is its Response Objects' `headers`. Hand-writing
 * all of that beside a document that already says it is how the two drift, and
 * a drifted CORS policy fails as an opaque browser error rather than a 4xx you
 * can read.
 *
 * What the document does **not** know is who may call the API. `servers` says
 * where the API is, not which origins may reach it, so `origin` is required
 * configuration and is never inferred. That is the one field where guessing
 * would be a security decision made from the wrong data.
 *
 * Everything here is derived once, per route, at construction. A preflight
 * costs a route match and a header write.
 */

import type {
  OpenAPIObject,
  ResponseObject,
  SecuritySchemeObject,
} from 'openapi3-ts/oas31'

import { resolveRef, type IndexedRoute } from './document.js'

/**
 * Which origins may call the API.
 *
 * A literal `'*'` with `credentials` is forbidden by the Fetch standard, so in
 * that combination the request's `Origin` is reflected instead.
 */
export type CorsOrigin =
  '*' | string | readonly string[] | ((origin: string | null) => boolean)

/** CORS configuration. Everything not listed here comes from the document. */
export interface OpenApiCorsOptions {
  /**
   * Allowed origins. **Required, and never derived** — a document describes
   * where an API lives, not who may call it.
   */
  origin: CorsOrigin

  /** Send `Access-Control-Allow-Credentials: true`. @defaultValue `false` */
  credentials?: boolean

  /** `Access-Control-Max-Age` in seconds, for preflight caching. */
  maxAge?: number

  /**
   * Request headers to allow **on top of** the ones derived from the document.
   * Reach for this when a header is genuinely not describable in OpenAPI; a
   * header the API actually reads belongs in the document instead.
   */
  allowedHeaders?: readonly string[]

  /** Response headers to expose on top of the ones derived from the document. */
  exposedHeaders?: readonly string[]

  /** Status for a successful preflight. @defaultValue `204` */
  optionsSuccessStatus?: number
}

/**
 * Response headers a browser exposes without being asked, so naming them in
 * `Access-Control-Expose-Headers` is noise.
 *
 * @see https://fetch.spec.whatwg.org/#cors-safelisted-response-header-name
 */
const SAFELISTED_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-language',
  'content-length',
  'content-type',
  'expires',
  'last-modified',
  'pragma',
])

/** Header names are case-insensitive; keep the first spelling seen. */
class HeaderNames {
  readonly #byLower = new Map<string, string>()

  add(name: string): void {
    const lower = name.toLowerCase()
    if (!this.#byLower.has(lower)) this.#byLower.set(lower, name)
  }

  has(name: string): boolean {
    return this.#byLower.has(name.toLowerCase())
  }

  join(): string {
    return [...this.#byLower.values()].join(', ')
  }
}

/**
 * The request header a security scheme travels in, or `undefined` when it
 * travels somewhere CORS does not care about (a cookie, a query parameter).
 */
function securityHeaderName(scheme: SecuritySchemeObject): string | undefined {
  switch (scheme.type) {
    case 'apiKey':
      return scheme.in === 'header' ? scheme.name : undefined
    case 'http':
    case 'oauth2':
    case 'openIdConnect':
      return 'Authorization'
    default:
      return undefined
  }
}

/** What a preflight for one path template answers with. */
interface RouteCors {
  /** `Access-Control-Allow-Methods` — the path's declared operations. */
  readonly methods: string
  /** `Access-Control-Allow-Headers`. */
  readonly allowedHeaders: string
  /** `Access-Control-Expose-Headers`, or `''` when there is nothing to expose. */
  readonly exposedHeaders: string
}

function deriveRouteCors(
  document: OpenAPIObject,
  route: IndexedRoute,
  schemeHeaders: ReadonlyMap<string, string>,
  options: OpenApiCorsOptions,
): RouteCors {
  const allowed = new HeaderNames()
  const exposed = new HeaderNames()

  for (const operation of route.operations.values()) {
    for (const param of operation.parameters.header) allowed.add(param.name)

    // `application/json` is not a CORS-safelisted `Content-Type` value, so any
    // operation taking a body needs the header allowed explicitly.
    if (operation.requestBody !== undefined) allowed.add('Content-Type')

    for (const requirement of operation.security ?? []) {
      for (const schemeName of Object.keys(requirement)) {
        const header = schemeHeaders.get(schemeName)
        if (header !== undefined) allowed.add(header)
      }
    }

    for (const response of Object.values(operation.operation.responses ?? {})) {
      const resolved = resolveRef<ResponseObject>(document, response)
      for (const name of Object.keys(resolved.headers ?? {})) {
        if (!SAFELISTED_RESPONSE_HEADERS.has(name.toLowerCase()))
          exposed.add(name)
      }
    }
  }

  for (const name of options.allowedHeaders ?? []) allowed.add(name)
  for (const name of options.exposedHeaders ?? []) exposed.add(name)

  return {
    methods: route.allow.join(', '),
    allowedHeaders: allowed.join(),
    exposedHeaders: exposed.join(),
  }
}

/** Built once at construction; answers preflights and stamps responses. */
export interface CorsPolicy {
  /** A preflight is `OPTIONS` carrying `Access-Control-Request-Method`. */
  isPreflight(req: Request): boolean
  /** The preflight response for a matched route. */
  preflight(req: Request, route: IndexedRoute): Response
  /**
   * Copy a response, adding the response-side CORS headers.
   *
   * The matched route is passed in rather than looked up, because it is what
   * `Access-Control-Expose-Headers` is derived from and the caller already
   * holds it. A side channel keyed on the request would be the alternative,
   * and the authoring guide's rule 3 exists to prevent exactly that.
   */
  stamp(
    response: Response,
    req: Request,
    route: IndexedRoute | undefined,
  ): Response
}

function resolveAllowOrigin(
  options: OpenApiCorsOptions,
  requestOrigin: string | null,
): string | null {
  const { origin } = options

  if (typeof origin === 'function') {
    return origin(requestOrigin) ? (requestOrigin ?? '*') : null
  }

  if (origin === '*') {
    // A literal `*` cannot be combined with credentials, so reflect instead.
    // With no `Origin` to reflect there is nothing to allow.
    return options.credentials === true ? requestOrigin : '*'
  }

  const allowed = typeof origin === 'string' ? [origin] : origin
  return requestOrigin !== null && allowed.includes(requestOrigin)
    ? requestOrigin
    : null
}

function applyCommonHeaders(
  headers: Headers,
  options: OpenApiCorsOptions,
  allowOrigin: string | null,
): void {
  // A disallowed origin simply gets no CORS headers. Enforcement is the
  // browser's; refusing to serve the request would break every non-browser
  // client for no gain.
  if (allowOrigin === null) return

  headers.set('Access-Control-Allow-Origin', allowOrigin)
  if (options.credentials === true) {
    headers.set('Access-Control-Allow-Credentials', 'true')
  }
  // Anything but a literal `*` varies by origin, so a shared cache must not
  // serve one origin's response to another. Appended rather than set, so a
  // `Vary` the handler already chose survives — and skipped when the handler
  // already named `Origin`, so the value does not grow a duplicate.
  if (allowOrigin !== '*' && !varyIncludesOrigin(headers)) {
    headers.append('Vary', 'Origin')
  }
}

function varyIncludesOrigin(headers: Headers): boolean {
  const vary = headers.get('Vary')
  return (
    vary !== null &&
    vary.split(',').some((token) => token.trim().toLowerCase() === 'origin')
  )
}

/** Derive a CORS policy from the document, once. */
export function createCorsPolicy(
  document: OpenAPIObject,
  routes: readonly IndexedRoute[],
  options: OpenApiCorsOptions,
): CorsPolicy {
  const schemeHeaders = new Map<string, string>()
  for (const [name, node] of Object.entries(
    document.components?.securitySchemes ?? {},
  )) {
    const header = securityHeaderName(
      resolveRef<SecuritySchemeObject>(document, node),
    )
    if (header !== undefined) schemeHeaders.set(name, header)
  }

  const byRoute = new Map<IndexedRoute, RouteCors>()
  for (const route of routes) {
    byRoute.set(route, deriveRouteCors(document, route, schemeHeaders, options))
  }

  const successStatus = options.optionsSuccessStatus ?? 204

  return {
    isPreflight: (req) =>
      req.method === 'OPTIONS' &&
      req.headers.has('Access-Control-Request-Method'),

    preflight(req, route) {
      const derived = byRoute.get(route)
      const headers = new Headers()
      applyCommonHeaders(
        headers,
        options,
        resolveAllowOrigin(options, req.headers.get('Origin')),
      )

      if (derived !== undefined) {
        if (derived.methods !== '') {
          headers.set('Access-Control-Allow-Methods', derived.methods)
        }
        if (derived.allowedHeaders !== '') {
          headers.set('Access-Control-Allow-Headers', derived.allowedHeaders)
        }
      }
      if (options.maxAge !== undefined) {
        headers.set('Access-Control-Max-Age', String(options.maxAge))
      }
      // The requested method varies the answer, and the requested headers are
      // echoed into the answer whenever they are not a fixed list.
      headers.append('Vary', 'Access-Control-Request-Method')

      return new Response(null, { status: successStatus, headers })
    },

    stamp(response, req, route) {
      // Copied rather than mutated, because a response from `fetch` — or any
      // response already handed out — has immutable headers.
      const headers = new Headers(response.headers)
      applyCommonHeaders(
        headers,
        options,
        resolveAllowOrigin(options, req.headers.get('Origin')),
      )

      const exposed =
        route === undefined ? undefined : byRoute.get(route)?.exposedHeaders
      if (exposed !== undefined && exposed !== '') {
        headers.set('Access-Control-Expose-Headers', exposed)
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    },
  }
}
