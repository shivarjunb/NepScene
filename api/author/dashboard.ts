import { Hono } from 'hono'
import type { Env } from '../env'
import { badRequest } from '../lib/http'
import { numeric, rowsOf, text, withRoundTrips, writeSession } from '../lib/d1'
import { auditStatement } from '../lib/audit'
import { uniqueSlug } from '../lib/slug'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { loadEditableListing } from './access'

/**
 * The organizer dashboard (#34): everything one person has listed, what state
 * it is in, and whether anybody looked.
 *
 * **The scoping rule is the security boundary, and it is one WHERE clause.**
 * An organizer sees listings they created *or* that belong to an organization
 * they are a member of — the same rule `loadEditableListing` uses for a single
 * listing, expressed as a set rather than a lookup. Editors and admins are not
 * given a wider view here on purpose: this is somebody's own work, and the
 * screen for looking at everyone's is the moderation queue (#33), which says
 * what it is.
 */
export const dashboardRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const PAGE = 25
const MAX_PAGE = 50
const STATUSES = ['draft', 'pending_review', 'published', 'rejected', 'archived'] as const

/**
 * The AC is a dashboard that loads in under a second at 100 listings, and this
 * is what buys it: two statements in one batch, one round trip, with the view
 * counts summed in SQL rather than fetched per row. A hundred listings at one
 * stats query each is a hundred round trips, which is the shape of the problem
 * the whole read path exists to avoid (docs/ARCHITECTURE.md).
 */
const MINE = `(l.created_by = ?1 OR (l.organization_id IS NOT NULL AND l.organization_id IN (
                SELECT organization_id FROM organization_users WHERE user_id = ?1)))`

// ─── GET /api/author/dashboard ───────────────────────────────────────────────
dashboardRoutes.get('/dashboard', requirePermission('listing:edit_own'), async (c) => {
  const user = c.get('user')
  const url = new URL(c.req.url)

  const status = url.searchParams.get('status')
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    throw badRequest('invalid_status', 'That is not a status a listing can be in')
  }
  const query = (url.searchParams.get('q') ?? '').trim()
  const limit = Math.min(Number(url.searchParams.get('limit')) || PAGE, MAX_PAGE)
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)

  const session = writeSession(c.env)
  const [rows, counts] = await session.batch([
    c.env.DB.prepare(
      `SELECT l.id, l.slug, l.title, l.status, l.listing_type, l.starts_at,
              l.updated_at, l.published_at, l.rejection_reason,
              v.name AS venue_name,
              (SELECT COUNT(*) FROM listing_media m WHERE m.listing_id = l.id) AS media_count,
              COALESCE((SELECT SUM(views) FROM listing_stats s WHERE s.listing_id = l.id), 0) AS views,
              COALESCE((SELECT SUM(clicks) FROM listing_stats s WHERE s.listing_id = l.id), 0) AS clicks
         FROM listings l
         LEFT JOIN venues v ON v.id = l.venue_id
        WHERE ${MINE}
          AND (?2 IS NULL OR l.status = ?2)
          -- Title only. An organizer searching their own listings is looking
          -- for one they named, and widening this to descriptions turns an
          -- exact recall into a list of near misses.
          AND (?3 = '' OR l.title LIKE ?4 ESCAPE '\\')
        ORDER BY l.updated_at DESC
        LIMIT ?5 OFFSET ?6`,
    ).bind(
      user.id, status, query,
      `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`,
      limit + 1, offset,
    ),
    // Counts for every state, unfiltered by the current tab: switching tabs
    // must not change the numbers on the other tabs.
    c.env.DB.prepare(
      `SELECT l.status, COUNT(*) AS n FROM listings l WHERE ${MINE} GROUP BY l.status`,
    ).bind(user.id),
  ])

  const page = rowsOf<Record<string, unknown>>(rows)
  const hasMore = page.length > limit
  const data = hasMore ? page.slice(0, limit) : page

  return withRoundTrips(Response.json({
    data: data.map((row) => ({
      id: text(row.id), slug: text(row.slug), title: text(row.title) ?? '',
      status: text(row.status), listing_type: text(row.listing_type),
      starts_at: text(row.starts_at), updated_at: text(row.updated_at),
      published_at: text(row.published_at),
      rejection_reason: text(row.rejection_reason),
      venue_name: text(row.venue_name),
      media_count: Number(row.media_count ?? 0),
      views: Number(row.views ?? 0),
      clicks: Number(row.clicks ?? 0),
    })),
    counts: Object.fromEntries(
      rowsOf<{ status: string; n: number }>(counts).map((row) => [row.status, Number(row.n)]),
    ),
    page: { limit, offset, has_more: hasMore },
  }), session)
})

