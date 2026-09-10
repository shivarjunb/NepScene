import type {
  ArtistSummary, Bootstrap, Listing, ListingDetail, OrganizerSummary, Page, PlacePage,
  SearchResult, Suggestion, VenueDetail, VenueSummary,
} from './catalog'

/**
 * The browser's half of the Catalog API.
 *
 * Same origin, so no base URL and no CORS: the Worker serves the SPA and the
 * API from one hostname (wrangler.jsonc `run_worker_first: ["/api/*"]`).
 */

/**
 * The status travels with the error because the pages care about the
 * difference: a 404 is a page that says "no such listing" and offers a way
 * back, while a 500 is a page that says "try again". Collapsing both into a
 * message string is how a missing listing ends up telling people the site is
 * broken.
 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

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
    throw new ApiError(response.status, body?.error?.message ?? `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  return search.size > 0 ? `?${search}` : ''
}

/**
 * Everything the homepage's first paint needs, in one request. The WaahTickets
 * SPA made five calls to render its first screen; on 3G the request count is
 * what costs, not the bytes.
 */
export const fetchBootstrap = (signal?: AbortSignal) =>
  get<Bootstrap>('/bootstrap', signal)

export const fetchListings = (
  params: Record<string, string | undefined>, signal?: AbortSignal,
) => get<Page<Listing>>(`/listings${query(params)}`, signal)

/** The listing page's whole payload, related rail included (#43). */
export const fetchListing = (slug: string, signal?: AbortSignal) =>
  get<ListingDetail>(`/listings/${encodeURIComponent(slug)}`, signal)

/**
 * Search (#42). Also the map's data source (#36), which is why `/search` is
 * the endpoint that accepts a viewport: `/listings` deliberately does not —
 * its cache key is the feed's parameter list, and a bbox on it would fragment
 * the feed cache with keys only the map ever asks for.
 */
export const fetchSearch = (
  params: Record<string, string | undefined>, signal?: AbortSignal,
) => get<SearchResult>(`/search${query(params)}`, signal)

export const fetchSuggestions = (q: string, signal?: AbortSignal) =>
  get<{ data: Suggestion[] }>(`/suggest${query({ q })}`, signal)

export const fetchVenues = (
  params: Record<string, string | undefined>, signal?: AbortSignal,
) => get<Page<VenueSummary>>(`/venues${query(params)}`, signal)

export const fetchVenue = (slug: string, signal?: AbortSignal) =>
  get<PlacePage<VenueDetail, 'venue'>>(`/venues/${encodeURIComponent(slug)}`, signal)

export const fetchOrganizers = (
  params: Record<string, string | undefined>, signal?: AbortSignal,
) => get<Page<OrganizerSummary>>(`/organizers${query(params)}`, signal)

export const fetchOrganizer = (slug: string, signal?: AbortSignal) =>
  get<PlacePage<OrganizerSummary, 'organizer'>>(`/organizers/${encodeURIComponent(slug)}`, signal)

export const fetchArtist = (slug: string, signal?: AbortSignal) =>
  get<PlacePage<ArtistSummary, 'artist'>>(`/artists/${encodeURIComponent(slug)}`, signal)
