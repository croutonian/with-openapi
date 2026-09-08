/**
 * `@croutonian/with-openapi` — hold an API to its own description.
 *
 * One middleware, {@link withOpenApi}, doing three separable things:
 *
 * - **Match.** Every request is resolved to an Operation Object, which lands
 *   on `ctx.openapi` along with its deserialized parameters.
 * - **Reject.** Optionally, refuse what the document does not describe — an
 *   unknown path, an undeclared method, a body that fails its schema.
 * - **Document.** Optionally, serve a Scalar API reference over the same
 *   document, so what is enforced and what is published cannot drift.
 *
 * @packageDocumentation
 */

export { withOpenApi } from './with-openapi.js'

export { OpenAPIInterface } from './interface.js'
export type { OpenApiCtx } from './interface.js'
export type {
  FromSchema,
  MethodsOf,
  OperationIdsOf,
  OperationOf,
  ParamsFor,
  RoutesOf,
} from './document-types.js'

export type { CorsOrigin, CorsPolicy, OpenApiCorsOptions } from './cors.js'

export { SCALAR_CDN_URL } from './reference.js'
export type { ScalarHtmlInput, ScalarReferenceOptions } from './reference.js'

export type { HttpMethod } from './document.js'
export type { SchemaDraft } from './schema.js'
export type {
  OpenApiContribution,
  OpenApiMatched,
  OpenApiParams,
  OpenApiRejection,
  OpenApiRejectionKind,
  OpenApiUnmatched,
  OpenApiValidateOptions,
  OpenApiViolation,
  ParameterIn,
  WithOpenApiConfig,
} from './types.js'

// Re-exported so a consumer who hand-nests instead of using `pipeline` can
// write `satisfies FetchHandler` without importing @supabase/middleware.
export type { FetchHandler } from '@supabase/middleware'
