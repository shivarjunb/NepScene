import type { BoundingBox, Circle } from '../lib/geo'
import type { Cursor } from '../lib/cursor'
import type { SearchTerm } from './terms'
import type { WhenBucket } from './when'

/**
 * One statement per endpoint, by design. Query complexity is free here and
 * round trips are not (docs/ARCHITECTURE.md): the whole database scans in
 * microseconds, while every extra sequential statement costs ~200ms from
 * Kathmandu. So categories come back as an aggregated JSON column rather than
 * as a second query.
 */
// Primary first, then by the taxonomy's own order. The pin reads element
// zero (api/catalog/pin.ts), so this ORDER BY is load-bearing, not cosmetic.
const CATEGORIES_JSON = `(
  SELECT json_group_array(json_object(
    'slug', c.slug, 'name', c.name, 'name_ne', c.name_ne, 'color', c.color, 'icon', c.icon,
    'is_primary', lc.is_primary
  ) ORDER BY lc.is_primary DESC, c.sort_order ASC)
  FROM listing_categories lc
  JOIN categories c ON c.id = lc.category_id
  WHERE lc.listing_id = l.id
) AS categories_json`

/**
 * The listing's first image, with its derivatives, on every feed row (#25).
 *
 * This is the correlated subquery that keeps a feed of twenty listings under
 * 500KB: without the derivatives here the card has nothing to build a srcset
 * from and falls back to the original, which is the WaahTickets behaviour this
 * feature exists to replace.
 */
const COVER_JSON = `(
  SELECT json_object(
    'id', m.id, 'r2_key', m.r2_key, 'kind', m.kind, 'mime_type', m.mime_type,
    'alt_text', m.alt_text, 'width', m.width, 'height', m.height,
    'derivatives', (
      SELECT json_group_array(json_object(
        'r2_key', d.r2_key, 'format', d.format, 'width', d.width
      ) ORDER BY d.width)
      FROM media_derivatives d WHERE d.media_id = m.id
    )
  )
  FROM listing_media m
  WHERE m.listing_id = l.id AND m.kind = 'image'
  ORDER BY m.sort_order
  LIMIT 1
) AS cover_json`

const TAGS_JSON = `(
  SELECT json_group_array(json_object('slug', t.slug, 'label', t.label) ORDER BY t.slug)
  FROM listing_tags lt
  JOIN tags t ON t.slug = lt.tag_slug
  WHERE lt.listing_id = l.id
) AS tags_json`

const LISTING_SUMMARY_COLUMNS = `
  l.id, l.slug, l.title, l.summary, l.listing_type, l.source,
  -- The Nepali half of the listing (#46). It rides on the summary rather than
  -- the detail because a card, a pin popup and a search result all have to be
  -- able to render in Nepali, and none of them fetches a detail payload.
  l.title_ne, l.summary_ne,
  l.starts_at, l.ends_at, l.is_all_day, l.timezone,
  l.cover_image_url, l.external_url, l.is_featured,
  -- The map draws popups straight from a feed row (#36), so the author's
  -- customisation (#32) has to travel with the summary. Leaving it to the
  -- detail payload would mean the public map silently ignoring what the wizard
  -- previewed — the exact drift #32 was written to end.
  l.map_popup_config,
  l.offer_url, l.offer_provider, l.offer_price_from_paisa,
  l.offer_currency, l.offer_sold_out, l.offer_checked_at,
  COALESCE(l.location_lat, v.latitude)  AS latitude,
  COALESCE(l.location_lng, v.longitude) AS longitude,
  v.id AS venue_id, v.slug AS venue_slug, v.name AS venue_name,
  v.area AS venue_area, v.city AS venue_city,
  o.id AS organizer_id, o.slug AS organizer_slug, o.name AS organizer_name,
  o.is_verified AS organizer_verified,
  ${CATEGORIES_JSON},
  ${COVER_JSON}`

/**
 * Free or ticketed, as one expression, used by the facet count and by the
 * filter that facet turns into — so a chip that says 8 leads to 8 listings.
 * An announcement is neither, and says so rather than being quietly counted as
 * free: nothing is on sale because there is nothing to attend yet.
 */
export const PRICE_BAND = `CASE
    WHEN l.listing_type = 'announcement' THEN 'announcement'
    -- A *known* zero is free. A null is an offer that could not be resolved,
    -- and COALESCEing it to zero would file every ticketed listing whose price
    -- has not been fetched under "Free" — the one mistake in this column that
    -- a reader acts on before discovering it (docs/SCOPE.md).
    WHEN l.listing_type = 'free' OR l.offer_price_from_paisa = 0 THEN 'free'
    ELSE 'ticketed'
  END`

