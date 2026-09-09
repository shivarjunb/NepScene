import type { Env } from '../env'
import { auditStatement } from '../lib/audit'
import { bumpCatalogVersion } from '../lib/cache'

/**
 * Auto-archive: listings that have finished leave the catalogue on their own
 * (#33).
 *
 * **Why this exists when the feed is already upcoming-by-default.** The read
 * path filters finished events out (#23, and the WaahTickets defect behind it
 * — its public endpoint served 28 finished events out of 50). That fixes what
 * the public sees and nothing else. `published` would still be the status of
 * every event that ever happened, so the moderation queue's counts, the
 * organizer dashboard's filters and every future report would describe a
 * catalogue that is mostly the past. Archiving is what makes "published" mean
 * "live" rather than "was live at some point".
 *
 * **A day of grace, and it is not padding.** A gig that ended at 2am is over,
 * but people are still looking for it at 9am — the address, who played, the
 * organizer's link. Archiving on the stroke of the end time would take the
 * page away from exactly the people most likely to want it.
 */
const GRACE_HOURS = 24

/**
 * How many listings one run may archive.
 *
 * Bounded because a sweep is the one thing here with no user waiting on it and
 * therefore no natural limit — the first run against an imported back
 * catalogue could otherwise try to archive years of events in one D1
 * transaction. It runs nightly, so a backlog drains at a hundred a night
 * without anybody noticing, and the number is a ceiling rather than a target.
 */
const MAX_PER_RUN = 100

export type SweepResult = { archived: string[]; scanned: number }

export async function archiveFinishedListings(env: Env, now = new Date()): Promise<SweepResult> {
  const cutoff = new Date(now.getTime() - GRACE_HOURS * 60 * 60 * 1000).toISOString()

  // COALESCE(ends_at, starts_at) is the expression migration 0010 indexes, and
  // it says what "finished" means: a listing with no explicit end finishes when
  // it starts. Without the index this scans every published row.
  const finished = await env.DB.prepare(
    `SELECT id, slug, COALESCE(ends_at, starts_at) AS finished_at
       FROM listings
      WHERE status = 'published'
        AND COALESCE(ends_at, starts_at) IS NOT NULL
        AND COALESCE(ends_at, starts_at) < ?1
      ORDER BY COALESCE(ends_at, starts_at) ASC
      LIMIT ?2`,
  ).bind(cutoff, MAX_PER_RUN).all<{ id: string; slug: string; finished_at: string }>()

  if (finished.results.length === 0) return { archived: [], scanned: 0 }

  const statements = finished.results.flatMap((row) => [
    // Still guarded by `status = 'published'`: between the SELECT and the
    // UPDATE an editor may have unpublished it, and the sweep must not undo a
    // decision a person made.
    env.DB.prepare(
      `UPDATE listings SET status = 'archived', updated_at = ?1
        WHERE id = ?2 AND status = 'published'`,
    ).bind(now.toISOString(), row.id),
    // Actor null, because there is no actor. Recording the sweep as if an
    // administrator had done it would make the audit log lie about who
    // archived somebody's listing, which is the one question this row exists
    // to answer.
    auditStatement(env, {
      entityType: 'listing', entityId: row.id, action: 'auto_archived',
      actorId: null, actorRole: null,
      details: { finished_at: row.finished_at, grace_hours: GRACE_HOURS },
    }),
  ])

  await env.DB.batch(statements)
  await bumpCatalogVersion(env)

  return {
    archived: finished.results.map((row) => row.id),
    scanned: finished.results.length,
  }
}
