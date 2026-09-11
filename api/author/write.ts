import { Hono } from 'hono'
import type { Env } from '../env'
import { badRequest, notFound } from '../lib/http'
import { numeric, rowsOf, text, withRoundTrips, writeSession, type WriteSession } from '../lib/d1'
import { auditStatement } from '../lib/audit'
import { bumpCatalogVersion } from '../lib/cache'
import { uniqueSlug } from '../lib/slug'
import { normaliseTags } from '../catalog/tags'
import { mediaUrl } from '../catalog/serialize'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { loadEditableListing } from './access'
import { LISTING_TYPES, validateListing, type ListingInput, type ListingType } from './validate'
import { parsePopupConfig, serialisePopupConfig } from './popupConfig'
import { swallowed } from '../lib/observability'

/**
 * Create, read-for-edit and update (#30). The status verbs live in
 * `listings.ts`; this file never writes `status` except to stamp a new row
 * `draft`.
 *
 * The governing decision: **a draft is not validated, a submission is.** The
 * wizard autosaves every few seconds, and a half-typed listing is the normal
 * state of a draft rather than an error to reject — refusing the save is how
 * you lose the thing autosave exists to protect. The rules in `validate.ts`
 * therefore gate the draft → pending_review transition, and nothing before it.
 */
export const authorWriteRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const MAX_ARTISTS = 20

// ─── Reading the body ────────────────────────────────────────────────────────
// Every field is coerced from untrusted JSON. `undefined` means "not sent" and
// is left alone by PATCH; `null` means "cleared" and is written.

const str = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

