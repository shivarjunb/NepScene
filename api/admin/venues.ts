import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest } from '../lib/http'
import { rowsOf, withRoundTrips, writeSession } from '../lib/d1'
import { auditStatement } from '../lib/audit'
import { bumpCatalogVersion } from '../lib/cache'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { validateVenue, type VenueInput } from '../author/validate'
import { parseVenueInput } from '../author/venues'
import { page, paging, readJson, search } from './shared'

/**
 * Venues, for the people who keep the catalogue tidy (the console's Venues
 * section).
 *
 * Three jobs, each one the wizard cannot do. **Fix a venue's details** — the
 * author who created it typed "Purple haze" and no address, and every
 * listing there inherits that. **Put it on the map** — a venue with no pin
 * is a listing the map cannot show. **Merge a duplicate** into the venue it
 * duplicates: search-before-create (#31) makes new duplicates rare, but the
 * imports and the years before it left some, and two "Patan Museum"s split
 * one venue page's listings in half.
 *
 * `venue:edit_any`, which editors have: this is catalogue work, not account
 * administration.
 */
export const adminVenueRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const FILTERS = ['unmapped', 'unverified'] as const

const VENUE = `
  SELECT v.id, v.slug, v.name, v.address, v.area, v.city, v.latitude, v.longitude,
         v.website_url, v.phone, v.is_verified, v.created_at, v.updated_at,
         (SELECT COUNT(*) FROM listings l WHERE l.venue_id = v.id) AS listing_count,
         (SELECT COUNT(*) FROM listings l WHERE l.venue_id = v.id AND l.status = 'published') AS published_count
    FROM venues v`

// ─── GET /api/admin/venues ───────────────────────────────────────────────────
adminVenueRoutes.get('/venues', requirePermission('venue:edit_any'), async (c) => {
  const url = new URL(c.req.url)
  const { query, pattern } = search(url)
  const paged = paging(url)
  const filter = url.searchParams.get('filter') || null
  if (filter && !(FILTERS as readonly string[]).includes(filter)) {
    throw badRequest('invalid_filter', 'Filter by unmapped or unverified, or not at all')
  }

  const matches = `(?1 = '' OR v.name LIKE ?2 ESCAPE '\\' OR v.area LIKE ?2 ESCAPE '\\'
                    OR v.city LIKE ?2 ESCAPE '\\' OR v.slug LIKE ?2 ESCAPE '\\')`

  const session = writeSession(c.env)
  const [rows, counts] = await session.batch([
    c.env.DB.prepare(
      `${VENUE}
        WHERE ${matches}
          AND (?3 IS NULL
               OR (?3 = 'unmapped' AND (v.latitude IS NULL OR v.longitude IS NULL))
               OR (?3 = 'unverified' AND v.is_verified = 0))
        ORDER BY v.name COLLATE NOCASE, v.id
        LIMIT ?4 OFFSET ?5`,
    ).bind(query, pattern, filter, paged.limit + 1, paged.offset),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(v.latitude IS NULL OR v.longitude IS NULL) AS unmapped,
              SUM(v.is_verified = 0) AS unverified
         FROM venues v WHERE ${matches}`,
    ).bind(query, pattern),
  ])

  const listed = page(rowsOf<Record<string, unknown>>(rows), paged)
  const tally = rowsOf<{ total: number; unmapped: number | null; unverified: number | null }>(counts)[0]
  return withRoundTrips(Response.json({
    data: listed.data.map(serialiseVenue),
    counts: {
      all: Number(tally?.total ?? 0),
      unmapped: Number(tally?.unmapped ?? 0),
      unverified: Number(tally?.unverified ?? 0),
    },
    page: listed.page,
  }), session)
})

/** The fields this screen edits. Everything else about a venue stays as the author left it. */
const EDITABLE = ['name', 'address', 'area', 'city', 'latitude', 'longitude', 'website_url', 'phone'] as const

// ─── PATCH /api/admin/venues/:id ─────────────────────────────────────────────
/**
 * A partial update: a key that is sent is set (null clears it), a key that
 * is not sent is left alone. The result is validated as a whole venue, with
 * the wizard's own rules, so a pin outside Nepal or a website without a
 * scheme is refused here for the same reason and in the same words.
 */
adminVenueRoutes.patch('/venues/:id', requirePermission('venue:edit_any'), async (c) => {
  const actor = c.get('user')
  const id = c.req.param('id')
  const body = await readJson(c.req.raw)

  const current = await c.env.DB.prepare(`${VENUE} WHERE v.id = ?1`).bind(id)
    .first<Record<string, unknown>>()
  if (!current) throw new ApiError(404, 'not_found', 'No such venue')

  const sent = parseVenueInput(body)
  const next: Partial<VenueInput> = {}
  const changed: string[] = []
  for (const key of EDITABLE) {
    if (!(key in body)) continue
    const value = sent[key] ?? null
    ;(next as Record<string, unknown>)[key] = value
    if (value !== (current[key] ?? null)) changed.push(key)
  }
  const merged = { ...current, ...next } as unknown as Partial<VenueInput>

  const errors = validateVenue({ ...merged, country: 'NP' })
  if (errors.length > 0) {
    return c.json({
      error: { code: 'invalid_venue', message: 'Some things need fixing before this venue can be saved', fields: errors },
    }, 400)
  }

  let verified = current.is_verified === 1
  if ('is_verified' in body) {
    if (typeof body.is_verified !== 'boolean') throw badRequest('invalid_verified', 'is_verified must be true or false')
    if (body.is_verified !== verified) changed.push('is_verified')
    verified = body.is_verified
  }

  if (changed.length > 0) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE venues
            SET name = ?1, address = ?2, area = ?3, city = ?4, latitude = ?5, longitude = ?6,
                website_url = ?7, phone = ?8, is_verified = ?9, updated_at = ?10
          WHERE id = ?11`,
      ).bind(
        merged.name, merged.address ?? null, merged.area ?? null, merged.city ?? null,
        merged.latitude ?? null, merged.longitude ?? null, merged.website_url ?? null,
        merged.phone ?? null, verified ? 1 : 0, new Date().toISOString(), id,
      ),
      auditStatement(c.env, {
        entityType: 'venue', entityId: id, action: 'updated',
        actorId: actor.id, actorRole: actor.role, details: { fields: changed },
      }),
    ])
    // A venue's name and pin are on every listing card and on the map.
    await bumpCatalogVersion(c.env)
  }

  const row = await c.env.DB.prepare(`${VENUE} WHERE v.id = ?1`).bind(id).first<Record<string, unknown>>()
  return c.json(serialiseVenue(row!))
})

