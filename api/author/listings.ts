import { Hono } from 'hono'
import type { Env } from '../env'
import { badRequest } from '../lib/http'
import { auditStatement, recordAudit } from '../lib/audit'
import { bumpCatalogVersion } from '../lib/cache'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import type { Permission } from '../identity/roles'
import { loadEditableListing } from './access'
import { validateForSubmission } from './write'
import { detectDuplicate } from './duplicates'
import { duplicateMessage } from './listingMatch'

/**
 * The publication workflow's API surface (#20's state transitions, #23's cache
 * invalidation, #33's reasons and duplicate flags). The moderation *queue* —
 * the list an editor works through — is `moderation.ts`; these are the verbs
 * underneath it, and they are also what the wizard calls directly, so they
 * cannot assume a moderator is on the other end.
 */
export const authorListingRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

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
export type Transition = {
  to: string; from: string[]; permission: Permission; action: string
  /** A move the author must justify to the person it lands on (#33). */
  needsReason?: boolean
}

export const TRANSITIONS: Record<string, Transition> = {
  submit:    { to: 'pending_review', from: ['draft', 'rejected'], permission: 'listing:edit_own', action: 'submitted_for_review' },
  publish:   { to: 'published',      from: ['pending_review'],    permission: 'listing:publish',  action: 'published' },
  reject:    { to: 'rejected',       from: ['pending_review'],    permission: 'listing:moderate', action: 'rejected', needsReason: true },
  archive:   { to: 'archived',       from: ['draft', 'published'], permission: 'listing:publish', action: 'archived' },
  unpublish: { to: 'draft',          from: ['pending_review', 'published', 'rejected', 'archived'], permission: 'listing:publish', action: 'unpublished' },
}

/**
 * A rejection must say why, and the check is here rather than in the UI.
 *
 * The criterion is that an author is told *why* on rejection, and a reason
 * that a client may omit is a reason that will be omitted — by the bulk
 * action, by a script, by the next client. Refusing the transition is the only
 * version of this rule that holds. The floor is deliberately low: it exists to
 * stop "no" and "spam", not to make editors write essays.
 */
const MIN_REASON = 10
const MAX_REASON = 1000

