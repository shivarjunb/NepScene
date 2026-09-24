import { Hono } from 'hono'
import type { Env } from '../env'
import { rowsOf, withRoundTrips, writeSession } from '../lib/d1'
import { auditStatement } from '../lib/audit'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { ROLES } from '../identity/roles'
import { archiveFinishedListings } from '../author/archive'
import { adminUserRoutes } from './users'
import { adminOrganizationRoutes } from './organizations'
import { adminAuditRoutes, serialiseEntry } from './audit'
import { adminScrapeRoutes } from './scrapes'
import { SELECT_RUN, serialiseRun, type ScrapeRunRow } from '../scrapes/runs'

/**
 * The admin console's API (#28), at `/api/admin/*`.
 *
 * Everything here needs `user:manage`, which only an admin has. The console
 * is deliberately not a table browser: WaahTickets' admin was a generic grid
 * over thirty tables, and the cost of that was a 4,800-line component in
 * which no screen knew what it was for. Each route here answers one question
 * an administrator actually asks — who can do what, which organization is
 * whose, what happened, and is the housekeeping running. Listings keep
 * their own API (`/api/author/queue`), which the console's Moderation section
 * calls with `listing:moderate` so an editor can work it too.
 */
export const adminRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

adminRoutes.route('/', adminUserRoutes)
adminRoutes.route('/', adminOrganizationRoutes)
adminRoutes.route('/', adminAuditRoutes)
adminRoutes.route('/', adminScrapeRoutes)

const RECENT = 10
/** How many of the oldest waiting listings the overview puts in front of an admin. */
const WAITING = 5

// ─── GET /api/admin/overview ─────────────────────────────────────────────────
/**
 * The first screen: the numbers, what is waiting longest, how the last scrape
 * went, and what happened last. One batch — an overview that takes six round
 * trips from Kathmandu is an overview nobody opens twice.
 */
adminRoutes.get('/overview', requirePermission('user:manage'), async (c) => {
  const session = writeSession(c.env)
  const [users, listings, organizations, recent, waiting, scrape] = await session.batch([
    c.env.DB.prepare(
      `SELECT role, COUNT(*) AS n, SUM(is_active = 0) AS inactive FROM users GROUP BY role`,
    ),
    c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM listings GROUP BY status'),
    c.env.DB.prepare(
      'SELECT COUNT(*) AS total, SUM(is_verified) AS verified FROM organizations',
    ),
    c.env.DB.prepare(
      `SELECT a.id, a.entity_type, a.entity_id, a.action, a.actor_id, a.actor_role,
              a.details, a.created_at, actor.email AS actor_email,
              CASE a.entity_type
                WHEN 'listing' THEN l.title WHEN 'organization' THEN o.name
                WHEN 'user' THEN subject.email
              END AS entity_label,
              CASE a.entity_type
                WHEN 'listing' THEN l.slug WHEN 'organization' THEN o.slug
              END AS entity_slug
         FROM audit_log a
         LEFT JOIN users actor ON actor.id = a.actor_id
         LEFT JOIN listings l ON a.entity_type = 'listing' AND l.id = a.entity_id
         LEFT JOIN organizations o ON a.entity_type = 'organization' AND o.id = a.entity_id
         LEFT JOIN users subject ON a.entity_type = 'user' AND subject.id = a.entity_id
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ?1`,
    ).bind(RECENT),
    // The queue's head, oldest first — the same order the queue itself uses,
    // so "publish" here takes the listing the queue would have shown first.
    c.env.DB.prepare(
      `SELECT l.id, l.slug, l.title, l.source, l.starts_at, l.updated_at,
              v.name AS venue_name, o.name AS organization_name,
              l.suspected_duplicate_of IS NOT NULL AS has_duplicate
         FROM listings l
         LEFT JOIN venues v ON v.id = l.venue_id
         LEFT JOIN organizations o ON o.id = l.organization_id
        WHERE l.status = 'pending_review'
        ORDER BY l.updated_at ASC
        LIMIT ?1`,
    ).bind(WAITING),
    c.env.DB.prepare(`${SELECT_RUN} ORDER BY r.requested_at DESC LIMIT 1`),
  ])

  const byRole = Object.fromEntries(ROLES.map((role) => [role, { total: 0, inactive: 0 }]))
  for (const row of rowsOf<{ role: string; n: number; inactive: number | null }>(users)) {
    byRole[row.role] = { total: Number(row.n), inactive: Number(row.inactive ?? 0) }
  }
  const orgs = rowsOf<{ total: number; verified: number | null }>(organizations)[0]

  return withRoundTrips(Response.json({
    users: byRole,
    listings: Object.fromEntries(
      rowsOf<{ status: string; n: number }>(listings).map((row) => [row.status, Number(row.n)]),
    ),
    organizations: { total: Number(orgs?.total ?? 0), verified: Number(orgs?.verified ?? 0) },
    recent: rowsOf<Record<string, unknown>>(recent).map(serialiseEntry),
    waiting: rowsOf<Record<string, unknown> & { has_duplicate: number }>(waiting)
      .map((row) => ({ ...row, has_duplicate: Boolean(row.has_duplicate) })),
    last_scrape: rowsOf<ScrapeRunRow>(scrape)
      .map((row) => serialiseRun(row, c.env.GITHUB_REPOSITORY))[0] ?? null,
  }), session)
})

// ─── POST /api/admin/system/archive ──────────────────────────────────────────
/**
 * The nightly sweep, on demand. The cron runs it at midnight Kathmandu; this
 * is for the afternoon somebody notices the queue's "published" count still
 * describes last month, and would rather not wait. Recorded, because a sweep
 * that a person started is a thing a person can be asked about.
 */
adminRoutes.post('/system/archive', requirePermission('user:manage'), async (c) => {
  const actor = c.get('user')
  const result = await archiveFinishedListings(c.env)
  if (result.archived.length > 0) {
    await auditStatement(c.env, {
      entityType: 'listing', entityId: 'sweep', action: 'archived_on_demand',
      actorId: actor.id, actorRole: actor.role,
      details: { archived: result.archived.length },
    }).run()
  }
  return c.json({ archived: result.archived.length, scanned: result.scanned })
})
