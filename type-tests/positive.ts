// Cases that must compile. Part of the main `tsconfig.json`, so `pnpm
// typecheck` fails if any of them stops holding.

import { pipeline } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'
import { withCors } from '@supabase/middleware/cors'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

import { withOpenApi } from '../src/index.js'

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
