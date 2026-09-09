import { Hono } from 'hono'
import type { Env } from '../env'
import { badRequest } from '../lib/http'
import { rowsOf, withRoundTrips, writeSession } from '../lib/d1'
import { auditStatement } from '../lib/audit'
import { bumpCatalogVersion } from '../lib/cache'
import { boundingBox } from '../lib/geo'
import { uniqueSlug, slugify } from '../lib/slug'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import {
  DUPLICATE_DISTANCE_M, duplicateMessage, findDuplicates, normaliseVenueName,
  rankVenueMatches, shouldSuggestCreate, tokensOf, type VenueRow,
} from './venueMatch'
import { validateVenue, type VenueInput } from './validate'

/**
 * The venue half of the listing wizard (#31): find the venue that already
 * exists, and make adding a second copy of it the harder path.
 *
 * Search-before-create is the whole interaction. If creating a venue is easier
 * than finding one, everyone creates one, and the catalogue re-accumulates the
 * duplicates #21 was built to remove.
 *
 * These read the **primary**, not a replica, and are not edge-cached. Both
 * follow from the same fact: an author who has just created a venue and typed
 * its name into the box must find it. `lookups.ts` reads the primary for
 * exactly this reason, and a cached autocomplete keyed on arbitrary text would
 * be a cache that never hits and a catalogue view that lags the writer.
 */
export const authorVenueRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

/** How many rows the SQL prefilter hands the ranker. */
const SEARCH_CANDIDATES = 60
/** How many ranked rows come back; an autocomplete list nobody scrolls. */
const SEARCH_RESULTS = 10
const MIN_QUERY = 2
/** A bound on how much of the catalogue a near-duplicate check may consider. */
const DUPLICATE_CANDIDATES = 200

