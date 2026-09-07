import { pipeline } from '@supabase/middleware'
import { describe, expect, it, vi } from 'vitest'

import { testDocument } from './fixture.js'
import {
  withOpenApi,
  type FetchHandler,
  type OpenApiRejection,
  type WithOpenApiConfig,
} from './index.js'

const document = testDocument()

const get = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init)

const post = (path: string, body: unknown, contentType = 'application/json') =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

/** The common shape: enforce the document, echo what landed on `ctx`. */
const echo = (config: Omit<Partial<WithOpenApiConfig>, 'document'> = {}) =>
  withOpenApi({ document, ...config }, async (_req, ctx) =>
    Response.json(
      ctx.openapi.matched
        ? {
            matched: true,
            route: ctx.openapi.route,
            operationId: ctx.openapi.operationId,
            params: ctx.openapi.params,
            body: ctx.openapi.body ?? null,
            mediaType: ctx.openapi.mediaType ?? null,
            security: ctx.openapi.security,
            validated: ctx.openapi.validated,
          }
        : {
            matched: false,
            reason: ctx.openapi.reason,
            route: ctx.openapi.route ?? null,
          },
    ),
  )

// Type-level check, verified by `tsc`: the stack is usable as a fetch entry.
const _anchored = withOpenApi({ document }, async (_req, ctx) =>
  Response.json({ matched: ctx.openapi.matched }),
) satisfies FetchHandler
void _anchored

describe('matching', () => {
  it('contributes the matched operation', async () => {
    const res = await echo()(get('/users?active=true'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({
      matched: true,
      route: '/users',
      operationId: 'listUsers',
      validated: true,
    })
  })

  it('prefers a static segment over a templated sibling', async () => {
    const res = await echo()(get('/users/me'))
    expect(await res.json()).toMatchObject({ operationId: 'currentUser' })
  })

  it('falls back to the template when the static path does not match', async () => {
    const res = await echo()(get('/users/42'))
    expect(await res.json()).toMatchObject({
      operationId: 'getUser',
      params: { path: { id: 42 } },
    })
  })

  it('treats a trailing slash as the same route', async () => {
    const res = await echo()(get('/users/42/'))
    expect(await res.json()).toMatchObject({ operationId: 'getUser' })
  })

  it('inherits document-level security, and an operation can clear it', async () => {
    const listed = await (await echo()(get('/users?active=true'))).json()
    expect(listed).toMatchObject({ security: [{ bearer: [] }] })

    const created = await (await echo()(post('/users', { name: 'ada' }))).json()
    expect(created).toMatchObject({ security: [] })
  })

  it('rejects an undescribed path with 404', async () => {
    const inner = vi.fn(async () => new Response('never'))
    const res = await withOpenApi({ document }, inner)(get('/nope'))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'route_not_found' })
    expect(inner).not.toHaveBeenCalled()
  })

  it('rejects an undeclared method with 405 and an Allow header', async () => {
    const res = await echo()(get('/users/me', { method: 'PUT' }))
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
    expect(await res.json()).toMatchObject({ error: 'method_not_allowed' })
  })

  it('lists every declared method in Allow', async () => {
    const res = await echo()(get('/users/1', { method: 'PATCH' }))
    expect(res.headers.get('allow')).toBe('GET, DELETE')
  })

  it('passes an undescribed path through when asked to', async () => {
    const res = await echo({ onUnknownRoute: 'pass' })(get('/nope'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      matched: false,
      reason: 'no_route',
      route: null,
    })
  })

  it('passes an undeclared method through when asked to', async () => {
    const res = await echo({ onUnknownMethod: 'pass' })(
      get('/users/me', { method: 'PUT' }),
    )
    expect(await res.json()).toEqual({
      matched: false,
      reason: 'no_operation',
      route: '/users/me',
    })
  })

  it('honors skip before anything else', async () => {
    const res = await echo({ skip: (req) => req.headers.has('x-raw') })(
      get('/nope', { headers: { 'x-raw': '1' } }),
    )
    expect(await res.json()).toEqual({
      matched: false,
      reason: 'skipped',
      route: null,
    })
  })

  it('mounts under a basePath', async () => {
    const handler = echo({ basePath: '/api/v1' })
    expect((await handler(get('/api/v1/users/me'))).status).toBe(200)
    expect((await handler(get('/users/me'))).status).toBe(404)
  })
})

