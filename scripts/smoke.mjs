// Loads the *built* bundle and exercises it end to end. Run it under whatever
// runtime you want to check:
//
//   node scripts/smoke.mjs
//   deno run --allow-read --allow-env --node-modules-dir=auto scripts/smoke.mjs
//   bun scripts/smoke.mjs
//
// The CORS cases matter most here. With `cors` set, the middleware runs as an
// async generator so it can stamp headers on the way out, and a generator is
// the one construct in this package whose behavior could plausibly differ
// between runtimes.

import { withOpenApi } from '../dist/index.js'

const ORIGIN = 'https://app.example.test'

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

const app = withOpenApi(
  { document, reference: true, cors: { origin: ORIGIN } },
  async (_req, ctx) =>
    Response.json({
      id: ctx.openapi.params.path.id,
      op: ctx.openapi.operationId,
    }),
)

const cases = [
  { path: '/users/7', status: 200 },
  { path: '/users/abc', status: 400 },
  { path: '/nope', status: 404 },
  { path: '/users/7', status: 405, init: { method: 'DELETE' } },
  { path: '/reference', status: 200 },
  { path: '/openapi.json', status: 200 },

  // Preflight, derived from the document: the path declares only `get`, so
  // that is the whole of Access-Control-Allow-Methods.
  {
    path: '/users/7',
    status: 204,
    init: {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    },
    headers: { 'access-control-allow-methods': 'GET' },
  },

  // A rejection has to carry the CORS headers too, or a browser sees an opaque
  // failure instead of the violations the body is carrying.
  {
    path: '/users/abc',
    status: 400,
    init: { headers: { origin: ORIGIN } },
    headers: { 'access-control-allow-origin': ORIGIN },
  },

  // The handler's own response, through the response seam.
  {
    path: '/users/7',
    status: 200,
    init: { headers: { origin: ORIGIN } },
    headers: { 'access-control-allow-origin': ORIGIN, vary: 'Origin' },
  },
]

let failed = 0
for (const { path, status, init, headers } of cases) {
  const res = await app(new Request(`http://localhost${path}`, init))

  const problems = []
  if (res.status !== status)
    problems.push(`status ${res.status}, wanted ${status}`)
  for (const [name, value] of Object.entries(headers ?? {})) {
    const actual = res.headers.get(name)
    if (actual !== value) problems.push(`${name}: ${actual}, wanted ${value}`)
  }

  const method = init?.method ?? 'GET'
  if (problems.length === 0) {
    console.log(`ok   ${method} ${path} → ${res.status}`)
  } else {
    failed++
    console.log(`FAIL ${method} ${path} — ${problems.join('; ')}`)
  }
}

if (failed > 0) {
  console.error(`${failed} smoke check(s) failed.`)
  process.exit(1)
}
console.log(`Smoke checks OK — ${cases.length} cases.`)
