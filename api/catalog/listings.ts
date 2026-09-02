import { Hono } from 'hono'
import type { Env } from '../env'
import { readSession } from '../lib/d1'
import { withEdgeCache } from '../lib/cache'
import { notFound } from '../lib/http'
import { listingBySlugQuery, slugRedirectQuery } from './queries'
import { toListingDetail } from './serialize'
import {
  FEED_PARAMS, SEARCH_PARAMS, fetchFeed, parseCentre, parseFeedFilters, withRoundTrips,
} from './shared'

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

// ─── GET /api/catalog/search ─────────────────────────────────────────────────
listingRoutes.get('/search', async (c) => {
  const url = new URL(c.req.url)
  const filters = parseFeedFilters(url, { withSearch: true })
  const centre = parseCentre(url)

  const session = readSession(c.env)
  const response = await withEdgeCache(c, { params: SEARCH_PARAMS }, async () =>
    Response.json(await fetchFeed(session, filters, centre)),
  )
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/listings/:slug ─────────────────────────────────────────
listingRoutes.get('/listings/:slug', async (c) => {
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