const num = (value: unknown): number | null | undefined => {
  if (value === undefined) return undefined
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined

export function parseListingInput(body: unknown): Partial<ListingInput> {
  if (typeof body !== 'object' || body === null) {
    throw badRequest('invalid_body', 'Send a JSON object')
  }
  const raw = body as Record<string, unknown>
  const input: Partial<ListingInput> = {}

  // Title is the one string that is never null: a listing with no title has an
  // empty one, which validation reports far more usefully than a missing key.
  if (raw.title !== undefined) input.title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (raw.summary !== undefined) input.summary = str(raw.summary) ?? null
  if (raw.description !== undefined) input.description = str(raw.description) ?? null
  // The Nepali half of a listing (#46). Optional in every sense: an author may
  // fill in one, both or neither, and nothing downstream requires the pair to
  // agree — a listing whose Nepali title is not a translation of its English
  // one is a listing, not an error.
  if (raw.title_ne !== undefined) input.title_ne = str(raw.title_ne) ?? null
  if (raw.summary_ne !== undefined) input.summary_ne = str(raw.summary_ne) ?? null
  if (raw.description_ne !== undefined) input.description_ne = str(raw.description_ne) ?? null

  if (raw.listing_type !== undefined) {
    const type = raw.listing_type
    if (typeof type !== 'string' || !(LISTING_TYPES as readonly string[]).includes(type)) {
      throw badRequest('invalid_listing_type', `Listing type must be one of: ${LISTING_TYPES.join(', ')}`)
    }
    input.listing_type = type as ListingType
  }

  if (raw.organization_id !== undefined) input.organization_id = str(raw.organization_id) ?? null
  if (raw.venue_id !== undefined) input.venue_id = str(raw.venue_id) ?? null
  if (raw.venue_room !== undefined) input.venue_room = str(raw.venue_room) ?? null
  if (raw.starts_at !== undefined) input.starts_at = str(raw.starts_at) ?? ''
  if (raw.ends_at !== undefined) input.ends_at = str(raw.ends_at) ?? null
  if (raw.is_all_day !== undefined) input.is_all_day = raw.is_all_day === true
  if (raw.timezone !== undefined) input.timezone = str(raw.timezone) ?? 'Asia/Kathmandu'
  if (raw.external_url !== undefined) input.external_url = str(raw.external_url) ?? null
  if (raw.offer_url !== undefined) input.offer_url = str(raw.offer_url) ?? null
  if (raw.location_lat !== undefined) input.location_lat = num(raw.location_lat) ?? null
  if (raw.location_lng !== undefined) input.location_lng = num(raw.location_lng) ?? null
  // Validated rather than passed through (#32). It arrives as arbitrary JSON,
  // is stored, and is later rendered on a public map — so the field set is
  // closed and the labels are capped here, at the boundary, not in whichever
  // component happens to read it.
  if (raw.map_popup_config !== undefined) {
    input.map_popup_config = raw.map_popup_config === null
      ? null
      : serialisePopupConfig(parsePopupConfig(raw.map_popup_config))
  }

  const categories = strings(raw.category_slugs)
  if (categories) input.category_slugs = [...new Set(categories)]
  if (raw.primary_category_slug !== undefined) {
    input.primary_category_slug = str(raw.primary_category_slug) ?? null
  }
  const tags = strings(raw.tags)
  if (tags) input.tags = tags
  const artists = strings(raw.artist_slugs)
  if (artists) input.artist_slugs = [...new Set(artists)].slice(0, MAX_ARTISTS)

  return input
}

// ─── Shared write plumbing ───────────────────────────────────────────────────

type Statement = ReturnType<D1Database['prepare']>

/**
 * Category slugs are validated against the closed set rather than left to the
 * foreign key, because an unknown slug should say *which* slug is unknown. The
 * FK would only say "constraint failed", and the wizard cannot put that next to
 * a field.
 */
async function resolveCategories(
  env: Env, session: WriteSession, slugs: string[],
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map()
  const placeholders = slugs.map((_, i) => `?${i + 1}`).join(', ')
  const [result] = await session.batch([
    env.DB.prepare(
      `SELECT id, slug FROM categories WHERE slug IN (${placeholders}) AND is_active = 1`,
    ).bind(...slugs),
  ])
  const results = rowsOf<{ id: string; slug: string }>(result)

  const found = new Map(results.map((row) => [row.slug, row.id]))
  const unknown = slugs.filter((slug) => !found.has(slug))
  if (unknown.length > 0) {
    throw badRequest('unknown_category', `No such category: ${unknown.join(', ')}`)
  }
  return found
}

/**
 * Taxonomy is replaced wholesale rather than diffed. The rows are a set with no
 * identity of their own, and a diff here buys nothing but a way to get it wrong.
 */
function taxonomyStatements(
  env: Env, listingId: string, input: Partial<ListingInput>, categoryIds: Map<string, string>,
  now: string,
): Statement[] {
  const statements: Statement[] = []

  if (input.category_slugs) {
    statements.push(
      env.DB.prepare('DELETE FROM listing_categories WHERE listing_id = ?1').bind(listingId),
    )
    // Exactly one primary, always — the unique index in migration 0005 enforces
    // it, and pin appearance is derived from it, so falling back to the first
    // selected category is better than leaving a listing with no pin colour.
    const primary = input.primary_category_slug && categoryIds.has(input.primary_category_slug)
      ? input.primary_category_slug
      : input.category_slugs[0]
    for (const slug of input.category_slugs) {
      statements.push(
        env.DB.prepare(
          'INSERT INTO listing_categories (listing_id, category_id, is_primary) VALUES (?1, ?2, ?3)',
        ).bind(listingId, categoryIds.get(slug), slug === primary ? 1 : 0),
      )
    }
  }

  if (input.tags) {
    statements.push(env.DB.prepare('DELETE FROM listing_tags WHERE listing_id = ?1').bind(listingId))
    for (const tag of normaliseTags(input.tags)) {
      // The first spelling seen wins the label, so an established tag is not
      // renamed by whoever types it next.
      statements.push(
        env.DB.prepare(
          'INSERT INTO tags (slug, label, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(slug) DO NOTHING',
        ).bind(tag.slug, tag.label, now),
      )
      statements.push(
        env.DB.prepare(
          'INSERT INTO listing_tags (listing_id, tag_slug) VALUES (?1, ?2)',
        ).bind(listingId, tag.slug),
      )
    }
  }

  if (input.artist_slugs) {
    statements.push(
      env.DB.prepare('DELETE FROM listing_artists WHERE listing_id = ?1').bind(listingId),
    )
    input.artist_slugs.forEach((slug, order) => {
      // Unknown artists are skipped rather than rejected: the select is fed by
      // the lookups endpoint, so an unknown slug is a stale tab, not a typo
      // worth blocking a save for.
      statements.push(
        env.DB.prepare(
          `INSERT INTO listing_artists (listing_id, artist_id, billing_order)
           SELECT ?1, id, ?3 FROM artists WHERE slug = ?2`,
        ).bind(listingId, slug, order),
      )
    })
  }

  return statements
}

// ─── POST /api/author/listings ───────────────────────────────────────────────
authorWriteRoutes.post('/listings', requirePermission('listing:create'), async (c) => {
  const user = c.get('user')
  const input = parseListingInput(await c.req.json().catch(() => {
    throw badRequest('invalid_body', 'Send a JSON object')
  }))

  const session = writeSession(c.env)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const type = input.listing_type ?? 'free'

  const categoryIds = await resolveCategories(c.env, session, input.category_slugs ?? [])

  // A slug is minted at creation even for an untitled draft, because the wizard
  // shows the URL the listing will have and a URL that changes under the author
  // reads as a bug. It is re-minted on the title change that PATCH handles.
  const slug = await uniqueSlug(input.title || 'untitled listing', async (candidate) => {
    const row = await session.first<{ ok: number }>(
      c.env.DB.prepare('SELECT 1 AS ok FROM listings WHERE slug = ?1').bind(candidate),
    )
    return row !== null
  })

  await session.batch([
    c.env.DB.prepare(
      `INSERT INTO listings (
         id, slug, title, summary, description, listing_type, source, status,
         organization_id, venue_id, venue_room, starts_at, ends_at, is_all_day, timezone,
         external_url, offer_url, offer_provider, location_lat, location_lng,
         map_popup_config, created_by, created_at, updated_at,
         title_ne, summary_ne, description_ne
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?9, ?22, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?21, ?23, ?24, ?25)`,
    ).bind(
      id, slug, input.title ?? '', input.summary ?? null, input.description ?? null,
      type,
      // Provenance (#20): an authenticated author writing through the wizard is
      // an organizer. Imports and editorial writes set their own source and do
      // not come through here.
      'organizer',
      input.organization_id ?? null, input.venue_id ?? null,
      // An unset start is stored as no start (migration 0008). Stamping the
      // creation time here — which is what a NOT NULL column forced — meant a
      // reopened draft read back a real-looking date nobody had chosen, and
      // validation had nothing left to object to.
      input.starts_at || null,
      input.ends_at ?? null, input.is_all_day ? 1 : 0, input.timezone ?? 'Asia/Kathmandu',
      input.external_url ?? null, input.offer_url ?? null,
      offerProviderFor(type, input.offer_url ?? null),
      input.location_lat ?? null, input.location_lng ?? null,
      input.map_popup_config ? JSON.stringify(input.map_popup_config) : null,
      user.id, now,
      // Which room inside the venue (#31, migration 0009). Appended as ?22
      // rather than renumbering fifteen existing placeholders, which is the
      // kind of edit that silently swaps two columns of the same type.
      input.venue_room ?? null,
      // Same reasoning for the Nepali fields (#46, migration 0013): appended
      // rather than woven into the middle of the list.
      input.title_ne ?? null, input.summary_ne ?? null, input.description_ne ?? null,
    ),
    ...taxonomyStatements(c.env, id, input, categoryIds, now),
    auditStatement(c.env, {
      entityType: 'listing', entityId: id, action: 'created',
      actorId: user.id, actorRole: user.role, details: { slug, listing_type: type },
    }),
  ])

  return withRoundTrips(Response.json({ id, slug, status: 'draft' }, { status: 201 }), session)
})

/**
 * The offer seam, and the only thing listing_type controls on the write path
 * (docs/SCOPE.md). NepScene records where entry is sold and never what it costs
 * — `offer_price_from_paisa` is written by the offer resolver from WaahTickets'
 * answer, never by an author.
 */
function offerProviderFor(type: ListingType, offerUrl: string | null): string | null {
  if (type === 'ticketed_internal') return 'waahtickets'
  if (type === 'ticketed_external' && offerUrl) return 'external'
  return null
}

// ─── GET /api/author/listings/:id ────────────────────────────────────────────
// Edit mode's load. One batch, one round trip: the AC is a two-second edit-mode
// load, and five sequential reads from Kathmandu is a second of that budget
// spent on nothing but latency.
authorWriteRoutes.get('/listings/:id', requirePermission('listing:edit_own'), async (c) => {
  const user = c.get('user')
  const listing = await loadEditableListing(c.env, user.id, user.role, c.req.param('id'))
  const session = writeSession(c.env)

  const [rows, categories, tags, artists, media] = await session.batch([
    c.env.DB.prepare('SELECT * FROM listings WHERE id = ?1').bind(listing.id),
    c.env.DB.prepare(
      `SELECT c.slug, lc.is_primary FROM listing_categories lc
         JOIN categories c ON c.id = lc.category_id
        WHERE lc.listing_id = ?1`,
    ).bind(listing.id),
    c.env.DB.prepare(
      `SELECT lt.tag_slug, t.label FROM listing_tags lt
         LEFT JOIN tags t ON t.slug = lt.tag_slug
        WHERE lt.listing_id = ?1`,
    ).bind(listing.id),
    c.env.DB.prepare(
      `SELECT a.slug FROM listing_artists la JOIN artists a ON a.id = la.artist_id
        WHERE la.listing_id = ?1 ORDER BY la.billing_order ASC`,
    ).bind(listing.id),
    c.env.DB.prepare(
      `SELECT id, r2_key, alt_text, width, height, sort_order FROM listing_media
        WHERE listing_id = ?1 ORDER BY sort_order ASC`,
    ).bind(listing.id),
  ])

  const row = rowsOf<Record<string, unknown>>(rows)[0]
  if (!row) throw notFound('No such listing')

  const categoryRows = rowsOf<{ slug: string; is_primary: number }>(categories)
  const mediaRows = rowsOf<{
    id: string; r2_key: string; alt_text: string | null
    width: number | null; height: number | null
  }>(media)

  return withRoundTrips(Response.json({
    id: row.id, slug: row.slug, status: row.status,
    // Returned on every edit-mode load, not fetched separately: the author
    // sees why it came back at the moment they open it to fix it (#33).
    rejection_reason: text(row.rejection_reason),
    listing: {
      title: text(row.title) ?? '',
      summary: text(row.summary),
      description: text(row.description),
      title_ne: text(row.title_ne),
      summary_ne: text(row.summary_ne),
      description_ne: text(row.description_ne),
      listing_type: row.listing_type as ListingType,
      organization_id: text(row.organization_id),
      venue_id: text(row.venue_id),
      venue_room: text(row.venue_room),
      starts_at: text(row.starts_at) ?? '',
      ends_at: text(row.ends_at),
      is_all_day: row.is_all_day === 1,
      timezone: text(row.timezone) ?? 'Asia/Kathmandu',
      external_url: text(row.external_url),
      offer_url: text(row.offer_url),
      location_lat: numeric(row.location_lat),
      location_lng: numeric(row.location_lng),
      map_popup_config: parseConfig(row.map_popup_config),
      category_slugs: categoryRows.map((r) => r.slug),
      primary_category_slug: categoryRows.find((r) => r.is_primary === 1)?.slug ?? null,
      tags: rowsOf<{ label: string | null; tag_slug: string }>(tags)
        .map((r) => r.label ?? r.tag_slug),
      artist_slugs: rowsOf<{ slug: string }>(artists).map((r) => r.slug),
    } satisfies ListingInput,
    media: mediaRows.map((m) => ({
      id: m.id, url: mediaUrl(m.r2_key), alt_text: m.alt_text,
      width: m.width, height: m.height,
    })),
    updated_at: row.updated_at,
  }), session)
})

function parseConfig(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw === '') return null
  try { return JSON.parse(raw) } catch (cause) {
    swallowed('author_json_parse', cause)
    return null
  }
}

