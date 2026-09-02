import { Hono } from 'hono'
import type { Env } from '../env'
import { readSession, type ReadSession } from '../lib/d1'
import { REFERENCE_TTL_SECONDS, withEdgeCache } from '../lib/cache'
import { decodeCursor, encodeCursor } from '../lib/cursor'
import { boundingBox, haversineKm } from '../lib/geo'
import { badRequest, boolParam, dateParam, floatParam, intParam, notFound } from '../lib/http'
import {
  buildFeedQuery, categoriesQuery, listingBySlugQuery, organizerBySlugQuery,
  slugRedirectQuery, venueBySlugQuery, venuesQuery, type FeedFilters,
} from './queries'
import { toListingDetail, toListingSummary, toVenueSummary } from './serialize'
import type { ListingSummary, Page } from './types'

const DEFAULT_LIMIT = 20
/** Hard ceiling. The audit's F4 was an endpoint that would return all 50 events. */
const MAX_LIMIT = 50

const LISTING_TYPES = ['ticketed_internal', 'ticketed_external', 'free', 'announcement']

const FEED_PARAMS = [
  'category', 'city', 'venue', 'organizer', 'type', 'featured',
  'from', 'to', 'include_past', 'cursor', 'limit',
] as const

const SEARCH_PARAMS = [...FEED_PARAMS, 'q', 'lat', 'lng', 'radius_km'] as const

export const catalogRoutes = new Hono<{ Bindings: Env }>()

/** Every catalog handler reports its D1 round trips; the budget is 1–3. */
function withRoundTrips(response: Response, session: ReadSession): Response {
  response.headers.set('x-d1-round-trips', String(session.roundTrips))
  return response
}

function parseFeedFilters(url: URL, { withSearch }: { withSearch: boolean }): FeedFilters {
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
    limit: intParam(q.get('limit') ?? undefined, {
      name: 'limit', fallback: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT,
    }),
    now: new Date().toISOString(),
  }

  if (filters.from && filters.to && filters.from > filters.to) {
    throw badRequest('invalid_parameter', 'from must be before to')
  }

  if (withSearch) {
    const query = (q.get('q') ?? '').trim()
    if (query) filters.query = query

    const lat = floatParam(q.get('lat') ?? undefined, 'lat')
    const lng = floatParam(q.get('lng') ?? undefined, 'lng')
    const radiusKm = floatParam(q.get('radius_km') ?? undefined, 'radius_km')
    if ((lat === undefined) !== (lng === undefined)) {
      throw badRequest('invalid_parameter', 'lat and lng must be given together')
    }
    if (lat !== undefined && lng !== undefined) {
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        throw badRequest('invalid_parameter', 'lat/lng are out of range')
      }
      const radius = radiusKm ?? 10
      if (radius <= 0 || radius > 500) {
        throw badRequest('invalid_parameter', 'radius_km must be between 0 and 500')
      }
      filters.box = boundingBox(lat, lng, radius)
    }
  }

  return filters
}