/**
 * Everything a text query matches, as one string per row.
 *
 * Measured, not assumed: matching eight columns separately meant eight LIKEs
 * per spelling per row, and at ten thousand listings a two-word query with an
 * alias group behind it took ~100ms of pure string comparison. Concatenating
 * once and matching once is the same result for an eighth of the work — a
 * substring search over the join of the fields is exactly a substring search
 * over any one of them, because the separator cannot appear inside a pattern
 * that came from a single word.
 *
 * COALESCE on every part: `x || NULL` is NULL in SQL, so one absent summary
 * would otherwise erase the whole haystack and make the row unfindable.
 */
const SEARCH_HAYSTACK = `(
  COALESCE(l.title, '')      || ' ' || COALESCE(l.title_ne, '')   || ' ' ||
  COALESCE(l.summary, '')    || ' ' || COALESCE(l.summary_ne, '') || ' ' ||
  COALESCE(v.name, '')       || ' ' || COALESCE(v.area, '')       || ' ' ||
  COALESCE(v.city, '')       || ' ' || COALESCE(o.name, '')
)`

const LISTING_JOINS = `
  FROM listings l
  LEFT JOIN venues v        ON v.id = l.venue_id
  LEFT JOIN organizations o ON o.id = l.organization_id`

export type FeedFilters = {
  category?: string
  tag?: string
  artist?: string
  city?: string
  venue?: string
  organizer?: string
  listingType?: string
  /** The facet's free-versus-ticketed band, not a price. See PRICE_BAND. */
  priceBand?: string
  featured?: boolean
  from?: string
  to?: string
  includePast: boolean
  /**
   * Finished before this moment — `COALESCE(ends_at, starts_at) <`, the exact
   * inverse of the upcoming window. A `to` bound would not do: it tests
   * `starts_at`, so a festival that opened last week and is still running
   * would count as past on a venue's history page (#44).
   */
  finishedBefore?: string
  /** Text search, already folded, alias-expanded and capped (see terms.ts). */
  terms?: SearchTerm[]
  box?: BoundingBox
  /**
   * The exact radius, applied in SQL beside the box (see geo.ts). The box is
   * the index prefilter; this is the filter.
   */
  circle?: Circle
  cursor?: Cursor
  /**
   * Soonest-first everywhere the reader is looking forwards. A past list reads
   * backwards — the most recent thing that happened here is the one worth
   * showing first — which is the only place `desc` is used (#44).
   */
  order?: 'asc' | 'desc'
  limit: number
  now: string
}

export type SqlStatement = { sql: string; params: unknown[] }

/**
 * **D1 allows a hundred bound variables per statement, and no more.** Measured,
 * not assumed: at 101 it answers `too many SQL variables`. A search for four
 * alias-rich words, matched across eleven columns, would bind several hundred
 * if each placeholder took one — so every value below is bound *once* and
 * referenced by number (`?7`), and identical values share a number.
 *
 * That is what makes the facet query affordable at all: it repeats the same
 * WHERE four times over and binds nothing extra to do it, where positional
 * placeholders would have needed four copies of every parameter.
 */
export const MAX_SQL_VARIABLES = 100

class Binder {
  private readonly values: unknown[] = []
  private readonly seen = new Map<string, string>()

  /** The placeholder for a value — the same one every time it recurs. */
  of(value: unknown): string {
    const key = `${typeof value}:${String(value)}`
    const existing = this.seen.get(key)
    if (existing) return existing
    this.values.push(value)
    const placeholder = `?${this.values.length}`
    this.seen.set(key, placeholder)
    return placeholder
  }

  get params(): unknown[] {
    return this.values
  }
}

/**
 * Everything but the paging and the text — shared by the feed, by search and
 * by the facet counts, so a facet can never describe a different set of
 * listings than the results it sits next to.
 */
