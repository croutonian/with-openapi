// Compiled against the *built* `.d.ts` with the floor version of tsc, so the
// `typescript >= 5.4` peer dependency stays honest.

import { withOpenApi } from '@johnstonmatt/with-openapi'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

const document: OpenAPIObject = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {},
}

export const handler = withOpenApi(
  { document, reference: true },
  async (_req, ctx) => {
    if (!ctx.openapi.matched) return new Response(null, { status: 404 })
    return Response.json({
      route: ctx.openapi.route,
      id: ctx.openapi.operationId,
    })
  },
)