// ─── PATCH /api/author/listings/:id ──────────────────────────────────────────
// The autosave target. Partial by construction: only what was sent is written,
// so a step that has never been opened cannot blank a field the author filled
// in on a previous visit.
const COLUMNS: { key: keyof ListingInput; column: string; transform?: (v: unknown) => unknown }[] = [
  { key: 'title', column: 'title' },
  { key: 'summary', column: 'summary' },
  { key: 'description', column: 'description' },
  { key: 'title_ne', column: 'title_ne' },
  { key: 'summary_ne', column: 'summary_ne' },
  { key: 'description_ne', column: 'description_ne' },
  { key: 'listing_type', column: 'listing_type' },
  { key: 'organization_id', column: 'organization_id' },
  { key: 'venue_id', column: 'venue_id' },
  { key: 'venue_room', column: 'venue_room' },
  { key: 'starts_at', column: 'starts_at' },
  { key: 'ends_at', column: 'ends_at' },
  { key: 'is_all_day', column: 'is_all_day', transform: (v) => (v ? 1 : 0) },
  { key: 'timezone', column: 'timezone' },
  { key: 'external_url', column: 'external_url' },
  { key: 'offer_url', column: 'offer_url' },
  { key: 'location_lat', column: 'location_lat' },
  { key: 'location_lng', column: 'location_lng' },
  { key: 'map_popup_config', column: 'map_popup_config', transform: (v) => (v ? JSON.stringify(v) : null) },
]

