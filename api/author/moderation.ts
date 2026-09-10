import { Hono } from 'hono'
import type { Env } from '../env'
import { badRequest, notFound } from '../lib/http'
import { numeric, rowsOf, text, withRoundTrips, writeSession } from '../lib/d1'
import { auditStatement } from '../lib/audit'
import { bumpCatalogVersion } from '../lib/cache'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { loadEditableListing } from './access'
import { readReason, TRANSITIONS } from './listings'

/**
 * The moderation queue (#33): the screen an editor works through, and the
 * three things they do from it.
 *
 * The verbs themselves are `listings.ts` — this file adds no new transition
 * and deliberately reuses that table, because a bulk action that could reach a
 * state the single action cannot is a hole in the state machine with a
 * friendly name on it.
 *
 * What is new here is the shape of the work: a *list* that is worth reading
 * (the duplicate flag is on it, so the decision needs no second screen), an
 * action that applies to many rows at once, and a merge.
 */
export const moderationRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

/** A page of work, not a page of scrolling. */
const PAGE = 25
const MAX_PAGE = 50
/** How many rows one bulk action may touch. See the note on the handler. */
const MAX_BULK = 50

type QueueRow = {
  id: string; slug: string; title: string; status: string
  listing_type: string; source: string
  starts_at: string | null; updated_at: string
  venue_name: string | null
  author_email: string | null
  author_name: string | null
  organization_name: string | null
  media_count: number
  category_slugs: string | null
  duplicate_score: number | null
  duplicate_id: string | null
  duplicate_slug: string | null
  duplicate_title: string | null
  duplicate_status: string | null
}

// ─── GET /api/author/queue ───────────────────────────────────────────────────
/**
 * Everything waiting, oldest first.
 *
 * **Oldest first is the whole ordering, and it is not the feed's.** The feed
 * orders by when an event happens; a queue orders by how long its author has
 * been waiting, which is `updated_at` — the moment of submission, since
 * submitting is a write. Migration 0010 adds `(status, updated_at)` for
 * exactly this, because `idx_listings_feed` would have sorted the queue by
 * event date and quietly starved anybody who submitted something far off.
 *
 * One round trip. Everything an editor needs to decide is on the row: the
 * author, the venue, whether there is a picture, and the listing this one may
 * be a copy of. A queue that needs a second request per row to be readable is
 * a queue nobody works through.
 */
