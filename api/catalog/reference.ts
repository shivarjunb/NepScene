import { Hono } from 'hono'
import type { Env } from '../env'
import { readSession } from '../lib/d1'
import { REFERENCE_TTL_SECONDS, withEdgeCache } from '../lib/cache'
import { buildFeedQuery, categoriesQuery, tagsQuery } from './queries'
import { toListingSummary } from './serialize'
import { withRoundTrips } from './shared'

export const referenceRoutes = new Hono<{ Bindings: Env }>()

const BOOTSTRAP_UPCOMING = 24
const BOOTSTRAP_FEATURED = 6
/** Enough to fill a chip row without turning the tail of the long tail into UI. */
const TAG_CLOUD_SIZE = 40

// ─── GET /api/catalog/categories ─────────────────────────────────────────────
referenceRoutes.get('/categories', async (c) => {
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

// ─── GET /api/catalog/tags ───────────────────────────────────────────────────
// The open half of the taxonomy. Unlike categories this list is not a contract
// — it is whatever authors have used lately — so it is ordered by how much is
// on, not by a curated sort order.
referenceRoutes.get('/tags', async (c) => {
  const session = readSession(c.env)
  const response = await withEdgeCache(
    c,
    { params: [], ttlSeconds: REFERENCE_TTL_SECONDS },
    async () => {
      const { sql, params } = tagsQuery(new Date().toISOString(), TAG_CLOUD_SIZE)
      const rows = await session.all<Record<string, unknown>>(sql, params)
      return Response.json({ data: rows })
    },
  )
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/bootstrap ──────────────────────────────────────────────
// Everything the homepage needs in one request. The WaahTickets SPA made five
// calls to render its first screen; on a 3G connection request count dominates.
referenceRoutes.get('/bootstrap', async (c) => {
  const session = readSession(c.env)
  const response = await withEdgeCache(c, { params: [] }, async () => {
    const now = new Date().toISOString()
    const categories = categoriesQuery(now)
    const upcoming = buildFeedQuery({ includePast: false, limit: BOOTSTRAP_UPCOMING, now })
    const featured = buildFeedQuery({
      includePast: false, featured: true, limit: BOOTSTRAP_FEATURED, now,
    })

    const [categoryRows, upcomingRows, featuredRows] = await session.batch<Record<string, unknown>>([
      { sql: categories.sql, params: categories.params },
      { sql: upcoming.sql, params: upcoming.params },
      { sql: featured.sql, params: featured.params },
    ])

    return Response.json({
      categories: categoryRows ?? [],
      upcoming: (upcomingRows ?? []).slice(0, BOOTSTRAP_UPCOMING).map(toListingSummary),
      featured: (featuredRows ?? []).slice(0, BOOTSTRAP_FEATURED).map(toListingSummary),
    })
  })
  return withRoundTrips(response, session)
})
