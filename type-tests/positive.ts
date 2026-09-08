// Cases that must compile. Part of the main `tsconfig.json`, so `pnpm
// typecheck` fails if any of them stops holding.

import { pipeline } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'
import { withCors } from '@supabase/middleware/cors'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

import { defineDocument, withOpenApi } from '../src/index.js'
import type { OperationIdsOf, ParamsFor, RoutesOf } from '../src/index.js'

/**
 * Exact type equality. Needed because an assignability check passes for a
 * wider type — `string` accepts `'/users'` — so `satisfies` alone cannot tell
 * a working projection from one that has degraded to `string`.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Expect<T extends true> = T

const document: OpenAPIObject = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {},
}

// P1 — stands alone as a fetch entry, with no prerequisites to satisfy.
const _p1 = withOpenApi({ document }, async (_req, ctx) =>
  Response.json({ matched: ctx.openapi.matched }),
) satisfies FetchHandler
void _p1

// P2 — composes in a pipeline, and `ctx` carries both keys.
const _p2 = pipeline(
  [withCors({}), withOpenApi({ document })],
  async (_req, ctx) =>
    Response.json({ cors: ctx.cors, matched: ctx.openapi.matched }),
) satisfies FetchHandler
void _p2

// P3 — the contribution is a discriminated union: narrowing on `matched`
// exposes the operation, and nothing else does.
const _p3 = withOpenApi({ document }, async (_req, ctx) => {
  if (!ctx.openapi.matched) return new Response(null, { status: 404 })
  const id: string | undefined = ctx.openapi.operationId
  const route: string = ctx.openapi.route
  const limit: unknown = ctx.openapi.params.query['limit']
  return Response.json({ id, route, limit })
}) satisfies FetchHandler
void _p3

// P4 — every optional knob is optional.
const _p4 = withOpenApi(
  {
    document,
    basePath: '/api',
    validate: { query: false, additionalQuery: 'reject', status: 422 },
    coerce: false,
    onUnknownRoute: 'pass',
    onUnknownMethod: 'pass',
    reference: { path: '/docs', configuration: { darkMode: true } },
    cors: {
      origin: (origin) => origin?.endsWith('.example.com') === true,
      credentials: true,
      maxAge: 600,
      allowedHeaders: ['X-Tenant'],
      exposedHeaders: ['X-Request-Id'],
      optionsSuccessStatus: 200,
    },
    schemaDraft: '2020-12',
    skip: (req) => req.method === 'OPTIONS',
    reject: (rejection) =>
      rejection.kind === 'route_not_found'
        ? undefined
        : new Response(null, { status: 400 }),
  },
  async () => new Response(),
) satisfies FetchHandler
void _p4

// P8..P17 — the type projections, against a document captured by
// `defineDocument` in its own module rather than inlined at the call site.
const doc = defineDocument({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  servers: [{ url: '/functions/v1/api' }],
  components: {
    schemas: { Limit: { type: 'integer', minimum: 1, maximum: 100 } },
    parameters: {
      TraceId: { name: 'x-trace-id', in: 'header', schema: { type: 'string' } },
    },
  },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { $ref: '#/components/schemas/Limit' },
          },
          {
            name: 'active',
            in: 'query',
            required: true,
            schema: { type: 'boolean' },
          },
          {
            name: 'tags',
            in: 'query',
            schema: { type: 'array', items: { type: 'string' } },
          },
          { $ref: '#/components/parameters/TraceId' },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/users/{id}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      ],
      get: {
        operationId: 'getUser',
        parameters: [
          { name: 'session', in: 'cookie', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok' } },
      },
      delete: {
        operationId: 'deleteUser',
        responses: { '204': { description: 'gone' } },
      },
    },
  },
})

type Doc = typeof doc

// P8 — the route union, not `string`.
type _p8 = Expect<Equals<RoutesOf<Doc>, '/users' | '/users/{id}'>>

// P9 — every declared operationId.
type _p9 = Expect<
  Equals<OperationIdsOf<Doc>, 'listUsers' | 'getUser' | 'deleteUser'>
>

// P10 — a leaf value `satisfies` would have widened to `string`.
type _p10 = Expect<Equals<Doc['servers'][0]['url'], '/functions/v1/api'>>

// P11 — a required path parameter is a number and is not optional.
type _p11 = Expect<
  Equals<ParamsFor<Doc, '/users/{id}', 'get'>['path'], { id: number }>
>

// P12 — an optional query parameter behind a `$ref`.
type _p12 = Expect<
  Equals<ParamsFor<Doc, '/users', 'get'>['query']['limit'], number | undefined>
>

// P13 — `required: true` makes it non-optional; a boolean schema a boolean.
type _p13 = Expect<
  Equals<ParamsFor<Doc, '/users', 'get'>['query']['active'], boolean>
>

// P14 — arrays carry their item type.
type _p14 = Expect<
  Equals<ParamsFor<Doc, '/users', 'get'>['query']['tags'], string[] | undefined>
>

// P15 — a `$ref`d Parameter Object resolves, and lands under its own `in`.
type _p15 = Expect<
  Equals<
    ParamsFor<Doc, '/users', 'get'>['header']['x-trace-id'],
    string | undefined
  >
>

// P16 — the Path Item's own parameters merge into every operation under it.
type _p16 = Expect<
  Equals<ParamsFor<Doc, '/users/{id}', 'delete'>['path'], { id: number }>
>

// P17 — cookie parameters are kept separate from query.
type _p17 = Expect<
  Equals<
    ParamsFor<Doc, '/users/{id}', 'get'>['cookie'],
    { session?: string | undefined }
  >
>

void (null as unknown as [
  _p8,
  _p9,
  _p10,
  _p11,
  _p12,
  _p13,
  _p14,
  _p15,
  _p16,
  _p17,
])

// P18..P21 — the document-aware call signature. `withOpenApi` in a pipeline
// carries the document's own operations through to the handler, so narrowing
// on `operationId` reaches that operation's parameter types with no cast and
// no runtime guard. This is the thing `ctx.openapi.params` being `unknown`
// cost, and it is why the projections exist at all.
const _p18 = pipeline(
  [
    withOpenApi({
      document: {
        openapi: '3.1.0',
        info: { title: 't', version: '1' },
        paths: {
          '/users/{id}': {
            get: {
              operationId: 'getUser',
              parameters: [
                {
                  name: 'id',
                  in: 'path',
                  required: true,
                  schema: { type: 'integer' },
                },
              ],
              responses: { '200': { description: 'ok' } },
            },
          },
          '/users': {
            get: {
              operationId: 'listUsers',
              parameters: [
                { name: 'limit', in: 'query', schema: { type: 'integer' } },
              ],
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      },
    }),
  ],
  async (_req, ctx) => {
    if (!ctx.openapi.matched) return new Response(null, { status: 404 })

    // P21 — the fields that are not specialized are still there.
    const route: string = ctx.openapi.route
    void route

    // P19 — the path parameter of the operation that matched.
    if (ctx.openapi.operationId === 'getUser') {
      const id: number = ctx.openapi.params.path.id
      return Response.json({ id })
    }
    // P20 — a different operation, a different parameter set.
    if (ctx.openapi.operationId === 'listUsers') {
      const limit: number | undefined = ctx.openapi.params.query.limit
      return Response.json({ limit })
    }
    // Both operations handled above, so the union is exhausted here — which
    // is itself the proof that the discrimination is complete.
    return ctx.openapi satisfies never
  },
) satisfies FetchHandler
void _p18

// P22 — an annotated document still works exactly as before. `RoutesOf` is
// `never` there, so the contribution falls back to the unspecialized shape
// rather than collapsing to a union with no `matched: true` branch.
const _p22 = withOpenApi({ document }, async (_req, ctx) => {
  if (!ctx.openapi.matched) return new Response(null, { status: 404 })
  const limit: unknown = ctx.openapi.params.query['limit']
  return Response.json({ limit })
}) satisfies FetchHandler
void _p22
