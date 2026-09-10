import type { Env } from '../env'
import { rowsOf, writeSession } from '../lib/d1'
import {
  findDuplicateListing, type ListingCandidate, type ListingDuplicate,
} from './listingMatch'

/**
 * The database half of duplicate detection (#33). The scoring is pure and
 * lives in `listingMatch.ts`; this is the query that decides which rows it is
 * allowed to see.
 */

/**
 * How far either side of the submission to look, and the reason the check is
 * bounded at all: the candidate set has to fit the index. Three days matches
 * `FESTIVAL_WINDOW_MS` in the scorer, because a candidate outside that window
 * can never score above the threshold on time and would be work thrown away.
 */
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000
/** A hard ceiling on the rows scored in the Worker, whatever the window holds. */
const MAX_CANDIDATES = 200

/**
 * Coordinates come from the listing's own override *or* its venue — the same
 * COALESCE the read path uses (api/catalog/queries.ts), because a listing that
 * inherits its venue's pin is at that pin as far as anybody looking at the map
 * is concerned.
 */
const CANDIDATE_COLUMNS = `l.id, l.slug, l.title, l.status, l.starts_at, l.venue_id,
                           v.name AS venue_name,
                           COALESCE(l.location_lat, v.latitude)  AS latitude,
                           COALESCE(l.location_lng, v.longitude) AS longitude`

export function candidateStatement(env: Env, listingId: string) {
  return env.DB.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM listings l
       LEFT JOIN venues v ON v.id = l.venue_id
      WHERE l.id = ?1`,
  ).bind(listingId)
}

/**
 * Everything a submission could be a second copy of.
 *
 * Only `published` and `pending_review`: a draft is nobody's duplicate yet —
 * it may never be submitted, and flagging against half-written private work
 * would leak one author's drafts into another's warning. An `archived` or
 * already-`rejected` listing is a decision that has been made, and re-raising
 * it is how a moderator ends up rejecting the same thing twice.
 *
 * `starts_at IS NULL` is included deliberately. An unset start scores 0.5 in
 * the scorer rather than zero — absent evidence is not evidence against — so a
 * submission with no date yet must still be reachable, and a BETWEEN alone
 * would silently drop it.
 */
export function nearbyStatement(env: Env, listingId: string, startsAt: string | null) {
  const centre = startsAt ? new Date(startsAt).getTime() : Date.now()
  const from = new Date(centre - WINDOW_MS).toISOString()
  const to = new Date(centre + WINDOW_MS).toISOString()

  return env.DB.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM listings l
       LEFT JOIN venues v ON v.id = l.venue_id
      WHERE l.id != ?1
        AND l.status IN ('published', 'pending_review')
        AND (l.starts_at IS NULL OR l.starts_at BETWEEN ?2 AND ?3)
      LIMIT ?4`,
  ).bind(listingId, from, to, MAX_CANDIDATES)
}

/**
 * Two round trips, and it cannot be one: the window the second query uses is
 * computed from the start date the first returns. Both are on the submission
 * path rather than the read path, which is where a round trip is affordable —
 * and it is the moment the answer is worth most, because the listing has just
 * stopped being private.
 */
export async function detectDuplicate(
  env: Env, listingId: string,
): Promise<ListingDuplicate | null> {
  const session = writeSession(env)
  const [self] = await session.batch([candidateStatement(env, listingId)])
  const candidate = rowsOf<ListingCandidate>(self)[0]
  if (!candidate) return null

  const [nearby] = await session.batch([
    nearbyStatement(env, listingId, candidate.starts_at),
  ])

  return findDuplicateListing(candidate, rowsOf<ListingCandidate>(nearby))
}
