import { Hono } from 'hono'
import type { Env } from '../env'
import { badRequest } from '../lib/http'
import { rowsOf, withRoundTrips, writeSession } from '../lib/d1'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { page, paging, search } from './shared'

/**
 * Every listing, whatever its state (the console's All listings section).
 *
 * The queue answers "what is waiting, oldest first"; this answers "where is
 * that listing" — the one somebody emailed about, the one a scraper imported
 * twice, the one that was archived last week and should not have been. So it
 * searches titles and slugs across every state at once, newest change first,
 * and the actions on a row are the queue's own (`/api/author/queue/actions`),
 * so there is still one code path that changes a listing's state.
 *
 * `listing:moderate`, not `user:manage`: an editor needs this as much as an
 * admin does.
 */
export const adminListingRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const STATUSES = ['draft', 'pending_review', 'published', 'rejected', 'archived'] as const
const SOURCES = ['organizer', 'submission', 'import', 'editorial'] as const

// ─── GET /api/admin/listings ─────────────────────────────────────────────────
adminListingRoutes.get('/listings', requirePermission('listing:moderate'), async (c) => {
  const url = new URL(c.req.url)
  const { query, pattern } = search(url)
  const paged = paging(url)
  const status = url.searchParams.get('status') || null
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    throw badRequest('invalid_status', 'That is not a state a listing can be in')
  }
  const source = url.searchParams.get('source') || null
  if (source && !(SOURCES as readonly string[]).includes(source)) {
    throw badRequest('invalid_source', 'That is not a source a listing can have')
  }

  // The same search and source filter for the rows and for the counts, so a
  // chip that says "Archived 3" means three archived listings match the box.
  const matches = `(?1 = '' OR l.title LIKE ?2 ESCAPE '\\' OR l.slug LIKE ?2 ESCAPE '\\')
                   AND (?3 IS NULL OR l.source = ?3)`

  const session = writeSession(c.env)
  const [rows, counts] = await session.batch([
    c.env.DB.prepare(
      `SELECT l.id, l.slug, l.title, l.status, l.source, l.listing_type,
              l.starts_at, l.updated_at, l.created_at,
              v.name AS venue_name, v.slug AS venue_slug,
              o.name AS organization_name,
              u.email AS author_email
         FROM listings l
         LEFT JOIN venues v ON v.id = l.venue_id
         LEFT JOIN organizations o ON o.id = l.organization_id
         LEFT JOIN users u ON u.id = l.created_by
        WHERE ${matches} AND (?4 IS NULL OR l.status = ?4)
        ORDER BY l.updated_at DESC, l.id
        LIMIT ?5 OFFSET ?6`,
    ).bind(query, pattern, source, status, paged.limit + 1, paged.offset),
    c.env.DB.prepare(
      `SELECT l.status, COUNT(*) AS n FROM listings l WHERE ${matches} GROUP BY l.status`,
    ).bind(query, pattern, source),
  ])

  const listed = page(rowsOf<Record<string, unknown>>(rows), paged)
  return withRoundTrips(Response.json({
    data: listed.data,
    counts: {
      ...Object.fromEntries(STATUSES.map((s) => [s, 0])),
      ...Object.fromEntries(rowsOf<{ status: string; n: number }>(counts).map((row) => [row.status, Number(row.n)])),
    },
    page: listed.page,
  }), session)
})