moderationRoutes.get('/queue', requirePermission('listing:moderate'), async (c) => {
  const url = new URL(c.req.url)
  const status = url.searchParams.get('status') ?? 'pending_review'
  if (!['pending_review', 'rejected', 'published', 'draft', 'archived'].includes(status)) {
    throw badRequest('invalid_status', 'That is not a status a listing can be in')
  }
  const limit = Math.min(Number(url.searchParams.get('limit')) || PAGE, MAX_PAGE)
  // Keyset on updated_at, which is what the index is ordered by. An OFFSET
  // would drift as editors work: publishing row 3 shifts everything after it,
  // and page 2 would skip whatever slid up into the gap.
  const after = url.searchParams.get('after')

  const session = writeSession(c.env)
  const [rows, counts] = await session.batch([
    c.env.DB.prepare(
      `SELECT l.id, l.slug, l.title, l.status, l.listing_type, l.source,
              l.starts_at, l.updated_at, l.duplicate_score,
              v.name AS venue_name,
              u.email AS author_email, u.name AS author_name,
              o.name AS organization_name,
              (SELECT COUNT(*) FROM listing_media m WHERE m.listing_id = l.id) AS media_count,
              (SELECT GROUP_CONCAT(c2.slug) FROM listing_categories lc
                 JOIN categories c2 ON c2.id = lc.category_id
                WHERE lc.listing_id = l.id) AS category_slugs,
              d.id AS duplicate_id, d.slug AS duplicate_slug,
              d.title AS duplicate_title, d.status AS duplicate_status
         FROM listings l
         LEFT JOIN venues v ON v.id = l.venue_id
         LEFT JOIN users u ON u.id = l.created_by
         LEFT JOIN organizations o ON o.id = l.organization_id
         LEFT JOIN listings d ON d.id = l.suspected_duplicate_of
        WHERE l.status = ?1 AND (?2 IS NULL OR l.updated_at > ?2)
        ORDER BY l.updated_at ASC
        LIMIT ?3`,
    ).bind(status, after, limit + 1),
    // The counts the tabs show. One statement, so switching tabs is a filter
    // rather than a fresh page load with a fresh set of numbers.
    c.env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM listings GROUP BY status`,
    ),
  ])

  const page = rowsOf<QueueRow>(rows)
  const hasMore = page.length > limit
  const data = hasMore ? page.slice(0, limit) : page

  return withRoundTrips(Response.json({
    data: data.map((row) => ({
      id: row.id, slug: row.slug, title: row.title, status: row.status,
      listing_type: row.listing_type, source: row.source,
      starts_at: row.starts_at, updated_at: row.updated_at,
      venue_name: row.venue_name,
      author: row.author_email
        ? { email: row.author_email, name: row.author_name }
        : null,
      organization_name: row.organization_name,
      media_count: Number(row.media_count ?? 0),
      category_slugs: row.category_slugs ? row.category_slugs.split(',') : [],
      // Null unless the submission was flagged. The score rides along so the
      // queue can show *how* sure rather than only *that* it is suspicious —
      // 0.76 and 1.00 are very different amounts of "look at this".
      duplicate: row.duplicate_id
        ? {
            id: row.duplicate_id, slug: row.duplicate_slug,
            title: row.duplicate_title, status: row.duplicate_status,
            score: numeric(row.duplicate_score),
          }
        : null,
    })),
    counts: Object.fromEntries(
      rowsOf<{ status: string; n: number }>(counts).map((row) => [row.status, Number(row.n)]),
    ),
    next: hasMore ? data[data.length - 1]?.updated_at ?? null : null,
  }), session)
})

// ─── POST /api/author/queue/actions ──────────────────────────────────────────
/**
 * One decision applied to many listings.
 *
 * **Bounded at fifty, and the bound is not arbitrary.** A bulk action is the
 * one place in this API where a mistake is multiplied, and D1 has a statement
 * limit per batch besides. Fifty is a screenful of queue at twice the page
 * size: enough that "reject all this spam" is one action, small enough that a
 * misclick is recoverable by hand.
 *
 * **Every row is still checked individually.** The permission, the legal
 * from-states, and the audit entry are per listing, exactly as they are for a
 * single action — the batch is a way to send fifty requests, not a way to skip
 * fifty checks. Rows that cannot make the move are reported back by id rather
 * than failing the whole call: an editor who selected one already-published
 * listing among forty should not have to work out which one and start again.
 */
moderationRoutes.post('/queue/actions', requirePermission('listing:moderate'), async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => {
    throw badRequest('invalid_body', 'Send a JSON object')
  }) as Record<string, unknown>

  const verb = typeof body.action === 'string' ? body.action : ''
  const transition = TRANSITIONS[verb]
  if (!transition || !['publish', 'reject', 'archive'].includes(verb)) {
    throw badRequest('invalid_action', 'A bulk action is one of: publish, reject, archive')
  }

  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string'))]
    : []
  if (ids.length === 0) throw badRequest('no_listings', 'Name at least one listing')
  if (ids.length > MAX_BULK) {
    throw badRequest('too_many', `A bulk action covers at most ${MAX_BULK} listings at a time`)
  }

  const reason = transition.needsReason ? readReason(body) : null
  const now = new Date().toISOString()
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ')

  const current = await c.env.DB.prepare(
    `SELECT id, slug, status FROM listings WHERE id IN (${placeholders})`,
  ).bind(...ids).all<{ id: string; slug: string; status: string }>()

  const known = new Map(current.results.map((row) => [row.id, row]))
  const applied: string[] = []
  const refused: { id: string; reason: string }[] = []
  const statements = []

  for (const id of ids) {
    const row = known.get(id)
    if (!row) {
      refused.push({ id, reason: 'No such listing' })
      continue
    }
    if (!transition.from.includes(row.status)) {
      refused.push({ id, reason: `A listing cannot go from ${row.status} to ${transition.to}` })
      continue
    }
    applied.push(id)
    statements.push(
      c.env.DB.prepare(
        `UPDATE listings
            SET status = ?1,
                published_at = CASE WHEN ?1 = 'published' THEN COALESCE(published_at, ?2) ELSE published_at END,
                rejection_reason = CASE WHEN ?1 = 'rejected' THEN ?4 ELSE NULL END,
                suspected_duplicate_of = NULL,
                duplicate_score = NULL,
                updated_at = ?2
          WHERE id = ?3 AND status = ?5`,
      ).bind(transition.to, now, id, reason, row.status),
      auditStatement(c.env, {
        entityType: 'listing', entityId: id, action: transition.action,
        actorId: user.id, actorRole: user.role,
        details: { from: row.status, to: transition.to, reason: reason ?? undefined, bulk: true },
      }),
    )
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements)
    c.executionCtx.waitUntil(bumpCatalogVersion(c.env))
  }

  return c.json({ applied, refused, status: transition.to })
})

// ─── POST /api/author/listings/:id/merge ─────────────────────────────────────
/**
 * Fold one listing into another and archive the loser.
 *
 * **"Preserves the better fields from both records" needs a definition, and
 * this is it: the survivor wins every field it has an answer for, and the
 * loser fills the blanks.** Not "longest wins" — that rewards padding, and a
 * moderator merging two records has already decided which one is the good one
 * by choosing the direction. Not "newest wins" either: the second submission
 * is usually the thinner one, which is why it looked like a duplicate.
 *
 * Media, categories, tags and artists are unioned rather than replaced,
 * because those are sets with no conflict to resolve — a picture the duplicate
 * had and the survivor did not is a picture the catalogue gains.
 *
 * The loser is archived and left pointing at the survivor rather than deleted.
 * Two things still need it: the slug it owned has to stay redirectable (#24),
 * and an author whose submission was merged deserves to be shown where it went
 * instead of finding it gone.
 */
moderationRoutes.post('/listings/:id/merge', requirePermission('listing:moderate'), async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => {
    throw badRequest('invalid_body', 'Send a JSON object')
  }) as Record<string, unknown>

  const loserId = c.req.param('id')
  const winnerId = typeof body.into === 'string' ? body.into : ''
  if (!winnerId) throw badRequest('missing_target', 'Say which listing this merges into')
  if (winnerId === loserId) {
    throw badRequest('same_listing', 'A listing cannot be merged into itself')
  }

  // Both go through the same access check the single verbs use, so a merge
  // cannot reach a listing an editor could not otherwise touch.
  await loadEditableListing(c.env, user.id, user.role, loserId)
  await loadEditableListing(c.env, user.id, user.role, winnerId)

  const session = writeSession(c.env)
  const [rows] = await session.batch([
    c.env.DB.prepare(
      `SELECT * FROM listings WHERE id IN (?1, ?2)`,
    ).bind(loserId, winnerId),
  ])

  const all = rowsOf<Record<string, unknown>>(rows)
  const loser = all.find((row) => row.id === loserId)
  const winner = all.find((row) => row.id === winnerId)
  if (!loser || !winner) throw notFound('No such listing')
  if (winner.status === 'archived') {
    throw badRequest('archived_target', 'Merge into a live listing, not an archived one')
  }

  /**
   * The fields worth carrying across. Deliberately not every column: status,
   * slug, source, ownership and the offer fields are properties of the record
   * rather than of the event, and inheriting them would let a merge quietly
   * change who owns a listing or where its tickets are sold.
   */
  const INHERITABLE = [
    'summary', 'description', 'venue_id', 'venue_room', 'ends_at',
    'external_url', 'cover_image_url', 'location_lat', 'location_lng',
    'map_popup_config',
  ] as const

  const filled: Record<string, unknown> = {}
  for (const column of INHERITABLE) {
    if ((winner[column] === null || winner[column] === undefined) && loser[column] != null) {
      filled[column] = loser[column]
    }
  }

  const now = new Date().toISOString()
  const statements = []

  if (Object.keys(filled).length > 0) {
    const assignments = Object.keys(filled)
      .map((column, i) => `${column} = ?${i + 1}`).join(', ')
    statements.push(
      c.env.DB.prepare(
        `UPDATE listings SET ${assignments}, updated_at = ?${Object.keys(filled).length + 1}
          WHERE id = ?${Object.keys(filled).length + 2}`,
      ).bind(...Object.values(filled), now, winnerId),
    )
  }

  // Sets, unioned. `INSERT OR IGNORE` against the primary keys those tables
  // already have does the union without reading either side first.
  statements.push(
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO listing_categories (listing_id, category_id, is_primary)
       SELECT ?1, category_id, 0 FROM listing_categories WHERE listing_id = ?2`,
    ).bind(winnerId, loserId),
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO listing_tags (listing_id, tag_slug)
       SELECT ?1, tag_slug FROM listing_tags WHERE listing_id = ?2`,
    ).bind(winnerId, loserId),
    // Billing order is offset past the survivor's own artists rather than
    // reused, because (listing_id, billing_order) is what orders the bill and
    // two artists cannot both be third.
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO listing_artists (listing_id, artist_id, billing_order)
       SELECT ?1, artist_id,
              billing_order + (SELECT COUNT(*) FROM listing_artists WHERE listing_id = ?1)
         FROM listing_artists WHERE listing_id = ?2`,
    ).bind(winnerId, loserId),
    // Media *moves*. Copying the rows would leave two listings pointing at one
    // R2 object, and deleting either would break the other's picture (#25).
    c.env.DB.prepare(
      `UPDATE listing_media
          SET listing_id = ?1,
              sort_order = sort_order + (SELECT COUNT(*) FROM listing_media WHERE listing_id = ?1)
        WHERE listing_id = ?2`,
    ).bind(winnerId, loserId),
    c.env.DB.prepare(
      `UPDATE listings
          SET status = 'archived', duplicate_of = ?1,
              suspected_duplicate_of = NULL, duplicate_score = NULL,
              updated_at = ?2
        WHERE id = ?3`,
    ).bind(winnerId, now, loserId),
    auditStatement(c.env, {
      entityType: 'listing', entityId: loserId, action: 'merged',
      actorId: user.id, actorRole: user.role,
      details: { into: winnerId, inherited: Object.keys(filled), from_status: loser.status },
    }),
    auditStatement(c.env, {
      entityType: 'listing', entityId: winnerId, action: 'merged_in',
      actorId: user.id, actorRole: user.role,
      details: { from: loserId, inherited: Object.keys(filled) },
    }),
  )

  await c.env.DB.batch(statements)
  c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

  return withRoundTrips(Response.json({
    merged: loserId,
    into: winnerId,
    slug: text(winner.slug),
    inherited: Object.keys(filled),
  }), session)
})