function buildBaseWhere(filters: FeedFilters, binder: Binder): string[] {
  const where: string[] = [`l.status = 'published'`]
  const p = (value: unknown) => binder.of(value)

  if (!filters.includePast) {
    // An event that started yesterday and ends tomorrow is still on, so the
    // window is on the end of the listing, not its start. This forfeits the
    // (status, starts_at, id) index for the range — acceptable while the
    // catalogue is small, and measured before it is optimised.
    where.push(`COALESCE(l.ends_at, l.starts_at) >= ${p(filters.now)}`)
  }
  if (filters.finishedBefore) {
    where.push(`COALESCE(l.ends_at, l.starts_at) < ${p(filters.finishedBefore)}`)
  }
  if (filters.from) where.push(`l.starts_at >= ${p(filters.from)}`)
  if (filters.to) where.push(`l.starts_at <= ${p(filters.to)}`)
  if (filters.category) {
    where.push(`EXISTS (
      SELECT 1 FROM listing_categories lc
      JOIN categories c2 ON c2.id = lc.category_id
      WHERE lc.listing_id = l.id AND c2.slug = ${p(filters.category)}
    )`)
  }
  if (filters.tag) {
    where.push(`EXISTS (
      SELECT 1 FROM listing_tags lt
      WHERE lt.listing_id = l.id AND lt.tag_slug = ${p(filters.tag)}
    )`)
  }
  if (filters.artist) {
    // The reverse of the artists on a listing detail: this is what makes the
    // relationship resolve in both directions without an artists table scan.
    where.push(`EXISTS (
      SELECT 1 FROM listing_artists la
      JOIN artists a2 ON a2.id = la.artist_id
      WHERE la.listing_id = l.id AND a2.slug = ${p(filters.artist)}
    )`)
  }
  if (filters.city) where.push(`LOWER(v.city) = LOWER(${p(filters.city)})`)
  if (filters.venue) where.push(`v.slug = ${p(filters.venue)}`)
  if (filters.organizer) where.push(`o.slug = ${p(filters.organizer)}`)
  if (filters.listingType) where.push(`l.listing_type = ${p(filters.listingType)}`)
  if (filters.priceBand) where.push(`${PRICE_BAND} = ${p(filters.priceBand)}`)
  if (filters.featured) where.push(`l.is_featured = 1`)
  if (filters.box) {
    // The box is the prefilter that can use the (latitude, longitude) index.
    where.push(`COALESCE(l.location_lat, v.latitude) BETWEEN ${p(filters.box.minLat)} AND ${p(filters.box.maxLat)}`)
    where.push(`COALESCE(l.location_lng, v.longitude) BETWEEN ${p(filters.box.minLng)} AND ${p(filters.box.maxLng)}`)
  }
  if (filters.circle) {
    // …and this is the filter. Squared distances, so no square root is needed
    // — the comparison is monotonic either way.
    const dLat = `(COALESCE(l.location_lat, v.latitude) - ${p(filters.circle.lat)})`
    const dLng = `(COALESCE(l.location_lng, v.longitude) - ${p(filters.circle.lng)})`
    where.push(`(${dLat} * ${dLat} * ${p(filters.circle.latScale)}
               + ${dLng} * ${dLng} * ${p(filters.circle.lngScale)})
               <= ${p(filters.circle.radiusKmSquared)}`)
  }

  return where
}

/**
 * One clause per word of the query, matched against a row that already carries
 * its own haystack (`hay`) and its id.
 *
 * Words are ANDed and spellings are ORed: "thamel jazz" means both words, and
 * either may be the Devanagari, the local or the misspelled form. The Nepali
 * columns are in the haystack beside the English ones rather than instead of
 * them, so a bilingual listing is found by whichever half the reader typed
 * (#46).
 *
 * The row's own text is tested first and the taxonomy after it, because a
 * correlated subquery per row is the expensive half and `OR` short-circuits —
 * a title match never reaches it. Both subqueries take the whole spelling list
 * at once rather than being repeated per spelling.
 */
function buildTextWhere(terms: SearchTerm[], binder: Binder): string[] {
  const clauses: string[] = []

  for (const term of terms) {
    const likes = term.patterns.map((pattern) => binder.of(`%${escapeLike(pattern)}%`))
    if (likes.length === 0) continue

    const direct = likes.map((like) => `hay LIKE ${like} ESCAPE '\\'`)
    const inCategories = likes
      .flatMap((like) => [`c3.name LIKE ${like} ESCAPE '\\'`, `c3.name_ne LIKE ${like} ESCAPE '\\'`])
      .join(' OR ')
    const inTags = likes.map((like) => `t3.label LIKE ${like} ESCAPE '\\'`).join(' OR ')

    clauses.push(`(
      ${direct.join(' OR ')}
      OR EXISTS (
        SELECT 1 FROM listing_categories lc3
        JOIN categories c3 ON c3.id = lc3.category_id
        WHERE lc3.listing_id = scanned.id AND (${inCategories})
      )
      OR EXISTS (
        SELECT 1 FROM listing_tags lt3
        JOIN tags t3 ON t3.slug = lt3.tag_slug
        WHERE lt3.listing_id = scanned.id AND (${inTags})
      )
    )`)
  }

  return clauses
}

