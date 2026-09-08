import { pipeline } from '@supabase/middleware'
import { describe, expect, it } from 'vitest'

import { OpenAPIInterface, withOpenApi } from './index.js'

const api = new OpenAPIInterface({
  openapi: '3.1.0',
  info: { title: 'Typed API', version: '1' },
  components: {
    schemas: { Limit: { type: 'integer', minimum: 1, maximum: 100 } },
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
        ],
        responses: { '200': { description: 'ok' } },
      },
      post: {
        operationId: 'createUser',
        responses: { '201': { description: 'created' } },
      },
    },
    '/users/{id}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      ],
      get: {
        operationId: 'getUser',
        responses: { '200': { description: 'ok' } },
      },
    },
  },
})

const get = (path: string) => new Request(`http://localhost${path}`)

describe('OpenAPIInterface', () => {
  it('keeps the document it was given, by reference', () => {
    expect(api.document.info.title).toBe('Typed API')
  })

  it('mounts through withOpenApi, which enforces the same document', async () => {
    const handler = pipeline(
      [withOpenApi({ document: api.document })],
      async () => Response.json({ fell: true }),
    )
    expect((await handler(get('/users?limit=10'))).status).toBe(200)
    // Enforcement still comes from the document: 101 exceeds Limit's maximum.
    expect((await handler(get('/users?limit=101'))).status).toBe(400)
    expect((await handler(get('/nope'))).status).toBe(404)
  })

  it('takes the rest of the config as withOpenApi always did', async () => {
    const handler = pipeline(
      [withOpenApi({ document: api.document, onUnknownRoute: 'pass' })],
      async () => Response.json({ fell: true }),
    )
    expect((await handler(get('/nope'))).status).toBe(200)
  })

  it('projects the Operation Object without a request', () => {
    expect(api.operation('/users', 'get').operationId).toBe('listUsers')
    expect(api.operation('/users/{id}', 'get').operationId).toBe('getUser')
  })

  it('hands back the params of the operation that ran', async () => {
    const handler = pipeline(
      [withOpenApi({ document: api.document })],
      async (_req, ctx) => {
        const params = api.params(ctx, '/users/{id}', 'get')
        return Response.json({ id: params?.path.id ?? null })
      },
    )
    expect(await (await handler(get('/users/7'))).json()).toEqual({ id: 7 })
  })

  // The projection is a cast, so the guard is what keeps it honest.
  it('returns undefined when the request is a different route', async () => {
    const handler = pipeline(
      [withOpenApi({ document: api.document })],
      async (_req, ctx) =>
        Response.json({
          params: api.params(ctx, '/users/{id}', 'get') ?? null,
        }),
    )
    expect(await (await handler(get('/users'))).json()).toEqual({
      params: null,
    })
  })

  // Naming the wrong method would otherwise return a confidently wrong shape.
  // `operationId` is what makes it detectable, since the contribution no
  // longer carries the method.
  it('returns undefined when the method names a different operation', async () => {
    const handler = pipeline(
      [withOpenApi({ document: api.document })],
      async (_req, ctx) =>
        Response.json({ params: api.params(ctx, '/users', 'post') ?? null }),
    )
    expect(await (await handler(get('/users?limit=10'))).json()).toEqual({
      params: null,
    })
  })

  it('returns undefined when nothing matched at all', async () => {
    const handler = pipeline(
      [withOpenApi({ document: api.document, onUnknownRoute: 'pass' })],
      async (_req, ctx) =>
        Response.json({ params: api.params(ctx, '/users', 'get') ?? null }),
    )
    expect(await (await handler(get('/nope'))).json()).toEqual({ params: null })
  })
})
