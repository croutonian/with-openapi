import { describe, expect, it } from 'vitest'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

import { indexDocument, normalizePathname, resolveRef } from './document.js'
import { createRouter } from './router.js'

const base = (paths: OpenAPIObject['paths']): OpenAPIObject => ({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths,
})

describe('resolveRef', () => {
  const document: OpenAPIObject = {
    ...base({}),
    components: {
      parameters: {
        A: { $ref: '#/components/parameters/B' },
        B: { name: 'b', in: 'query' },
        Loop: { $ref: '#/components/parameters/Loop' },
      },
    },
  }

  it('follows a chain of refs', () => {
    expect(resolveRef(document, { $ref: '#/components/parameters/A' })).toEqual(
      {
        name: 'b',
        in: 'query',
      },
    )
  })

  it('rejects an external ref rather than fetching it', () => {
    expect(() => resolveRef(document, { $ref: './other.yaml#/Thing' })).toThrow(
      /only local \$refs/,
    )
  })

  it('rejects a ref that points at nothing', () => {
    expect(() =>
      resolveRef(document, { $ref: '#/components/schemas/Missing' }),
    ).toThrow(/does not resolve/)
  })

  it('rejects a ref that points at itself', () => {
    expect(() =>
      resolveRef(document, { $ref: '#/components/parameters/Loop' }),
    ).toThrow(/circular/)
  })
})

describe('normalizePathname', () => {
  it('drops one trailing slash but keeps the root', () => {
    expect(normalizePathname('/users/')).toBe('/users')
    expect(normalizePathname('/users')).toBe('/users')
    expect(normalizePathname('/')).toBe('/')
  })
})

describe('indexDocument', () => {
  it('merges path-level and operation-level parameters, operation winning', () => {
    const document = base({
      '/x': {
        parameters: [
          { name: 'a', in: 'query', schema: { type: 'string' } },
          { name: 'b', in: 'query', required: true },
        ],
        get: {
          parameters: [
            {
              name: 'a',
              in: 'query',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          responses: {},
        },
      },
    })

    const query =
      indexDocument(document)[0]?.operations.get('get')?.parameters.query
    expect(query).toHaveLength(2)
    expect(query?.find((p) => p.name === 'a')).toMatchObject({
      required: true,
      schema: { type: 'integer' },
    })
  })

  it('treats a path parameter as required even when the document omits the flag', () => {
    const document = base({
      '/x/{id}': {
        get: { parameters: [{ name: 'id', in: 'path' }], responses: {} },
      },
    })
    expect(
      indexDocument(document)[0]?.operations.get('get')?.parameters.path[0],
    ).toMatchObject({
      required: true,
    })
  })

  it('applies the style and explode defaults each location has', () => {
    const document = base({
      '/x/{id}': {
        get: {
          parameters: [
            { name: 'id', in: 'path' },
            { name: 'q', in: 'query' },
            { name: 'h', in: 'header' },
          ],
          responses: {},
        },
      },
    })
    const params = indexDocument(document)[0]?.operations.get('get')?.parameters
    expect(params?.path[0]).toMatchObject({ style: 'simple', explode: false })
    expect(params?.query[0]).toMatchObject({ style: 'form', explode: true })
    expect(params?.header[0]).toMatchObject({ style: 'simple', explode: false })
  })

  it('falls back to document-level security, and lets an operation override it', () => {
    const document: OpenAPIObject = {
      ...base({
        '/a': { get: { responses: {} } },
        '/b': { get: { security: [], responses: {} } },
      }),
      security: [{ oauth: ['read'] }],
    }
    const routes = indexDocument(document)
    expect(routes[0]?.operations.get('get')?.security).toEqual([
      { oauth: ['read'] },
    ])
    expect(routes[1]?.operations.get('get')?.security).toEqual([])
  })

  it('rejects two templates that differ only in parameter names', () => {
    expect(() =>
      indexDocument(
        base({
          '/x/{id}': { get: { responses: {} } },
          '/x/{key}': { get: { responses: {} } },
        }),
      ),
    ).toThrow(/are the same path/)
  })

  it('rejects a path parameter the template does not contain', () => {
    expect(() =>
      indexDocument(
        base({
          '/x': {
            get: { parameters: [{ name: 'id', in: 'path' }], responses: {} },
          },
        }),
      ),
    ).toThrow(/does not contain/)
  })

  it('rejects a template that is not absolute', () => {
    expect(() =>
      indexDocument(base({ 'x/{id}': { get: { responses: {} } } })),
    ).toThrow(/must start with/)
  })
})

describe('routing', () => {
  const router = createRouter(
    indexDocument(
      base({
        '/': { get: { operationId: 'root', responses: {} } },
        '/a/{x}/c': { get: { operationId: 'templated', responses: {} } },
        '/a/b/c': { get: { operationId: 'static', responses: {} } },
        '/{x}/b/c': { get: { operationId: 'leading', responses: {} } },
      }),
    ),
  )

  const id = (path: string) =>
    router.match(path)?.route.operations.get('get')?.operationId

  it('prefers static segments, leftmost first', () => {
    expect(id('/a/b/c')).toBe('static')
    expect(id('/a/z/c')).toBe('templated')
    expect(id('/z/b/c')).toBe('leading')
  })

  it('matches the root path', () => {
    expect(id('/')).toBe('root')
  })

  it('percent-decodes a captured segment', () => {
    expect(router.match('/a/hello%20world/c')?.pathValues).toEqual({
      x: 'hello world',
    })
  })

  it('does not let a parameter capture an empty segment', () => {
    expect(router.match('/a//c')).toBeUndefined()
  })

  it('returns nothing for a different segment count', () => {
    expect(router.match('/a/b')).toBeUndefined()
    expect(router.match('/a/b/c/d')).toBeUndefined()
  })
})
