import { describe, expect, it, vi } from 'vitest'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

import { testDocument } from './fixture.js'
import { withOpenApi, type OpenApiCorsOptions } from './index.js'

const document = testDocument()
const ORIGIN = 'https://app.example.com'

const app = (cors: OpenApiCorsOptions = { origin: ORIGIN }) =>
  withOpenApi({ document, cors }, async () => Response.json({ ok: true }))

const preflight = (
  path: string,
  method: string,
  headers: string | null = null,
) =>
  new Request(`http://localhost${path}`, {
    method: 'OPTIONS',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': method,
      ...(headers === null
        ? {}
        : { 'access-control-request-headers': headers }),
    },
  })

const get = (path: string, origin: string | null = ORIGIN) =>
  new Request(`http://localhost${path}`, {
    headers: origin === null ? {} : { origin },
  })

describe('preflight', () => {
  it('advertises exactly the methods the path declares', async () => {
    // `/users/{id}` declares GET and DELETE, and nothing else.
    const res = await app()(preflight('/users/1', 'DELETE'))
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, DELETE')
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  it('does not advertise a method the document does not declare', async () => {
    // The point of deriving: a static method list would wave PUT through, and
    // the request behind it would then come back 405.
    const res = await app()(preflight('/users/1', 'PUT'))
    expect(res.headers.get('access-control-allow-methods')).not.toContain('PUT')
  })

  it('is answered before the 405 an undeclared OPTIONS would otherwise get', async () => {
    // No document declares an `options` operation, so without this ordering
    // every preflight would fail as an opaque CORS error.
    expect((await app()(preflight('/users/1', 'GET'))).status).toBe(204)

    // A plain OPTIONS is not a preflight, and is still a 405.
    const plain = await app()(
      new Request('http://localhost/users/1', { method: 'OPTIONS' }),
    )
    expect(plain.status).toBe(405)
  })

  it('derives allowed headers from the parameters the path declares', async () => {
    // `/users` GET declares the $ref-ed `x-trace-id` header parameter.
    const allowed = (await app()(preflight('/users', 'GET'))).headers.get(
      'access-control-allow-headers',
    )
    expect(allowed?.split(', ')).toContain('x-trace-id')
  })

  it('allows Content-Type where the path takes a body', async () => {
    // `application/json` is not a safelisted Content-Type value, so a body
    // endpoint that does not allow the header is unreachable from a browser.
    const withBody = (await app()(preflight('/users', 'POST'))).headers.get(
      'access-control-allow-headers',
    )
    expect(withBody?.split(', ')).toContain('Content-Type')

    const withoutBody = (
      await app()(preflight('/users/me', 'GET'))
    ).headers.get('access-control-allow-headers')
    expect(withoutBody ?? '').not.toContain('Content-Type')
  })

  it('derives the credential header from the security scheme in force', async () => {
    // The document's `security` is `[{ bearer: [] }]`, an http scheme, so the
    // credential travels in Authorization.
    const allowed = (await app()(preflight('/users/1', 'GET'))).headers.get(
      'access-control-allow-headers',
    )
    expect(allowed?.split(', ')).toContain('Authorization')
  })

  it('omits Authorization where the operation clears its security', async () => {
    // `/users` POST sets `security: []`, so nothing there carries a credential.
    const only = withOpenApi(
      {
        document: {
          ...document,
          security: undefined,
          paths: { '/open': { post: { security: [], responses: {} } } },
        } as OpenAPIObject,
        cors: { origin: ORIGIN },
      },
      async () => new Response(),
    )
    const allowed = (await only(preflight('/open', 'POST'))).headers.get(
      'access-control-allow-headers',
    )
    expect(allowed ?? '').not.toContain('Authorization')
  })

  it('adds configured headers on top of the derived ones', async () => {
    const res = await app({ origin: ORIGIN, allowedHeaders: ['X-Tenant'] })(
      preflight('/users', 'GET'),
    )
    const allowed = res.headers.get('access-control-allow-headers')?.split(', ')
    expect(allowed).toContain('X-Tenant')
    expect(allowed).toContain('x-trace-id')
  })

  it('carries maxAge and a custom success status', async () => {
    const res = await app({
      origin: ORIGIN,
      maxAge: 600,
      optionsSuccessStatus: 200,
    })(preflight('/users', 'GET'))
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-max-age')).toBe('600')
  })

  it('preflighting an undescribed path is still a 404', async () => {
    expect((await app()(preflight('/nope', 'GET'))).status).toBe(404)
  })
})

describe('response headers', () => {
  it('stamps the handler response', async () => {
    const res = await app()(get('/users/me'))
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('stamps rejections, so a browser can read the violations', async () => {
    for (const [path, status] of [
      ['/users', 400], //  missing required `active`
      ['/nope', 404],
      ['/users/me/extra/deep', 404],
    ] as const) {
      const res = await app()(get(path))
      expect(res.status).toBe(status)
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    }
  })

  it('keeps the rejection body intact through the stamping', async () => {
    const res = await app()(get('/users'))
    expect(await res.json()).toMatchObject({
      error: 'validation_failed',
      violations: [{ in: 'query', name: 'active' }],
    })
  })

  it('leaves the handler response body and status alone', async () => {
    const handler = withOpenApi(
      { document, cors: { origin: ORIGIN } },
      async () => new Response('teapot', { status: 418, statusText: 'Nope' }),
    )
    const res = await handler(get('/users/me'))
    expect(res.status).toBe(418)
    expect(await res.text()).toBe('teapot')
  })
})

describe('origin resolution', () => {
  it('omits the headers for an origin that is not allowed', async () => {
    const res = await app()(get('/users/me', 'https://evil.example'))
    // The request still reaches the handler — CORS is enforced by the browser,
    // and refusing here would break every non-browser client.
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('accepts a list and a predicate', async () => {
    const list = app({ origin: ['https://a.test', ORIGIN] })
    expect(
      (await list(get('/users/me'))).headers.get('access-control-allow-origin'),
    ).toBe(ORIGIN)

    const predicate = vi.fn(
      (origin: string | null) => origin?.endsWith('.test') === true,
    )
    const fn = app({ origin: predicate })
    expect(
      (await fn(get('/users/me', 'https://x.test'))).headers.get(
        'access-control-allow-origin',
      ),
    ).toBe('https://x.test')
    expect(predicate).toHaveBeenCalled()
  })

  it("reflects the origin rather than sending a literal '*' with credentials", async () => {
    // `*` plus credentials is forbidden by the Fetch standard.
    const res = await app({ origin: '*', credentials: true })(get('/users/me'))
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it("sends a literal '*' without credentials, and does not vary on origin", async () => {
    const res = await app({ origin: '*' })(get('/users/me'))
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('vary') ?? '').not.toContain('Origin')
  })

  it('varies on origin whenever the answer is per-origin', async () => {
    const res = await app()(get('/users/me'))
    expect(res.headers.get('vary')).toContain('Origin')
  })
})

describe('exposed headers', () => {
  const withResponseHeaders: OpenAPIObject = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/x': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              headers: {
                'X-Request-Id': { schema: { type: 'string' } },
                // Safelisted, so naming it would be noise.
                'Content-Type': { schema: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  }

  it('derives them from the Response Objects, minus the safelist', async () => {
    const res = await withOpenApi(
      { document: withResponseHeaders, cors: { origin: ORIGIN } },
      async () => new Response(),
    )(get('/x'))
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'X-Request-Id',
    )
  })

  it('sets nothing when the document exposes nothing', async () => {
    expect(
      (await app()(get('/users/me'))).headers.get(
        'access-control-expose-headers',
      ),
    ).toBeNull()
  })
})

describe('with cors off', () => {
  it('adds no CORS headers at all', async () => {
    const res = await withOpenApi({ document }, async () =>
      Response.json({ ok: true }),
    )(get('/users/me'))
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('vary')).toBeNull()
  })

  it('still answers a preflight with 405, since OPTIONS is undeclared', async () => {
    const res = await withOpenApi(
      { document },
      async () => new Response(),
    )(preflight('/users/1', 'GET'))
    expect(res.status).toBe(405)
  })
})

describe('Vary', () => {
  it('does not duplicate an Origin the handler already named', async () => {
    const res = await withOpenApi(
      { document, cors: { origin: ORIGIN } },
      async () =>
        new Response(null, { headers: { Vary: 'Origin, Accept-Encoding' } }),
    )(get('/users/me'))
    expect(res.headers.get('vary')).toBe('Origin, Accept-Encoding')
  })

  it('keeps a Vary the handler chose for its own reasons', async () => {
    const res = await withOpenApi(
      { document, cors: { origin: ORIGIN } },
      async () => new Response(null, { headers: { Vary: 'Accept-Encoding' } }),
    )(get('/users/me'))
    expect(res.headers.get('vary')).toBe('Accept-Encoding, Origin')
  })
})
