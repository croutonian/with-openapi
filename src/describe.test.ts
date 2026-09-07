import { describe, expect, it } from 'vitest'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

import { withOpenApi } from './index.js'

/**
 * A validator says what is mechanically wrong. The document says what the
 * field is *for*, and it already wrote it down — these cover it getting from
 * one to the other.
 */
const document: OpenAPIObject = {
  openapi: '3.1.0',
  info: { title: 'Described', version: '1' },
  components: {
    schemas: {
      Email: {
        type: 'string',
        format: 'email',
        description: 'An address we can actually deliver to.',
      },
      User: {
        type: 'object',
        description: 'A person with access to the workspace.',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            description: 'Display name. Shown to teammates.',
          },
          email: { $ref: '#/components/schemas/Email' },
          manager: { $ref: '#/components/schemas/User' },
          // Deliberately undescribed.
          nickname: { type: 'string', maxLength: 3 },
        },
      },
      Bare: {
        type: 'object',
        required: ['x'],
        properties: { x: { type: 'string' } },
      },
    },
  },
  paths: {
    '/users': {
      get: {
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: true,
            description: 'How many to return. Between 1 and 100.',
            schema: { type: 'integer', minimum: 1, maximum: 100 },
          },
          {
            // No prose of its own — the schema's should be used instead.
            name: 'contact',
            in: 'query',
            schema: { $ref: '#/components/schemas/Email' },
          },
          { name: 'plain', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {},
      },
      post: {
        requestBody: {
          required: true,
          description: 'The user to create.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/User' },
            },
          },
        },
        responses: {},
      },
    },
    '/bare': {
      post: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Bare' },
            },
          },
        },
        responses: {},
      },
    },
  },
}

interface Violation {
  name?: string
  location?: string
  message: string
  description?: string
}

const app = (config = {}) =>
  withOpenApi({ document, ...config }, async () => new Response('ok'))

async function violations(req: Request, config = {}): Promise<Violation[]> {
  const res = await app(config)(req)
  return ((await res.json()) as { violations: Violation[] }).violations
}

const get = (query: string) => new Request(`http://localhost/users?${query}`)
const post = (body: string, path = '/users') =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })

describe('parameters', () => {
  it('describes a required parameter that was not sent', async () => {
    expect((await violations(get('')))[0]).toMatchObject({
      name: 'limit',
      message: 'required query parameter "limit" is missing',
      description: 'How many to return. Between 1 and 100.',
    })
  })

  it('describes a parameter that failed its schema', async () => {
    expect((await violations(get('limit=999')))[0]).toMatchObject({
      message: '999 is greater than 100.',
      description: 'How many to return. Between 1 and 100.',
    })
  })

  it('falls back to the schema when the parameter has no prose of its own', async () => {
    const found = (await violations(get('limit=1&contact=nope'))).find(
      (v) => v.name === 'contact',
    )
    expect(found).toMatchObject({
      description: 'An address we can actually deliver to.',
    })
  })

  it('omits the field when the document describes nothing', async () => {
    const found = (await violations(get('limit=1&plain=x'))).find(
      (v) => v.name === 'plain',
    )
    expect(found?.message).toContain('Instance type')
    expect(found).not.toHaveProperty('description')
  })
})

describe('bodies', () => {
  it('describes the property that failed, not the object containing it', async () => {
    expect((await violations(post('{"name":""}')))[0]).toMatchObject({
      location: '#/name',
      description: 'Display name. Shown to teammates.',
    })
  })

  it('follows a $ref on the property to find its prose', async () => {
    const found = (await violations(post('{"name":"a","email":"nope"}'))).find(
      (v) => v.location === '#/email',
    )
    expect(found).toMatchObject({
      description: 'An address we can actually deliver to.',
    })
  })

  it('reaches through recursive nesting', async () => {
    const found = (
      await violations(post('{"name":"a","manager":{"name":""}}'))
    ).find((v) => v.location === '#/manager/name')
    expect(found).toMatchObject({
      description: 'Display name. Shown to teammates.',
    })
  })

  it('describes the missing property, not its container', async () => {
    // `required` fails against the object, so the naive answer would be the
    // object's own prose — which says nothing about what is missing.
    expect((await violations(post('{}')))[0]).toMatchObject({
      message: 'Instance does not have required property "name".',
      description: 'Display name. Shown to teammates.',
    })
  })

  it('falls back to the container when the missing property has no prose', async () => {
    expect((await violations(post('{}', '/bare')))[0]).not.toHaveProperty(
      'description',
    )
  })

  it('describes an undescribed property as undescribed', async () => {
    const found = (
      await violations(post('{"name":"a","nickname":"abcd"}'))
    ).find((v) => v.location === '#/nickname')
    expect(found?.message).toContain('too long')
    expect(found).not.toHaveProperty('description')
  })

  it('describes a body that was never sent', async () => {
    const res = await app()(
      new Request('http://localhost/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(
      ((await res.json()) as { violations: Violation[] }).violations[0],
    ).toMatchObject({
      message: 'a request body is required',
      description: 'The user to create.',
    })
  })
})

describe('describe: false', () => {
  it('leaves every violation undescribed', async () => {
    const found = await violations(get('limit=999'), {
      validate: { describe: false },
    })
    expect(found[0]?.message).toBe('999 is greater than 100.')
    expect(found[0]).not.toHaveProperty('description')

    const body = await violations(post('{"name":""}'), {
      validate: { describe: false },
    })
    expect(body[0]).not.toHaveProperty('description')
  })
})
