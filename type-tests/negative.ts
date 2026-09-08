// Cases that must NOT compile. Checked by `scripts/check-negative-types.mjs`,
// which asserts each marker's diagnostic actually appears — and that no other
// diagnostic does, so a case cannot pass for the wrong reason.
//
// Marker format: `// @expect-error <TSCODE> <substring of the message>`

import { pipeline } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

import { withOpenApi } from '../src/index.js'

const document: OpenAPIObject = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {},
}

// N1 — `ctx` is genuinely typed, not silently `any`.
// @expect-error TS2339 Property 'nope' does not exist on type
withOpenApi({ document }, async (_req, ctx) =>
  Response.json({ x: ctx.nope }),
) satisfies FetchHandler

// N2 — the contribution is a union, so the Operation Object is only reachable
// once `matched` is narrowed. This is the mistake the type exists to catch.
// @expect-error TS18048 'ctx.openapi.operation' is possibly 'undefined'
withOpenApi({ document }, async (_req, ctx) =>
  Response.json({ tags: ctx.openapi.operation.tags }),
) satisfies FetchHandler

// N3 — two instances collide on the `openapi` key.
// @expect-error TS2345 middleware-conflict
pipeline(
  [withOpenApi({ document }), withOpenApi({ document })],
  async () => new Response(),
) satisfies FetchHandler

// N4 — the document is not optional.
// @expect-error TS2769 Property 'document' is missing
withOpenApi({ basePath: '/api' }, async () => new Response())

// N5 — coercion happens at runtime, so a parameter is `unknown` and not the
// type its schema implies. Pinned because widening it to `any` would make this
// compile and hand every consumer an unchecked value that looks checked.
// @expect-error TS2322 Type 'unknown' is not assignable to type 'number'
withOpenApi({ document }, async (_req, ctx) => {
  const limit: number = ctx.openapi.params.query['limit']
  return Response.json({ limit })
}) satisfies FetchHandler
