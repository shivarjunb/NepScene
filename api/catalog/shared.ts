import type { Context } from 'hono'
import type { Env } from '../env'
import type { ReadSession } from '../lib/d1'
import { decodeCursor, encodeCursor } from '../lib/cursor'
import { boundingBox, haversineKm } from '../lib/geo'
import { badRequest, boolParam, dateParam, floatParam, intParam } from '../lib/http'
import { buildFeedQuery, type FeedFilters } from './queries'
import { toListingSummary } from './serialize'
import type { ListingSummary, Page } from './types'

export const DEFAULT_LIMIT = 20
/** Hard ceiling. The audit's F4 was an endpoint that would return all 50 events. */
export const MAX_LIMIT = 50

export const LISTING_TYPES = ['ticketed_internal', 'ticketed_external', 'free', 'announcement']

export const FEED_PARAMS = [
  'category', 'city', 'venue', 'organizer', 'type', 'featured',
  'from', 'to', 'include_past', 'cursor', 'limit',
] as const

export const SEARCH_PARAMS = [...FEED_PARAMS, 'q', 'lat', 'lng', 'radius_km'] as const

export type CatalogContext = Context<{ Bindings: Env }>

/** Every catalog handler reports its D1 round trips; the budget is 1–3. */
export function withRoundTrips(response: Response, session: ReadSession): Response {
  response.headers.set('x-d1-round-trips', String(session.roundTrips))
  return response
}

export function limitParam(url: URL): number {
  return intParam(url.searchParams.get('limit') ?? undefined, {
    name: 'limit', fallback: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT,
  })
}

export function parseFeedFilters(url: URL, { withSearch }: { withSearch: boolean }): FeedFilters {
  const q = url.searchParams
  const listingType = q.get('type') ?? undefined
  if (listingType && !LISTING_TYPES.includes(listingType)) {
    throw badRequest('invalid_parameter', `type must be one of ${LISTING_TYPES.join(', ')}`)
  }

  const filters: FeedFilters = {
    category: q.get('category') ?? undefined,
    city: q.get('city') ?? undefined,
    venue: q.get('venue') ?? undefined,
    organizer: q.get('organizer') ?? undefined,
    listingType,
    featured: boolParam(q.get('featured') ?? undefined),
    from: dateParam(q.get('from') ?? undefined, 'from'),
    to: dateParam(q.get('to') ?? undefined, 'to'),
    // Upcoming by default. Past listings are opt-in, because the WaahTickets
    // endpoint this replaces returned 28 finished events out of 50.
    includePast: boolParam(q.get('include_past') ?? undefined),
    cursor: decodeCursor(q.get('cursor') ?? undefined),
    limit: limitParam(url),
    now: new Date().toISOString(),
  }

  if (filters.from && filters.to && filters.from > filters.to) {
    throw badRequest('invalid_parameter', 'from must be before to')
  }

  if (withSearch) {
    const query = (q.get('q') ?? '').trim()
    if (query) filters.query = query
    const centre = parseCentre(url)
    if (centre) filters.box = boundingBox(centre.lat, centre.lng, centre.radiusKm)
  }

  return filters
}

export type Centre = { lat: number; lng: number; radiusKm: number }

export function parseCentre(url: URL): Centre | undefined {
  const lat = floatParam(url.searchParams.get('lat') ?? undefined, 'lat')
  const lng = floatParam(url.searchParams.get('lng') ?? undefined, 'lng')
  const radiusKm = floatParam(url.searchParams.get('radius_km') ?? undefined, 'radius_km')

  if ((lat === undefined) !== (lng === undefined)) {
    throw badRequest('invalid_parameter', 'lat and lng must be given together')
  }
  if (lat === undefined || lng === undefined) return undefined

  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw badRequest('invalid_parameter', 'lat/lng are out of range')
  }
  const radius = radiusKm ?? 10
  if (radius <= 0 || radius > 500) {
    throw badRequest('invalid_parameter', 'radius_km must be between 0 and 500')
  }
  return { lat, lng, radiusKm: radius }
}

export async function fetchFeed(
  session: ReadSession,
  filters: FeedFilters,
  centre?: Centre,
): Promise<Page<ListingSummary>> {
  const { sql, params } = buildFeedQuery(filters)
  const rows = await session.all<Record<string, unknown>>(sql, params)

  const hasMore = rows.length > filters.limit
  const page = rows.slice(0, filters.limit).map(toListingSummary)

  let data = page
  if (centre) {
    // The SQL box contains the circle, so the exact radius is applied here.
    // A page may therefore come back shorter than `limit`; has_more still
    // tells the client whether to keep paging.
    data = page.flatMap((listing) => {
      if (listing.latitude === null || listing.longitude === null) return []
      const distance = haversineKm(centre.lat, centre.lng, listing.latitude, listing.longitude)
      return distance <= centre.radiusKm ? [{ ...listing, distance_km: round(distance) }] : []
    })
  }

  const last = page.at(-1)
  return {
    data,
    page: {
      limit: filters.limit,
      has_more: hasMore,
      next_cursor: hasMore && last ? encodeCursor({ startsAt: last.starts_at, id: last.id }) : null,
    },
  }
}

const round = (n: number) => Math.round(n * 10) / 10
