import type { Bootstrap, Listing, Page } from './catalog'

/**
 * The browser's half of the Catalog API.
 *
 * Same origin, so no base URL and no CORS: the Worker serves the SPA and the
 * API from one hostname (wrangler.jsonc `run_worker_first: ["/api/*"]`).
 */

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/catalog${path}`, {
    signal,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    // The API's error shape is { error: { code, message } }; fall back to the
    // status when a proxy returns something else entirely.
    const body = await response.json().catch(() => null) as
      { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

/**
 * Everything the homepage's first paint needs, in one request. The WaahTickets
 * SPA made five calls to render its first screen; on 3G the request count is
 * what costs, not the bytes.
 */
export const fetchBootstrap = (signal?: AbortSignal) =>
  get<Bootstrap>('/bootstrap', signal)

export function fetchListings(
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<Page<Listing>> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value)
  }
  const suffix = query.size > 0 ? `?${query}` : ''
  return get<Page<Listing>>(`/listings${suffix}`, signal)
}

/**
 * The map's data source (#36): `/search`, which is the endpoint that accepts a
 * viewport. `/listings` deliberately does not — its cache key is the feed's
 * parameter list, and a bbox on it would fragment the feed cache with keys
 * only the map ever asks for.
 */
export function fetchSearch(
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<Page<Listing>> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value)
  }
  const suffix = query.size > 0 ? `?${query}` : ''
  return get<Page<Listing>>(`/search${suffix}`, signal)
}
