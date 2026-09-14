import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest } from '../lib/http'
import { rowsOf, text, withRoundTrips, writeSession } from '../lib/d1'
import { auditStatement } from '../lib/audit'
import { bumpCatalogVersion } from '../lib/cache'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { page, paging, readJson, search } from './shared'

/**
 * Organizations and who may author for them (#28).
 *
 * Membership is the thing an administrator actually changes here. An
 * organizer who cannot list under their organization's name ends up listing
 * under their own, and the organizer page then shows half their events — so
 * "add this person to that organization" is the request that arrives most,
 * and it is a form on the organization rather than a row in a join table.
 *
 * Verification is the other switch. It is a public mark (the organizer page
 * and every listing card show it), so flipping it bumps the catalogue version
 * the same way publishing does.
 */
export const adminOrganizationRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const ORG_ROLES = ['owner', 'manager', 'member'] as const

const ORGANIZATION = `
  SELECT o.id, o.slug, o.name, o.contact_email, o.website_url, o.is_verified, o.created_at,
         (SELECT COUNT(*) FROM organization_users ou WHERE ou.organization_id = o.id) AS member_count,
         (SELECT COUNT(*) FROM listings l WHERE l.organization_id = o.id) AS listing_count,
         (SELECT COUNT(*) FROM listings l WHERE l.organization_id = o.id AND l.status = 'published') AS published_count
    FROM organizations o`

const MEMBERS = `
  SELECT ou.user_id, ou.org_role, ou.created_at, u.email, u.name, u.role, u.is_active
    FROM organization_users ou
    JOIN users u ON u.id = ou.user_id
   WHERE ou.organization_id = ?1
   ORDER BY CASE ou.org_role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.email`

// ─── GET /api/admin/organizations ────────────────────────────────────────────
adminOrganizationRoutes.get('/organizations', requirePermission('user:manage'), async (c) => {
  const url = new URL(c.req.url)
  const { query, pattern } = search(url)
  const paged = paging(url)

  const session = writeSession(c.env)
  const [rows] = await session.batch([
    c.env.DB.prepare(
      `${ORGANIZATION}
        WHERE (?1 = '' OR o.name LIKE ?2 ESCAPE '\\' OR o.slug LIKE ?2 ESCAPE '\\')
        ORDER BY o.name COLLATE NOCASE
        LIMIT ?3 OFFSET ?4`,
    ).bind(query, pattern, paged.limit + 1, paged.offset),
  ])

  const listed = page(rowsOf<Record<string, unknown>>(rows), paged)
  return withRoundTrips(Response.json({
    data: listed.data.map(serialiseOrganization), page: listed.page,
  }), session)
})

// ─── GET /api/admin/organizations/:id ────────────────────────────────────────
adminOrganizationRoutes.get('/organizations/:id', requirePermission('user:manage'), async (c) => {
  const id = c.req.param('id')
  const session = writeSession(c.env)
  const [org, members] = await session.batch([
    c.env.DB.prepare(`${ORGANIZATION} WHERE o.id = ?1`).bind(id),
    c.env.DB.prepare(MEMBERS).bind(id),
  ])
  const row = rowsOf<Record<string, unknown>>(org)[0]
  if (!row) throw new ApiError(404, 'not_found', 'No such organization')

  return withRoundTrips(Response.json({
    ...serialiseOrganization(row),
    members: rowsOf<Record<string, unknown>>(members).map(serialiseMember),
  }), session)
})

// ─── PATCH /api/admin/organizations/:id ──────────────────────────────────────
adminOrganizationRoutes.patch('/organizations/:id', requirePermission('user:manage'), async (c) => {
  const actor = c.get('user')
  const id = c.req.param('id')
  const body = await readJson(c.req.raw)
  if (typeof body.is_verified !== 'boolean') {
    throw badRequest('invalid_verified', 'is_verified must be true or false')
  }

  const current = await c.env.DB.prepare('SELECT is_verified FROM organizations WHERE id = ?1')
    .bind(id).first<{ is_verified: number }>()
  if (!current) throw new ApiError(404, 'not_found', 'No such organization')

  if ((current.is_verified === 1) !== body.is_verified) {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE organizations SET is_verified = ?1, updated_at = ?2 WHERE id = ?3')
        .bind(body.is_verified ? 1 : 0, new Date().toISOString(), id),
      auditStatement(c.env, {
        entityType: 'organization', entityId: id,
        action: body.is_verified ? 'verified' : 'unverified',
        actorId: actor.id, actorRole: actor.role,
      }),
    ])
    await bumpCatalogVersion(c.env)
  }

  return c.json({ id, is_verified: body.is_verified })
})

