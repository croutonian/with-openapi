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
import type { ScalarReferenceOptions } from './reference.js'
import type { SchemaDraft } from './schema.js'

/** Where a parameter was declared. */
export type ParameterIn = 'path' | 'query' | 'header' | 'cookie'

/**
 * Deserialized, coerced parameters, grouped by where they came from.
 *
 * `unknown` rather than the schema's type: the document is read at runtime, and
 * lifting a schema into a TypeScript type needs code generation, which this
 * package does not do. The value is coerced and checked; narrowing the type is
 * the consumer's. Pinned by `N5` in `type-tests/negative.ts`, so widening this
 * to `any` — which would compile and look safer while checking nothing — fails
 * the build.
 */
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
  /** What the validator objected to, mechanically. */
  readonly message: string
  /**
   * The document's own prose for whatever failed — the Parameter Object's
   * `description`, or the `description` on the schema the failing keyword
   * belongs to.
   *
   * {@link message} says what is wrong; this says what the thing is *for*, and
   * it is the half a caller can usually act on. Absent when the document does
   * not describe that field, or when `validate.describe` is off.
   */
  readonly description?: string
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
  /**
   * A more specific explanation than the kind's stock wording, when there is
   * one to give. `route_not_found` uses it to say whether the pathname missed
   * `basePath` or matched no template under it, which are the same status and
   * very different mistakes.
   */
  readonly message?: string
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
   * the body is never read here and reaches the handler unexamined.
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
   * Include the document's `description` prose on each violation, so a caller
   * is told what a field is for and not only that it is wrong.
   *
   * A document's descriptions are written for its consumers, which is who
   * reads these errors — but turn this off if yours carries notes you would
   * rather not return in a response body.
   *
   * @defaultValue `true`
   */
  describe?: boolean

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
   * `/openapi.json`.
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

/**
 * `ctx.openapi` when an operation in the document describes the request.
 *
 * Every field here is something a consumer would otherwise have to derive from
 * the document itself. What the caller already holds — the document, the
 * method, the validate config, the request body — is deliberately absent.
 */
export interface OpenApiMatched {
  readonly matched: true
  /**
   * Path template that matched, e.g. `'/users/{id}'`.
   *
   * The label to group a request under. A pathname cannot be used for that —
   * `/users/1` and `/users/2` are separate series — so this is what metrics,
   * traces, rate-limit buckets and audit logs key on.
   */
  readonly route: string
  /**
   * The Operation Object, with its own `$ref` (if any) already followed.
   *
   * How a consumer drives behaviour off the document: `x-` extensions
   * (`operation['x-rate-limit']`, `x-required-scope`), `deprecated` to stamp a
   * sunset header, `tags` to attribute a request to the team that owns it.
   *
   * Here rather than left to a `document.paths` lookup because a Path Item can
   * itself be a `$ref`, so that lookup is not reliably an Operation Object.
   */
  readonly operation: OperationObject
  /**
   * A name for this operation that survives the path changing, which `route`
   * does not — so it is the stable key for a permission check, a handler
   * dispatch table, or a log field you intend to query next year.
   *
   * Read through from {@link operation}, so it adds no information; it is here
   * because it is the field consumers reach for most.
   */
  readonly operationId: string | undefined
  /**
   * Security requirements in force — the operation's, falling back to the
   * document's. Never enforced here; contributed so a downstream auth layer
   * can enforce it without a route table of its own, and tell a public
   * operation (`[]`) from one that needs a credential.
   *
   * The fallback is the reason this is not left to the consumer: reading
   * `operation.security` alone treats a document-secured operation as public,
   * which fails open.
   */
  readonly security: SecurityRequirementObject[] | undefined
  /**
   * Deserialized and (unless turned off) coerced parameters, keyed by
   * location.
   *
   * The one that saves real work: `params.query.limit` holds a number, already
   * checked against its `maximum`, with `style`/`explode` honoured, so
   * `?ids=1,2,3` arrives as an array and `?filter[a]=b` as an object. Without
   * it every handler re-reads `URLSearchParams` and re-coerces by hand.
   *
   * Values only — every entry is typed `unknown`. See {@link OpenApiParams}.
   */
  readonly params: OpenApiParams
  /**
   * Which `content` key matched, and so which Media Type Object's schema the
   * body was checked against.
   *
   * Worth having when an operation declares more than one: it tells a handler
   * which contract it is serving (`application/json` against
   * `application/vnd.acme.v2+json`, say), and tells telemetry which declared
   * variant clients actually send, which is what you need before deprecating
   * one.
   *
   * Not a substitute for the request's own `Content-Type`: a catch-all range
   * matches anything, so this says which *declaration* applied, not what was
   * actually sent. A handler choosing how to parse wants the header — which is
   * what this middleware reads too.
   *
   * Contributed because it is the one decision made here that a consumer
   * cannot cheaply repeat: it takes resolving a `$ref` on `requestBody` and
   * reimplementing the exact / type-wildcard / catch-all precedence, and a
   * reimplementation that drifted would disagree about which schema ran. The
   * parsed body is not contributed for the opposite reason — reading it here
   * does not consume it, so `req.json()` in the handler is one call away and
   * returns the same value this middleware validated.
   */
  readonly mediaType: string | undefined
}

/**
 * `ctx.openapi` when the document does not describe the request.
 *
 * Only reachable with `onUnknownRoute`/`onUnknownMethod` set to `'pass'`, or a
 * `skip` — which is how you put this middleware in front of an existing API
 * and watch what it *would* have refused before letting it refuse anything.
 */
export interface OpenApiUnmatched {
  readonly matched: false
  /**
   * Which kind of miss it was, so an observer can tell them apart: `no_route`
   * is a path the document does not describe (an undocumented endpoint, or
   * someone probing), `no_operation` is a path it does describe reached with a
   * verb it does not, and `skipped` is the consumer's own `skip` firing. Three
   * different follow-up actions, and nothing else records which happened.
   */
  readonly reason: 'skipped' | 'no_route' | 'no_operation'
  /** Set when the path matched but the method was not declared under it. */
  readonly route: string | undefined
  readonly operation: undefined
  readonly operationId: undefined
  readonly security: undefined
  /**
   * Always empty here. Kept uniform across both branches so the field every
   * consumer reaches for does not need a `matched` guard.
   */
  readonly params: OpenApiParams
  readonly mediaType: undefined
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
