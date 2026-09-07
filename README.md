# `@croutonian/with-openapi`

[![npm](https://img.shields.io/npm/v/@croutonian/with-openapi)](https://www.npmjs.com/package/@croutonian/with-openapi)
[![JSR](https://jsr.io/badges/@croutonian/with-openapi)](https://jsr.io/@croutonian/with-openapi)
[![pkg.pr.new](https://pkg.pr.new/badge/johnstonmatt/with-openapi)](https://pkg.pr.new/~/johnstonmatt/with-openapi)
[![CI](https://github.com/johnstonmatt/with-openapi/actions/workflows/ci.yml/badge.svg)](https://github.com/johnstonmatt/with-openapi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

OpenAPI middleware for [`@supabase/middleware`](https://github.com/supabase/middleware).

An OpenAPI document already says what your API accepts. This makes it say it at
runtime: every request is matched to an Operation Object, optionally refused if
it does not fit, and optionally published as a
[Scalar](https://scalar.com/products/api-references) reference from the same
document — so what you enforce and what you document cannot drift.

```ts
import { pipeline } from '@supabase/middleware'
import { withOpenApi } from '@croutonian/with-openapi'
import document from './openapi.json' with { type: 'json' }

export default {
  fetch: pipeline(
    [withOpenApi({ document, reference: true })],
    async (_req, ctx) => {
      if (!ctx.openapi.matched) return new Response(null, { status: 404 })
      // Already validated, already coerced: `limit` is a number.
      const { limit } = ctx.openapi.params.query
      return Response.json({ operation: ctx.openapi.operationId, limit })
    },
  ),
}
```

`GET /users?limit=abc` is answered `400` before the handler runs. `GET /nope` is
answered `404`. `DELETE /users` is answered `405` with an `Allow` header.
`GET /reference` serves the docs. Everything else reaches the handler with the
matched operation on `ctx`.

## Install

```sh
npm install @croutonian/with-openapi
pnpm add @croutonian/with-openapi
```

Also on [JSR](https://jsr.io/@croutonian/with-openapi), which serves the
TypeScript source rather than a build:

```sh
deno add jsr:@croutonian/with-openapi
```

```ts
// Supabase Edge Functions — no install
import { withOpenApi } from 'npm:@croutonian/with-openapi'
```

Requires TypeScript 5.4 or newer to typecheck against the shipped `.d.ts`, and
Node 22 or newer on Node. Deno, Bun and Cloudflare Workers add no floor of their
own — there are no `node:` imports and no code generation anywhere in the
runtime path.

## What lands on `ctx.openapi`

A discriminated union on `matched`:

```ts
if (ctx.openapi.matched) {
  ctx.openapi.route //  '/users/{id}' — the path template, not the pathname
  ctx.openapi.method //  'get'
  ctx.openapi.operation //  the Operation Object, `$ref` already followed
  ctx.openapi.operationId //  'getUser'
  ctx.openapi.security //  the operation's, falling back to the document's
  ctx.openapi.params //  { path, query, header, cookie }, deserialized + coerced
  ctx.openapi.body //  the parsed request body
  ctx.openapi.mediaType //  the `content` key that matched
  ctx.openapi.validated //  false when `validate: false`
}
```

With the defaults, the handler only ever sees `matched: true` — anything else
was already answered with a `404` or a `405`. The narrowing matters once you set
`onUnknownRoute` or `onUnknownMethod` to `'pass'`, or pass a `skip`; then the
other branch carries a `reason` of `'no_route'`, `'no_operation'` or
`'skipped'`.

`security` is **contributed, not enforced.** Authentication is a different
middleware's job; this one just tells it what the document asks for.

## Configuration

| Option            | Default      | What it does                                                                                  |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `document`        | _(required)_ | The OpenAPI 3.1 document. Read once, at construction.                                         |
| `validate`        | `true`       | `false` to match without refusing anything, or an object to check some halves and not others. |
| `coerce`          | `true`       | Turn `'10'` into `10` where the schema says `integer`.                                        |
| `basePath`        | —            | Prefix stripped before matching, for an API mounted under a sub-path.                         |
| `onUnknownRoute`  | `'reject'`   | `'pass'` falls through with `matched: false` instead of answering `404`.                      |
| `onUnknownMethod` | `'reject'`   | `'pass'` falls through instead of answering `405`.                                            |
| `reference`       | off          | `true` for the defaults, or an object to place and theme it.                                  |
| `schemaDraft`     | inferred     | JSON Schema draft. `2020-12` for a 3.1 document, `4` for a 3.0 one.                           |
| `skip`            | —            | Leave a request alone entirely.                                                               |
| `reject`          | —            | Answer a refusal yourself. Return `undefined` for the default response.                       |

`validate` as an object takes `path`, `query`, `header`, `cookie`, `body` (all
`true`), `additionalQuery` (`'allow'` or `'reject'`), `status` (`400`) and
`maxViolations` (`20`).

### Describing without enforcing

```ts
withOpenApi({ document, validate: false, onUnknownRoute: 'pass' })
```

Routes are still matched and parameters still deserialized onto `ctx`; nothing
is refused. Useful for putting the middleware in front of an existing API and
watching what _would_ have been rejected before turning it on.

## Rejections

Four kinds, each with a default response and each available to a `reject`
callback before that response is built:

| Kind                     | Status | When                                                                    |
| ------------------------ | ------ | ----------------------------------------------------------------------- |
| `route_not_found`        | 404    | No path template matches the pathname.                                  |
| `method_not_allowed`     | 405    | The path matches; the operation is not declared. `Allow` names what is. |
| `unsupported_media_type` | 415    | The body's content type is not in the operation's `content`.            |
| `validation_failed`      | 400    | A parameter or body failed its schema.                                  |

The default body:

```json
{
  "error": "validation_failed",
  "message": "the request does not match the API description",
  "violations": [
    {
      "in": "query",
      "name": "limit",
      "location": "#",
      "keyword": "maximum",
      "message": "999 is greater than 100.",
      "description": "How many users to return. Between 1 and 100."
    }
  ]
}
```

Every violation is reported, not just the first, capped at `maxViolations`.
`location` is a JSON pointer into the offending value, which for a body is the
path to the property that failed.

### Descriptions

`message` is the validator's, and says what is mechanically wrong.
`description` is the **document's own prose** for whatever failed, and is
usually the half a caller can act on. You wrote it once; there is no reason for
an error response to throw it away.

It is resolved from the most specific place that has it:

| Violation                   | Described by                                                 |
| --------------------------- | ------------------------------------------------------------ |
| a parameter                 | its Parameter Object's `description`, else its schema's      |
| a body property             | the `description` on the schema that failed, `$ref` followed |
| a missing required property | that **property's** `description`, not its container's       |
| a body that was never sent  | the Request Body Object's `description`                      |

```
missing required param   999 is greater than 100.
                       → How many users to return. Between 1 and 100.

body #/manager/name      String is too short (0 < 1).
                       → Display name. Shown to teammates.

body                     Instance does not have required property "name".
                       → Display name. Shown to teammates.
```

That third row is the one worth pointing at: `required` fails against the
_object_, so the obvious implementation describes the object — "A person with
access to the workspace" — which says nothing about what is missing. The
property is named only inside the validator's message, so it is read from
there, and falls back to the container's prose if that wording ever changes.

A field with nothing written about it simply has no `description`. Set
`validate: { describe: false }` to leave them all off — descriptions are
written for a document's consumers, who are the same people reading these
errors, but turn it off if yours carries notes you would rather not return in
a response body.

To answer in your own error envelope:

```ts
withOpenApi({
  document,
  reject: (rejection) =>
    Response.json(
      { code: rejection.kind, detail: rejection.violations },
      { status: rejection.status },
    ),
})
```

Return `undefined` from `reject` to fall back to the default for that kind —
handy for customizing one kind and leaving the rest alone.

## The Scalar reference

`reference: true` serves two routes, both **before** matching, so they need no
entry in the document:

- `GET /reference` — the HTML page
- `GET /reference/openapi.json` — the document, for the page to load

```ts
withOpenApi({
  document,
  reference: {
    path: '/docs',
    documentPath: '/docs/openapi.json',
    title: 'Acme API',
    configuration: { darkMode: true, theme: 'purple' },
  },
})
```

`configuration` is passed through to
[`Scalar.createApiReference`](https://scalar.com/products/api-references/configuration).

The page is a twenty-line shell that loads Scalar's standalone build from
jsDelivr. That is deliberate: `@scalar/api-reference` is a Vue application, and
bundling it into an edge middleware would add megabytes to every deploy to serve
one HTML page. Point `cdnUrl` at your own copy to self-host, or replace the page
entirely:

```ts
reference: {
  html: ({ documentPath }) => myOwnPage(documentPath)
}
```

The reference paths are absolute — they are **not** relative to `basePath`.

## Parameters

`style` and `explode` are honored, so the document decides how a value is
spelled:

| `in`     | Styles supported                                                  |
| -------- | ----------------------------------------------------------------- |
| `query`  | `form` (default), `spaceDelimited`, `pipeDelimited`, `deepObject` |
| `path`   | `simple` (default), `label`, `matrix`                             |
| `header` | `simple`                                                          |
| `cookie` | `form`                                                            |

Coercion then reads the schema and converts the text. It is deliberately
conservative — it only ever converts a string, it never converts when `string`
is among the schema's allowed types, and where a conversion would not round-trip
it leaves the text alone so the validator reports a real type error rather than
a silent `NaN`:

```
?limit=10       type: integer          → 10
?limit=ten      type: integer          → 'ten', then a 400 naming the type
?limit=10       type: [string, integer] → '10'   (string is allowed; leave it)
?flag=true      type: boolean          → true
?flag=1         type: boolean          → '1',   then a 400
```

## Bodies

The media type is matched against the operation's `content` — exact key first,
then a `type` wildcard range, then the catch-all range — and parsed from what
the request says it is:

| Content type                         | Parsed as                          | Validated |
| ------------------------------------ | ---------------------------------- | --------- |
| `application/json`, anything `+json` | JSON                               | yes       |
| `application/x-www-form-urlencoded`  | object, coerced against the schema | yes       |
| `text/*`, anything `+xml`            | string                             | yes       |
| `multipart/form-data`                | object, with parts left as `File`  | no        |
| anything else                        | not read at all                    | no        |

Multipart parts are `File` objects, which no JSON Schema describes, so the body
is parsed onto `ctx` but not schema-checked. Binary media types are never
buffered — there is no shape to check, and reading a large upload to ignore it
is pure cost. `required` is enforced for both.

Reading the body here does not consume it. The framework hands every layer a
buffered request, so the handler can still call `req.json()`.

## CORS

An OpenAPI document already knows most of a CORS policy. `cors` derives it,
per route:

```ts
withOpenApi({
  document,
  cors: { origin: ['https://app.example.com'], credentials: true },
})
```

| Header                          | Derived from                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Access-Control-Allow-Methods`  | the operations the matched path declares                                                                                    |
| `Access-Control-Allow-Headers`  | its `in: header` parameters, `Content-Type` where it takes a body, and the header its security schemes carry credentials in |
| `Access-Control-Expose-Headers` | its Response Objects' `headers`, minus the browser safelist                                                                 |

So for a path declaring only `get` and `delete`:

```
preflight PUT /users/{id}  → 204, Allow-Methods: GET, DELETE
```

A hand-maintained list would advertise `PUT` and let the request through to a
`405`. This one does not, because it is reading the same document the `405`
comes from.

Three things worth knowing:

- **`origin` is required and never derived.** A document says where an API
  lives, not who may call it — `servers` is not an allowlist, and treating it
  as one would be a security decision made from the wrong data. Same for
  `credentials`.
- **Rejections are stamped too.** An unstamped `400` reaches a browser as an
  opaque CORS error rather than the violations it is carrying.
- **The document is the source of truth for headers.** A request header the API
  reads but the document does not declare will be refused by the browser. That
  is usually the document being wrong; `allowedHeaders` is the escape hatch
  when it genuinely is not.

Preflights are answered after the route match but before the method lookup —
otherwise the `OPTIONS` no document declares an operation for would come back
`405`. A plain `OPTIONS` with no `Access-Control-Request-Method` is not a
preflight and is still handled normally.

With `cors` unset the middleware is purely request-side and touches no response
headers at all.

## Composing

`withOpenApi` contributes one key and declares no prerequisites, so it goes
anywhere in a `pipeline` array. Put authentication after it, so it can read the
security requirements the document declares for the matched operation:

```ts
pipeline(
  [
    withOpenApi({ document, cors: { origin: ['https://app.example.com'] } }),
    // `ctx.openapi.security` is the operation's requirement, falling back to
    // the document's. This middleware never enforces it — that is auth's job.
    withAuth(),
  ],
  handler,
)
```

## Limits

Worth knowing before you wire this into something:

- **OpenAPI 3.1.** 3.1 schemas _are_ JSON Schema 2020-12, which is what makes
  validation a matter of handing the schema to a validator rather than
  translating it. A 3.0 document falls back to draft 4, which gets
  `exclusiveMinimum` and `required` right but does **not** translate `nullable`.
  Convert to 3.1 for full fidelity.
- **Local `$ref`s only.** External and remote references are not fetched.
  Bundle the document first.
- **Requests only.** Responses are not validated. That is the framework's model,
  not an omission: a middleware runs before the handler, and response shape stays
  under the handler's ownership.
- **`deepObject` is one level deep**, matching what the specification defines.
- **Trailing slashes are normalized**, so `/users` and `/users/` are one route.
- Indexing the document for validation stamps each node with its own absolute
  URI, as **non-enumerable** properties. The document object you pass in is
  mutated in that one respect; nothing observable changes — not `Object.keys`,
  not a spread, not `JSON.stringify` — and the reference endpoint serves the
  document byte-for-byte as it came in.

## Dependencies

Three, and each is load-bearing:

- **`openapi3-ts`** — the OpenAPI 3.1 types. Imported `type`-only, so it is
  erased from the runtime bundle entirely; it stays a real dependency because
  the published `.d.ts` refers to `OpenAPIObject`.
- **`@cfworker/json-schema`** — the validator. Zero dependencies, and it
  _interprets_ schemas rather than compiling them to JavaScript, which is what
  lets it run on Cloudflare Workers and anywhere else `new Function` is
  unavailable. The document is walked once at construction and every subschema in
  it validated against that one index, so `$ref` — recursive ones included —
  resolves without inlining anything.
- **`@supabase/middleware`** — the composition engine.

Scalar is **not** a dependency; the reference page loads it from a CDN.

## Development

```sh
pnpm install
pnpm test                    # vitest
pnpm typecheck               # source + the must-compile type tests
pnpm typecheck:negative      # asserts the must-NOT-compile cases still fail
pnpm build
pnpm smoke                   # exercises the built bundle end to end
pnpm check-exports           # attw, against the ESM-only profile
pnpm check-jsr               # jsr publish --dry-run, including the slow-type check
```

Two artifacts ship from one source tree, and the TypeScript 5.4 floor applies to
both — so there are two floor checks, because neither covers the other:

```sh
pnpm typecheck:min        # compiles src/ at 5.4  — what JSR consumers get
pnpm typecheck:consumer   # compiles against dist/index.d.ts at 5.4 — npm consumers
```

`scripts/smoke.mjs` takes no arguments and imports nothing but `dist/`, so it
runs under any of the targets:

```sh
node scripts/smoke.mjs
deno run --allow-read --allow-env --node-modules-dir=auto scripts/smoke.mjs
bun scripts/smoke.mjs
```

## Releasing

Conventional commits on `main` keep a
[release-please](https://github.com/googleapis/release-please) PR open. Merging
it tags a release, which publishes to npm and JSR. Both authenticate with the
workflow's OIDC token, so there are no publish secrets in the repository — the
one-time setup is a trusted publisher on npm and a linked repository on JSR.

Between releases, every branch push and pull request publishes an installable
preview to [pkg.pr.new](https://pkg.pr.new):

```sh
npm i https://pkg.pr.new/@croutonian/with-openapi@<sha-or-pr-number>
```

That compact form needs the package to already be on npm with a `repository`
field. Before the first release, use the long form, which always resolves:

```sh
npm i https://pkg.pr.new/johnstonmatt/with-openapi/@croutonian/with-openapi@<sha>
```

Previews are npm-side only. pkg.pr.new serves npm-compatible tarballs, and
Deno's resolver rejects a bare tarball URL (`Not implemented scheme 'https'`),
so Deno and JSR consumers cannot install one. JSR has no pre-release channel at
all. To try a branch under Deno, check the repository out and point an import
map at `src/index.ts`.

CI runs the built bundle on Node, Deno and Bun on every push. The claim that
this package is Web Fetch only — no `node:` imports, no code generation — is
only worth making if something checks it.

## License

MIT
