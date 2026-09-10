import { Hono } from 'hono'
import type { Env } from '../env'
import { readSession } from '../lib/d1'
import { withEdgeCache } from '../lib/cache'
import { notFound } from '../lib/http'
import { listingBySlugQuery, relatedListingsQuery, slugRedirectQuery } from './queries'
import { toListingDetail, toListingSummary } from './serialize'
import { FEED_PARAMS, fetchFeed, parseFeedFilters, withRoundTrips } from './shared'

export const listingRoutes = new Hono<{ Bindings: Env }>()

// ─── GET /api/catalog/listings ───────────────────────────────────────────────
listingRoutes.get('/listings', async (c) => {
  const filters = parseFeedFilters(new URL(c.req.url), { withSearch: false })
  const session = readSession(c.env)
  const response = await withEdgeCache(c, { params: FEED_PARAMS }, async () =>
    Response.json(await fetchFeed(session, filters)),
  )
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/listings/:slug ─────────────────────────────────────────
/**
 * The listing page's whole payload (#43): the record, and what to read next.
 *
 * Both statements go in one batch. The related query resolves the listing by
 * slug in a CTE of its own precisely so it does not have to wait for the
 * detail response to learn the venue and organizer ids — a page that costs two
 * sequential round trips from Kathmandu costs ~400ms before a byte is rendered.
 */
const RELATED_LIMIT = 6

listingRoutes.get('/listings/:slug', async (c) => {
  const slug = c.req.param('slug')
  const session = readSession(c.env)

  const response = await withEdgeCache(c, { params: [] }, async () => {
    const now = new Date().toISOString()
    const detail = listingBySlugQuery(slug)
    const related = relatedListingsQuery({ slug, limit: RELATED_LIMIT, now })

    const [detailRows, relatedRows] = await session.batch<Record<string, unknown>>([
      { sql: detail.sql, params: detail.params },
      { sql: related.sql, params: related.params },
    ])

    const row = detailRows?.[0]
    if (row) {
      return Response.json({
        ...toListingDetail(row),
        related: (relatedRows ?? []).map(toListingSummary),
      })
    }

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
