/**
 * The public surface: what a consumer passes in, what lands on `ctx`, and what
 * a rejection looks like.
 */

import type {
  OpenAPIObject,
  OperationObject,
  SecurityRequirementObject,
} from 'openapi3-ts/oas31'

import type { OpenApiCorsOptions } from './cors.js'
import type { HttpMethod } from './document.js'
import type { ScalarReferenceOptions } from './reference.js'
import type { SchemaDraft } from './schema.js'

/** Where a parameter was declared. */
export type ParameterIn = 'path' | 'query' | 'header' | 'cookie'

/** Deserialized, coerced parameters, grouped by where they came from. */
export interface OpenApiParams {
  readonly path: Readonly<Record<string, unknown>>
  readonly query: Readonly<Record<string, unknown>>
  readonly header: Readonly<Record<string, unknown>>
  readonly cookie: Readonly<Record<string, unknown>>
}

/** One thing wrong with a request. */
export interface OpenApiViolation {
  /** Which half of the request it is about. */
  readonly in: ParameterIn | 'body'
  /** Parameter name. Absent for a violation of the body as a whole. */
  readonly name?: string
  /** JSON pointer into the offending value, from the schema validator. */
  readonly location?: string
  /** The JSON Schema keyword that failed, when one did. */
  readonly keyword?: string
  /** Human-readable description. */
  readonly message: string
}

/** Why the middleware is refusing a request. */
export type OpenApiRejectionKind =
  | 'route_not_found'
  | 'method_not_allowed'
  | 'unsupported_media_type'
  | 'validation_failed'

/** Everything known about a refusal, handed to {@link WithOpenApiConfig.reject}. */
export interface OpenApiRejection {
  readonly kind: OpenApiRejectionKind
  /** Status the default response would use. */
  readonly status: number
  /** The request's method, as sent. */
  readonly method: string
  /** The request's pathname, before `basePath` is stripped. */
  readonly pathname: string
  /** Path template that matched, when one did. */
  readonly route?: string
  /** Methods the route does declare. Set on `method_not_allowed`. */
  readonly allow?: readonly string[]
  /** Media types the operation accepts. Set on `unsupported_media_type`. */
  readonly accepts?: readonly string[]
  /** Empty for the routing kinds, which have nothing per-field to report. */
  readonly violations: readonly OpenApiViolation[]
}

/** Which halves of a request to check, and how strictly. */
export interface OpenApiValidateOptions {
  /** Check path parameters. @defaultValue `true` */
  path?: boolean
  /** Check query parameters. @defaultValue `true` */
  query?: boolean
  /** Check header parameters. @defaultValue `true` */
  header?: boolean
  /** Check cookie parameters. @defaultValue `true` */
  cookie?: boolean
  /**
   * Check — and therefore read and parse — the request body. With this off,
   * `ctx.openapi.body` is `undefined` and the handler reads the body itself.
   *
   * @defaultValue `true`
   */
  body?: boolean
  /**
   * What to do with query parameters the operation does not declare.
   * `'allow'` ignores them; `'reject'` treats each as a violation.
   *
   * @defaultValue `'allow'`
   */
  additionalQuery?: 'allow' | 'reject'
  /** Status for a validation failure. @defaultValue `400` */
  status?: number
  /**
   * Most violations to report in one rejection. One bad array in a large body
   * can fail thousands of times, and nobody reads past the first few.
   *
   * @defaultValue `20`
   */
  maxViolations?: number
}

/** Per-instance configuration for `withOpenApi`. */
export interface WithOpenApiConfig {
  /**
   * The OpenAPI 3.1 document. Read once, at construction: `$ref`s are
   * followed, parameters merged, and path templates compiled, so a request
   * costs a segment walk rather than a document traversal.
   *
   * External `$ref`s are not fetched — bundle the document first.
   */
  document: OpenAPIObject

  /**
   * Prefix stripped from the pathname before matching, for an API mounted
   * under a sub-path. The reference endpoint's paths are **not** relative to
   * it; they are matched against the full pathname.
   */
  basePath?: string

  /**
   * Check requests against the document, and reject the ones that do not fit.
   *
   * `false` turns rejection off entirely: routes are still matched and
   * parameters still deserialized onto `ctx.openapi.params`, but nothing is
   * refused for being invalid. Pass an object to check some halves of the
   * request and not others.
   *
   * @defaultValue `true`
   */
  validate?: boolean | OpenApiValidateOptions

