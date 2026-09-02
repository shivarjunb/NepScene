import { Hono } from 'hono'
import type { Env } from '../env'
import { readSession } from '../lib/d1'
import { withEdgeCache } from '../lib/cache'
import { notFound } from '../lib/http'
import { buildFeedQuery, organizerBySlugQuery, venueBySlugQuery, venuesQuery } from './queries'
import { toListingSummary, toVenueSummary } from './serialize'
import { limitParam, withRoundTrips } from './shared'

/** Venues and organizers — the two things a listing belongs to that own a page. */
export const placeRoutes = new Hono<{ Bindings: Env }>()

const LISTINGS_PER_PAGE_VIEW = 20

// ─── GET /api/catalog/venues ─────────────────────────────────────────────────
placeRoutes.get('/venues', async (c) => {
  const url = new URL(c.req.url)
  const limit = limitParam(url)
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
placeRoutes.get('/venues/:slug', async (c) => {
  const slug = c.req.param('slug')
  const session = readSession(c.env)

  const response = await withEdgeCache(c, { params: [] }, async () => {
    const now = new Date().toISOString()
    const venue = venueBySlugQuery(slug, now)
    const listings = buildFeedQuery({
      venue: slug, includePast: false, limit: LISTINGS_PER_PAGE_VIEW, now,
    })

    // One batch, one round trip: the venue and what is on there.
    const [venueRows, listingRows] = await session.batch<Record<string, unknown>>([
      { sql: venue.sql, params: venue.params },
      { sql: listings.sql, params: listings.params },
    ])

    const row = venueRows?.[0]
    if (!row) throw notFound('No venue with that slug')

    return Response.json({
      venue: {
        ...toVenueSummary(row),
        description: row.description ?? null,
        website_url: row.website_url ?? null,
        phone: row.phone ?? null,
        capacity: row.capacity ?? null,
        google_place_id: row.google_place_id ?? null,
      },
      listings: (listingRows ?? []).slice(0, LISTINGS_PER_PAGE_VIEW).map(toListingSummary),
    })
  })
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/organizers/:slug ───────────────────────────────────────
placeRoutes.get('/organizers/:slug', async (c) => {
  const slug = c.req.param('slug')
  const session = readSession(c.env)

  const response = await withEdgeCache(c, { params: [] }, async () => {
    const now = new Date().toISOString()
    const organizer = organizerBySlugQuery(slug, now)
    const listings = buildFeedQuery({
      organizer: slug, includePast: false, limit: LISTINGS_PER_PAGE_VIEW, now,
    })

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
      listings: (listingRows ?? []).slice(0, LISTINGS_PER_PAGE_VIEW).map(toListingSummary),
    })
  })
  return withRoundTrips(response, session)
})