/**
 * The two-stage scan a text query runs through, and the reason it exists.
 *
 * The obvious shape puts the haystack expression directly in the WHERE, once
 * per spelling. Measured at ten thousand listings, a two-word query with alias
 * groups behind both words — sixteen spellings — spent **114ms** in the
 * candidate query and 103ms in the facets, and the cost was almost linear in
 * the number of spellings: the row's eight fields were being concatenated into
 * a fresh string sixteen times per row.
 *
 * So the haystack becomes a column, computed once per row in `scanned`, and
 * the spellings are matched against that column in `matched`. Same rows, an
 * eighth of the string building.
 *
 * **`MATERIALIZED` is load-bearing, not a hint about taste.** Without it
 * SQLite flattens the CTE into its consumer and substitutes the haystack
 * expression back into every LIKE — reproducing exactly the cost this is here
 * to remove. It is also what stops the facet query scanning four times over,
 * once per aggregate.
 */
function textScan(
  filters: FeedFilters, binder: Binder, extraColumns: string,
): { sql: string; from: string } | null {
  const terms = filters.terms ?? []
  if (terms.length === 0) return null

  const base = buildBaseWhere(filters, binder)
  const text = buildTextWhere(terms, binder)

  return {
    sql: `WITH scanned AS MATERIALIZED (
            SELECT l.id AS id, ${SEARCH_HAYSTACK} AS hay${extraColumns}
            ${LISTING_JOINS}
            WHERE ${base.join(' AND ')}
          ),
          matched AS MATERIALIZED (
            SELECT * FROM scanned WHERE ${text.join(' AND ')}
          )`,
    from: 'matched',
  }
}

export function buildFeedQuery(filters: FeedFilters): SqlStatement {
  const binder = new Binder()
  const scan = textScan(filters, binder, '')
  // With a text query the base filters have already been applied inside the
  // scan, and the join to it is what carries them; without one they are the
  // whole WHERE.
  const where = scan
    ? [`l.id IN (SELECT id FROM matched)`]
    : buildBaseWhere(filters, binder)
  const descending = filters.order === 'desc'

  if (filters.cursor) {
    // Keyset, not OFFSET: page 40 costs the same as page 1, and rows cannot
    // shift between pages when something publishes mid-scroll. The comparison
    // follows the order, or a backwards page would walk forwards.
    const at = binder.of(filters.cursor.startsAt)
    const id = binder.of(filters.cursor.id)
    where.push(descending
      ? `(l.starts_at < ${at} OR (l.starts_at = ${at} AND l.id < ${id}))`
      : `(l.starts_at > ${at} OR (l.starts_at = ${at} AND l.id > ${id}))`)
  }

  // limit + 1: the extra row answers has_more without a COUNT(*).
  const limit = binder.of(filters.limit + 1)
  const direction = descending ? 'DESC' : 'ASC'

  return {
    sql: `${scan?.sql ?? ''}
          SELECT ${LISTING_SUMMARY_COLUMNS} ${LISTING_JOINS}
          WHERE ${where.join(' AND ')}
          ORDER BY l.starts_at ${direction}, l.id ${direction}
          LIMIT ${limit}`,
    params: binder.params,
  }
}

/**
 * The candidate set a ranked search chooses from (#42).
 *
 * Identical filtering to the feed, plus the one signal ranking needs that is
 * not on a listing row: how many people have looked lately. It is a correlated
 * SUM rather than a join so the row count is unchanged and `LIMIT` still means
 * what it says.
 *
 * Ordered soonest-first and capped, because ranking happens in the Worker
 * (api/catalog/ranking.ts). That is a real ceiling and worth stating plainly:
 * a query matching more listings than the cap is ranked over the *soonest* of
 * them, not over all of them. Date proximity is the heaviest signal in the
 * blend, so the rows the cap discards are the rows ranking would have put last
 * anyway — but a search for something six months out, in a catalogue with a
 * cap's worth of matches before it, will not surface it. Paging is what
 * reaches those, and the cap is set well above a page.
 */
export function buildCandidateQuery(
  filters: FeedFilters,
  { candidates, popularitySince }: { candidates: number; popularitySince: string },
): SqlStatement {
  const binder = new Binder()
  const scan = textScan(filters, binder, '')
  const where = scan
    ? [`l.id IN (SELECT id FROM matched)`]
    : buildBaseWhere(filters, binder)
  const since = binder.of(popularitySince)
  const limit = binder.of(candidates)
  return {
    sql: `${scan?.sql ?? ''}
          SELECT ${LISTING_SUMMARY_COLUMNS},
            (SELECT COALESCE(SUM(s.views), 0) FROM listing_stats s
              WHERE s.listing_id = l.id AND s.day >= ${since}) AS recent_views
          ${LISTING_JOINS}
          WHERE ${where.join(' AND ')}
          ORDER BY l.starts_at ASC, l.id ASC
          LIMIT ${limit}`,
    params: binder.params,
  }
}