  /**
   * Convert parameter text into the JSON types the schemas describe, so
   * `?limit=10` satisfies `type: integer`. Off, every non-string parameter in
   * every document fails its own type check.
   *
   * @defaultValue `true`
   */
  coerce?: boolean

  /**
   * What to do with a pathname no path template matches. `'reject'` answers
   * `404`; `'pass'` falls through to the handler with
   * `ctx.openapi.matched === false`.
   *
   * @defaultValue `'reject'`
   */
  onUnknownRoute?: 'reject' | 'pass'

  /**
   * What to do when the path matches but the operation is not declared for
   * the request's method. `'reject'` answers `405` with an `Allow` header;
   * `'pass'` falls through with `ctx.openapi.matched === false`.
   *
   * @defaultValue `'reject'`
   */
  onUnknownMethod?: 'reject' | 'pass'

  /**
   * Serve a Scalar API reference and the document JSON. `true` takes every
   * default — the page at `/reference`, the document at
   * `/reference/openapi.json`.
   *
   * @defaultValue off
   */
  reference?: boolean | ScalarReferenceOptions

  /**
   * Answer CORS preflights and stamp `Access-Control-*` headers, with the
   * policy derived from the document: a path's declared operations are its
   * allowed methods, its `in: header` parameters and security schemes are its
   * allowed request headers, its Response Objects' `headers` are what it
   * exposes.
   *
   * `origin` is the one field that is never derived and so is required — a
   * document says where an API lives, not who may call it.
   *
   * Rejections are stamped too. An unstamped `400` reaches a browser as an
   * opaque CORS error rather than the violations it is carrying.
   *
   * @defaultValue off
   */
  cors?: OpenApiCorsOptions

  /**
   * JSON Schema draft the document's schemas are written against. Inferred
   * from the document's `openapi` version, which is almost always right.
   */
  schemaDraft?: SchemaDraft

  /**
   * Leave a request alone entirely — no matching, no reference endpoint, no
   * rejection. The handler still sees `ctx.openapi`, with
   * `matched === false`.
   */
  skip?: (req: Request) => boolean

  /**
   * Answer a refusal yourself. Return `undefined` to fall back to the default
   * response for that {@link OpenApiRejection}.
   */
  reject?: (
    rejection: OpenApiRejection,
    req: Request,
  ) => Response | undefined | Promise<Response | undefined>
}

/** `ctx.openapi` when an operation in the document describes the request. */
export interface OpenApiMatched {
  readonly matched: true
  /** The document, as passed to `withOpenApi`. */
  readonly document: OpenAPIObject
  /** Path template that matched, e.g. `'/users/{id}'`. */
  readonly route: string
  /** Lowercase method the operation was declared under. */
  readonly method: HttpMethod
  /** The Operation Object, with its own `$ref` (if any) already followed. */
  readonly operation: OperationObject
  readonly operationId: string | undefined
  /**
   * Security requirements in force — the operation's, falling back to the
   * document's. Contributed for a downstream auth middleware to act on; this
   * middleware never enforces them.
   */
  readonly security: SecurityRequirementObject[] | undefined
  /** Deserialized and (unless turned off) coerced parameters. */
  readonly params: OpenApiParams
  /**
   * The parsed request body. `undefined` when the operation declares none,
   * when none was sent, when body validation is off, or when the media type
   * is binary and was deliberately left unread.
   */
  readonly body: unknown
  /** The `content` key that matched the request's content type. */
  readonly mediaType: string | undefined
  /** `false` when `validate: false` — the request was matched, not checked. */
  readonly validated: boolean
}

/** `ctx.openapi` when the document does not describe the request. */
export interface OpenApiUnmatched {
  readonly matched: false
  /** Why nothing matched. */
  readonly reason: 'skipped' | 'no_route' | 'no_operation'
  readonly document: OpenAPIObject
  /** Set when the path matched but the method was not declared under it. */
  readonly route: string | undefined
  /** The request's method, as sent. */
  readonly method: string
  readonly operation: undefined
  readonly operationId: undefined
  readonly security: undefined
  readonly params: OpenApiParams
  readonly body: undefined
  readonly mediaType: undefined
  readonly validated: false
}

/**
 * What lands at `ctx.openapi`.
 *
 * With the default `onUnknownRoute`/`onUnknownMethod` of `'reject'` and no
 * `skip`, the handler only ever sees {@link OpenApiMatched} — anything else was
 * already answered with a `404` or a `405`. Narrow with
 * `if (!ctx.openapi.matched)` where those are set to `'pass'`.
 */
export type OpenApiContribution = OpenApiMatched | OpenApiUnmatched
