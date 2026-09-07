import { describe, expect, it } from 'vitest'
import type { OpenAPIObject, ParameterObject } from 'openapi3-ts/oas31'

import { resolveSchema } from './document.js'
import {
  coerceToSchema,
  parseCookies,
  readParameter,
  schemaKind,
} from './params.js'
import type { IndexedParameter } from './document.js'

const empty: OpenAPIObject = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
}
const resolve = (schema: Parameters<typeof resolveSchema>[1]) =>
  resolveSchema(empty, schema)

/** Build the indexed shape by hand, so a case reads as one line of intent. */
function param(
  spec: ParameterObject & { explode?: boolean },
): IndexedParameter {
  const style =
    spec.style ??
    (spec.in === 'path' || spec.in === 'header' ? 'simple' : 'form')
  return {
    name: spec.name,
    in: spec.in,
    description: spec.description,
    required: spec.required ?? spec.in === 'path',
    style,
    explode: spec.explode ?? (style === 'form' || style === 'deepObject'),
    allowEmptyValue: false,
    schema: spec.schema,
    resolved: resolveSchema(empty, spec.schema),
  }
}

const sources = (init: {
  path?: Record<string, string>
  query?: string
  headers?: Record<string, string>
  cookie?: string
}) => ({
  pathValues: init.path ?? {},
  search: new URLSearchParams(init.query ?? ''),
  headers: new Headers(init.headers ?? {}),
  cookies: parseCookies(init.cookie ?? null),
})

const strings = { type: 'array', items: { type: 'string' } } as const
const object = {
  type: 'object',
  properties: { role: { type: 'string' }, level: { type: 'integer' } },
} as const

describe('schemaKind', () => {
  it('reads an explicit type', () => {
    expect(schemaKind({ type: 'array' })).toBe('array')
    expect(schemaKind({ type: 'object' })).toBe('object')
    expect(schemaKind({ type: 'integer' })).toBe('primitive')
  })

  it('sees through a nullable union', () => {
    expect(schemaKind({ type: ['array', 'null'] })).toBe('array')
  })

  it('falls back to keywords when type is absent', () => {
    expect(schemaKind({ items: { type: 'string' } })).toBe('array')
    expect(schemaKind({ properties: {} })).toBe('object')
    expect(schemaKind(undefined)).toBe('primitive')
  })
})

describe('query parameters', () => {
  it('form + explode reads repeated keys as an array', () => {
    const read = readParameter(
      param({ name: 'tag', in: 'query', schema: strings }),
      sources({ query: 'tag=a&tag=b' }),
    )
    expect(read).toEqual({ present: true, value: ['a', 'b'] })
  })

  it('form without explode splits on commas', () => {
    const read = readParameter(
      param({ name: 'tag', in: 'query', explode: false, schema: strings }),
      sources({ query: 'tag=a,b' }),
    )
    expect(read.value).toEqual(['a', 'b'])
  })

  it('spaceDelimited and pipeDelimited use their own separators', () => {
    expect(
      readParameter(
        param({
          name: 'q',
          in: 'query',
          style: 'spaceDelimited',
          explode: false,
          schema: strings,
        }),
        sources({ query: 'q=a%20b' }),
      ).value,
    ).toEqual(['a', 'b'])

    expect(
      readParameter(
        param({
          name: 'q',
          in: 'query',
          style: 'pipeDelimited',
          explode: false,
          schema: strings,
        }),
        sources({ query: 'q=a%7Cb' }),
      ).value,
    ).toEqual(['a', 'b'])
  })

  it('deepObject reads bracketed keys', () => {
    const read = readParameter(
      param({
        name: 'filter',
        in: 'query',
        style: 'deepObject',
        schema: object,
      }),
      sources({ query: 'filter[role]=admin&filter[level]=3&other=1' }),
    )
    expect(read.value).toEqual({ role: 'admin', level: '3' })
  })

  it('an exploded form object reads its declared property names', () => {
    const read = readParameter(
      param({ name: 'filter', in: 'query', schema: object }),
      sources({ query: 'role=admin&level=3' }),
    )
    expect(read.value).toEqual({ role: 'admin', level: '3' })
  })

  it('an un-exploded form object reads comma-separated pairs', () => {
    const read = readParameter(
      param({ name: 'filter', in: 'query', explode: false, schema: object }),
      sources({ query: 'filter=role,admin,level,3' }),
    )
    expect(read.value).toEqual({ role: 'admin', level: '3' })
  })

  it('reports absence rather than an empty value', () => {
    expect(
      readParameter(
        param({ name: 'q', in: 'query', schema: { type: 'string' } }),
        sources({}),
      ),
    ).toEqual({ present: false, value: undefined })
  })

  it('distinguishes an empty value from an absent one', () => {
    expect(
      readParameter(
        param({ name: 'q', in: 'query', schema: { type: 'string' } }),
        sources({ query: 'q=' }),
      ),
    ).toEqual({ present: true, value: '' })
  })
})