async function fetchFeed(
  session: ReadSession,
  filters: FeedFilters,
  centre?: { lat: number; lng: number; radiusKm: number },
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

// ─── GET /api/catalog/listings ───────────────────────────────────────────────
catalogRoutes.get('/listings', async (c) => {
  const filters = parseFeedFilters(new URL(c.req.url), { withSearch: false })
  const session = readSession(c.env)
  const response = await withEdgeCache(c, { params: FEED_PARAMS }, async () =>
    Response.json(await fetchFeed(session, filters)),
  )
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/search ─────────────────────────────────────────────────
catalogRoutes.get('/search', async (c) => {
  const url = new URL(c.req.url)
  const filters = parseFeedFilters(url, { withSearch: true })
  const lat = floatParam(url.searchParams.get('lat') ?? undefined, 'lat')
  const lng = floatParam(url.searchParams.get('lng') ?? undefined, 'lng')
  const radiusKm = floatParam(url.searchParams.get('radius_km') ?? undefined, 'radius_km') ?? 10
  const centre = lat !== undefined && lng !== undefined ? { lat, lng, radiusKm } : undefined

  const session = readSession(c.env)
  const response = await withEdgeCache(c, { params: SEARCH_PARAMS }, async () =>
    Response.json(await fetchFeed(session, filters, centre)),
  )
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/listings/:slug ─────────────────────────────────────────
catalogRoutes.get('/listings/:slug', async (c) => {
  const slug = c.req.param('slug')
  const session = readSession(c.env)

  const response = await withEdgeCache(c, { params: [] }, async () => {
    const { sql, params } = listingBySlugQuery(slug)
    const row = await session.first<Record<string, unknown>>(sql, params)
    if (row) return Response.json(toListingDetail(row))

    // Second round trip only on a miss: an old URL still resolves (#24).
    const redirect = slugRedirectQuery('listing', slug)
    const moved = await session.first<{ current_slug: string | null }>(redirect.sql, redirect.params)
    if (moved?.current_slug) {
      return new Response(null, {
        status: 301,
        headers: { location: `/api/catalog/listings/${moved.current_slug}` },
      })
    }
    throw notFound('No published listing with that slug')
  })
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/venues ─────────────────────────────────────────────────
catalogRoutes.get('/venues', async (c) => {
  const url = new URL(c.req.url)
  const limit = intParam(url.searchParams.get('limit') ?? undefined, {
    name: 'limit', fallback: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT,
  })
  const session = readSession(c.env)

  const response = await withEdgeCache(c, { params: ['city', 'q', 'cursor', 'limit'] }, async () => {
    const { sql, params } = venuesQuery({
      city: url.searchParams.get('city') ?? undefined,
      query: (url.searchParams.get('q') ?? '').trim() || undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit,
      now: new Date().toISOString(),
    })
    const rows = await session.all<Record<string, unknown>>(sql, params)
    const hasMore = rows.length > limit
    const data = rows.slice(0, limit).map(toVenueSummary)
    return Response.json({
      data,
      // Venues are ordered by slug, so the slug is the cursor.
      page: { limit, has_more: hasMore, next_cursor: hasMore ? (data.at(-1)?.slug ?? null) : null },
    })
  })
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/venues/:slug ───────────────────────────────────────────
catalogRoutes.get('/venues/:slug', async (c) => {
  const slug = c.req.param('slug')
  const session = readSession(c.env)

  const response = await withEdgeCache(c, { params: ['limit'] }, async () => {
    const now = new Date().toISOString()
    const venue = venueBySlugQuery(slug, now)
    const listings = buildFeedQuery({ venue: slug, includePast: false, limit: 20, now })

    // One batch, one round trip: the venue and what is on there.
    const [venueRows, listingRows] = await session.batch<Record<string, unknown>>([
      { sql: venue.sql, params: venue.params },
      { sql: listings.sql, params: listings.params },
    ])

    const row = venueRows?.[0]
    if (!row) throw notFound('No venue with that slug')

    return Response.json({
      venue: { ...toVenueSummary(row), description: row.description ?? null,
               website_url: row.website_url ?? null, phone: row.phone ?? null,
               capacity: row.capacity ?? null, google_place_id: row.google_place_id ?? null },
      listings: (listingRows ?? []).slice(0, 20).map(toListingSummary),
    })
  })
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/organizers/:slug ───────────────────────────────────────
catalogRoutes.get('/organizers/:slug', async (c) => {
  const slug = c.req.param('slug')
  const session = readSession(c.env)

  const response = await withEdgeCache(c, { params: [] }, async () => {
    const now = new Date().toISOString()
    const organizer = organizerBySlugQuery(slug, now)
    const listings = buildFeedQuery({ organizer: slug, includePast: false, limit: 20, now })

    const [organizerRows, listingRows] = await session.batch<Record<string, unknown>>([
      { sql: organizer.sql, params: organizer.params },
      { sql: listings.sql, params: listings.params },
    ])

    const row = organizerRows?.[0]
    if (!row) throw notFound('No organizer with that slug')

    return Response.json({
      organizer: {
        id: row.id, slug: row.slug, name: row.name,
        description: row.description ?? null, logo_url: row.logo_url ?? null,
        website_url: row.website_url ?? null, is_verified: row.is_verified === 1,
        upcoming_listing_count: row.upcoming_listing_count ?? 0,
      },
      listings: (listingRows ?? []).slice(0, 20).map(toListingSummary),
    })
  })
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/categories ─────────────────────────────────────────────
catalogRoutes.get('/categories', async (c) => {
  const session = readSession(c.env)
  const response = await withEdgeCache(
    c,
    { params: [], ttlSeconds: REFERENCE_TTL_SECONDS },
    async () => {
      const { sql, params } = categoriesQuery(new Date().toISOString())
      const rows = await session.all<Record<string, unknown>>(sql, params)
      return Response.json({ data: rows })
    },
  )
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/bootstrap ──────────────────────────────────────────────
// Everything the homepage needs in one request. The WaahTickets SPA made five
// calls to render its first screen; on a 3G connection request count dominates.
catalogRoutes.get('/bootstrap', async (c) => {
  const session = readSession(c.env)
  const response = await withEdgeCache(c, { params: [] }, async () => {
    const now = new Date().toISOString()
    const categories = categoriesQuery(now)
    const upcoming = buildFeedQuery({ includePast: false, limit: 24, now })
    const featured = buildFeedQuery({ includePast: false, featured: true, limit: 6, now })

    const [categoryRows, upcomingRows, featuredRows] = await session.batch<Record<string, unknown>>([
      { sql: categories.sql, params: categories.params },
      { sql: upcoming.sql, params: upcoming.params },
      { sql: featured.sql, params: featured.params },
    ])

    return Response.json({
      categories: categoryRows ?? [],
      upcoming: (upcomingRows ?? []).slice(0, 24).map(toListingSummary),
      featured: (featuredRows ?? []).slice(0, 6).map(toListingSummary),
    })
  })
  return withRoundTrips(response, session)
})
