import { Hono } from 'hono'
import type { Env } from '../env'
import type { ReadSession } from '../lib/d1'
import { readSession } from '../lib/d1'
import { REFERENCE_TTL_SECONDS, withEdgeCache } from '../lib/cache'
import { fold } from '../lib/fold'
import { withinDistance } from '../lib/editDistance'
import { buildCandidateQuery, buildFacetQuery, vocabularyQueries } from './queries'
import { toListingSummary } from './serialize'
import { correct, parseTerms, vocabularyWords, type SearchTerm } from './terms'
import { rankListings } from './ranking'
import { whenBuckets } from './when'
import { parseCentre, parseFeedFilters, withRoundTrips, SEARCH_PARAMS } from './shared'
import type { Facet, ListingSummary, SearchFacets, Suggestion } from './types'
import { haversineKm } from '../lib/geo'
import { swallowed } from '../lib/observability'

/**
 * Search (#42) — a rebuild, not a port. WaahTickets filtered an
 * already-downloaded array in the browser, which is why its search only ever
 * worked at fifty events.
 *
 * The request is three decisions, in this order:
 *
 *  1. **Recall, in SQL.** Words are ANDed, spellings are ORed, and the
 *     spellings include the aliases and the other script (`aliases.ts`). Every
 *     row the SQL returns is a result: nothing is filtered out afterwards, so
 *     the facet counts — taken over the same WHERE — cannot disagree with what
 *     the reader is looking at.
 *  2. **Order, in the Worker.** A blend of text, date proximity, distance and
 *     popularity that is a pure function and therefore arguable in a test
 *     (`ranking.ts`).
 *  3. **Rescue, only when there was nothing.** A query that found nothing is
 *     corrected against the catalogue's own vocabulary and run once more. A
 *     query that found something is never second-guessed.
 *
 * That third step is why typo tolerance costs nothing on the common path: the
 * fuzzy work happens on the request that had nothing to lose.
 */
export const searchRoutes = new Hono<{ Bindings: Env }>()

/**
 * How deep ranking can reach. Set well above a page so paging is not ranking's
 * problem, and well below the catalogue so a broad query cannot pull the whole
 * of it into the Worker. See `buildCandidateQuery` for what the cap costs.
 */
const SEARCH_CANDIDATES = 200
/** Popularity is "lately", not "ever" — a gig that sold out in March is over. */
const POPULARITY_WINDOW_DAYS = 30
/** Enough vocabulary to correct against and suggest from; still one small response. */
const VOCABULARY_LIMIT = 250
const MAX_SUGGESTIONS = 8
/** Alternatives offered when even the corrected query found nothing. */
const MAX_ALTERNATIVES = 6

type VocabularyRow = { kind: Suggestion['kind']; slug: string; label: string; weight: number }

// ─── GET /api/catalog/search ─────────────────────────────────────────────────
searchRoutes.get('/search', async (c) => {
  const url = new URL(c.req.url)
  const raw = (url.searchParams.get('q') ?? '').trim()
  const session = readSession(c.env)

  const response = await withEdgeCache(c, { params: SEARCH_PARAMS }, async () => {
    const now = new Date()
    const result = await runSearch(session, url, raw, now)
    return Response.json(result)
  })
  return withRoundTrips(response, session)
})

// ─── GET /api/catalog/suggest ────────────────────────────────────────────────
/**
 * Search-as-you-type. One statement, edge-cached for minutes, and matched in
 * the Worker: the whole vocabulary is small enough to filter in memory, and
 * doing it there is what lets a suggestion be prefix-matched, alias-matched
 * and typo-matched at once without three round trips.
 */
searchRoutes.get('/suggest', async (c) => {
  const url = new URL(c.req.url)
  const raw = (url.searchParams.get('q') ?? '').trim()
  const session = readSession(c.env)

  const response = await withEdgeCache(
    c,
    { params: ['q'], ttlSeconds: REFERENCE_TTL_SECONDS },
    async () => {
      if (!raw) return Response.json({ data: [] })
      const vocabulary = await loadVocabulary(session, new Date())
      return Response.json({ data: suggest(raw, vocabulary) })
    },
  )
  return withRoundTrips(response, session)
})

async function loadVocabulary(session: ReadSession, now: Date): Promise<VocabularyRow[]> {
  const statements = vocabularyQueries(now.toISOString(), VOCABULARY_LIMIT)
  const groups = await session.batch<VocabularyRow>(statements)
  return groups.flat()
}

/**
 * The suggestion list, in one pass over the vocabulary.
 *
 * A prefix hit beats a word-start hit beats a contained hit beats a corrected
 * one, and the entry's own weight breaks ties — a listing outranks the tag it
 * carries. Sorting by kind alone would put every category above every listing,
 * which is not what someone typing three letters is looking for.
 */
