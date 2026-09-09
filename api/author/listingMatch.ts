import { haversineKm } from '../lib/geo'
import { nameContains, nameSimilarity } from './venueMatch'

/**
 * Duplicate detection for listings, run at submission (#33).
 *
 * The failure mode this exists for is named in the issue: the same festival
 * submitted by three people. It is the most likely way an open catalogue
 * becomes useless, and it is the cheapest thing in the world to catch — at the
 * moment of submission, against a bounded set of listings that are already
 * near in time.
 *
 * **Why a listing needs three signals where a venue needed two.** A venue's
 * name is close to an identity: two places called "Purple Haze" within 150 m
 * of each other are one place. An event's title is not. "Open Mic Night" is
 * the title of fifty-two genuinely different events a year at one bar, and
 * flagging every Tuesday against last Tuesday would train editors to dismiss
 * the warning without reading it — which costs more than never warning at all.
 * So title, time and place are scored together and none of them decides alone.
 *
 * The weights and the threshold below are **reasoned, not measured**, unlike
 * the venue thresholds in `venueMatch.ts` which come from real name pairs.
 * There is no corpus of known-duplicate Nepali listings to calibrate against
 * yet. What there is instead is a set of cases the scoring must get right, and
 * they are the test file: same event twice must flag, a weekly residency must
 * not, two different gigs at one venue on one night must not, and a festival
 * whose second submitter invented a duplicate venue must still flag.
 */

// ─── Weights ─────────────────────────────────────────────────────────────────

/**
 * Title carries the most because it is the only signal that is about *this
 * event* rather than about its circumstances; time and place are shared by
 * everything else on that night. But it carries less than half, so a title
 * match alone — the weekly residency — cannot reach the threshold on its own.
 */
const WEIGHT = { title: 0.5, time: 0.3, place: 0.2 } as const

/**
 * **0.75.** Not a round number picked for looking decisive: it is the line
 * that falls between the two cases nearest to each other.
 *
 * The weakest thing that must flag is the same event submitted twice with the
 * title reworded — title 0.80, same day, same venue: 0.40 + 0.21 + 0.20 =
 * 0.81. The strongest thing that must not is the same event title at the same
 * venue a week later — title 1.00, no time match, same venue: 0.50 + 0 + 0.20
 * = 0.70. The gap is 0.11 wide and 0.75 sits in it.
 */
export const DUPLICATE_THRESHOLD = 0.75

/** Two starts this close are the same event, whatever the calendar says. */
const SAME_MOMENT_MS = 2 * 60 * 60 * 1000
/** A multi-day festival, submitted twice with different days chosen. */
const FESTIVAL_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
/** Nepal is UTC+5:45, and "the same day" has to mean the same day *there*. */
const KATHMANDU_OFFSET_MS = 5.75 * 60 * 60 * 1000

/** The same distance the venue check uses: two honest pins at one place. */
const SAME_PLACE_M = 150
const NEARBY_M = 1000

// ─── Types ───────────────────────────────────────────────────────────────────

export type ListingCandidate = {
  id: string
  slug: string
  title: string
  status: string
  starts_at: string | null
  venue_id: string | null
  venue_name?: string | null
  latitude: number | null
  longitude: number | null
}

export type ListingDuplicate = ListingCandidate & {
  score: number
  /** Which signals fired, so the queue can say *why* rather than show a number. */
  signals: { title: number; time: number; place: number }
}

// ─── The three signals ───────────────────────────────────────────────────────

/**
 * Titles, compared the same way venue names are — Dice over bigrams, with
 * containment as a separate test because a single number cannot both accept
 * "Kutumba Live" inside "Kutumba Live in Concert" and reject two different
 * durbar squares (see `nameContains`).
 */
export function titleScore(a: string, b: string): number {
  if (nameContains(a, b)) return 1
  return nameSimilarity(a, b)
}

const dayInKathmandu = (iso: string): string =>
  new Date(new Date(iso).getTime() + KATHMANDU_OFFSET_MS).toISOString().slice(0, 10)

/**
 * How much two start times agree.
 *
 * Three steps rather than a curve, because the cases are genuinely discrete: a
 * resubmission of the same event (the same evening), a festival entered on
 * different days of its run, and everything else. A smooth decay would put
 * "eleven hours apart" halfway between the same event and a different one,
 * which is not a thing eleven hours means.
 */
