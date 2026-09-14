import { Hono } from 'hono'
import type { Env } from '../env'
import { badRequest } from '../lib/http'
import { rowsOf, text, withRoundTrips, writeSession } from '../lib/d1'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { changeRole, setActive } from '../identity/manage'
import { isRole, ROLES } from '../identity/roles'
import { page, paging, readJson, search } from './shared'

/**
 * Accounts, for the person who administers them (#28).
 *
 * The list carries everything a decision needs — how the account signs in,
 * whether it has ever been used, what it has written — so promoting someone
 * or switching them off is one screen and not a lookup in three. The listing
 * count is a correlated subquery answered from `idx_listings_created_by`
 * (migration 0014): a join and a GROUP BY over every listing costs more for a
 * page of twenty-five than twenty-five index hits do.
 */
export const adminUserRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

// ─── GET /api/admin/users ────────────────────────────────────────────────────
adminUserRoutes.get('/users', requirePermission('user:manage'), async (c) => {
  const url = new URL(c.req.url)
  const { query, pattern } = search(url)
  const role = url.searchParams.get('role')
  if (role && !isRole(role)) throw badRequest('invalid_role', 'That is not a role')
  const paged = paging(url)

  const session = writeSession(c.env)
  const [rows, counts] = await session.batch([
    c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.role, u.is_active, u.email_verified,
              u.password_hash IS NOT NULL AS has_password,
              u.google_sub IS NOT NULL AS has_google,
              u.last_login_at, u.created_at,
              (SELECT COUNT(*) FROM listings l WHERE l.created_by = u.id) AS listing_count,
              (SELECT COUNT(*) FROM organization_users ou WHERE ou.user_id = u.id) AS organization_count
         FROM users u
        WHERE (?1 IS NULL OR u.role = ?1)
          AND (?2 = '' OR u.email LIKE ?3 ESCAPE '\\' OR u.name LIKE ?3 ESCAPE '\\')
        ORDER BY u.created_at DESC
        LIMIT ?4 OFFSET ?5`,
    ).bind(role, query, pattern, paged.limit + 1, paged.offset),
    // Unfiltered by the search: the counts say how many of each role exist,
    // which is the number a "who can moderate?" question wants.
    c.env.DB.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role'),
  ])

  const listed = page(rowsOf<Record<string, unknown>>(rows), paged)
  return withRoundTrips(Response.json({
    data: listed.data.map(serialiseUser),
    counts: Object.fromEntries([
      ...ROLES.map((r) => [r, 0]),
      ...rowsOf<{ role: string; n: number }>(counts).map((row) => [row.role, Number(row.n)]),
    ]),
    page: listed.page,
  }), session)
})

// ─── PATCH /api/admin/users/:id ──────────────────────────────────────────────
/**
 * `{ role }`, `{ is_active }`, or both. Each is applied through the same
 * function the older `/api/auth/users/:id/role` uses, so the console cannot do
 * anything that endpoint refuses.
 */
adminUserRoutes.patch('/users/:id', requirePermission('user:manage'), async (c) => {
  const actor = c.get('user')
  const id = c.req.param('id')
  const body = await readJson(c.req.raw)

  if (body.role === undefined && body.is_active === undefined) {
    throw badRequest('nothing_to_change', 'Send a role, is_active, or both')
  }
  if (body.role !== undefined && !isRole(body.role)) {
    throw badRequest('invalid_role', 'role must be visitor, organizer, editor or admin')
  }
  if (body.is_active !== undefined && typeof body.is_active !== 'boolean') {
    throw badRequest('invalid_active', 'is_active must be true or false')
  }

  if (isRole(body.role)) await changeRole(c.env, actor, id, body.role)
  if (typeof body.is_active === 'boolean') await setActive(c.env, actor, id, body.is_active)

  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.is_active, u.email_verified,
            u.password_hash IS NOT NULL AS has_password,
            u.google_sub IS NOT NULL AS has_google,
            u.last_login_at, u.created_at,
            (SELECT COUNT(*) FROM listings l WHERE l.created_by = u.id) AS listing_count,
            (SELECT COUNT(*) FROM organization_users ou WHERE ou.user_id = u.id) AS organization_count
       FROM users u WHERE u.id = ?1`,
  ).bind(id).first<Record<string, unknown>>()
  return c.json(serialiseUser(row!))
})

export function serialiseUser(row: Record<string, unknown>) {
  return {
    id: text(row.id), email: text(row.email), name: text(row.name),
    role: text(row.role),
    is_active: row.is_active === 1,
    email_verified: row.email_verified === 1,
    has_password: row.has_password === 1,
    has_google: row.has_google === 1,
    last_login_at: text(row.last_login_at),
    created_at: text(row.created_at),
    listing_count: Number(row.listing_count ?? 0),
    organization_count: Number(row.organization_count ?? 0),
  }
}
