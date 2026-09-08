/**
 * Capturing a document's type where it is written.
 *
 * `withOpenApi` reads the document you hand it, and when that document is a
 * literal at the call site its type comes along for free. A document kept in
 * its own module is the case that needs help: writing
 * `const doc: OpenAPIObject = { ... }` widens `paths` to an index signature
 * and throws away everything the projections depend on.
 *
 * `satisfies OpenAPIObject` is most of the answer — it keeps route names and
 * schemas — but it still lets leaf values widen where the target type says
 * `string`, so `servers[0].url` comes back as `string` rather than the URL you
 * wrote. A `const` type parameter infers as-const *before* checking the
 * constraint, so nothing widens.
 */

import type { OpenAPIObject } from 'openapi3-ts/oas31'

/**
 * Check a document against `OpenAPIObject` without widening it.
 *
 * Returns its argument; the whole function is the type parameter.
 *
 * @example
 * ```ts
 * // document.ts
 * export const document = defineDocument({
 *   openapi: '3.1.0',
 *   info: { title: 'Acme', version: '1' },
 *   servers: [{ url: '/api' }],
 *   paths: { ... },
 * })
 *
 * // server.ts — `ctx.openapi` is typed against these operations
 * pipeline([withOpenApi({ document })], handler)
 *
 * document.servers[0].url //  '/api', not string
 * ```
 */
export function defineDocument<const Document extends OpenAPIObject>(
  document: Document,
): Document {
  return document
}
