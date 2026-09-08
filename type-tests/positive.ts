// Cases that must compile. Part of the main `tsconfig.json`, so `pnpm
// typecheck` fails if any of them stops holding.

import { pipeline } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'
import { withCors } from '@supabase/middleware/cors'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

import { OpenAPIInterface, withOpenApi } from '../src/index.js'
import type { OperationIdsOf, RoutesOf } from '../src/index.js'

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

// P8..P16 — OpenAPIInterface projections. Written as exact-equality checks:
// every one of these degrades to `unknown` or `string` if the document's
// literal type is lost, and an assignability check would not notice.
const api = new OpenAPIInterface({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  components: {
    schemas: {
      Limit: { type: 'integer', minimum: 1, maximum: 100 },
      User: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
          manager: { $ref: '#/components/schemas/User' },
        },
      },
    },
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

type Doc = (typeof api)['document']

// P8 — the route union, not `string`.
type _p8 = Expect<Equals<RoutesOf<Doc>, '/users' | '/users/{id}'>>

// P9 — every declared operationId, not `string | undefined`.
type _p9 = Expect<
  Equals<OperationIdsOf<Doc>, 'listUsers' | 'getUser' | 'deleteUser'>
>

// P10 — a required path parameter is a number and is not optional.
type P10 = NonNullable<ReturnType<typeof api.params<'/users/{id}', 'get'>>>
type _p10 = Expect<Equals<P10['path'], { id: number }>>

// P11 — an optional query parameter behind a `$ref`.
type P11 = NonNullable<ReturnType<typeof api.params<'/users', 'get'>>>
type _p11 = Expect<Equals<P11['query']['limit'], number | undefined>>

// P12 — `required: true` makes it non-optional, and a boolean schema a boolean.
type _p12 = Expect<Equals<P11['query']['active'], boolean>>

// P13 — arrays carry their item type.
type _p13 = Expect<Equals<P11['query']['tags'], string[] | undefined>>

// P14 — a `$ref`d Parameter Object resolves, and lands under its own `in`.
type _p14 = Expect<Equals<P11['header']['x-trace-id'], string | undefined>>

// P15 — the Path Item's own parameters merge into every operation under it.
type P15 = NonNullable<ReturnType<typeof api.params<'/users/{id}', 'delete'>>>
type _p15 = Expect<Equals<P15['path'], { id: number }>>

// P16 — cookie parameters are kept separate from query.
type _p16 = Expect<Equals<P10['cookie'], { session?: string | undefined }>>

void (null as unknown as [_p8, _p9, _p10, _p11, _p12, _p13, _p14, _p15, _p16])

// P17 — the document may live in its own module, declared with `satisfies`
// instead of annotated. Route keys and schemas both survive that, so the
// projections work exactly as they do for a literal passed inline.
const SATISFIED = {
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
  },
} satisfies OpenAPIObject

const detached = new OpenAPIInterface(SATISFIED)
type P17 = NonNullable<ReturnType<typeof detached.params<'/users/{id}', 'get'>>>
// Property types are asserted rather than the whole object: `satisfies`
// leaves the mapped type in a form that is mutually assignable with
// `{ id: number }` but not *identical* to it, and `Equals` is strict about
// that. What a caller touches is the property, and that is exact.
type _p17 = Expect<Equals<P17['path']['id'], number>>
type _p17routes = Expect<
  Equals<RoutesOf<(typeof detached)['document']>, '/users/{id}'>
>

void (null as unknown as [_p17, _p17routes])