/**
 * Every facet count for a search, in one statement and — this is the part
 * that matters — **one scan**.
 *
 * The counts are taken over the *whole* matching set rather than over the page
 * or over the ranked candidates, which is the only reading of "accurate
 * counts" that survives paging: a city facet that said 12 on page one and 4 on
 * page two would be describing the page, not the search.
 *
 * The first version of this repeated the WHERE in each of four aggregates. It
 * was correct and it cost 664ms at ten thousand listings, because a text query
 * is a scan and that was four of them. The matched set now goes into a
 * MATERIALIZED CTE — the hint is load-bearing, since SQLite would otherwise
 * inline the CTE into each branch and reproduce exactly the four scans this
 * exists to avoid — and the aggregates group over the result.
 *
 * Four branches is also the ceiling: D1 refuses a compound SELECT of more than
 * five terms.
 */
export function buildFacetQuery(filters: FeedFilters, buckets: WhenBucket[]): SqlStatement {
  const binder = new Binder()

  // The last bucket is the fall-through, so only the boundaries before it are
  // tested; a listing that reaches the end of the chain is in it by exclusion.
  const whenCase = `CASE ${buckets.slice(0, -1)
    .map((bucket) => `WHEN l.starts_at < ${binder.of(bucket.to)} THEN '${bucket.value}'`)
    .join(' ')} ELSE '${buckets.at(-1)?.value ?? 'later'}' END`

  const columns = `, v.city AS city, ${PRICE_BAND} AS price, ${whenCase} AS bucket`
  const scan = textScan(filters, binder, columns)
  const cte = scan?.sql ?? `WITH matched AS MATERIALIZED (
            SELECT l.id AS id${columns}
            ${LISTING_JOINS}
            WHERE ${buildBaseWhere(filters, binder).join(' AND ')}
          )`

  return {
    sql: `${cte}
          SELECT 'city' AS facet, city AS value, city AS label, NULL AS label_ne,
                 COUNT(*) AS count
          FROM matched WHERE city IS NOT NULL AND city <> ''
          GROUP BY city

          UNION ALL
          -- The taxonomy's Nepali label rides along, so a filter chip reads in
          -- the reader's language like the card beside it (#46). A city has no
          -- second spelling to carry and a band and a bucket are labelled by
          -- the client, so those send null.
          SELECT 'category', c4.slug, c4.name, c4.name_ne, COUNT(*)
          FROM matched
          JOIN listing_categories lc4 ON lc4.listing_id = matched.id
          JOIN categories c4         ON c4.id = lc4.category_id
          GROUP BY c4.slug, c4.name, c4.name_ne

          UNION ALL
          SELECT 'price', price, price, NULL, COUNT(*) FROM matched GROUP BY price

          UNION ALL
          SELECT 'when', bucket, bucket, NULL, COUNT(*) FROM matched GROUP BY bucket

          ORDER BY facet ASC, count DESC, value ASC`,
    params: binder.params,
  }
}

/**
 * The words the catalogue actually contains (#42): what suggestions are drawn
 * from, and what a misspelling is corrected against.
 *
 * Corrections are made against this rather than against a dictionary because
 * the corpus is proper nouns. "Kutumba" is not a word and no spell checker
 * would leave it alone — but it is a band with listings, so it is in here, and
 * "Kutumbaa" resolves to it.
 *
 * **Two statements, not one, and the reason is a hard limit rather than a
 * preference.** D1 refuses a compound SELECT of more than five terms
 * (`too many terms in compound SELECT`), and there are nine things worth
 * knowing the names of. They go in the same batch, so this costs no extra
 * round trip — only the discipline of keeping each group at five.
 *
 * Bounded at every branch. This is a reference read served from the edge cache
 * for minutes at a time, and an unbounded one would put the whole catalogue in
 * a response nobody asked for.
 */
export const VOCABULARY_COMPOUND_LIMIT = 5

