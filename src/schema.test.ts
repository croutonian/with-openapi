import { describe, expect, it } from 'vitest'
import type { OpenAPIObject } from 'openapi3-ts/oas31'

import { createSchemaValidator, draftFor, normalizeErrors } from './schema.js'

const document: OpenAPIObject = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {},
  components: {
    schemas: {
      Node: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
          child: { $ref: '#/components/schemas/Node' },
        },
      },
    },
  },
}

const validate = createSchemaValidator(document, '2020-12')
const nodeRef = { $ref: '#/components/schemas/Node' } as const

describe('createSchemaValidator', () => {
  it('validates through a $ref into components', () => {
    expect(validate({ name: 'a' }, nodeRef)).toEqual([])
    expect(validate({ age: 1 }, nodeRef)).not.toEqual([])
  })

  it('validates through a recursive $ref at any depth', () => {
    expect(
      validate(
        { name: 'a', child: { name: 'b', child: { name: 'c' } } },
        nodeRef,
      ),
    ).toEqual([])

    const errors = validate(
      { name: 'a', child: { name: 'b', child: { age: 1 } } },
      nodeRef,
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      instanceLocation: '#/child/child',
      keyword: 'required',
    })
  })

  it('reports every problem, not just the first', () => {
    const errors = validate({ age: 'x', extra: 1 }, nodeRef)
    const keywords = errors.map((e) => e.keyword)
    expect(keywords).toContain('required')
    expect(keywords).toContain('type')
  })

  it('leaves the document JSON-identical — its bookkeeping is non-enumerable', () => {
    expect(JSON.parse(JSON.stringify(document))).toEqual({
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {},
      components: document.components,
    })
    expect(Object.keys(document)).toEqual([
      'openapi',
      'info',
      'paths',
      'components',
    ])
  })
})

describe('normalizeErrors', () => {
  const unit = (
    keyword: string,
    instanceLocation: string,
    error = keyword,
  ) => ({
    keyword,
    instanceLocation,
    keywordLocation: '#',
    error,
  })

  it('drops keywords that only say something nested failed', () => {
    expect(
      normalizeErrors([
        unit('$ref', '#'),
        unit('properties', '#'),
        unit('minLength', '#/name'),
      ]),
    ).toEqual([unit('minLength', '#/name')])
  })

  it('keeps distinct problems at the same location', () => {
    const errors = normalizeErrors([
      unit('minLength', '#/a'),
      unit('pattern', '#/a'),
    ])
    expect(errors).toHaveLength(2)
  })

  it('drops the additionalProperties re-check of a property that already failed', () => {
    // The upstream validator re-applies `additionalProperties` to a declared
    // property that `properties` rejected, producing a second, misleading
    // "not allowed here" against a key the schema does declare.
    const errors = normalizeErrors([
      unit('properties', '#'),
      unit('type', '#/age'),
      unit('additionalProperties', '#'),
      unit('false', '#/age', 'False boolean schema.'),
    ])
    expect(errors).toEqual([unit('type', '#/age')])
  })

  it('drops the re-check even when the real error is further down', () => {
    const errors = normalizeErrors([
      unit('required', '#/child/child'),
      unit('false', '#/child', 'False boolean schema.'),
    ])
    expect(errors).toEqual([unit('required', '#/child/child')])
  })

  it('keeps a false-schema error for a genuinely undeclared property', () => {
    const errors = normalizeErrors([
      unit('additionalProperties', '#'),
      unit('false', '#/zzz', 'False boolean schema.'),
    ])
    expect(errors).toEqual([unit('false', '#/zzz', 'False boolean schema.')])
  })

  it('is what the real validator output goes through', () => {
    // The end-to-end version of the two cases above.
    expect(validate({ name: 'a', age: 'x' }, nodeRef)).toEqual([
      expect.objectContaining({ instanceLocation: '#/age', keyword: 'type' }),
    ])
    expect(validate({ name: 'a', zzz: 1 }, nodeRef)).toEqual([
      expect.objectContaining({ instanceLocation: '#/zzz', keyword: 'false' }),
    ])
  })
})

describe('draftFor', () => {
  it('picks 2020-12 for OpenAPI 3.1', () => {
    expect(
      draftFor({
        openapi: '3.1.0',
        info: { title: 't', version: '1' },
        paths: {},
      }),
    ).toBe('2020-12')
  })

  it('falls back to draft 4 for a 3.0 document', () => {
    expect(
      draftFor({
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        paths: {},
      }),
    ).toBe('4')
  })
})
