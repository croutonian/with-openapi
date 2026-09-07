import { describe, expect, it } from 'vitest'

import { testDocument } from './fixture.js'
import { SCALAR_CDN_URL, withOpenApi, type WithOpenApiConfig } from './index.js'

const document = testDocument()
const handler = (config: Omit<Partial<WithOpenApiConfig>, 'document'> = {}) =>
  withOpenApi({ document, reference: true, ...config }, async () =>
    Response.json({ handled: true }),
  )

const get = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init)

describe('the Scalar reference endpoint', () => {
  it('is off unless asked for', async () => {
    const res = await withOpenApi(
      { document },
      async () => new Response(),
    )(get('/reference'))
    expect(res.status).toBe(404)
  })

  it('serves the page at /reference by default', async () => {
    const res = await handler()(get('/reference'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')

    const html = await res.text()
    expect(html).toContain(SCALAR_CDN_URL)
    expect(html).toContain("Scalar.createApiReference('#app'")
    expect(html).toContain('"url":"/reference/openapi.json"')
    expect(html).toContain('<title>Test API</title>')
  })

  it('serves the document as JSON for the page to load', async () => {
    const res = await handler()(get('/reference/openapi.json'))
    expect(res.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    expect(await res.json()).toEqual(document)
  })

  it('answers HEAD without a body', async () => {
    const res = await handler()(get('/reference', { method: 'HEAD' }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('takes custom paths, a title, and extra Scalar configuration', async () => {
    const app = handler({
      reference: {
        path: '/docs',
        documentPath: '/docs/spec.json',
        title: 'Docs',
        cdnUrl: 'https://example.test/scalar.js',
        configuration: { darkMode: true, theme: 'purple' },
      },
    })

    const html = await (await app(get('/docs'))).text()
    expect(html).toContain('<title>Docs</title>')
    expect(html).toContain('https://example.test/scalar.js')
    expect(html).toContain('"darkMode":true')
    expect(html).toContain('"url":"/docs/spec.json"')

    expect((await app(get('/docs/spec.json'))).status).toBe(200)
    expect((await app(get('/reference'))).status).toBe(404)
  })

  it('escapes a config value that would otherwise close the script element', async () => {
    const html = await (
      await handler({
        reference: {
          configuration: { theme: '</script><img src=x onerror=alert(1)>' },
        },
      })(get('/reference'))
    ).text()

    expect(html).not.toContain('</script><img')
    expect(html).toContain('\\u003c/script>')
  })

  it('lets the page be replaced wholesale', async () => {
    const app = handler({
      reference: { html: (input) => `custom:${input.documentPath}` },
    })
    expect(await (await app(get('/reference'))).text()).toBe(
      'custom:/reference/openapi.json',
    )
  })

  it('is served before matching, so it needs no entry in the document', async () => {
    // `/reference` is not a path in the document, and would 404 otherwise.
    expect((await handler()(get('/reference'))).status).toBe(200)
  })

  it('is not relative to basePath', async () => {
    const app = handler({ basePath: '/api' })
    expect((await app(get('/reference'))).status).toBe(200)
    expect((await app(get('/api/reference'))).status).toBe(404)
  })

  it('rejects a reference path that is not absolute', () => {
    expect(() =>
      withOpenApi(
        { document, reference: { path: 'docs' } },
        async () => new Response(),
      ),
    ).toThrow(/must start with "\/"/)
  })
})