// ─── POST /api/author/listings/:id/duplicate ─────────────────────────────────
/**
 * Copy a listing into a new draft.
 *
 * This is the quick action that earns its place: the same festival next year,
 * the same night at the same venue with a different band. Retyping a venue, a
 * category set and a description that already exist is how a second listing
 * ends up thinner than the first — and a thin listing is what the duplicate
 * detector in #33 then has to work out is not a duplicate.
 *
 * **What does not come across is as considered as what does.** The copy starts
 * as a `draft`, unpublished and never reviewed, so duplicating cannot be a way
 * around the state machine. Its date is cleared: a copy with the original's
 * date is a copy that will be submitted with last year's date on it, and the
 * validator catching that is worse than the wizard asking for it. Media is not
 * copied either — the R2 objects belong to the original, and a shared object
 * with two owners breaks whichever is deleted second (#25). The author uploads
 * the new poster, which is the one thing they certainly have.
 */
dashboardRoutes.post('/listings/:id/duplicate', requirePermission('listing:create'), async (c) => {
  const user = c.get('user')
  const original = await loadEditableListing(c.env, user.id, user.role, c.req.param('id'))

  const session = writeSession(c.env)
  const [rows, slugs] = await session.batch([
    c.env.DB.prepare('SELECT * FROM listings WHERE id = ?1').bind(original.id),
    // Every slug the copy's name could collide with, in the same trip.
    c.env.DB.prepare('SELECT slug FROM listings WHERE slug LIKE ?1')
      .bind(`${original.slug.slice(0, 70)}%`),
  ])

  const row = rowsOf<Record<string, unknown>>(rows)[0]
  if (!row) throw badRequest('not_found', 'No such listing')

  const title = `${text(row.title) ?? 'Untitled'} (copy)`
  const taken = new Set(rowsOf<{ slug: string }>(slugs).map((entry) => entry.slug))
  const slug = await uniqueSlug(title, async (candidate) => taken.has(candidate))

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await session.batch([
    c.env.DB.prepare(
      `INSERT INTO listings (
         id, slug, title, summary, description, listing_type, source, status,
         organization_id, venue_id, venue_room, starts_at, ends_at, is_all_day,
         timezone, external_url, offer_url, offer_provider,
         location_lat, location_lng, map_popup_config,
         created_by, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'organizer', 'draft', ?7, ?8, ?9,
                 NULL, NULL, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19)`,
    ).bind(
      id, slug, title, text(row.summary), text(row.description),
      text(row.listing_type), text(row.organization_id), text(row.venue_id),
      text(row.venue_room), row.is_all_day === 1 ? 1 : 0,
      text(row.timezone) ?? 'Asia/Kathmandu',
      text(row.external_url), text(row.offer_url), text(row.offer_provider),
      numeric(row.location_lat), numeric(row.location_lng),
      text(row.map_popup_config), user.id, now,
    ),
    c.env.DB.prepare(
      `INSERT INTO listing_categories (listing_id, category_id, is_primary)
       SELECT ?1, category_id, is_primary FROM listing_categories WHERE listing_id = ?2`,
    ).bind(id, original.id),
    c.env.DB.prepare(
      `INSERT INTO listing_tags (listing_id, tag_slug)
       SELECT ?1, tag_slug FROM listing_tags WHERE listing_id = ?2`,
    ).bind(id, original.id),
    c.env.DB.prepare(
      `INSERT INTO listing_artists (listing_id, artist_id, billing_order)
       SELECT ?1, artist_id, billing_order FROM listing_artists WHERE listing_id = ?2`,
    ).bind(id, original.id),
    auditStatement(c.env, {
      entityType: 'listing', entityId: id, action: 'duplicated',
      actorId: user.id, actorRole: user.role,
      details: { from: original.id, slug },
    }),
  ])

  return withRoundTrips(Response.json({ id, slug, status: 'draft' }, { status: 201 }), session)
})
