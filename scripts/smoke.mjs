// Loads the *built* bundle and exercises the four outcomes end to end. Run it
// under whatever runtime you want to check:
//
//   node scripts/smoke.mjs
//   deno run --allow-read --allow-env --node-modules-dir=auto scripts/smoke.mjs
//   bun scripts/smoke.mjs

import { withOpenApi } from '../dist/index.js'

const document = {
  openapi: '3.1.0',
  info: { title: 'Smoke', version: '1' },
  paths: {
    '/users/{id}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      ],
      get: {
        operationId: 'getUser',
        responses: { 200: { description: 'ok' } },
      },
    },
  },
}

const app = withOpenApi({ document, reference: true }, async (_req, ctx) =>
  Response.json({
    id: ctx.openapi.params.path.id,
    op: ctx.openapi.operationId,
  }),
)

const expected = [
  ['/users/7', 200],
  ['/users/abc', 400],
  ['/nope', 404],
  ['/users/7', 405, { method: 'DELETE' }],
  ['/reference', 200],
  ['/reference/openapi.json', 200],
]

let failed = 0
for (const [path, status, init] of expected) {
  const res = await app(new Request(`http://localhost${path}`, init))
  const ok = res.status === status
  if (!ok) failed++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${init?.method ?? 'GET'} ${path} → ${res.status} (expected ${status})`,
  )
}

if (failed > 0) {
  console.error(`${failed} smoke check(s) failed.`)
  process.exit(1)
}
console.log('Smoke checks OK.')