describe('parameters', () => {
  it('coerces query text into the schema type', async () => {
    const res = await echo()(get('/users?active=true&limit=10'))
    expect(await res.json()).toMatchObject({
      params: { query: { limit: 10, active: true } },
    })
  })

  it('reports a required parameter that was not sent', async () => {
    const res = await echo()(get('/users'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: 'validation_failed',
      violations: [{ in: 'query', name: 'active' }],
    })
  })

  it('reports a value the schema rejects', async () => {
    const res = await echo()(get('/users?active=true&limit=999'))
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      violations: { name: string; keyword: string }[]
    }
    expect(json.violations).toHaveLength(1)
    expect(json.violations[0]).toMatchObject({
      in: 'query',
      name: 'limit',
      keyword: 'maximum',
    })
  })

  it('reports uncoercible text as a type error rather than NaN', async () => {
    const res = await echo()(get('/users?active=true&limit=ten'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      violations: [{ name: 'limit', keyword: 'type' }],
    })
  })

  it('collects every violation, not just the first', async () => {
    const res = await echo()(get('/users?limit=999&x-nope=1'))
    const json = (await res.json()) as { violations: unknown[] }
    expect(json.violations).toHaveLength(2)
  })

  it('deserializes an exploded form array', async () => {
    const res = await echo()(get('/users?active=true&tags=a&tags=b'))
    expect(await res.json()).toMatchObject({
      params: { query: { tags: ['a', 'b'] } },
    })
  })

  it('deserializes a pipeDelimited array', async () => {
    const res = await echo()(get('/users?active=true&sort=name%7C-age'))
    expect(await res.json()).toMatchObject({
      params: { query: { sort: ['name', '-age'] } },
    })
  })

  it('validates a parameter schema that is a $ref', async () => {
    expect((await echo()(get('/users?active=true&limit=10'))).status).toBe(200)

    const res = await echo()(get('/users?active=true&limit=999'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      violations: [{ in: 'query', name: 'limit', keyword: 'maximum' }],
    })
  })

  it('validates a $ref nested inside a parameter schema', async () => {
    expect(
      (await echo()(get('/users?active=true&window=1&window=2'))).status,
    ).toBe(200)

    const res = await echo()(get('/users?active=true&window=1&window=999'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      violations: [
        { in: 'query', name: 'window', location: '#/1', keyword: 'maximum' },
      ],
    })
  })

  it('reads a $ref-ed header parameter', async () => {
    const res = await echo()(
      get('/users?active=true', { headers: { 'x-trace-id': 'abcd' } }),
    )
    expect(await res.json()).toMatchObject({
      params: { header: { 'x-trace-id': 'abcd' } },
    })
  })

  it('validates a $ref-ed header parameter', async () => {
    const res = await echo()(
      get('/users?active=true', { headers: { 'x-trace-id': 'ab' } }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      violations: [{ in: 'header', name: 'x-trace-id', keyword: 'minLength' }],
    })
  })

  it('reads a cookie parameter', async () => {
    const res = await echo()(
      get('/users/7', { headers: { cookie: 'session=abcdef; other=1' } }),
    )
    expect(await res.json()).toMatchObject({
      params: { cookie: { session: 'abcdef' } },
    })
  })

  it('ignores undeclared query parameters by default', async () => {
    const res = await echo()(get('/users?active=true&whatever=1'))
    expect(res.status).toBe(200)
  })

  it('rejects undeclared query parameters when asked to', async () => {
    const res = await echo({ validate: { additionalQuery: 'reject' } })(
      get('/users?active=true&whatever=1'),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      violations: [{ in: 'query', name: 'whatever' }],
    })
  })

  it('rejects a path parameter that does not fit its schema', async () => {
    const res = await echo()(get('/users/not-a-number'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      violations: [{ in: 'path', name: 'id', keyword: 'type' }],
    })
  })
})

