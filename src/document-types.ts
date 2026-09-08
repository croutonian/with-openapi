/**
 * Type-level projections of a document literal.
 *
 * These only say anything when the document keeps its literal type — which is
 * what {@link OpenAPIInterface}'s `const` type parameter is for. Handed a
 * document widened to `OpenAPIObject` (by an annotation) or imported from
 * `.json` (which TypeScript widens), every projection here degrades to
 * `unknown` rather than lying.
 *
 * This is a deliberate subset of JSON Schema, not an implementation of it. The
 * runtime validator is the authority; this exists so a handler can read a
 * parameter without casting. Anything not covered below resolves to `unknown`,
 * which is the same answer the untyped path gives.
 */

import type {
  OpenApiContribution,
  OpenApiMatched,
  OpenApiUnmatched,
} from './types.js'

/**
 * Collapse an intersection of mapped types into one object type.
 *
 * Splitting `properties` by `required` produces `{ a: A } & { b?: B }`, which
 * is assignable both ways but is not the *same* type — so an exact-equality
 * test fails, and hovering it shows the intersection rather than the shape.
 * Both matter here: the point of these projections is what the editor tells
 * you.
 */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** How deep `$ref` chains and nested schemas are followed before giving up. */
type MaxDepth = 8
type Deeper<D extends unknown[]> = [...D, unknown]

type LocalRef<
  Document,
  Ref extends string,
  Bucket extends string,
> = Ref extends `#/components/${Bucket}/${infer Name}`
  ? Document extends {
      components: { [K in Bucket]: Record<Name, infer Target> }
    }
    ? Target
    : unknown
  : unknown

/**
 * A Schema Object as a TypeScript type.
 *
 * Covers `$ref` into `#/components/schemas`, `const`, `enum`, the primitive
 * types, arrays, and objects with `required` driving optionality. Composition
 * keywords (`allOf`, `oneOf`, `anyOf`) are not interpreted — they resolve to
 * `unknown`, because guessing at them is how a type starts disagreeing with
 * the validator.
 */
export type FromSchema<
  Schema,
  Document,
  Depth extends unknown[] = [],
> = Depth['length'] extends MaxDepth
  ? unknown
  : Schema extends { $ref: infer Ref extends string }
    ? FromSchema<LocalRef<Document, Ref, 'schemas'>, Document, Deeper<Depth>>
    : Schema extends { const: infer Value }
      ? Value
      : Schema extends { enum: ReadonlyArray<infer Member> }
        ? Member
        : Schema extends { type: 'string' }
          ? string
          : Schema extends { type: 'integer' | 'number' }
            ? number
            : Schema extends { type: 'boolean' }
              ? boolean
              : Schema extends { type: 'null' }
                ? null
                : Schema extends { type: 'array' }
                  ? FromArraySchema<Schema, Document, Depth>
                  : Schema extends { type: 'object' }
                    ? FromObjectSchema<Schema, Document, Depth>
                    : unknown

type FromArraySchema<
  Schema,
  Document,
  Depth extends unknown[],
> = Schema extends { items: infer Items }
  ? Array<FromSchema<Items, Document, Deeper<Depth>>>
  : unknown[]

type FromObjectSchema<
  Schema,
  Document,
  Depth extends unknown[],
> = Schema extends { properties: infer Props }
  ? Schema extends { required: ReadonlyArray<infer Required extends string> }
    ? Optionalize<Props, Required, Document, Depth>
    : Optionalize<Props, never, Document, Depth>
  : Record<string, unknown>

/** Split `properties` by whether `required` names them. */
type Optionalize<
  Props,
  Required extends string,
  Document,
  Depth extends unknown[],
> = Simplify<
  {
    [K in keyof Props as K extends Required ? K : never]: FromSchema<
      Props[K],
      Document,
      Deeper<Depth>
    >
  } & {
    [K in keyof Props as K extends Required ? never : K]?: FromSchema<
      Props[K],
      Document,
      Deeper<Depth>
    >
  }
>

/** The path templates the document declares. */
export type RoutesOf<Document> = Document extends { paths: infer Paths }
  ? Extract<keyof Paths, string>
  : never

type PathItemOf<Document, Route extends string> = Document extends {
  paths: Record<Route, infer Item>
}
  ? Item
  : never

/** HTTP methods the document declares under `Route`. */
export type MethodsOf<Document, Route extends string> = Extract<
  keyof PathItemOf<Document, Route>,
  'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace'