export function vocabularyQueries(now: string, limit: number): SqlStatement[] {
  const upcoming = `l.status = 'published' AND COALESCE(l.ends_at, l.starts_at) >= ?1`
  return [
    {
      sql: `SELECT kind, slug, label, weight FROM (
              SELECT * FROM (
                SELECT 'listing' AS kind, l.slug AS slug, l.title AS label, 3 AS weight
                FROM listings l WHERE ${upcoming}
                ORDER BY l.starts_at ASC LIMIT ?2
              )
              UNION ALL
              -- The Nepali title is a separate entry rather than a second
              -- column: it is a different string to match, suggest and correct
              -- against (#46).
              SELECT * FROM (
                SELECT 'listing', l.slug, l.title_ne, 3
                FROM listings l WHERE ${upcoming} AND l.title_ne IS NOT NULL
                ORDER BY l.starts_at ASC LIMIT ?2
              )
              UNION ALL
              SELECT * FROM (
                SELECT 'venue', v.slug, v.name, 2 FROM venues v
                WHERE EXISTS (SELECT 1 FROM listings l WHERE l.venue_id = v.id AND ${upcoming})
                ORDER BY v.slug ASC LIMIT ?2
              )
              UNION ALL
              SELECT * FROM (
                SELECT 'city', LOWER(v.city), MIN(v.city), 2 FROM venues v
                WHERE v.city IS NOT NULL AND v.city <> '' GROUP BY LOWER(v.city)
                LIMIT ?2
              )
              UNION ALL
              SELECT * FROM (
                SELECT 'area', LOWER(v.area), MIN(v.area), 1 FROM venues v
                WHERE v.area IS NOT NULL AND v.area <> '' GROUP BY LOWER(v.area)
                LIMIT ?2
              )
            )
            WHERE label IS NOT NULL AND label <> ''`,
      params: [now, limit],
    },
    {
      sql: `SELECT kind, slug, label, weight FROM (
              SELECT 'organizer' AS kind, o.slug AS slug, o.name AS label, 2 AS weight
              FROM organizations o
              WHERE EXISTS (SELECT 1 FROM listings l WHERE l.organization_id = o.id AND ${upcoming})
              UNION ALL
              SELECT 'artist', a.slug, a.name, 2 FROM artists a
              WHERE EXISTS (SELECT 1 FROM listing_artists la
                              JOIN listings l ON l.id = la.listing_id
                             WHERE la.artist_id = a.id AND ${upcoming})
              UNION ALL
              SELECT 'category', c.slug, c.name, 1 FROM categories c WHERE c.is_active = 1
              UNION ALL
              SELECT 'category', c.slug, c.name_ne, 1 FROM categories c
              WHERE c.is_active = 1 AND c.name_ne IS NOT NULL
              UNION ALL
              SELECT 'tag', t.slug, t.label, 1 FROM tags t
              WHERE EXISTS (SELECT 1 FROM listing_tags lt
                              JOIN listings l ON l.id = lt.listing_id
                             WHERE lt.tag_slug = t.slug AND ${upcoming})
            )
            WHERE label IS NOT NULL AND label <> ''
            LIMIT ?2`,
      params: [now, limit],
    },
  ]
}

/**
 * What else to read after this one (#43).
 *
 * Relatedness is ranked, not filtered: same venue beats same organizer beats
 * shared category, and the soonest wins inside each band. A UNION of three
 * queries would return the same rows and leave the ordering to chance.
 *
 * The listing is named by slug and resolved in a CTE rather than by ids passed
 * in from a previous response, so this can be batched *alongside* the detail
 * query instead of after it — one round trip for the page rather than two
 * (docs/ARCHITECTURE.md, rule 4). It also excludes itself in SQL, so a rail of
 * four is four other listings, not three and the one already on screen.
 */
export function relatedListingsQuery(
  { slug, limit, now }: { slug: string; limit: number; now: string },
): SqlStatement {
  return {
    sql: `WITH target AS (
            SELECT id, venue_id, organization_id FROM listings
            WHERE slug = ?1 AND status = 'published'
          )
          SELECT ${LISTING_SUMMARY_COLUMNS},
            CASE
              WHEN l.venue_id IS NOT NULL AND l.venue_id = t.venue_id THEN 3
              WHEN l.organization_id IS NOT NULL
                   AND l.organization_id = t.organization_id THEN 2
              ELSE 1
            END AS relatedness
          ${LISTING_JOINS}
          JOIN target t
          WHERE l.status = 'published'
            AND COALESCE(l.ends_at, l.starts_at) >= ?2
            AND l.id <> t.id
            AND (
              (l.venue_id IS NOT NULL AND l.venue_id = t.venue_id)
              OR (l.organization_id IS NOT NULL AND l.organization_id = t.organization_id)
              OR EXISTS (
                SELECT 1 FROM listing_categories mine
                JOIN listing_categories theirs ON theirs.category_id = mine.category_id
                WHERE mine.listing_id = l.id AND theirs.listing_id = t.id
              )
            )
          ORDER BY relatedness DESC, l.starts_at ASC, l.id ASC
          LIMIT ?3`,
    params: [slug, now, limit],
  }
}

