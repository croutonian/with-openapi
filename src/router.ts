/**
 * Matching a request pathname against the document's path templates.
 *
 * Routes are bucketed by segment count and, within a bucket, ordered by
 * specificity: reading left to right, a static segment beats a templated one.
 * That is the ordering OpenAPI asks for — `/pets/mine` wins over `/pets/{id}`
 * — and doing it once at construction keeps matching to a linear scan of a
 * bucket that is usually one or two entries deep.
 */

import {
  normalizePathname,
  type IndexedRoute,
  type Segment,
} from './document.js'

/** A route template that matched, with its path parameters already decoded. */
export interface RouteMatch {
  readonly route: IndexedRoute
  /** Raw (percent-decoded) segment text, keyed by template parameter name. */
  readonly pathValues: Readonly<Record<string, string>>
}

/** What {@link createRouter} returns. */
export interface Router {
  match(pathname: string): RouteMatch | undefined
}

function moreSpecific(a: IndexedRoute, b: IndexedRoute): number {
  const length = Math.min(a.segments.length, b.segments.length)
  for (let i = 0; i < length; i++) {
    const left = a.segments[i]?.kind === 'static'
    const right = b.segments[i]?.kind === 'static'
    if (left !== right) return left ? -1 : 1
  }
  // Same shape: order by template so matching is deterministic across runs.
  return a.template < b.template ? -1 : a.template > b.template ? 1 : 0
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    // A malformed escape is not worth a 500 — hand the raw text to validation,
    // which will report it against the parameter's schema.
    return raw
  }
}

function matchSegments(
  segments: readonly Segment[],
  actual: readonly string[],
): Record<string, string> | undefined {
  const pathValues: Record<string, string> = {}
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const value = actual[i]
    if (segment === undefined || value === undefined) return undefined
    if (segment.kind === 'static') {
      if (segment.value !== value) return undefined
    } else {
      // An empty segment is not a value — `/users//posts` must not match
      // `/users/{id}/posts` with `id: ''`.
      if (value === '') return undefined
      pathValues[segment.name] = decodeSegment(value)
    }
  }
  return pathValues
}

/** Build a matcher over an indexed document. */
export function createRouter(routes: readonly IndexedRoute[]): Router {
  const byLength = new Map<number, IndexedRoute[]>()
  for (const route of routes) {
    const bucket = byLength.get(route.segments.length)
    if (bucket) bucket.push(route)
    else byLength.set(route.segments.length, [route])
  }
  for (const bucket of byLength.values()) bucket.sort(moreSpecific)

  return {
    match(pathname) {
      const actual = normalizePathname(pathname).slice(1).split('/')
      const bucket = byLength.get(actual.length)
      if (bucket === undefined) return undefined
      for (const route of bucket) {
        const pathValues = matchSegments(route.segments, actual)
        if (pathValues !== undefined) return { route, pathValues }
      }
      return undefined
    },
  }
}
