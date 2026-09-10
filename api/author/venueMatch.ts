import { slugify } from '../lib/slug'
import { haversineKm } from '../lib/geo'

/**
 * Ranking and duplicate detection for venues (#31).
 *
 * Pure, and deliberately so: it is the half of the venue picker worth testing
 * exhaustively, and every threshold in it is a judgement call that has to be
 * arguable in a test rather than buried in a WHERE clause.
 *
 * There is **no full-text index** in this schema — migrations 0001-0008 create
 * no FTS5 table and no trigram table, and adding one would need triggers to
 * stay in sync, which `wrangler d1 migrations apply` cannot carry because it
 * splits SQL on semicolons (see migration 0004). So the shape here is the one
 * `api/lib/geo.ts` already uses for distance: a coarse, index-friendly LIKE
 * prefilter in SQL, and the real comparison in the Worker over a bounded set
 * of rows. The database narrows; this file decides.
 */

// ─── Normalising ─────────────────────────────────────────────────────────────

/**
 * One venue name, reduced to the thing worth comparing.
 *
 * It goes through `slugify` rather than a private regex so that a Devanagari
 * name and its romanisation compare equal for free — ठमेल and "Thamel" reduce
 * to the same string, which is exactly what stops the catalogue holding both.
 * The hyphens come straight back out because tokens matter here and they do
 * not in a URL.
 */
export function normaliseVenueName(value: string): string {
  return slugify(value).replace(/-/g, ' ').trim()
}

export const tokensOf = (value: string): string[] =>
  normaliseVenueName(value).split(' ').filter((token) => token !== '')

/**
 * Words that carry no identity. Dropped before the containment test below, so
 * "The Yellow House" and "Yellow House" are one venue.
 */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'at', 'in', 'on'])

/**
 * Words that describe *what kind of place* it is rather than which one. A name
 * made of nothing but these — "Hall", "The Bar" — is not specific enough to
 * conclude anything from, so containment refuses to fire on it. Without this a
 * venue somebody genuinely called "Garden" would be flagged as a duplicate of
 * every other garden in the catalogue.
 */
const GENERIC = new Set([
  'hall', 'bar', 'cafe', 'restaurant', 'hotel', 'ground', 'grounds', 'stadium',
  'club', 'house', 'centre', 'center', 'lounge', 'pub', 'garden', 'gardens',
  'park', 'theatre', 'theater', 'studio', 'arena', 'room', 'venue', 'space',
])

const identityTokens = (value: string): string[] =>
  tokensOf(value).filter((token) => !STOPWORDS.has(token))

// ─── Similarity ──────────────────────────────────────────────────────────────

/** Character bigrams of the normalised name with the spaces taken out, so
 *  "Jazz Upstairs" and "Jazzupstairs" are the same string before we start. */