export function timeScore(a: string | null, b: string | null): number {
  // An unset start is a draft that has not decided yet (migration 0008). It is
  // not evidence either way, so it scores as the shrug it is rather than as a
  // mismatch — otherwise no incomplete submission could ever be flagged.
  if (!a || !b) return 0.5
  const left = new Date(a).getTime()
  const right = new Date(b).getTime()
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0.5

  const apart = Math.abs(left - right)
  if (apart <= SAME_MOMENT_MS) return 1
  if (dayInKathmandu(a) === dayInKathmandu(b)) return 0.7
  if (apart <= FESTIVAL_WINDOW_MS) return 0.3
  return 0
}

/**
 * How much two listings agree about where they are.
 *
 * The same venue id is certainty. Failing that, coordinates — which is what
 * catches the case the id cannot: a second submitter who could not find the
 * venue and created their own copy of it, so the ids differ and the pins are
 * ten metres apart.
 *
 * **Zero means contradicted, and nothing else does.** Two listings that both
 * know where they are and are more than a kilometre apart are not the same
 * gathering, whatever their titles say — so zero here is a veto in
 * `scoreDuplicate` rather than a low number to be outvoted. That distinction
 * is the whole reason "we cannot tell" scores 0.5 instead: a listing with no
 * venue yet must stay flaggable, and would not be if absent evidence read as
 * evidence against.
 *
 * Two *different* venue ids with no coordinates on either side is the awkward
 * middle. It is weak evidence against — but not a veto, because the ids may be
 * two rows for one place, which is the duplicate-venue case above with the
 * pins missing.
 */
export function placeScore(a: ListingCandidate, b: ListingCandidate): number {
  if (a.venue_id && b.venue_id && a.venue_id === b.venue_id) return 1

  const aHasPin = a.latitude !== null && a.longitude !== null
  const bHasPin = b.latitude !== null && b.longitude !== null
  if (aHasPin && bHasPin) {
    const metres = haversineKm(a.latitude!, a.longitude!, b.latitude!, b.longitude!) * 1000
    if (metres <= SAME_PLACE_M) return 1
    if (metres <= NEARBY_M) return 0.5
    return 0
  }

  if (a.venue_id && b.venue_id) return 0.25
  return 0.5
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export function scoreDuplicate(
  candidate: ListingCandidate, existing: ListingCandidate,
): ListingDuplicate {
  const signals = {
    title: titleScore(candidate.title, existing.title),
    time: timeScore(candidate.starts_at, existing.starts_at),
    place: placeScore(candidate, existing),
  }
  // The veto. Without it, an identical title at an identical hour scores 0.80
  // on title and time alone — so the same tribute night in Kathmandu and in
  // Pokhara would be flagged as one event, which is two real gigs merged.
  const score = signals.place === 0
    ? 0
    : signals.title * WEIGHT.title + signals.time * WEIGHT.time + signals.place * WEIGHT.place

  return { ...existing, score: Math.round(score * 100) / 100, signals }
}

/**
 * The best duplicate candidate, or null.
 *
 * One, not a list: the queue needs an answer an editor can act on — merge into
 * *that* — and a ranked list of near-misses is a screen nobody reads. The
 * others stay findable through search if the first turns out to be wrong.
 */
export function findDuplicateListing(
  candidate: ListingCandidate, existing: ListingCandidate[],
): ListingDuplicate | null {
  const scored = existing
    .filter((row) => row.id !== candidate.id)
    .map((row) => scoreDuplicate(candidate, row))
    .filter((row) => row.score >= DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score
      // A published listing is the better thing to merge into than another
      // submission still waiting: it has a URL people may already hold.
      || Number(b.status === 'published') - Number(a.status === 'published'))

  return scored[0] ?? null
}

/** What the wizard and the queue both say about a flag, in one sentence. */
export function duplicateMessage(duplicate: ListingDuplicate): string {
  const where = duplicate.venue_name ? ` at ${duplicate.venue_name}` : ''
  const when = duplicate.starts_at
    ? ` on ${dayInKathmandu(duplicate.starts_at)}`
    : ''
  return `This looks like “${duplicate.title}”${where}${when}, which is already in the catalogue.`
}
