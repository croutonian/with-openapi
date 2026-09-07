/**
 * The optional Scalar API reference endpoint.
 *
 * Two routes, both served before any matching or validation happens: an HTML
 * page, and the document itself as JSON for that page to load.
 *
 * The page is a ~20-line shell that pulls Scalar's standalone build from a CDN.
 * That is deliberate. `@scalar/api-reference` is a Vue application; bundling it
 * into a middleware that is meant to run at the edge would add megabytes to
 * every deploy to serve one HTML page. Point `cdnUrl` at your own copy of the
 * standalone bundle if you would rather not depend on jsDelivr, or replace the
 * page entirely with `html`.
 */

import type { OpenAPIObject } from 'openapi3-ts/oas31'

/** Default CDN for Scalar's standalone browser build. */
export const SCALAR_CDN_URL =
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference'

/** Everything {@link ScalarReferenceOptions.html} is given to render a page. */
export interface ScalarHtmlInput {
  /** Absolute path the document JSON is served from. */
  readonly documentPath: string
  /** Page `<title>`. */
  readonly title: string
  /** Script URL for Scalar's standalone build. */
  readonly cdnUrl: string
  /** Config object passed to `Scalar.createApiReference`, `url` included. */
  readonly configuration: Record<string, unknown>
}

/** Configuration for the reference endpoint. */
export interface ScalarReferenceOptions {
  /**
   * Path the HTML page is served from. Matched exactly, and *before* the
   * document's own routes, so it does not need to appear in the document.
   *
   * @defaultValue `'/reference'`
   */
  path?: string

  /**
   * Path the document JSON is served from.
   *
   * @defaultValue `` `${path}/openapi.json` ``
   */
  documentPath?: string

  /** Page title. @defaultValue the document's `info.title`, or `'API Reference'` */
  title?: string

  /** Script URL for Scalar's standalone build. @defaultValue {@link SCALAR_CDN_URL} */
  cdnUrl?: string

  /**
   * Extra options merged into the `Scalar.createApiReference` config — theme,
   * `darkMode`, `proxyUrl`, and anything else Scalar accepts. `url` is set
   * from {@link documentPath} and can be overridden here.
   *
   * @see https://scalar.com/products/api-references/configuration
   */
  configuration?: Record<string, unknown>

  /** `Cache-Control` on both responses. @defaultValue `'no-cache'` */
  cacheControl?: string

  /** Render the page yourself, ignoring every option above except the paths. */
  html?: (input: ScalarHtmlInput) => string
}

/** The reference endpoint, with defaults resolved. */
export interface ResolvedReference {
  readonly path: string
  readonly documentPath: string
  readonly cacheControl: string
  render(): string
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char)
}

/**
 * Serialize for embedding inside a `<script>` body. Escaping `<` is what stops
 * a `</script>` sequence anywhere in the config from ending the element early —
 * the standard XSS hole in inline JSON.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function renderScalarHtml(input: ScalarHtmlInput): string {
  return `<!doctype html>
<html>
  <head>
    <title>${escapeHtml(input.title)}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        margin: 0;
      }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script src="${escapeHtml(input.cdnUrl)}"></script>
    <script>
      Scalar.createApiReference('#app', ${jsonForScript(input.configuration)})
    </script>
  </body>
</html>
`
}

function joinPath(base: string, child: string): string {
  return `${base.endsWith('/') ? base.slice(0, -1) : base}/${child}`
}

/** Fill in the reference endpoint's defaults, once, at construction. */
export function resolveReference(
  document: OpenAPIObject,
  options: ScalarReferenceOptions,
): ResolvedReference {
  const path = options.path ?? '/reference'
  if (!path.startsWith('/')) {
    throw new Error(
      `withOpenApi: reference.path must start with "/", got ${JSON.stringify(path)}`,
    )
  }
  const documentPath = options.documentPath ?? joinPath(path, 'openapi.json')
  const title = options.title ?? document.info?.title ?? 'API Reference'
  const cdnUrl = options.cdnUrl ?? SCALAR_CDN_URL
  const configuration = { url: documentPath, ...options.configuration }
  const render = options.html ?? renderScalarHtml

  // Rendered once: the inputs cannot change between requests.
  const page = render({ documentPath, title, cdnUrl, configuration })

  return {
    path,
    documentPath,
    cacheControl: options.cacheControl ?? 'no-cache',
    render: () => page,
  }
}
