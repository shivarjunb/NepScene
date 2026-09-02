import { Hono } from 'hono'
import type { Env } from '../env'
import { readSession } from '../lib/d1'
import { REFERENCE_TTL_SECONDS, withEdgeCache } from '../lib/cache'
import { buildFeedQuery, categoriesQuery } from './queries'
import { toListingSummary } from './serialize'
import { withRoundTrips } from './shared'

export const referenceRoutes = new Hono<{ Bindings: Env }>()

const BOOTSTRAP_UPCOMING = 24
const BOOTSTRAP_FEATURED = 6

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