>

/** The Operation Object at `Route` + `Method`. */
export type OperationOf<Document, Route extends string, Method extends string> =
  PathItemOf<Document, Route> extends Record<Method, infer Operation>
    ? Operation
    : never

/** Every `operationId` the document declares, as a union. */
export type OperationIdsOf<Document> = Document extends { paths: infer Paths }
  ? {
      [R in keyof Paths]: {
        [M in keyof Paths[R]]: Paths[R][M] extends { operationId: infer Id }
          ? Id
          : never
      }[keyof Paths[R]]
    }[keyof Paths]
  : never

/**
 * Parameter Objects in force for an operation: the Path Item's, then the
 * operation's own, with `$ref`s into `#/components/parameters` followed.
 */
type ParametersOf<Document, Route extends string, Method extends string> =
  | ResolveParameter<
      Document,
      PathItemOf<Document, Route> extends {
        parameters: ReadonlyArray<infer Parameter>
      }
        ? Parameter
        : never
    >
  | ResolveParameter<
      Document,
      OperationOf<Document, Route, Method> extends {
        parameters: ReadonlyArray<infer Parameter>
      }
        ? Parameter
        : never
    >

type ResolveParameter<Document, Parameter> = Parameter extends {
  $ref: infer Ref extends string
}
  ? LocalRef<Document, Ref, 'parameters'>
  : Parameter

type SchemaOfParameter<Document, Parameter> = Parameter extends {
  schema: infer Schema
}
  ? FromSchema<Schema, Document>
  : unknown

/** Parameters declared `in: Location`, keyed by name, optional unless required. */
type ParametersIn<
  Document,
  Route extends string,
  Method extends string,
  Location extends string,
> =
  Extract<
    ParametersOf<Document, Route, Method>,
    { name: string; in: Location }
  > extends infer Declared
    ? Simplify<
        {
          [
            P in Extract<Declared, { name: string }> as P extends {
              required: true
            }
              ? P['name']
              : never
          ]: SchemaOfParameter<Document, P>
        } & {
          [
            P in Extract<Declared, { name: string }> as P extends {
              required: true
            }
              ? never
              : P['name']
          ]?: SchemaOfParameter<Document, P>
        }
      >
    : never

/**
 * `ctx.openapi.params` for one operation, with each value typed by its schema
 * instead of `unknown`.
 */
export type ParamsFor<Document, Route extends string, Method extends string> = {
  readonly path: ParametersIn<Document, Route, Method, 'path'>
  readonly query: ParametersIn<Document, Route, Method, 'query'>
  readonly header: ParametersIn<Document, Route, Method, 'header'>
  readonly cookie: ParametersIn<Document, Route, Method, 'cookie'>
}

/**
 * The `matched` branch for one operation, with `route`, `operation` and
 * `params` specialized to it.
 *
 * `security` and `mediaType` keep their general types: they are not what the
 * narrowing is for, and pinning them would add conditional depth for no gain.
 */
type MatchedOperation<Document, Route extends string, Method extends string> = {
  readonly matched: true
  readonly route: Route
  readonly operation: OperationOf<Document, Route, Method>
  readonly operationId: OperationOf<Document, Route, Method> extends {
    operationId: infer Id
  }
    ? Id
    : undefined
  readonly security: OpenApiMatched['security']
  readonly params: ParamsFor<Document, Route, Method>
  readonly mediaType: OpenApiMatched['mediaType']
}

/**
 * Every operation the document declares, as a union — one branch each, so
 * narrowing on `operationId` (or `route`) inside a handler reaches that
 * operation's own parameter types with no cast.
 */
export type MatchedFor<Document> = {
  [Route in RoutesOf<Document>]: {
    [Method in MethodsOf<Document, Route>]: MatchedOperation<
      Document,
      Route,
      Method
    >
  }[MethodsOf<Document, Route>]
}[RoutesOf<Document>]

/**
 * What lands at `ctx.openapi` for a given document.
 *
 * Falls back to the unspecialized {@link OpenApiContribution} when the
 * document arrived without its literal type — annotated `: OpenAPIObject`,
 * say. `RoutesOf` is `never` there, which would otherwise leave a union with
 * no `matched: true` branch at all and break every existing consumer.
 * Degrading to today's shape is what keeps this change additive.
 */
export type ContributionFor<Document> = [RoutesOf<Document>] extends [never]
  ? OpenApiContribution
  : MatchedFor<Document> | OpenApiUnmatched
