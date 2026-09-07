/**
 * A small OpenAPI 3.1 document the tests share.
 *
 * Deliberately exercises the awkward parts: a static path that has to beat a
 * templated sibling, a `$ref`d parameter, a recursive schema, and a
 * document-level `security` an operation inherits.
 */

import type { OpenAPIObject } from 'openapi3-ts/oas31'

export function testDocument(): OpenAPIObject {
  return {
    openapi: '3.1.0',
    info: { title: 'Test API', version: '1.0.0' },
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      parameters: {
        TraceId: {
          name: 'x-trace-id',
          in: 'header',
          required: false,
          schema: { type: 'string', minLength: 4 },
        },
      },
      schemas: {
        Limit: { type: 'integer', minimum: 1, maximum: 100 },
        User: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1 },
            age: { type: 'integer', minimum: 0 },
            // Recursive: only resolvable because the validator keeps the whole
            // document in its lookup rather than inlining subschemas.
            manager: { $ref: '#/components/schemas/User' },
          },
        },
      },
    },
    paths: {
      '/users': {
        get: {
          operationId: 'listUsers',
          parameters: [
            // A $ref inside a `parameters` array — the one place a JSON Schema
            // walk does not reach, so this is the case that catches a
            // validator wired up to resolve refs only where it walked.
            {
              name: 'limit',
              in: 'query',
              schema: { $ref: '#/components/schemas/Limit' },
            },
            {
              name: 'window',
              in: 'query',
              schema: {
                type: 'array',
                items: { $ref: '#/components/schemas/Limit' },
              },
            },
            {
              name: 'tags',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'sort',
              in: 'query',
              style: 'pipeDelimited',
              explode: false,
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'active',
              in: 'query',
              required: true,
              schema: { type: 'boolean' },
            },
            { $ref: '#/components/parameters/TraceId' },
          ],
          responses: { '200': { description: 'ok' } },
        },
        post: {
          operationId: 'createUser',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' },
              },
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string' },
                    avatar: { type: 'string', contentMediaType: 'image/png' },
                  },
                },
              },
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string' },
                    age: { type: 'integer' },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
      // Static sibling of `/users/{id}` — has to win the match.
      '/users/me': {
        get: {
          operationId: 'currentUser',
          responses: { '200': { description: 'ok' } },
        },
      },
      '/users/{id}': {
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        get: {
          operationId: 'getUser',
          parameters: [
            {
              name: 'session',
              in: 'cookie',
              schema: { type: 'string', minLength: 3 },
            },
          ],
          responses: { '200': { description: 'ok' } },
        },
        delete: {
          operationId: 'deleteUser',
          responses: { '204': { description: 'gone' } },
        },
      },
    },
  }
}