describe('request bodies', () => {
  it('parses and contributes a valid JSON body', async () => {
    const res = await echo()(post('/users', { name: 'ada', age: 36 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      body: { name: 'ada', age: 36 },
      mediaType: 'application/json',
    })
  })

  it('validates through a recursive $ref', async () => {
    const ok = await echo()(
      post('/users', { name: 'ada', manager: { name: 'grace' } }),
    )
    expect(ok.status).toBe(200)

    const bad = await echo()(
      post('/users', { name: 'ada', manager: { age: 1 } }),
    )
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({
      violations: [
        {
          in: 'body',
          location: '#/manager',
          keyword: 'required',
          message: 'Instance does not have required property "name".',
        },
      ],
    })
  })

  it('rejects a body that fails its schema', async () => {
    const res = await echo()(post('/users', { age: -1 }))
    expect(res.status).toBe(400)
    const json = (await res.json()) as { violations: unknown[] }
    expect(json.violations.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects a missing required body', async () => {
    const res = await echo()(
      new Request('http://localhost/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      violations: [{ in: 'body', message: 'a request body is required' }],
    })
  })

  it('rejects malformed JSON', async () => {
    const res = await echo()(post('/users', 'not json'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      violations: [{ in: 'body', message: 'body is not valid JSON' }],
    })
  })

  it('rejects a content type the operation does not accept with 415', async () => {
    const res = await echo()(post('/users', 'hi', 'text/plain'))
    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({
      error: 'unsupported_media_type',
      accepts: [
        'application/json',
        'multipart/form-data',
        'application/x-www-form-urlencoded',
      ],
    })
  })

  it('coerces a urlencoded body against its schema', async () => {
    const res = await echo()(
      post('/users', 'name=ada&age=36', 'application/x-www-form-urlencoded'),
    )
    expect(await res.json()).toMatchObject({
      body: { name: 'ada', age: 36 },
      mediaType: 'application/x-www-form-urlencoded',
    })
  })

  it('parses a multipart body without schema-checking its parts', async () => {
    const form = new FormData()
    form.set('name', 'ada')
    form.set(
      'avatar',
      new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
    )

    const res = await withOpenApi({ document }, async (_req, ctx) =>
      Response.json({
        mediaType: ctx.openapi.matched ? ctx.openapi.mediaType : null,
        name: ctx.openapi.matched
          ? (ctx.openapi.body as Record<string, unknown>)['name']
          : null,
        avatarIsFile:
          ctx.openapi.matched &&
          (ctx.openapi.body as Record<string, unknown>)['avatar'] instanceof
            File,
      }),
    )(new Request('http://localhost/users', { method: 'POST', body: form }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      mediaType: 'multipart/form-data',
      name: 'ada',
      avatarIsFile: true,
    })
  })

  it('still enforces required on a body it does not schema-check', async () => {
    const res = await echo()(
      new Request('http://localhost/users', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
      }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      violations: [{ in: 'body', message: 'a request body is required' }],
    })
  })

  it('does not buffer a binary body, and does not check it', async () => {
    const res = await echo()(
      new Request('http://localhost/users', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3]),
      }),
    )
    // No `*/*` entry in the document's `content`, so this is a 415.
    expect(res.status).toBe(415)
  })

  it('matches a content type that carries parameters', async () => {
    const res = await echo()(
      post('/users', { name: 'ada' }, 'application/json; charset=utf-8'),
    )
    expect(res.status).toBe(200)
  })

  it('leaves the body readable by the handler', async () => {
    const handler = withOpenApi({ document }, async (req, ctx) =>
      Response.json({
        fromCtx: ctx.openapi.matched && ctx.openapi.body,
        again: await req.json(),
      }),
    )
    const res = await handler(post('/users', { name: 'ada' }))
    expect(await res.json()).toEqual({
      fromCtx: { name: 'ada' },
      again: { name: 'ada' },
    })
  })
})

describe('validate: false', () => {
  it('matches and deserializes without rejecting anything', async () => {
    const res = await echo({ validate: false })(get('/users?limit=999'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      matched: true,
      validated: false,
      params: { query: { limit: 999 } },
    })
  })

  it('still rejects an undescribed path', async () => {
    const res = await echo({ validate: false })(get('/nope'))
    expect(res.status).toBe(404)
  })

  it('leaves the body to the handler', async () => {
    const res = await echo({ validate: { body: false } })(
      post('/users', { nope: true }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ body: null, mediaType: null })
  })
})

describe('rejection responses', () => {
  it('hands the rejection to a custom responder', async () => {
    const seen: OpenApiRejection[] = []
    const res = await echo({
      reject: (rejection) => {
        seen.push(rejection)
        return new Response('nope', { status: 418 })
      },
    })(get('/users?active=true&limit=999'))

    expect(res.status).toBe(418)
    expect(seen[0]).toMatchObject({
      kind: 'validation_failed',
      route: '/users',
      pathname: '/users',
      method: 'GET',
    })
  })

  it('falls back to the default response when the responder returns undefined', async () => {
    const res = await echo({ reject: () => undefined })(get('/nope'))
    expect(res.status).toBe(404)
  })

  it('honors a custom validation status', async () => {
    const res = await echo({ validate: { status: 422 } })(get('/users'))
    expect(res.status).toBe(422)
  })
})

describe('composition', () => {
  it('drops into a pipeline array', async () => {
    const handler = pipeline([withOpenApi({ document })], async (_req, ctx) =>
      Response.json({
        id: ctx.openapi.matched ? ctx.openapi.operationId : null,
      }),
    ) satisfies FetchHandler

    expect(await (await handler(get('/users/me'))).json()).toEqual({
      id: 'currentUser',
    })
  })
})
