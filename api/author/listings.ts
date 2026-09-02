import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest, notFound } from '../lib/http'
import { auditStatement, recordAudit } from '../lib/audit'
import { bumpCatalogVersion } from '../lib/cache'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { can, type Permission, type Role } from '../identity/roles'

/**
 * The publication workflow's API surface (#20's state transitions, #23's
 * cache invalidation). The moderation *queue* — the list an editor works
 * through — is #33; this is the verb underneath it.
 */
export const authorListingRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

type Listing = { id: string; slug: string; status: string; created_by: string | null; organization_id: string | null }

export async function loadEditableListing(
  env: Env, userId: string, role: Role, listingId: string,
): Promise<Listing> {
  const listing = await env.DB.prepare(
    'SELECT id, slug, status, created_by, organization_id FROM listings WHERE id = ?1',
  ).bind(listingId).first<Listing>()
  if (!listing) throw notFound('No such listing')

  if (can(role, 'listing:edit_any')) return listing
  if (listing.created_by === userId) return listing

  if (listing.organization_id) {
    const membership = await env.DB.prepare(
      'SELECT 1 AS ok FROM organization_users WHERE organization_id = ?1 AND user_id = ?2',
    ).bind(listing.organization_id, userId).first<{ ok: number }>()
    if (membership) return listing
  }

  throw new ApiError(403, 'forbidden', 'That listing belongs to someone else')
}

/**
 * The publication state machine (#20). `from` is not decoration: it goes into
 * the UPDATE's WHERE clause, so the database refuses an illegal transition and
 * two concurrent moderators cannot both win. See migration 0004 for why this is
 * not a trigger.
 *
 *   draft ──> pending_review ──> published ──> archived
 *     ^            │  ^              │
 *     └── rejected ┘  └──────────────┘
 *
 * draft → published is absent on purpose: everything public has been reviewed.
 */
type Transition = { to: string; from: string[]; permission: Permission; action: string }

const TRANSITIONS: Record<string, Transition> = {
  submit:    { to: 'pending_review', from: ['draft', 'rejected'], permission: 'listing:edit_own', action: 'submitted_for_review' },
  publish:   { to: 'published',      from: ['pending_review'],    permission: 'listing:publish',  action: 'published' },
  reject:    { to: 'rejected',       from: ['pending_review'],    permission: 'listing:moderate', action: 'rejected' },
  archive:   { to: 'archived',       from: ['draft', 'published'], permission: 'listing:publish', action: 'archived' },
  unpublish: { to: 'draft',          from: ['pending_review', 'published', 'rejected', 'archived'], permission: 'listing:publish', action: 'unpublished' },
}

for (const [verb, transition] of Object.entries(TRANSITIONS)) {
  authorListingRoutes.post(
    `/listings/:id/${verb}`,
    requirePermission(transition.permission),
    async (c) => {
      const user = c.get('user')
      const listing = await loadEditableListing(c.env, user.id, user.role, c.req.param('id'))

      if (listing.status === transition.to) {
        throw badRequest('already_in_state', `That listing is already ${transition.to}`)
      }

      const now = new Date().toISOString()
      const legalFrom = transition.from.map((_, i) => `?${i + 4}`).join(', ')

      // The WHERE clause is the constraint: if the listing is not in a state
      // this transition may start from, nothing is updated and nothing is
      // audited. It also makes the move atomic against a concurrent one.
      const updated = await c.env.DB.prepare(
        `UPDATE listings
            SET status = ?1,
                published_at = CASE WHEN ?1 = 'published' THEN COALESCE(published_at, ?2) ELSE published_at END,
                updated_at = ?2
          WHERE id = ?3 AND status IN (${legalFrom})`,
      ).bind(transition.to, now, listing.id, ...transition.from).run()

      if ((updated.meta.changes ?? 0) === 0) {
        throw badRequest(
          'invalid_transition',
          `A listing cannot go from ${listing.status} to ${transition.to}`,
        )
      }

      await recordAudit(c.env, {
        entityType: 'listing', entityId: listing.id, action: transition.action,
        actorId: user.id, actorRole: user.role,
        details: { from: listing.status, to: transition.to },
      })

      // Publishing changes what the public read path should return, so every
      // cached catalog key is invalidated by bumping the version stamp.
      c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

      return c.json({ id: listing.id, slug: listing.slug, status: transition.to })
    },
  )
}

// ─── DELETE /api/author/listings/:id ─────────────────────────────────────────
authorListingRoutes.delete('/listings/:id', requirePermission('listing:edit_own'), async (c) => {
  const user = c.get('user')
  const listing = await loadEditableListing(c.env, user.id, user.role, c.req.param('id'))

  // Read the keys before the rows go: ON DELETE CASCADE removes the index
  // rows, and without this the bytes in R2 would be orphaned with no way left
  // to find them.
  const media = await c.env.DB.prepare(
    'SELECT r2_key FROM listing_media WHERE listing_id = ?1',
  ).bind(listing.id).all<{ r2_key: string }>()

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM listings WHERE id = ?1').bind(listing.id),
    auditStatement(c.env, {
      entityType: 'listing', entityId: listing.id, action: 'deleted',
      actorId: user.id, actorRole: user.role,
      details: { slug: listing.slug, media_objects: media.results.length },
    }),
  ])

  const keys = media.results.map((row) => row.r2_key)
  if (keys.length > 0) c.executionCtx.waitUntil(c.env.MEDIA.delete(keys))
  c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

  return c.json({ ok: true, deleted_media: keys.length })
})
