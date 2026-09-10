import { fold } from '../lib/fold'
import { haversineKm } from '../lib/geo'
import type { SearchTerm } from './terms'
import type { ListingSummary } from './types'

/**
 * What comes first, and why (#42).
 *
 * Ranking runs here rather than in the SQL, over a bounded candidate set. The
 * reason is not performance — SQLite would compute an ORDER BY expression
 * happily — it is that a blend of four signals is a thing that has to be
 * *argued about*, and an expression spliced into a query string cannot be
 * unit-tested against a list of listings and a stated expectation. The cost is
 * a ceiling on how deep a ranked search can reach (`SEARCH_CANDIDATES`), which
 * is stated where it is applied.
 *
 * The blend, and what each part is there to stop:
 *
 *   - **Text** — how well and *where* the words matched. Without it a query
 *     for a band ranks the whole city above the band.
 *   - **Date proximity** — the acceptance criterion in #42: a match tomorrow
 *     beats one in six months. This is the signal that makes a discovery
 *     search feel different from a web search.
 *   - **Distance** — only when the reader has said where they are. Weight
 *     redistributes rather than counting a zero, so a search with no location
 *     is not a search where every result lost a quarter of its score.
 *   - **Popularity** — views over the last month, saturating. Deliberately the
 *     smallest weight: it is the signal that entrenches whatever is already
 *     winning, and a catalogue this young has nothing to entrench.
 */
const WEIGHTS = { text: 0.45, date: 0.3, distance: 0.15, popularity: 0.1 }

/** Half-life-ish shape: tomorrow ≈ 0.93, a fortnight ≈ 0.5, six months ≈ 0.07. */
const DATE_SCALE_DAYS = 14
/** 5km is "in my neighbourhood"; the score halves there and keeps falling. */
const DISTANCE_SCALE_KM = 5
/** Views at which popularity is half of what it can ever contribute. */
const POPULARITY_MIDPOINT = 50

export type RankContext = {
  terms: SearchTerm[]
  now: Date
  centre?: { lat: number; lng: number }
  /** Listing id → views in the recent window. Absent ids score zero. */
  popularity?: Map<string, number>
}

/**
 * Where a term matched, and what that is worth.
 *
 * A title match is the strongest evidence of intent; a category match is the
 * weakest, because every listing has one and it is the field most likely to
 * match by accident. The venue sits high because "Purple Haze" is a query
 * people actually type.
 */
const FIELD_WEIGHTS: { weight: number; of: (listing: ListingSummary) => (string | null)[] }[] = [
  { weight: 0.8, of: (l) => [l.title, l.title_ne] },
  { weight: 0.6, of: (l) => [l.venue?.name ?? null, l.venue?.area ?? null, l.venue?.city ?? null] },
  { weight: 0.48, of: (l) => [l.organizer?.name ?? null] },
  { weight: 0.44, of: (l) => [l.summary, l.summary_ne] },
  { weight: 0.28, of: (l) => l.categories.map((category) => category.name) },
]

/**
 * A whole-word hit is worth more than the same letters inside a longer word —
 * "Art Week" over "Departure". The base weights above are set so that the
 * bonus lands *at* 1.0 for a title rather than past it: a weight that clamps
 * would score both of those the same and lose the distinction entirely.
 */
const WHOLE_WORD_BONUS = 1.25

/**
 * A listing's text, folded once.
 *
 * Folding is not free — it normalises, strips accents and lowercases — and the
 * obvious shape recomputed it per field *per term*, which at two hundred
 * candidates and two words is three thousand foldings on the response path.
 * Preparing each listing once and scoring every term against the result is the
 * same answer for a fraction of the work; it is most of the difference between
 * a search that answers in 30ms at ten thousand listings and one that takes
 * 200.
 */
type Profile = { weight: number; values: string[]; words: Set<string> }[]