function bigrams(value: string): Map<string, number> {
  const compact = normaliseVenueName(value).replace(/ /g, '')
  const counts = new Map<string, number>()
  for (let i = 0; i < compact.length - 1; i++) {
    const gram = compact.slice(i, i + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/**
 * Sørensen–Dice over those bigrams, 0 to 1.
 *
 * Dice rather than Levenshtein because the failure mode here is not single
 * character edits, it is the same name written at different lengths, and an
 * edit distance normalised by length punishes "Kathmandu Jazz Conservatory
 * (KJC)" for the four characters it adds. Bigram overlap does not.
 */
export function nameSimilarity(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  let shared = 0
  let leftTotal = 0
  let rightTotal = 0
  for (const [gram, count] of left) {
    leftTotal += count
    const other = right.get(gram)
    if (other) shared += Math.min(count, other)
  }
  for (const [, count] of right) rightTotal += count
  // A one-character name has no bigrams at all; fall back to equality so
  // "K" and "K" do not read as completely different places.
  if (leftTotal === 0 || rightTotal === 0) {
    return normaliseVenueName(a) === normaliseVenueName(b) ? 1 : 0
  }
  return (2 * shared) / (leftTotal + rightTotal)
}

/**
 * Whether one name is the other plus decoration: "Purple Haze" inside "Purple
 * Haze Rock Bar", "Nepal Academy" inside "Nepal Academy Hall".
 *
 * This is a separate test from similarity and not a redundant one. Dice scores
 * "Purple Haze" against "Purple Haze Rock Bar" at 0.72 — below any threshold
 * that also rejects "Patan Durbar Square" against "Basantapur Durbar Square"
 * at 0.70 — so a single number cannot separate the two cases. Containment can:
 * *patan* is not in the second name, *purple* and *haze* are.
 */
export function nameContains(a: string, b: string): boolean {
  const left = identityTokens(a)
  const right = identityTokens(b)
  if (left.length === 0 || right.length === 0) return false
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  // Nothing but generic words is not an identity, so it cannot be contained.
  if (shorter.every((token) => GENERIC.has(token))) return false
  const set = new Set(longer)
  return shorter.every((token) => set.has(token))
}

// ─── Duplicate thresholds ────────────────────────────────────────────────────

/**
 * **Name similarity: 0.80 Dice.**
 *
 * Measured against real Kathmandu and Pokhara venue names rather than picked
 * for looking round. The highest-scoring pair that is genuinely two places is
 * "Patan Durbar Square" against "Basantapur Durbar Square" at 0.70 — two
 * different durbar squares, and a catalogue that merged them would be wrong.
 * The lowest-scoring pair that is genuinely one place is "Bhrikutimandap
 * Exhibition Hall" against "Bhrikuti Mandap Exhibition Ground" at 0.82. 0.80
 * sits in that gap with room on both sides, so neither a rewording of the
 * spacing nor a second durbar square moves the answer.
 *
 * What it misses, knowingly: a transposition inside a short name — "Purpel
 * Haze" scores 0.67 against "Purple Haze" — because two characters out of
 * eleven is a large fraction of a short name's bigrams. The distance rule below
 * is what catches that case in practice, which is the reason there are two
 * rules and not one.
 */
export const DUPLICATE_NAME_SIMILARITY = 0.8

/**
 * **Distance: 150 metres.**
 *
 * The floor is the error we expect between two honest attempts at the same
 * place. A phone's GPS fix in a Thamel alley is good to 20-40m, and Google's
 * geocoder against a Nepali address — which routinely resolves to a ward or the
 * nearest named road rather than a door — is often 100m out. Anything under
 * ~100m would fire only when both authors had already agreed, which is when we
 * least need to ask.
 *
 * The ceiling is the distance between two genuinely different venues in the
 * densest part of the catalogue. Thamel has several distinct live-music bars
 * inside 200m of each other, so a 500m rule would warn constantly and be
 * learned as noise. 150m is roughly "the same building, or the one next door".
 *
 * Where it does fire on two real neighbours the author clicks through, which is
 * the whole reason this is a warning: the cost of a false positive is one extra
 * confirmation, and the cost of a false negative is a duplicate venue that
 * splits a place's listings across two pages forever.
 */
export const DUPLICATE_DISTANCE_M = 150

// ─── Types ───────────────────────────────────────────────────────────────────

/** The columns the SQL prefilter selects; everything below works from these. */
export type VenueRow = {
  id: string
  slug: string
  name: string
  area: string | null
  city: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
  upcoming_listing_count?: number | null
  listing_count?: number | null
}

export type DuplicateReason = 'name' | 'distance' | 'name_and_distance'

export type DuplicateWarning = {
  id: string
  slug: string
  name: string
  city: string | null
  reason: DuplicateReason
  similarity: number
  distance_m: number | null
}

// ─── Duplicate detection ─────────────────────────────────────────────────────

/**
 * Every existing venue a new one might already be.
 *
 * Two independent signals, either of which is enough. They cover each other:
 * a misspelling scores too low on name but lands on the same corner, and a
 * venue entered with no coordinates at all still gets caught by its name.
 *
 * The name signal is suppressed when both venues name a city and the cities
 * differ. Nepali place names repeat — "Lakeside" is a neighbourhood in Pokhara
 * and could as easily be a bar in Kathmandu — and a warning that fires across
 * cities teaches authors to dismiss warnings without reading them.
 */
export function findDuplicates(
  candidate: { name: string; city?: string | null; latitude?: number | null; longitude?: number | null },
  existing: VenueRow[],
): DuplicateWarning[] {
  const warnings: DuplicateWarning[] = []

  for (const venue of existing) {
    const similarity = nameSimilarity(candidate.name, venue.name)
    const sameCity = !candidate.city || !venue.city
      || candidate.city.trim().toLowerCase() === venue.city.trim().toLowerCase()
    const nameMatch = sameCity
      && (similarity >= DUPLICATE_NAME_SIMILARITY || nameContains(candidate.name, venue.name))

    const distanceM = candidate.latitude != null && candidate.longitude != null
      && venue.latitude != null && venue.longitude != null
      ? haversineKm(candidate.latitude, candidate.longitude, venue.latitude, venue.longitude) * 1000
      : null
    const nearby = distanceM !== null && distanceM <= DUPLICATE_DISTANCE_M

    if (!nameMatch && !nearby) continue
    warnings.push({
      id: venue.id,
      slug: venue.slug,
      name: venue.name,
      city: venue.city,
      reason: nameMatch && nearby ? 'name_and_distance' : nameMatch ? 'name' : 'distance',
      similarity: Math.round(similarity * 100) / 100,
      distance_m: distanceM === null ? null : Math.round(distanceM),
    })
  }

  // Both signals beats one; after that the closest name, then the closest pin.
  // The wizard shows the first one by name, so the ordering is the message.
  const weight = (reason: DuplicateReason) => (reason === 'name_and_distance' ? 0 : reason === 'name' ? 1 : 2)
  return warnings.sort((a, b) =>
    weight(a.reason) - weight(b.reason)
    || b.similarity - a.similarity
    || (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity))
}

/** One sentence an author can act on, naming the venue rather than the rule. */
export function duplicateMessage(warning: DuplicateWarning): string {
  const where = warning.city ? ` in ${warning.city}` : ''
  if (warning.reason === 'distance') {
    return `There is already a venue ${warning.distance_m}m from that pin — “${warning.name}”${where}.`
      + ' Use it if it is the same place, or confirm to add this one anyway.'
  }
  const near = warning.distance_m !== null ? ` and it is ${warning.distance_m}m from that pin` : ''
  return `“${warning.name}”${where} is already in the catalogue${near}.`
    + ' Use it if it is the same place, or confirm to add this one anyway.'
}

// ─── Search ranking ──────────────────────────────────────────────────────────

/**
 * The ranking the acceptance criterion turns on: *searching an existing venue
 * returns it before offering to create a new one*. If a venue that exists can
 * be buried under three near-misses, the author creates a second copy of it,
 * and the deduplication work #21 did starts over.
 *
 * Lower is better. The tiers are ordered by how sure we are that this is the
 * row the author meant, which is not the same as how many characters match:
 * an exact name is certain, a name that *starts* with what was typed is very
 * likely (autocomplete is typed left to right), a word inside the name is
 * plausible, and a hit on the address is a last resort.
 */
export const MATCH_TIER = {
  exact: 0,
  prefix: 1,
  wordPrefix: 2,
  substring: 3,
  place: 4,
  none: 5,
} as const

export type MatchTier = (typeof MATCH_TIER)[keyof typeof MATCH_TIER]

export function matchTier(query: string, venue: VenueRow): MatchTier {
  const q = normaliseVenueName(query)
  if (q === '') return MATCH_TIER.none
  const name = normaliseVenueName(venue.name)

  if (name === q) return MATCH_TIER.exact
  if (name.startsWith(q)) return MATCH_TIER.prefix
  // A word inside the name starting with the query: "haze" finding "Purple
  // Haze". Distinguished from a bare substring because a match that begins a
  // word is what someone typing a name means, and "aze" is not.
  if (tokensOf(venue.name).some((token) => token.startsWith(q))) return MATCH_TIER.wordPrefix
  if (name.includes(q)) return MATCH_TIER.substring

  const place = [venue.area, venue.city, venue.address]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .map(normaliseVenueName)
  if (place.some((value) => value.includes(q))) return MATCH_TIER.place

  return MATCH_TIER.none
}

export type RankedVenue = VenueRow & { tier: MatchTier; similarity: number }

/**
 * Rows the SQL prefilter handed back, in the order the wizard should show them.
 *
 * Ties inside a tier are broken by how much has actually happened at the venue
 * — the same rule the lookups endpoint already uses, and for the same reason:
 * the venue an author wants is overwhelmingly one that is already in use.
 * Similarity breaks the remaining ties so that "Purple Haze" beats "Purple
 * Haze Rock Bar and Grill" when both merely contain what was typed.
 */
export function rankVenueMatches(query: string, venues: VenueRow[]): RankedVenue[] {
  return venues
    .map((venue) => ({
      ...venue,
      tier: matchTier(query, venue),
      similarity: Math.round(nameSimilarity(query, venue.name) * 100) / 100,
    }))
    .filter((venue) => venue.tier !== MATCH_TIER.none)
    .sort((a, b) =>
      a.tier - b.tier
      || (b.upcoming_listing_count ?? 0) - (a.upcoming_listing_count ?? 0)
      || (b.listing_count ?? 0) - (a.listing_count ?? 0)
      || b.similarity - a.similarity
      || a.name.localeCompare(b.name))
}

/**
 * Whether the wizard should offer "add a new venue" at all.
 *
 * Answered here rather than in the browser because it is the acceptance
 * criterion itself, and a rule that lives in one component is a rule that is
 * true until somebody rewrites that component. An exact name match means the
 * venue exists and the author has found it; anything less and creating one is
 * a legitimate thing to want.
 */
export function shouldSuggestCreate(ranked: RankedVenue[]): boolean {
  return !ranked.some((venue) => venue.tier === MATCH_TIER.exact)
}
