/**
 * `OpenAPIInterface` — a document, plus typed projections of it.
 *
 * The middleware is deliberately untyped in the document: it reads whatever
 * document it is handed at runtime, so `ctx.openapi.params` is `unknown` and a
 * handler narrows it. That is the honest answer when the document is data.
 *
 * When the document is a literal in your own source, though, its type is right
 * there — and the only thing that throws it away is assigning it to
 * `OpenAPIObject` first. So this class takes the literal as a `const` type
 * parameter and hands the captured type back as projections: which routes
 * exist, which methods each declares, and what a parameter actually is.
 *
 * There is no runtime magic here. Types are erased; the constructor stores a
 * reference. What the class buys is a capture site and somewhere to hang the
 * per-operation projections that make a union of every operation usable.
 */

import type { SingleKeyEntry } from '@supabase/middleware'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

import type { OpenApiContribution, WithOpenApiConfig } from './types.js'
import { withOpenApi } from './with-openapi.js'
import type {
  MethodsOf,
  OperationOf,
  ParamsFor,
  RoutesOf,
} from './document-types.js'

/** The slice of a pipeline `ctx` these projections read. */
export interface OpenApiCtx {
  readonly openapi: OpenApiContribution
}

/**
 * Wrap a document literal so its type survives.
 *
 * @example
 * ```ts
 * const api = new OpenAPIInterface({
 *   openapi: '3.1.0',
 *   info: { title: 'Acme', version: '1' },
 *   paths: {
 *     '/users/{id}': {
 *       get: {
 *         operationId: 'getUser',
 *         parameters: [
 *           { name: 'id', in: 'path', required: true,
 *             schema: { type: 'integer' } },
 *         ],
 *         responses: { '200': { description: 'ok' } },
 *       },
 *     },
 *   },
 * })
 *
 * export default {
 *   fetch: pipeline([api.middleware()], async (_req, ctx) => {
 *     const params = api.params(ctx, '/users/{id}', 'get')
 *     if (params === undefined) return new Response(null, { status: 404 })
 *     params.path.id // number, not unknown
 *     return Response.json({ id: params.path.id })
 *   }),
 * }
 * ```
 *
 * **Do not annotate the document on the way in.** The literal has to reach
 * the constructor with its type intact — as the argument, or as a `const`
 * declared with `satisfies OpenAPIObject`, which preserves route keys and
 * schemas alike. Both degenerate inputs fail loudly rather than quietly
 * handing back `unknown`:
 *
 * - `const doc: OpenAPIObject = {...}` widens `paths` to an index signature,
 *   and `paths` is optional on that interface, so {@link RoutesOf} resolves to
 *   `never` and no route name can be passed to {@link OpenAPIInterface.params}.
 * - a `.json` import keeps its keys but widens every value, so `in: string` no
 *   longer narrows to a `ParameterLocation` and the document fails this
 *   constructor's own constraint.
 *
 * Both are pinned as `N6` and `N7` in `type-tests/negative.ts`.
 */
export class OpenAPIInterface<const Document extends OpenAPIObject> {
  constructor(readonly document: Document) {}

  /**
   * The middleware for this document, as a `pipeline` entry, with the rest of
   * the config optional.
   *
   * The return type is spelled out rather than inferred because JSR refuses to
   * publish an inferred one — every function in a public API needs an explicit
   * return type there, so consumers get `.d.ts` files without a type-check.
   */
  middleware(
    config: Omit<WithOpenApiConfig, 'document'> = {},
  ): SingleKeyEntry<'openapi', Record<never, never>, OpenApiContribution> {
    return withOpenApi({ ...config, document: this.document })
  }

  /**
   * The Operation Object at `route` + `method`, typed — so `x-` extensions and
   * `tags` read back as what the document says rather than as `unknown`.
   *
   * A pure projection of the document; it does not look at a request.
   */
  operation<
    Route extends RoutesOf<Document>,
    Method extends MethodsOf<Document, Route>,
  >(route: Route, method: Method): OperationOf<Document, Route, Method> {
    const paths = this.document.paths as
      Record<string, Record<string, unknown>> | undefined
    return paths?.[route]?.[method] as OperationOf<Document, Route, Method>
  }

  /**
   * `ctx.openapi.params` for one operation, with each value typed by its
   * schema — `undefined` when this request is not that operation.
   *
   * The check is real, not a bare cast: the contributed `route` must be the
   * one asked for, and where the document gives the operation an
   * `operationId`, that must match too. The `operationId` comparison is what
   * makes naming the wrong `method` safe — without it, asking for `'post'`
   * types on a `get` request would hand back a confidently wrong shape.
   *
   * An operation with no `operationId` cannot be cross-checked that way, so
   * there the method is taken on trust. Declaring `operationId` is worth it
   * for more than tidiness.
   */
  params<
    Route extends RoutesOf<Document>,
    Method extends MethodsOf<Document, Route>,
  >(
    ctx: OpenApiCtx,
    route: Route,
    method: Method,
  ): ParamsFor<Document, Route, Method> | undefined {
    const { openapi } = ctx
    if (!openapi.matched || openapi.route !== route) return undefined

    const declared = (
      this.operation(route, method) as { operationId?: string } | undefined
    )?.operationId
    if (
      declared !== undefined &&
      openapi.operationId !== undefined &&
      declared !== openapi.operationId
    ) {
      return undefined
    }

    return openapi.params as ParamsFor<Document, Route, Method>
  }
}