function profile(listing: ListingSummary): Profile {
  return FIELD_WEIGHTS.map((field) => {
    const values: string[] = []
    const words = new Set<string>()
    for (const value of field.of(listing)) {
      if (!value) continue
      const folded = fold(value)
      if (!folded) continue
      values.push(folded)
      for (const word of folded.split(' ')) words.add(word)
    }
    return { weight: field.weight, values, words }
  })
}

function fieldScore(prepared: Profile, token: string): number {
  let best = 0
  for (const field of prepared) {
    // Nothing this field can score would beat what is already held.
    if (field.weight * WHOLE_WORD_BONUS <= best) continue

    const whole = field.words.has(token)
    const hit = whole || field.values.some((value) => value.includes(token))
    if (!hit) continue

    const score = Math.min(1, field.weight * (whole ? WHOLE_WORD_BONUS : 1))
    if (score > best) best = score
  }
  return best
}

function textScoreOf(prepared: Profile, terms: SearchTerm[]): number {
  if (terms.length === 0) return 0
  let total = 0
  for (const term of terms) total += fieldScore(prepared, term.token)
  return total / terms.length
}

/** The score one listing's text gets for a query — the unit-testable door. */
export function textScore(listing: ListingSummary, terms: SearchTerm[]): number {
  return textScoreOf(profile(listing), terms)
}

export function dateScore(listing: ListingSummary, now: Date): number {
  const days = (Date.parse(listing.starts_at) - now.getTime()) / 86_400_000
  // Something already running is as close as it gets — not further away for
  // having started, which is what a signed difference would say.
  return 1 / (1 + Math.max(0, days) / DATE_SCALE_DAYS)
}

export function distanceScore(listing: ListingSummary, centre: { lat: number; lng: number }): number | null {
  if (listing.latitude === null || listing.longitude === null) return null
  const km = haversineKm(centre.lat, centre.lng, listing.latitude, listing.longitude)
  return 1 / (1 + km / DISTANCE_SCALE_KM)
}

export function popularityScore(views: number): number {
  return views / (views + POPULARITY_MIDPOINT)
}

export function scoreListing(listing: ListingSummary, context: RankContext): number {
  return scoreWith(listing, profile(listing), context)
}

function scoreWith(listing: ListingSummary, prepared: Profile, context: RankContext): number {
  const parts: { weight: number; value: number }[] = [
    { weight: WEIGHTS.date, value: dateScore(listing, context.now) },
    { weight: WEIGHTS.popularity, value: popularityScore(context.popularity?.get(listing.id) ?? 0) },
  ]

  // A query-less search — a filter with a location, say — has no text signal,
  // and scoring every result 0 on 45% of the blend would leave the rest
  // fighting over the remainder. Dropping the component redistributes it.
  if (context.terms.length > 0) {
    parts.push({ weight: WEIGHTS.text, value: textScoreOf(prepared, context.terms) })
  }
  if (context.centre) {
    const distance = distanceScore(listing, context.centre)
    // A listing with no coordinates keeps its other signals rather than being
    // pushed to the bottom of a distance-weighted search it may still answer.
    if (distance !== null) parts.push({ weight: WEIGHTS.distance, value: distance })
  }

  const total = parts.reduce((sum, part) => sum + part.weight, 0)
  return parts.reduce((sum, part) => sum + part.weight * part.value, 0) / total
}

/**
 * Highest score first, soonest first where scores tie, then by id so the order
 * is total. A ranking with a non-deterministic tail pages badly: the same
 * listing appears on page one and page two.
 */
export function rankListings(listings: ListingSummary[], context: RankContext): ListingSummary[] {
  return listings
    // Folded once here rather than inside the comparator: `sort` calls the
    // comparator O(n log n) times and would refold on every comparison.
    .map((listing) => ({ listing, score: scoreWith(listing, profile(listing), context) }))
    .sort((a, b) =>
      b.score - a.score ||
      a.listing.starts_at.localeCompare(b.listing.starts_at) ||
      a.listing.id.localeCompare(b.listing.id))
    .map((entry) => entry.listing)
}