authorWriteRoutes.patch('/listings/:id', requirePermission('listing:edit_own'), async (c) => {
  const user = c.get('user')
  const existing = await loadEditableListing(c.env, user.id, user.role, c.req.param('id'))
  const input = parseListingInput(await c.req.json().catch(() => {
    throw badRequest('invalid_body', 'Send a JSON object')
  }))

  const session = writeSession(c.env)
  const now = new Date().toISOString()
  const categoryIds = await resolveCategories(c.env, session, input.category_slugs ?? [])

  const assignments: string[] = []
  const params: unknown[] = []
  for (const { key, column, transform } of COLUMNS) {
    if (input[key] === undefined) continue
    params.push(transform ? transform(input[key]) : input[key])
    assignments.push(`${column} = ?${params.length}`)
  }

  // The offer provider is derived, never sent. Recomputing it whenever either
  // input moves is what stops a listing switched from external to free keeping
  // a provider that no longer means anything.
  if (input.listing_type !== undefined || input.offer_url !== undefined) {
    const type = input.listing_type ?? (await currentType(c.env, session, existing.id))
    params.push(offerProviderFor(type, input.offer_url ?? null))
    assignments.push(`offer_provider = ?${params.length}`)
  }

  const statements: Statement[] = []

  // A published URL is a promise (#24). Retitling a draft just re-mints the
  // slug; retitling something that has been public leaves a redirect behind.
  let slug = existing.slug
  if (input.title !== undefined && input.title.trim() !== '') {
    const desired = await uniqueSlug(input.title, async (candidate) => {
      if (candidate === existing.slug) return false
      const row = await session.first<{ ok: number }>(
        c.env.DB.prepare('SELECT 1 AS ok FROM listings WHERE slug = ?1').bind(candidate),
      )
      return row !== null
    })
    if (desired !== existing.slug) {
      slug = desired
      params.push(slug)
      assignments.push(`slug = ?${params.length}`)
      if (existing.status === 'published' || existing.status === 'archived') {
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO slug_redirects (entity_type, old_slug, entity_id, created_at)
             VALUES ('listing', ?1, ?2, ?3) ON CONFLICT DO NOTHING`,
          ).bind(existing.slug, existing.id, now),
        )
      }
    }
  }

  params.push(now)
  assignments.push(`updated_at = ?${params.length}`)
  params.push(existing.id)

  statements.unshift(
    c.env.DB.prepare(`UPDATE listings SET ${assignments.join(', ')} WHERE id = ?${params.length}`)
      .bind(...params),
  )
  statements.push(...taxonomyStatements(c.env, existing.id, input, categoryIds, now))
  statements.push(auditStatement(c.env, {
    entityType: 'listing', entityId: existing.id, action: 'updated',
    actorId: user.id, actorRole: user.role,
    details: { fields: Object.keys(input) },
  }))

  await session.batch(statements)

  // A published listing that has just been edited is stale in every colo's
  // cache. A draft is in nobody's.
  if (existing.status === 'published') {
    c.executionCtx.waitUntil(bumpCatalogVersion(c.env))
  }

  return withRoundTrips(
    Response.json({ id: existing.id, slug, status: existing.status, updated_at: now }),
    session,
  )
})

async function currentType(env: Env, session: WriteSession, id: string): Promise<ListingType> {
  const row = await session.first<{ listing_type: ListingType }>(
    env.DB.prepare('SELECT listing_type FROM listings WHERE id = ?1').bind(id),
  )
  return row?.listing_type ?? 'free'
}

// ─── GET /api/author/listings ────────────────────────────────────────────────
// What the wizard needs to offer draft recovery: the author's unfinished work,
// newest first. The full organizer dashboard is #34; this is the list behind
// "you have a draft in progress".
const DRAFT_PAGE = 20

authorWriteRoutes.get('/listings', requirePermission('listing:edit_own'), async (c) => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, title, status, listing_type, starts_at, updated_at
       FROM listings
      WHERE created_by = ?1
      ORDER BY updated_at DESC
      LIMIT ?2`,
  ).bind(user.id, DRAFT_PAGE).all<Record<string, unknown>>()

  return c.json({ data: results })
})

/**
 * Exported for the submit transition in `listings.ts`, which is where the rules
 * finally bite: anything may be saved, only a complete listing may be sent for
 * review.
 */
export async function validateForSubmission(env: Env, listingId: string) {
  const session = writeSession(env)
  const [rows, categories] = await session.batch([
    env.DB.prepare('SELECT * FROM listings WHERE id = ?1').bind(listingId),
    env.DB.prepare(
      `SELECT c.slug, lc.is_primary FROM listing_categories lc
         JOIN categories c ON c.id = lc.category_id WHERE lc.listing_id = ?1`,
    ).bind(listingId),
  ])
  const row = rowsOf<Record<string, unknown>>(rows)[0]
  if (!row) throw notFound('No such listing')

  const categoryRows = rowsOf<{ slug: string; is_primary: number }>(categories)

  return validateListing({
    title: text(row.title) ?? '',
    summary: text(row.summary),
    description: text(row.description),
    listing_type: row.listing_type as ListingType,
    organization_id: text(row.organization_id),
    venue_id: text(row.venue_id),
    venue_room: text(row.venue_room),
    starts_at: text(row.starts_at) ?? '',
    ends_at: text(row.ends_at),
    is_all_day: row.is_all_day === 1,
    timezone: text(row.timezone) ?? 'Asia/Kathmandu',
    external_url: text(row.external_url),
    offer_url: text(row.offer_url),
    location_lat: numeric(row.location_lat),
    location_lng: numeric(row.location_lng),
    map_popup_config: null,
    category_slugs: categoryRows.map((r) => r.slug),
    primary_category_slug: categoryRows.find((r) => r.is_primary === 1)?.slug ?? null,
    tags: [],
    artist_slugs: [],
  })
}