export function listingBySlugQuery(slug: string): SqlStatement {
  return {
    sql: `SELECT ${LISTING_SUMMARY_COLUMNS},
            l.description, l.description_ne, l.map_popup_config, l.published_at, l.venue_room,
            v.address AS venue_address, v.district AS venue_district,
            v.province AS venue_province, v.latitude AS venue_latitude,
            v.longitude AS venue_longitude,
            (SELECT json_group_array(json_object(
               'id', m.id, 'r2_key', m.r2_key, 'kind', m.kind, 'mime_type', m.mime_type,
               'alt_text', m.alt_text, 'width', m.width, 'height', m.height,
               'derivatives', (
                 SELECT json_group_array(json_object(
                   'r2_key', d.r2_key, 'format', d.format, 'width', d.width
                 ) ORDER BY d.width)
                 FROM media_derivatives d WHERE d.media_id = m.id
               )
             ) ORDER BY m.sort_order)
             FROM listing_media m WHERE m.listing_id = l.id) AS media_json,
            -- The count rides along so the page can decide whether an artist
            -- name is a link. Without it the listing would link to a page the
            -- API refuses to serve below its threshold (api/catalog/places.ts).
            (SELECT json_group_array(json_object(
               'slug', a.slug, 'name', a.name, 'image_url', a.image_url,
               'listing_count', (
                 SELECT COUNT(*) FROM listing_artists la2
                 JOIN listings l2 ON l2.id = la2.listing_id
                 WHERE la2.artist_id = a.id AND l2.status = 'published'
               )
             ) ORDER BY la.billing_order)
             FROM listing_artists la JOIN artists a ON a.id = la.artist_id
             WHERE la.listing_id = l.id) AS artists_json,
            ${TAGS_JSON}
          ${LISTING_JOINS}
          WHERE l.slug = ? AND l.status = 'published'
          LIMIT 1`,
    params: [slug],
  }
}

/** Only run on a slug miss — a redirect lookup must not cost every request. */
export function slugRedirectQuery(entityType: string, oldSlug: string): SqlStatement {
  return {
    sql: `SELECT r.entity_id,
            CASE ?1
              WHEN 'listing' THEN (SELECT slug FROM listings      WHERE id = r.entity_id)
              WHEN 'venue'   THEN (SELECT slug FROM venues        WHERE id = r.entity_id)
              ELSE                (SELECT slug FROM organizations WHERE id = r.entity_id)
            END AS current_slug
          FROM slug_redirects r
          WHERE r.entity_type = ?1 AND r.old_slug = ?2
          LIMIT 1`,
    params: [entityType, oldSlug],
  }
}

export function venuesQuery(
  { city, query, cursor, limit, now }:
  { city?: string; query?: string; cursor?: string; limit: number; now: string },
): SqlStatement {
  const where: string[] = ['1 = 1']
  const params: unknown[] = [now]
  if (city) {
    where.push('LOWER(v.city) = LOWER(?)')
    params.push(city)
  }
  if (query) {
    const pattern = `%${escapeLike(query)}%`
    where.push(`(v.name LIKE ? ESCAPE '\\' OR v.area LIKE ? ESCAPE '\\' OR v.city LIKE ? ESCAPE '\\')`)
    params.push(pattern, pattern, pattern)
  }
  if (cursor) {
    where.push('v.slug > ?')
    params.push(cursor)
  }
  params.push(limit + 1)
  return {
    sql: `SELECT v.id, v.slug, v.name, v.area, v.city, v.district, v.province,
                 v.address, v.latitude, v.longitude, v.cover_image_url, v.is_verified,
                 (SELECT COUNT(*) FROM listings l
                   WHERE l.venue_id = v.id AND l.status = 'published'
                     AND COALESCE(l.ends_at, l.starts_at) >= ?) AS upcoming_listing_count
          FROM venues v
          WHERE ${where.join(' AND ')}
          ORDER BY v.slug ASC
          LIMIT ?`,
    params,
  }
}

export function venueBySlugQuery(slug: string, now: string): SqlStatement {
  return {
    sql: `SELECT v.id, v.slug, v.name, v.description, v.area, v.city, v.district,
                 v.province, v.address, v.latitude, v.longitude, v.google_place_id,
                 v.cover_image_url, v.website_url, v.phone, v.capacity, v.is_verified,
                 (SELECT COUNT(*) FROM listings l
                   WHERE l.venue_id = v.id AND l.status = 'published'
                     AND COALESCE(l.ends_at, l.starts_at) >= ?) AS upcoming_listing_count,
                 (SELECT COUNT(*) FROM listings l
                   WHERE l.venue_id = v.id AND l.status = 'published'
                     AND COALESCE(l.ends_at, l.starts_at) < ?) AS past_listing_count
          FROM venues v WHERE v.slug = ? LIMIT 1`,
    params: [now, now, slug],
  }
}