/** The columns everything in this file works from. */
const VENUE_COLUMNS = `v.id, v.slug, v.name, v.area, v.city, v.address,
                       v.latitude, v.longitude`

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`)

// ─── GET /api/author/venues ──────────────────────────────────────────────────
/**
 * Autocomplete over existing venues. One round trip, always.
 *
 * The ORDER BY here is a coarse copy of the ranking in `venueMatch.ts`, and
 * that duplication is deliberate rather than sloppy: the LIMIT has to keep the
 * rows most likely to win, and SQL is the only place that can decide which 60
 * rows survive. What SQL cannot do is normalise — it has no view of Devanagari
 * transliteration, of punctuation, or of where a word starts — so the rows it
 * keeps are re-ranked properly in the Worker before anybody sees them. Same
 * division of labour as `api/lib/geo.ts`: the index narrows, the Worker decides.
 */
authorVenueRoutes.get('/venues', requirePermission('listing:create'), async (c) => {
  const raw = (new URL(c.req.url).searchParams.get('q') ?? '').trim()
  if (raw.length < MIN_QUERY) {
    throw badRequest('query_too_short', `Type at least ${MIN_QUERY} characters to search venues`)
  }

  const session = writeSession(c.env)
  const normalised = normaliseVenueName(raw)
  const pattern = `%${escapeLike(raw)}%`
  const prefix = `${escapeLike(raw)}%`
  const slugPattern = `%${escapeLike(slugify(raw))}%`

  const [rows] = await session.batch([
    c.env.DB.prepare(
      `SELECT ${VENUE_COLUMNS},
              (SELECT COUNT(*) FROM listings l
                WHERE l.venue_id = v.id AND l.status = 'published') AS listing_count
         FROM venues v
        WHERE v.name LIKE ?2 ESCAPE '\\'
           OR v.slug LIKE ?5 ESCAPE '\\'
           OR v.area LIKE ?2 ESCAPE '\\'
           OR v.city LIKE ?2 ESCAPE '\\'
           OR v.address LIKE ?2 ESCAPE '\\'
        ORDER BY CASE
                   WHEN LOWER(v.name) = LOWER(?1) THEN 0
                   WHEN LOWER(v.name) LIKE ?3 ESCAPE '\\' THEN 1
                   WHEN v.name LIKE ?2 ESCAPE '\\' THEN 2
                   ELSE 3
                 END,
                 listing_count DESC,
                 v.name ASC
        LIMIT ?4`,
    ).bind(raw, pattern, prefix.toLowerCase(), SEARCH_CANDIDATES, slugPattern),
  ])

  const ranked = rankVenueMatches(raw, rowsOf<VenueRow>(rows)).slice(0, SEARCH_RESULTS)

  return withRoundTrips(Response.json({
    query: raw,
    normalised_query: normalised,
    data: ranked,
    /**
     * The acceptance criterion, answered by the server: *searching an existing
     * venue returns it before offering to create a new one*. False here means
     * the venue typed already exists exactly, and the picker should not lead
     * with "add a new one".
     */
    suggest_create: shouldSuggestCreate(ranked),
  }), session)
})

// ─── Reading the body ────────────────────────────────────────────────────────
// Same convention as `write.ts`: `undefined` is "not sent", `null` is "cleared".

const str = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export function parseVenueInput(body: unknown): Partial<VenueInput> & { confirm_duplicate: boolean } {
  if (typeof body !== 'object' || body === null) {
    throw badRequest('invalid_body', 'Send a JSON object')
  }
  const raw = body as Record<string, unknown>
  return {
    // Never null, for the same reason a listing's title is not: a venue with no
    // name has an empty one, and validation reports that far more usefully than
    // a missing key.
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    description: str(raw.description),
    address: str(raw.address),
    area: str(raw.area),
    city: str(raw.city),
    district: str(raw.district),
    province: str(raw.province),
    country: str(raw.country) ?? 'NP',
    latitude: num(raw.latitude),
    longitude: num(raw.longitude),
    google_place_id: str(raw.google_place_id),
    website_url: str(raw.website_url),
    phone: str(raw.phone),
    capacity: num(raw.capacity),
    // The author's answer to a warning they have already been shown. Absent on
    // a first attempt by construction, because the warning has not happened yet.
    confirm_duplicate: raw.confirm_duplicate === true,
  }
}

// ─── POST /api/author/venues ─────────────────────────────────────────────────
/**
 * Create a venue, with duplicate detection.
 *
 * Two round trips when it succeeds, one when it refuses. The first batch does
 * three jobs at once — near-duplicate candidates, a Google place id collision,
 * and every slug already taken around the one this name wants — because each
 * of them is an independent read and doing them in sequence would be 600ms from
 * Kathmandu for a form submission (docs/ARCHITECTURE.md).
 *
 * **Why a warning refuses the write rather than riding along with it.** The
 * obvious alternative is to create the venue and return the warning beside it,
 * which never blocks anybody. It also does not work: the duplicate is in the
 * catalogue by the time anyone reads the warning, and undoing it is a merge
 * nobody will do. Refusing and asking for `confirm_duplicate: true` costs one
 * extra request in the case where the author genuinely means it, and that is
 * the case we can afford to charge. The refusal names the venue it resembles
 * and how far away it is, so "use that one instead" is a decision the author
 * can actually make.
 *
 * A matching `google_place_id` is not a warning. Two rows cannot hold one place
 * id — migration 0001 has a unique index on it — and more to the point, Google
 * saying "this is the same place" is not a resemblance, it is an identity.
 */
authorVenueRoutes.post('/venues', requirePermission('venue:create'), async (c) => {
  const user = c.get('user')
  const input = parseVenueInput(await c.req.json().catch(() => {
    throw badRequest('invalid_body', 'Send a JSON object')
  }))

  const errors = validateVenue(input)
  if (errors.length > 0) {
    return c.json({
      error: {
        code: 'invalid_venue',
        message: 'Some things need fixing before this venue can be saved',
        fields: errors,
      },
    }, 400)
  }

  const name = input.name!
  const session = writeSession(c.env)
  const base = slugify(name) || 'venue'

  const [candidates, placeIdMatch, slugSiblings] = await session.batch([
    duplicateCandidateStatement(c.env, input),
    c.env.DB.prepare(
      `SELECT id, slug, name FROM venues WHERE google_place_id IS NOT NULL AND google_place_id = ?1`,
    ).bind(input.google_place_id ?? null),
    // Every slug this name could collide with, fetched once. `uniqueSlug`
    // otherwise probes the database per candidate, and -2, -3, -4 is three
    // round trips for a naming collision nobody will ever see.
    c.env.DB.prepare('SELECT slug FROM venues WHERE slug LIKE ?1').bind(`${base.slice(0, 76)}%`),
  ])

  const existingPlace = rowsOf<{ id: string; slug: string; name: string }>(placeIdMatch)[0]
  if (existingPlace) {
    return withRoundTrips(c.json({
      error: {
        code: 'venue_exists',
        message: `Google says that is “${existingPlace.name}”, which is already in the catalogue. Use it instead.`,
        fields: [{ field: 'google_place_id', message: `Pick “${existingPlace.name}” from the list` }],
      },
      venue: existingPlace,
    }, 409), session)
  }

  const duplicates = findDuplicates(
    { name, city: input.city ?? null, latitude: input.latitude ?? null, longitude: input.longitude ?? null },
    rowsOf<VenueRow>(candidates),
  )

  if (duplicates.length > 0 && !input.confirm_duplicate) {
    const first = duplicates[0]!
    return withRoundTrips(c.json({
      error: {
        code: 'possible_duplicate',
        message: duplicateMessage(first),
        fields: [{ field: first.reason === 'distance' ? 'latitude' : 'name', message: duplicateMessage(first) }],
      },
      duplicates,
    }, 409), session)
  }

  const taken = new Set(rowsOf<{ slug: string }>(slugSiblings).map((row) => row.slug))
  // Async by signature, but every answer is already in memory: no round trip.
  const slug = await uniqueSlug(name, async (candidate) => taken.has(candidate), 'venue')

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await session.batch([
    c.env.DB.prepare(
      `INSERT INTO venues (
         id, slug, name, description, address, area, city, district, province,
         country, latitude, longitude, google_place_id, website_url, phone,
         capacity, is_verified, created_by, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 ?15, ?16, 0, ?17, ?18, ?18)`,
    ).bind(
      id, slug, name, input.description ?? null, input.address ?? null,
      input.area ?? null, input.city ?? null, input.district ?? null,
      input.province ?? null, (input.country ?? 'NP').toUpperCase(),
      input.latitude ?? null, input.longitude ?? null,
      input.google_place_id ?? null, input.website_url ?? null,
      input.phone ?? null, input.capacity ?? null, user.id, now,
    ),
    // The audit records that a warning was overridden, and which venue it named.
    // Somebody merging duplicates later needs to know whether this one was a
    // considered decision or a warning nobody read (#28).
    auditStatement(c.env, {
      entityType: 'venue', entityId: id, action: 'created',
      actorId: user.id, actorRole: user.role,
      details: {
        slug,
        confirmed_over_duplicates: duplicates.length > 0
          ? duplicates.map((d) => ({ id: d.id, reason: d.reason, distance_m: d.distance_m }))
          : undefined,
      },
    }),
  ])

  // A new venue shows on /api/catalog/venues, which every colo has cached.
  // Off the response path — an author waiting on a KV write is 200ms of nothing.
  c.executionCtx.waitUntil(bumpCatalogVersion(c.env))

  return withRoundTrips(c.json({
    id, slug, name,
    city: input.city ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    // Returned even on success: the author confirmed past these, and the wizard
    // should be able to say so rather than pretend the question never came up.
    duplicates,
  }, 201), session)
})

/**
 * The candidate set a near-duplicate could be hiding in.
 *
 * A bounding box around the pin (the `(latitude, longitude)` index from
 * migration 0001), plus a LIKE probe per meaningful word in the name. It is a
 * prefilter and it is allowed to be imprecise in one direction only: it may
 * hand over rows that turn out not to match, and `findDuplicates` throws those
 * away. What it must not do is miss one, and the miss it accepts knowingly is a
 * duplicate that shares no word with the original and sits nowhere near it —
 * which is not a duplicate anybody would recognise either.
 */
function duplicateCandidateStatement(env: Env, input: Partial<VenueInput>) {
  const clauses: string[] = []
  const params: unknown[] = []

  if (input.latitude != null && input.longitude != null) {
    const box = boundingBox(input.latitude, input.longitude, DUPLICATE_DISTANCE_M / 1000)
    clauses.push(`(v.latitude BETWEEN ?${params.length + 1} AND ?${params.length + 2}
                   AND v.longitude BETWEEN ?${params.length + 3} AND ?${params.length + 4})`)
    params.push(box.minLat, box.maxLat, box.minLng, box.maxLng)
  }

  // The longest words first: they are the ones that identify a place, and
  // capping the probes keeps the statement bounded whatever somebody types.
  const words = tokensOf(input.name ?? '')
    .filter((token) => token.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 4)
  for (const word of words) {
    params.push(`%${escapeLike(word)}%`)
    clauses.push(`v.name LIKE ?${params.length} ESCAPE '\\'`)
  }

  // A name of nothing but very short words still has to be checked against
  // something, so fall back to the whole name.
  if (clauses.length === 0) {
    params.push(`%${escapeLike(input.name ?? '')}%`)
    clauses.push(`v.name LIKE ?${params.length} ESCAPE '\\'`)
  }

  params.push(DUPLICATE_CANDIDATES)
  return env.DB.prepare(
    `SELECT ${VENUE_COLUMNS} FROM venues v
      WHERE ${clauses.join(' OR ')}
      LIMIT ?${params.length}`,
  ).bind(...params)
}
