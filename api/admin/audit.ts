import { Hono } from 'hono'
import type { Env } from '../env'
import { badRequest } from '../lib/http'
import { rowsOf, text, withRoundTrips, writeSession } from '../lib/d1'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { swallowed } from '../lib/observability'
import { page, paging } from './shared'

/**
 * The audit trail, readable (#20, #28).
 *
 * Every write that changes something a person could be asked about later has
 * been recorded since migration 0004; this is the first place anyone can read
 * it without a database client. Newest first, filtered by what and by whom.
 *
 * Each row is resolved to something a person can recognise — the actor's
 * email, the listing's title, the organization's name — in the same query,
 * with one LEFT JOIN per entity type. Resolving on the client would be a
 * request per row, which for the fifty rows on a page is the waterfall the
 * whole read path is built to avoid (docs/ARCHITECTURE.md).
 */
export const adminAuditRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const ENTITY_TYPES = ['listing', 'venue', 'organization', 'user', 'media'] as const

// ─── GET /api/admin/audit ────────────────────────────────────────────────────
adminAuditRoutes.get('/audit', requirePermission('user:manage'), async (c) => {
  const url = new URL(c.req.url)
  const entityType = url.searchParams.get('entity_type')
  if (entityType && !(ENTITY_TYPES as readonly string[]).includes(entityType)) {
    throw badRequest('invalid_entity_type', 'That is not something the audit log records')
  }
  const entityId = url.searchParams.get('entity_id')
  const actorId = url.searchParams.get('actor_id')
  const paged = paging(url)

  const session = writeSession(c.env)
  const [rows] = await session.batch([
    c.env.DB.prepare(
      `SELECT a.id, a.entity_type, a.entity_id, a.action, a.actor_id, a.actor_role,
              a.details, a.created_at,
              actor.email AS actor_email,
              CASE a.entity_type
                WHEN 'listing' THEN l.title
                WHEN 'venue' THEN v.name
                WHEN 'organization' THEN o.name
                WHEN 'user' THEN subject.email
              END AS entity_label,
              CASE a.entity_type
                WHEN 'listing' THEN l.slug
                WHEN 'venue' THEN v.slug
                WHEN 'organization' THEN o.slug
              END AS entity_slug
         FROM audit_log a
         LEFT JOIN users actor ON actor.id = a.actor_id
         LEFT JOIN listings l ON a.entity_type = 'listing' AND l.id = a.entity_id
         LEFT JOIN venues v ON a.entity_type = 'venue' AND v.id = a.entity_id
         LEFT JOIN organizations o ON a.entity_type = 'organization' AND o.id = a.entity_id
         LEFT JOIN users subject ON a.entity_type = 'user' AND subject.id = a.entity_id
        WHERE (?1 IS NULL OR a.entity_type = ?1)
          AND (?2 IS NULL OR a.entity_id = ?2)
          AND (?3 IS NULL OR a.actor_id = ?3)
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ?4 OFFSET ?5`,
    ).bind(entityType, entityId, actorId, paged.limit + 1, paged.offset),
  ])

  const listed = page(rowsOf<Record<string, unknown>>(rows), paged)
  return withRoundTrips(Response.json({
    data: listed.data.map(serialiseEntry), page: listed.page,
  }), session)
})

export function serialiseEntry(row: Record<string, unknown>) {
  let details: unknown = null
  if (typeof row.details === 'string') {
    try {
      details = JSON.parse(row.details)
    } catch (cause) {
      // Written by auditStatement as JSON.stringify output, so this cannot
      // happen for a row this code wrote; a hand-edited row still renders,
      // and the count says whether anyone is hand-editing the audit log.
      swallowed('audit_details_parse', cause, { id: String(row.id) })
      details = { raw: row.details }
    }
  }
  return {
    id: text(row.id),
    entity_type: text(row.entity_type), entity_id: text(row.entity_id),
    entity_label: text(row.entity_label), entity_slug: text(row.entity_slug),
    action: text(row.action),
    actor: row.actor_id
      ? { id: text(row.actor_id), email: text(row.actor_email), role: text(row.actor_role) }
      : null,
    details,
    created_at: text(row.created_at),
  }
}