export function organizerBySlugQuery(slug: string, now: string): SqlStatement {
  return {
    sql: `SELECT o.id, o.slug, o.name, o.description, o.logo_url, o.website_url,
                 o.is_verified,
                 (SELECT COUNT(*) FROM listings l
                   WHERE l.organization_id = o.id AND l.status = 'published'
                     AND COALESCE(l.ends_at, l.starts_at) >= ?) AS upcoming_listing_count,
                 (SELECT COUNT(*) FROM listings l
                   WHERE l.organization_id = o.id AND l.status = 'published'
                     AND COALESCE(l.ends_at, l.starts_at) < ?) AS past_listing_count
          FROM organizations o WHERE o.slug = ? LIMIT 1`,
    params: [now, now, slug],
  }
}

/**
 * Organizers with something published, for the index page (#44).
 *
 * Inner in effect rather than in form: an organization row with no published
 * listing has no page worth linking to, and listing it would send people to an
 * empty one. The same reason the tag cloud is an inner join.
 */
export function organizersQuery(
  { query, cursor, limit, now }:
  { query?: string; cursor?: string; limit: number; now: string },
): SqlStatement {
  const where: string[] = [
    `EXISTS (SELECT 1 FROM listings l WHERE l.organization_id = o.id AND l.status = 'published')`,
  ]
  const params: unknown[] = [now, now]
  if (query) {
    const pattern = `%${escapeLike(query)}%`
    where.push(`o.name LIKE ? ESCAPE '\\'`)
    params.push(pattern)
  }
  if (cursor) {
    where.push('o.slug > ?')
    params.push(cursor)
  }
  params.push(limit + 1)
  return {
    sql: `SELECT o.id, o.slug, o.name, o.description, o.logo_url, o.website_url, o.is_verified,
                 (SELECT COUNT(*) FROM listings l
                   WHERE l.organization_id = o.id AND l.status = 'published'
                     AND COALESCE(l.ends_at, l.starts_at) >= ?) AS upcoming_listing_count,
                 (SELECT COUNT(*) FROM listings l
                   WHERE l.organization_id = o.id AND l.status = 'published'
                     AND COALESCE(l.ends_at, l.starts_at) < ?) AS past_listing_count
          FROM organizations o
          WHERE ${where.join(' AND ')}
          ORDER BY o.slug ASC
          LIMIT ?`,
    params,
  }
}

/**
 * An artist page exists only where there is enough to fill one (#44).
 *
 * The threshold is applied here, in the lookup, rather than in the handler:
 * "does this artist have a page" and "what is on it" have to be one answer, or
 * a link appears on a listing for a page that then 404s.
 */
export function artistBySlugQuery(slug: string, now: string): SqlStatement {
  return {
    sql: `SELECT a.id, a.slug, a.name, a.image_url, a.bio, a.links,
                 (SELECT COUNT(*) FROM listing_artists la
                    JOIN listings l ON l.id = la.listing_id
                   WHERE la.artist_id = a.id AND l.status = 'published') AS listing_count,
                 (SELECT COUNT(*) FROM listing_artists la
                    JOIN listings l ON l.id = la.listing_id
                   WHERE la.artist_id = a.id AND l.status = 'published'
                     AND COALESCE(l.ends_at, l.starts_at) >= ?) AS upcoming_listing_count
          FROM artists a WHERE a.slug = ? LIMIT 1`,
    params: [now, slug],
  }
}

export function categoriesQuery(now: string): SqlStatement {
  return {
    sql: `SELECT c.slug, c.name, c.name_ne, c.icon, c.color,
                 (SELECT COUNT(*) FROM listing_categories lc
                  JOIN listings l ON l.id = lc.listing_id
                  WHERE lc.category_id = c.id AND l.status = 'published'
                    AND COALESCE(l.ends_at, l.starts_at) >= ?) AS upcoming_listing_count
          FROM categories c
          WHERE c.is_active = 1
          ORDER BY c.sort_order ASC`,
    params: [now],
  }
}

/**
 * Tags that are actually on something upcoming. The join is inner on purpose:
 * a tag nobody has used since last winter is not a browse surface, it is a
 * dead chip, and a free-form vocabulary accumulates those quickly.
 */
export function tagsQuery(now: string, limit: number): SqlStatement {
  return {
    sql: `SELECT t.slug, t.label, COUNT(*) AS upcoming_listing_count
          FROM tags t
          JOIN listing_tags lt ON lt.tag_slug = t.slug
          JOIN listings l      ON l.id = lt.listing_id
          WHERE l.status = 'published' AND COALESCE(l.ends_at, l.starts_at) >= ?
          GROUP BY t.slug, t.label
          ORDER BY upcoming_listing_count DESC, t.slug ASC
          LIMIT ?`,
    params: [now, limit],
  }
}

/** LIKE wildcards in user input are literals, not operators. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