export function suggest(raw: string, vocabulary: VocabularyRow[]): Suggestion[] {
  const needle = fold(raw)
  if (!needle) return []

  const scored: { entry: VocabularyRow; score: number }[] = []
  const seen = new Set<string>()

  for (const entry of vocabulary) {
    if (!entry.label) continue
    const key = `${entry.kind}:${entry.slug}:${entry.label}`
    if (seen.has(key)) continue

    const haystack = fold(entry.label)
    let score = 0
    if (haystack.startsWith(needle)) score = 4
    else if (haystack.split(' ').some((word) => word.startsWith(needle))) score = 3
    else if (haystack.includes(needle)) score = 2
    else if (needle.length >= 4 && haystack.split(' ').some((word) =>
      withinDistance(needle, word, 1) !== null)) score = 1

    if (score === 0) continue
    seen.add(key)
    scored.push({ entry, score })
  }

  return scored
    .sort((a, b) =>
      b.score - a.score ||
      b.entry.weight - a.entry.weight ||
      a.entry.label.length - b.entry.label.length ||
      a.entry.label.localeCompare(b.entry.label))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ entry }) => ({ kind: entry.kind, slug: entry.slug, label: entry.label }))
}

export type SearchResult = {
  data: ListingSummary[]
  page: { limit: number; has_more: boolean; next_cursor: string | null }
  facets: SearchFacets
  /** The query the results are actually for, when it is not the one typed. */
  corrected_from: string | null
  /** Somewhere to go when there is nothing. Empty whenever there are results. */
  alternatives: Suggestion[]
}

async function runSearch(
  session: ReadSession, url: URL, raw: string, now: Date,
): Promise<SearchResult> {
  const buckets = whenBuckets(now)
  const centre = parseCentre(url)
  const offset = rankOffset(url)

  const first = await execute(session, url, raw, now, buckets, { withVocabulary: raw !== '' })

  // A query that found something is never second-guessed. Only an empty result
  // pays for the correction pass — and it pays for it with a round trip that
  // the successful path never makes.
  let corrected: string | null = null
  let outcome = first
  // `exact=1` is the reader saying "I meant what I typed" — the link the page
  // offers next to "showing results for a corrected spelling". Without it a
  // correction the reader has just rejected would be applied again.
  const exact = url.searchParams.get('exact') === '1'
  if (!exact && raw && first.listings.length === 0 && first.vocabulary) {
    const words = vocabularyWords(first.vocabulary.map((entry) => entry.label))
    const attempt = correct(raw, words)
    if (attempt.from !== null) {
      const second = await execute(session, url, attempt.query, now, buckets, { withVocabulary: false })
      if (second.listings.length > 0) {
        outcome = second
        corrected = attempt.from
      }
    }
  }

  const ranked = rankListings(outcome.listings, {
    terms: outcome.terms,
    now,
    centre: centre ? { lat: centre.lat, lng: centre.lng } : undefined,
    popularity: outcome.popularity,
  })

  const limit = outcome.limit
  const window = ranked.slice(offset, offset + limit)
  const hasMore = ranked.length > offset + limit

  // Distance is reported here and filtered in SQL: the radius reached the
  // query as a circle (api/lib/geo.ts), so every row that came back is inside
  // it and the facet counts describe the same set. What is left for the Worker
  // is the exact haversine for display, which may differ from the flat-earth
  // filter by metres at the boundary.
  const data = centre
    ? window.map((listing) => withDistance(listing, centre))
    : window

  return {
    data,
    page: {
      limit,
      has_more: hasMore,
      next_cursor: hasMore ? encodeRankCursor(offset + limit) : null,
    },
    facets: outcome.facets,
    corrected_from: corrected,
    alternatives: outcome.listings.length === 0
      ? alternativesFor(raw, first.vocabulary ?? [])
      : [],
  }
}

/**
 * Somewhere to go from a dead end (#42).
 *
 * The near-misses first: a search for "Kutumbaa" that found nothing should
 * offer Kutumba. When the query resembles nothing in the catalogue at all —
 * which is the *worst* dead end, not a lesser one — it falls back to the
 * broadest entry points there are, so the page always has somewhere to send
 * the reader rather than an apology.
 */
export function alternativesFor(raw: string, vocabulary: VocabularyRow[]): Suggestion[] {
  const near = suggest(raw, vocabulary).slice(0, MAX_ALTERNATIVES)
  if (near.length > 0) return near

  const broad = vocabulary.filter((entry) =>
    entry.kind === 'category' || entry.kind === 'city')
  return broad
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
    .slice(0, MAX_ALTERNATIVES)
    .map((entry) => ({ kind: entry.kind, slug: entry.slug, label: entry.label }))
}

function withDistance(
  listing: ListingSummary, centre: { lat: number; lng: number },
): ListingSummary {
  if (listing.latitude === null || listing.longitude === null) return listing
  const km = haversineKm(centre.lat, centre.lng, listing.latitude, listing.longitude)
  return { ...listing, distance_km: Math.round(km * 10) / 10 }
}

type Execution = {
  listings: ListingSummary[]
  terms: SearchTerm[]
  facets: SearchFacets
  popularity: Map<string, number>
  vocabulary: VocabularyRow[] | null
  limit: number
}

