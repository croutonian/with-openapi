// Cases that must NOT compile. Checked by `scripts/check-negative-types.mjs`,
// which asserts each marker's diagnostic actually appears — and that no other
// diagnostic does, so a case cannot pass for the wrong reason.
//
// Marker format: `// @expect-error <TSCODE> <substring of the message>`

import { pipeline } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

import { defineDocument, withOpenApi } from '../src/index.js'

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

// N6 — the shape a `.json` import produces: keys survive but every value
// widens, so `in: string` no longer narrows to a ParameterLocation and the
// document fails `defineDocument`'s constraint. Loud, at the capture site.
declare const jsonShaped: {
  openapi: string
  info: { title: string; version: string }
  paths: {
    '/users': {
      get: {
        parameters: { name: string; in: string; required: boolean }[]
        responses: { '200': { description: string } }
      }
    }
  }
}
// @expect-error TS2345 is not assignable to parameter of type 'OpenAPIObject'
defineDocument(jsonShaped)

// N7 — a document annotated `OpenAPIObject` loses its literal type, so the
// contribution falls back to the unspecialized shape and `params` is
// `unknown`. The fallback is deliberate — it is what keeps this backward
// compatible — so the failure is at the use, not at the mount.
withOpenApi({ document }, async (_req, ctx) => {
  if (!ctx.openapi.matched) return new Response()
  // @expect-error TS2322 Type 'unknown' is not assignable to type 'number'
  const limit: number = ctx.openapi.params.query['limit']
  return Response.json({ limit })
})

// N8 — `onUnknownRoute: 'pass'` makes the unmatched branch reachable again,
// and the type says so. Both branches carry the same keys, so the difference
// shows in the value: `route` is the literal on a matched contribution and
// `string | undefined` once an unmatched one is possible. Without this, the
// elimination on default configs would be a convenience that could also be
// wrong.
const passing = withOpenApi({
  document: defineDocument({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/things': {
        get: {
          operationId: 'listThings',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  }),
  onUnknownRoute: 'pass',
})
pipeline([passing], async (_req, ctx) => {
  // @expect-error TS2322 is not assignable to type '"/things"'
  const route: '/things' = ctx.openapi.route
  return Response.json({ route })
})