// ─── POST /api/admin/venues/:id/merge ────────────────────────────────────────
/**
 * Fold a duplicate into the venue it duplicates: its listings move, it goes.
 * One batch, so a listing is never left pointing at a venue that no longer
 * exists. The audit row on the survivor names what was merged into it,
 * because the duplicate's own id will not resolve to anything afterwards.
 */
adminVenueRoutes.post('/venues/:id/merge', requirePermission('venue:edit_any'), async (c) => {
  const actor = c.get('user')
  const id = c.req.param('id')
  const body = await readJson(c.req.raw)
  const into = typeof body.into === 'string' ? body.into : ''
  if (!into) throw badRequest('invalid_into', 'Say which venue to merge this one into')
  if (into === id) throw badRequest('merge_into_self', 'A venue cannot be merged into itself')

  const session = writeSession(c.env)
  const [pair] = await session.batch([
    c.env.DB.prepare('SELECT id, slug, name FROM venues WHERE id IN (?1, ?2)').bind(id, into),
  ])
  const found = rowsOf<{ id: string; slug: string; name: string }>(pair)
  const source = found.find((row) => row.id === id)
  const target = found.find((row) => row.id === into)
  if (!source) throw new ApiError(404, 'not_found', 'No such venue')
  if (!target) throw new ApiError(404, 'not_found', 'The venue to merge into does not exist')

  const now = new Date().toISOString()
  const [moved] = await session.batch([
    c.env.DB.prepare('UPDATE listings SET venue_id = ?1, updated_at = ?2 WHERE venue_id = ?3')
      .bind(into, now, id),
    c.env.DB.prepare('DELETE FROM venues WHERE id = ?1').bind(id),
    auditStatement(c.env, {
      entityType: 'venue', entityId: into, action: 'merged',
      actorId: actor.id, actorRole: actor.role,
      details: { merged: { id: source.id, slug: source.slug, name: source.name } },
    }),
  ])
  await bumpCatalogVersion(c.env)

  return withRoundTrips(c.json({
    merged: id, into, slug: target.slug, moved: moved?.meta?.changes ?? 0,
  }), session)
})

function serialiseVenue(row: Record<string, unknown>) {
  return {
    ...row,
    is_verified: row.is_verified === 1,
    listing_count: Number(row.listing_count ?? 0),
    published_count: Number(row.published_count ?? 0),
  }
}