/**
 * One round trip: candidates, facet counts and — on the first attempt only —
 * the vocabulary the correction pass would need. Fetching the vocabulary
 * speculatively is cheaper than fetching it conditionally: it rides in a batch
 * that is already being sent, where a second attempt would cost a whole trip.
 */
async function execute(
  session: ReadSession, url: URL, query: string, now: Date,
  buckets: ReturnType<typeof whenBuckets>,
  { withVocabulary }: { withVocabulary: boolean },
): Promise<Execution> {
  const filters = parseFeedFilters(url, { withSearch: true, withCursor: false })
  filters.terms = query ? parseTerms(query) : undefined

  // A query of nothing but punctuation — `?q=%` — folds away to no terms at
  // all. Letting that through would answer a search for "%" with the entire
  // catalogue, which is the one answer that is certainly wrong.
  if (query && (filters.terms?.length ?? 0) === 0) {
    return {
      listings: [], terms: [], popularity: new Map(), limit: filters.limit,
      facets: { city: [], category: [], price: [], when: [] },
      vocabulary: withVocabulary ? await loadVocabulary(session, now) : null,
    }
  }

  const candidates = buildCandidateQuery(filters, {
    candidates: SEARCH_CANDIDATES,
    popularitySince: new Date(now.getTime() - POPULARITY_WINDOW_DAYS * 86_400_000).toISOString(),
  })
  const facets = buildFacetQuery(filters, buckets)
  const vocabulary = withVocabulary ? vocabularyQueries(now.toISOString(), VOCABULARY_LIMIT) : []

  const statements = [
    { sql: candidates.sql, params: candidates.params },
    { sql: facets.sql, params: facets.params },
    ...vocabulary,
  ]
  const [candidateRows, facetRows, ...vocabularyGroups] =
    await session.batch<Record<string, unknown>>(statements)

  const popularity = new Map<string, number>()
  for (const row of candidateRows ?? []) {
    popularity.set(row.id as string, Number(row.recent_views ?? 0))
  }

  return {
    listings: (candidateRows ?? []).map(toListingSummary),
    terms: filters.terms ?? [],
    facets: toFacets((facetRows ?? []) as FacetRow[], buckets),
    popularity,
    vocabulary: withVocabulary
      ? (vocabularyGroups.flat() as unknown as VocabularyRow[])
      : null,
    limit: filters.limit,
  }
}

type FacetRow = {
  facet: keyof SearchFacets
  value: string
  label: string
  label_ne: string | null
  count: number
}

/**
 * The flat UNION comes back as one list; this is where it becomes four.
 * Anything the shape does not recognise is dropped rather than crashing the
 * search — a facet is a refinement, and a search that fails because a
 * refinement could not be counted has its priorities backwards.
 */
export function toFacets(rows: FacetRow[], buckets: ReturnType<typeof whenBuckets>): SearchFacets {
  const facets: SearchFacets = { city: [], category: [], price: [], when: [] }
  const byBucket = new Map(buckets.map((bucket) => [bucket.value, bucket]))

  for (const row of rows) {
    const list = facets[row.facet]
    if (!list || !row.value) continue
    const facet: Facet = {
      value: row.value,
      label: row.label || row.value,
      label_ne: row.label_ne ?? null,
      count: Number(row.count),
    }
    if (row.facet === 'when') {
      const bucket = byBucket.get(row.value as never)
      if (!bucket) continue
      facet.label = bucket.label
      facet.from = bucket.from
      facet.to = bucket.to
    }
    if (row.facet === 'price') facet.label = PRICE_LABELS[row.value] ?? row.value
    list.push(facet)
  }

  // The date facets read as a timeline, not a leaderboard: "Later" above
  // "Today" because more falls in it is a list nobody can scan.
  const order = buckets.map((bucket) => bucket.value as string)
  facets.when.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value))
  return facets
}

const PRICE_LABELS: Record<string, string> = {
  free: 'Free', ticketed: 'Ticketed', announcement: 'Announcement',
}

/**
 * A ranked page has no keyset to page by — the order is a score computed in
 * the Worker, not a column — so the cursor is an offset into the ranked list.
 * Opaque like every other cursor, and rejected rather than coerced when it is
 * not one this API issued.
 */
const RANK_CURSOR_PREFIX = 'r:'

export function encodeRankCursor(offset: number): string {
  return btoa(`${RANK_CURSOR_PREFIX}${offset}`).replace(/=+$/, '')
}

function rankOffset(url: URL): number {
  const raw = url.searchParams.get('cursor')
  if (!raw) return 0
  try {
    const decoded = atob(raw + '='.repeat((4 - (raw.length % 4)) % 4))
    if (!decoded.startsWith(RANK_CURSOR_PREFIX)) return 0
    const offset = Number(decoded.slice(RANK_CURSOR_PREFIX.length))
    return Number.isInteger(offset) && offset >= 0 && offset < SEARCH_CANDIDATES ? offset : 0
  } catch (cause) {
    // A cursor we did not issue, or one that has been truncated. Starting from
    // the beginning is the right behaviour; a rate of these is a sign that
    // something is generating them (#50).
    swallowed('search_cursor_decode', cause)
    return 0
  }
}