export function readReason(body: unknown): string {
  const raw = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>).reason
    : undefined
  const reason = typeof raw === 'string' ? raw.trim() : ''
  if (reason.length < MIN_REASON) {
    throw badRequest(
      'reason_required',
      'Say why, in a sentence the author can act on — they see this verbatim',
    )
  }
  return reason.slice(0, MAX_REASON)
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

      const reason = transition.needsReason
        ? readReason(await c.req.json().catch(() => null))
        : null

      // Where the rules finally bite (#30). Everything up to here accepts a
      // half-written listing, because that is what a draft is; leaving the
      // catalogue is the moment it has to be complete. The errors come back
      // per field so the wizard can send the author to the step that is wrong
      // rather than to a paragraph of prose.
      if (verb === 'submit') {
        const errors = await validateForSubmission(c.env, listing.id)
        if (errors.length > 0) {
          return c.json({
            error: {
              code: 'incomplete_listing',
              message: 'Some things still need filling in before this can be reviewed',
              fields: errors,
            },
          }, 400)
        }
      }

      /**
       * Duplicate detection runs on submission and nowhere else (#33). The
       * same festival submitted by three people is the likeliest way an open
       * catalogue becomes useless, and submission is both the moment it is
       * cheapest to catch and the moment the answer is worth most — the
       * listing has just stopped being private.
       *
       * It **flags rather than refuses**, unlike the venue check in
       * `venues.ts`. The asymmetry is deliberate and it is about who is next.
       * A duplicate venue is created by the author, seen by nobody, and merged
       * by nobody; refusing it is the only thing that keeps it out. A
       * duplicate listing goes straight to a moderator who is about to look at
       * both — so the flag has a reader, and refusing a genuine second event
       * that merely resembles the first would be worse than showing an editor
       * a warning they can dismiss.
       */
      const duplicate = verb === 'submit'
        ? await detectDuplicate(c.env, listing.id)
        : null

      const now = new Date().toISOString()
      // The legal states start after the six fixed parameters below. Numbering
      // them from the length of that prefix rather than from a literal is what
      // stops a seventh parameter silently colliding with the first of these.
      const FIXED_PARAMS = 6
      const legalFrom = transition.from
        .map((_, i) => `?${i + FIXED_PARAMS + 1}`).join(', ')

      // The WHERE clause is the constraint: if the listing is not in a state
      // this transition may start from, nothing is updated and nothing is
      // audited. It also makes the move atomic against a concurrent one.
      const updated = await c.env.DB.prepare(
        `UPDATE listings
            SET status = ?1,
                published_at = CASE WHEN ?1 = 'published' THEN COALESCE(published_at, ?2) ELSE published_at END,
                -- The reason is written by a rejection and cleared by every
                -- other move. An author resubmitting needs to know what to fix
                -- now; the argument from three months ago is the audit log's
                -- job, and leaving it on the row would show a published
                -- listing the note that came back with it once.
                rejection_reason = CASE WHEN ?1 = 'rejected' THEN ?4 ELSE NULL END,
                suspected_duplicate_of = ?5,
                duplicate_score = ?6,
                updated_at = ?2
          WHERE id = ?3 AND status IN (${legalFrom})`,
      ).bind(
        transition.to, now, listing.id, reason,
        // Only a submission has an opinion about duplicates. Every other verb
        // writes what it found, which is nothing, and clearing the flag on the
        // way out of the queue is correct: whatever the moderator decided, the
        // question has been answered.
        duplicate?.id ?? null, duplicate?.score ?? null,
        ...transition.from,
      ).run()

      if ((updated.meta.changes ?? 0) === 0) {
        throw badRequest(
          'invalid_transition',
          `A listing cannot go from ${listing.status} to ${transition.to}`,
        )
      }

      await recordAudit(c.env, {
        entityType: 'listing', entityId: listing.id, action: transition.action,
        actorId: user.id, actorRole: user.role,
        details: {
          from: listing.status, to: transition.to,
          reason: reason ?? undefined,
          suspected_duplicate_of: duplicate?.id,
          duplicate_score: duplicate?.score,
        },
      })

      // Publishing changes what the public read path should return, so every
      // cached catalog key is invalidated by bumping the version stamp.
      c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

      return c.json({
        id: listing.id, slug: listing.slug, status: transition.to,
        // The author is told at once, in the same breath as "sent for review",
        // rather than finding out days later through a rejection. Most of the
        // time they know something the detector does not and can say so; the
        // rest of the time they have just been saved a wasted submission.
        duplicate: duplicate
          ? {
              id: duplicate.id, slug: duplicate.slug, title: duplicate.title,
              score: duplicate.score, message: duplicateMessage(duplicate),
            }
          : null,
      })
    },
  )
}

// ─── DELETE /api/author/listings/:id ─────────────────────────────────────────
authorListingRoutes.delete('/listings/:id', requirePermission('listing:edit_own'), async (c) => {
  const user = c.get('user')
  const listing = await loadEditableListing(c.env, user.id, user.role, c.req.param('id'))

  // Read the keys before the rows go: ON DELETE CASCADE removes the index
  // rows, and without this the bytes in R2 would be orphaned with no way left
  // to find them. Derivatives cascade from the media row, so they have to be
  // collected here too (#25).
  const media = await c.env.DB.prepare(
    `SELECT r2_key FROM listing_media WHERE listing_id = ?1
     UNION ALL
     SELECT d.r2_key FROM media_derivatives d
       JOIN listing_media m ON m.id = d.media_id
      WHERE m.listing_id = ?1`,
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