// ─── PUT /api/admin/organizations/:id/members ────────────────────────────────
/**
 * Add by email, not by user id: the administrator has the email in the
 * message that asked for this, and looking up the id first is a screen the
 * console would otherwise have to grow. An upsert, so the same call changes
 * an existing member's org_role.
 */
adminOrganizationRoutes.put('/organizations/:id/members', requirePermission('user:manage'), async (c) => {
  const actor = c.get('user')
  const id = c.req.param('id')
  const body = await readJson(c.req.raw)
  const email = String(body.email ?? '').trim().toLowerCase()
  const orgRole = body.org_role ?? 'member'

  if (!email) throw badRequest('invalid_email', 'Say whose account to add')
  if (!(ORG_ROLES as readonly unknown[]).includes(orgRole)) {
    throw badRequest('invalid_org_role', 'org_role must be owner, manager or member')
  }

  const [org, user] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id FROM organizations WHERE id = ?1').bind(id),
    c.env.DB.prepare('SELECT id, role FROM users WHERE email = ?1').bind(email),
  ])
  if (!rowsOf(org)[0]) throw new ApiError(404, 'not_found', 'No such organization')
  const subject = rowsOf<{ id: string; role: string }>(user)[0]
  if (!subject) throw new ApiError(404, 'no_such_user', 'No account has that email address')

  const now = new Date().toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO organization_users (organization_id, user_id, org_role, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(organization_id, user_id) DO UPDATE SET org_role = excluded.org_role`,
    ).bind(id, subject.id, orgRole, now),
    // A visitor added to an organization is an organizer: membership is
    // pointless without the permission to use it, and asking for two calls
    // is how accounts end up half set up.
    c.env.DB.prepare(
      `UPDATE users SET role = 'organizer', updated_at = ?1 WHERE id = ?2 AND role = 'visitor'`,
    ).bind(now, subject.id),
    auditStatement(c.env, {
      entityType: 'organization', entityId: id, action: 'member_set',
      actorId: actor.id, actorRole: actor.role,
      details: { user_id: subject.id, email, org_role: orgRole, promoted: subject.role === 'visitor' },
    }),
  ])

  const members = await c.env.DB.prepare(MEMBERS).bind(id).all<Record<string, unknown>>()
  return c.json({ members: rowsOf<Record<string, unknown>>(members).map(serialiseMember) })
})

// ─── DELETE /api/admin/organizations/:id/members/:userId ─────────────────────
adminOrganizationRoutes.delete('/organizations/:id/members/:userId', requirePermission('user:manage'), async (c) => {
  const actor = c.get('user')
  const id = c.req.param('id')
  const userId = c.req.param('userId')

  // Checked first rather than read off `meta.changes`: the audit row rides in
  // the same batch as the delete, and a batch that deletes nothing must not
  // record that something was removed.
  const member = await c.env.DB.prepare(
    'SELECT 1 FROM organization_users WHERE organization_id = ?1 AND user_id = ?2',
  ).bind(id, userId).first()
  if (!member) throw new ApiError(404, 'not_found', 'Not a member')

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM organization_users WHERE organization_id = ?1 AND user_id = ?2')
      .bind(id, userId),
    auditStatement(c.env, {
      entityType: 'organization', entityId: id, action: 'member_removed',
      actorId: actor.id, actorRole: actor.role, details: { user_id: userId },
    }),
  ])

  // The membership is gone; the person's role is not. They may still author
  // under their own name, and taking that away is a separate decision.
  const members = await c.env.DB.prepare(MEMBERS).bind(id).all<Record<string, unknown>>()
  return c.json({ members: rowsOf<Record<string, unknown>>(members).map(serialiseMember) })
})

function serialiseOrganization(row: Record<string, unknown>) {
  return {
    id: text(row.id), slug: text(row.slug), name: text(row.name) ?? '',
    contact_email: text(row.contact_email), website_url: text(row.website_url),
    is_verified: row.is_verified === 1,
    created_at: text(row.created_at),
    member_count: Number(row.member_count ?? 0),
    listing_count: Number(row.listing_count ?? 0),
    published_count: Number(row.published_count ?? 0),
  }
}

function serialiseMember(row: Record<string, unknown>) {
  return {
    user_id: text(row.user_id), email: text(row.email), name: text(row.name),
    role: text(row.role), org_role: text(row.org_role),
    is_active: row.is_active === 1, since: text(row.created_at),
  }
}