describe('path parameters', () => {
  it('simple style reads the segment', () => {
    expect(
      readParameter(
        param({ name: 'id', in: 'path', schema: { type: 'string' } }),
        sources({ path: { id: 'abc' } }),
      ).value,
    ).toBe('abc')
  })

  it('simple style splits an array on commas', () => {
    expect(
      readParameter(
        param({ name: 'ids', in: 'path', schema: strings }),
        sources({ path: { ids: 'a,b,c' } }),
      ).value,
    ).toEqual(['a', 'b', 'c'])
  })

  it('label style strips the leading dot', () => {
    expect(
      readParameter(
        param({
          name: 'ids',
          in: 'path',
          style: 'label',
          explode: false,
          schema: strings,
        }),
        sources({ path: { ids: '.a,b' } }),
      ).value,
    ).toEqual(['a', 'b'])
  })

  it('matrix style strips the name prefix', () => {
    expect(
      readParameter(
        param({
          name: 'id',
          in: 'path',
          style: 'matrix',
          schema: { type: 'string' },
        }),
        sources({ path: { id: ';id=5' } }),
      ).value,
    ).toBe('5')

    expect(
      readParameter(
        param({
          name: 'ids',
          in: 'path',
          style: 'matrix',
          explode: true,
          schema: strings,
        }),
        sources({ path: { ids: ';ids=a;ids=b' } }),
      ).value,
    ).toEqual(['a', 'b'])
  })

  it('exploded objects use assignments, un-exploded ones use pairs', () => {
    expect(
      readParameter(
        param({ name: 'f', in: 'path', explode: true, schema: object }),
        sources({ path: { f: 'role=admin,level=3' } }),
      ).value,
    ).toEqual({ role: 'admin', level: '3' })

    expect(
      readParameter(
        param({ name: 'f', in: 'path', explode: false, schema: object }),
        sources({ path: { f: 'role,admin,level,3' } }),
      ).value,
    ).toEqual({ role: 'admin', level: '3' })
  })
})

describe('header and cookie parameters', () => {
  it('reads a header case-insensitively and trims list items', () => {
    expect(
      readParameter(
        param({ name: 'X-Tags', in: 'header', schema: strings }),
        sources({ headers: { 'x-tags': 'a, b' } }),
      ).value,
    ).toEqual(['a', 'b'])
  })

  it('parses cookies, percent-decoding values', () => {
    expect(parseCookies('a=1; b=hello%20world; malformed')).toEqual({
      a: '1',
      b: 'hello world',
    })
  })

  it('reads a cookie parameter', () => {
    expect(
      readParameter(
        param({ name: 'session', in: 'cookie', schema: { type: 'string' } }),
        sources({ cookie: 'session=xyz' }),
      ).value,
    ).toBe('xyz')
  })
})

describe('coercion', () => {
  const coerce = (
    value: unknown,
    schema: Parameters<typeof coerceToSchema>[1],
  ) => coerceToSchema(value, schema, resolve)

  it('converts to the type the schema names', () => {
    expect(coerce('42', { type: 'integer' })).toBe(42)
    expect(coerce('4.5', { type: 'number' })).toBe(4.5)
    expect(coerce('true', { type: 'boolean' })).toBe(true)
    expect(coerce('false', { type: 'boolean' })).toBe(false)
  })

  it('leaves text alone when the schema would accept text', () => {
    expect(coerce('42', { type: 'string' })).toBe('42')
    expect(coerce('42', { type: ['string', 'integer'] })).toBe('42')
  })

  it('leaves text alone when the conversion would not round-trip', () => {
    // The validator then reports a real type error instead of NaN.
    expect(coerce('ten', { type: 'integer' })).toBe('ten')
    expect(coerce('4.5', { type: 'integer' })).toBe('4.5')
    expect(coerce('', { type: 'integer' })).toBe('')
    expect(coerce('yes', { type: 'boolean' })).toBe('yes')
    expect(coerce('Infinity', { type: 'number' })).toBe('Infinity')
  })

  it('sees through a nullable union', () => {
    expect(coerce('42', { type: ['integer', 'null'] })).toBe(42)
    expect(coerce('null', { type: ['integer', 'null'] })).toBe(null)
  })

  it('reads a numeric enum with no declared type', () => {
    expect(coerce('2', { enum: [1, 2, 3] })).toBe(2)
    expect(coerce('2', { enum: ['1', '2'] })).toBe('2')
  })

  it('recurses into arrays and objects', () => {
    expect(
      coerce(['1', '2'], { type: 'array', items: { type: 'integer' } }),
    ).toEqual([1, 2])
    expect(coerce({ role: 'admin', level: '3' }, object)).toEqual({
      role: 'admin',
      level: 3,
    })
  })

  it('coerces tuple positions independently', () => {
    expect(
      coerce(['1', 'a'], {
        type: 'array',
        prefixItems: [{ type: 'integer' }, { type: 'string' }],
      }),
    ).toEqual([1, 'a'])
  })

  it('applies additionalProperties to undeclared keys', () => {
    expect(
      coerce(
        { known: '1', other: '2' },
        {
          type: 'object',
          properties: { known: { type: 'integer' } },
          additionalProperties: { type: 'number' },
        },
      ),
    ).toEqual({ known: 1, other: 2 })
  })

  it('passes a value through when there is no schema', () => {
    expect(coerce('42', undefined)).toBe('42')
  })
})
