import { Hono } from 'hono'
import type { Env } from '../env'
import { readSession } from '../lib/d1'
import { withEdgeCache } from '../lib/cache'
import { notFound } from '../lib/http'
import {
  artistBySlugQuery, buildFeedQuery, organizerBySlugQuery, organizersQuery,
  venueBySlugQuery, venuesQuery,
} from './queries'
import {
  ARTIST_PAGE_MINIMUM, toArtistSummary, toListingSummary, toOrganizerSummary, toVenueSummary,
} from './serialize'
import { limitParam, withRoundTrips } from './shared'

/**
 * The pages a listing belongs to (#44): venues, organizers and artists.
 *
 * All three answer the same two questions — what is on, and what has been —
 * and all three answer them in **one round trip**: the entity and both lists
 * go in a single batch. The alternative, a lookup followed by a feed, doubles
 * the latency of the page that does most of this site's search-engine work.
 *
 * Past listings are fetched alongside the upcoming ones rather than on demand,
 * because a venue between seasons is the normal case, not the exception. A
 * page that shows an empty "what's on" and makes the reader ask for the
 * history is a page that looks closed.
 */
export const placeRoutes = new Hono<{ Bindings: Env }>()

const LISTINGS_PER_PAGE_VIEW = 20
/**
 * Past listings are evidence that a place is alive, not an archive to browse.
 * Ten is enough to establish that and small enough not to bury what is on.
 */
const PAST_PER_PAGE_VIEW = 10

/**
 * An artist page needs enough on it to be worth landing on. Below this the
 * artist's name is still shown on the listing — it just does not become a link
 * to a page with one thing on it and nothing else.
 *
 * The listing detail does not repeat this number: `has_page` on every artist
 * reference is computed from it (api/catalog/serialize.ts), so raising it here
 * cannot leave listings linking to pages this file then refuses.
 */
export const ARTIST_PAGE_THRESHOLD = ARTIST_PAGE_MINIMUM

/** The two lists every entity page carries, as one batch of statements. */
function listingStatements(scope: { venue?: string; organizer?: string; artist?: string }, now: string) {
  return {
    upcoming: buildFeedQuery({
      ...scope, includePast: false, limit: LISTINGS_PER_PAGE_VIEW, now,
    }),
    past: buildFeedQuery({
      // `includePast` opens the window and `finishedBefore` closes it at now,
      // which together mean "finished" — as opposed to a `to` bound, which
      // would call a festival that is still running past because it started
      // last week.
      ...scope, includePast: true, finishedBefore: now, limit: PAST_PER_PAGE_VIEW, now,
      order: 'desc',
    }),
  }
}

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

// ─── GET /api/catalog/organizers ─────────────────────────────────────────────
placeRoutes.get('/organizers', async (c) => {
  const url = new URL(c.req.url)
  const limit = limitParam(url)
  const session = readSession(c.env)

  const response = await withEdgeCache(c, { params: ['q', 'cursor', 'limit'] }, async () => {
    const { sql, params } = organizersQuery({
      query: (url.searchParams.get('q') ?? '').trim() || undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit,
      now: new Date().toISOString(),
    })
    const rows = await session.all<Record<string, unknown>>(sql, params)
    const hasMore = rows.length > limit
    const data = rows.slice(0, limit).map(toOrganizerSummary)
    return Response.json({
      data,
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
    const listings = listingStatements({ venue: slug }, now)

    const [venueRows, upcomingRows, pastRows] = await session.batch<Record<string, unknown>>([
      { sql: venue.sql, params: venue.params },
      { sql: listings.upcoming.sql, params: listings.upcoming.params },
      { sql: listings.past.sql, params: listings.past.params },
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
      listings: (upcomingRows ?? []).slice(0, LISTINGS_PER_PAGE_VIEW).map(toListingSummary),
      past: (pastRows ?? []).slice(0, PAST_PER_PAGE_VIEW).map(toListingSummary),
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
    const listings = listingStatements({ organizer: slug }, now)

    const [organizerRows, upcomingRows, pastRows] = await session.batch<Record<string, unknown>>([
      { sql: organizer.sql, params: organizer.params },
      { sql: listings.upcoming.sql, params: listings.upcoming.params },
      { sql: listings.past.sql, params: listings.past.params },
    ])

    const row = organizerRows?.[0]
    if (!row) throw notFound('No organizer with that slug')

    return Response.json({
      organizer: toOrganizerSummary(row),
      listings: (upcomingRows ?? []).slice(0, LISTINGS_PER_PAGE_VIEW).map(toListingSummary),
      past: (pastRows ?? []).slice(0, PAST_PER_PAGE_VIEW).map(toListingSummary),
    })
  })
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/artists/:slug ──────────────────────────────────────────
/**
 * An artist page, where there is enough for one. Below the threshold this is a
 * 404 rather than a thin page — and the same threshold decides whether the
 * listing page links here at all, so the two can never disagree.
 */
placeRoutes.get('/artists/:slug', async (c) => {
  const slug = c.req.param('slug')
  const session = readSession(c.env)

  const response = await withEdgeCache(c, { params: [] }, async () => {
    const now = new Date().toISOString()
    const artist = artistBySlugQuery(slug, now)
    const listings = listingStatements({ artist: slug }, now)

    const [artistRows, upcomingRows, pastRows] = await session.batch<Record<string, unknown>>([
      { sql: artist.sql, params: artist.params },
      { sql: listings.upcoming.sql, params: listings.upcoming.params },
      { sql: listings.past.sql, params: listings.past.params },
    ])

    const row = artistRows?.[0]
    if (!row) throw notFound('No artist with that slug')

    const summary = toArtistSummary(row)
    if (summary.listing_count < ARTIST_PAGE_THRESHOLD) {
      throw notFound('That artist has too few listings for a page of their own')
    }

    return Response.json({
      artist: summary,
      listings: (upcomingRows ?? []).slice(0, LISTINGS_PER_PAGE_VIEW).map(toListingSummary),
      past: (pastRows ?? []).slice(0, PAST_PER_PAGE_VIEW).map(toListingSummary),
    })
  })
  return withRoundTrips(response, session)
})
