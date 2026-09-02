import type { BoundingBox } from '../lib/geo'
import type { Cursor } from '../lib/cursor'

/**
 * One statement per endpoint, by design. Query complexity is free here and
 * round trips are not (docs/ARCHITECTURE.md): the whole database scans in
 * microseconds, while every extra sequential statement costs ~200ms from
 * Kathmandu. So categories come back as an aggregated JSON column rather than
 * as a second query.
 */
const CATEGORIES_JSON = `(
  SELECT json_group_array(json_object(
    'slug', c.slug, 'name', c.name, 'color', c.color, 'icon', c.icon
  ))
  FROM listing_categories lc
  JOIN categories c ON c.id = lc.category_id
  WHERE lc.listing_id = l.id
) AS categories_json`

const LISTING_SUMMARY_COLUMNS = `
  l.id, l.slug, l.title, l.summary, l.listing_type, l.source,
  l.starts_at, l.ends_at, l.is_all_day, l.timezone,
  l.cover_image_url, l.external_url, l.is_featured, l.map_pin_icon,
  l.offer_url, l.offer_provider, l.offer_price_from_paisa,
  l.offer_currency, l.offer_sold_out, l.offer_checked_at,
  COALESCE(l.location_lat, v.latitude)  AS latitude,
  COALESCE(l.location_lng, v.longitude) AS longitude,
  v.id AS venue_id, v.slug AS venue_slug, v.name AS venue_name,
  v.area AS venue_area, v.city AS venue_city,
  o.id AS organizer_id, o.slug AS organizer_slug, o.name AS organizer_name,
  o.is_verified AS organizer_verified,
  ${CATEGORIES_JSON}`

const LISTING_JOINS = `
  FROM listings l
  LEFT JOIN venues v        ON v.id = l.venue_id
  LEFT JOIN organizations o ON o.id = l.organization_id`

export type FeedFilters = {
  category?: string
  city?: string
  venue?: string
  organizer?: string
  listingType?: string
  featured?: boolean
  from?: string
  to?: string
  includePast: boolean
  query?: string
  box?: BoundingBox
  cursor?: Cursor
  limit: number
  now: string
}

export type SqlStatement = { sql: string; params: unknown[] }

export function buildFeedQuery(filters: FeedFilters): SqlStatement {
  const where: string[] = [`l.status = 'published'`]
  const params: unknown[] = []

  if (!filters.includePast) {
    // An event that started yesterday and ends tomorrow is still on, so the
    // window is on the end of the listing, not its start. This forfeits the
    // (status, starts_at, id) index for the range — acceptable while the
    // catalogue is small, and measured before it is optimised.
    where.push(`COALESCE(l.ends_at, l.starts_at) >= ?`)
    params.push(filters.now)
  }
  if (filters.from) {
    where.push(`l.starts_at >= ?`)
    params.push(filters.from)
  }
  if (filters.to) {
    where.push(`l.starts_at <= ?`)
    params.push(filters.to)
  }
  if (filters.category) {
    where.push(`EXISTS (
      SELECT 1 FROM listing_categories lc
      JOIN categories c2 ON c2.id = lc.category_id
      WHERE lc.listing_id = l.id AND c2.slug = ?
    )`)
    params.push(filters.category)
  }
  if (filters.city) {
    where.push(`LOWER(v.city) = LOWER(?)`)
    params.push(filters.city)
  }
  if (filters.venue) {
    where.push(`v.slug = ?`)
    params.push(filters.venue)
  }
  if (filters.organizer) {
    where.push(`o.slug = ?`)
    params.push(filters.organizer)
  }
  if (filters.listingType) {
    where.push(`l.listing_type = ?`)
    params.push(filters.listingType)
  }
  if (filters.featured) {
    where.push(`l.is_featured = 1`)
  }
  if (filters.query) {
    const pattern = `%${escapeLike(filters.query)}%`
    // Area matters as much as city here: people search 'Thamel' and 'Lakeside',
    // which are neighbourhoods, not cities.
    where.push(`(
      l.title   LIKE ? ESCAPE '\\' OR
      l.summary LIKE ? ESCAPE '\\' OR
      v.name    LIKE ? ESCAPE '\\' OR
      v.area    LIKE ? ESCAPE '\\' OR
      v.city    LIKE ? ESCAPE '\\' OR
      o.name    LIKE ? ESCAPE '\\'
    )`)
    params.push(pattern, pattern, pattern, pattern, pattern, pattern)
  }
  if (filters.box) {
    // Box prefilter only; the exact circle is applied in the Worker (geo.ts).
    where.push(`COALESCE(l.location_lat, v.latitude) BETWEEN ? AND ?`)
    where.push(`COALESCE(l.location_lng, v.longitude) BETWEEN ? AND ?`)
    params.push(filters.box.minLat, filters.box.maxLat, filters.box.minLng, filters.box.maxLng)
  }
  if (filters.cursor) {
    // Keyset, not OFFSET: page 40 costs the same as page 1, and rows cannot
    // shift between pages when something publishes mid-scroll.
    where.push(`(l.starts_at > ? OR (l.starts_at = ? AND l.id > ?))`)
    params.push(filters.cursor.startsAt, filters.cursor.startsAt, filters.cursor.id)
  }

  // limit + 1: the extra row answers has_more without a COUNT(*).
  params.push(filters.limit + 1)

  return {
    sql: `SELECT ${LISTING_SUMMARY_COLUMNS} ${LISTING_JOINS}
          WHERE ${where.join(' AND ')}
          ORDER BY l.starts_at ASC, l.id ASC
          LIMIT ?`,
    params,
  }
}

export function listingBySlugQuery(slug: string): SqlStatement {
  return {
    sql: `SELECT ${LISTING_SUMMARY_COLUMNS},
            l.description, l.map_popup_config, l.published_at,
            v.address AS venue_address, v.district AS venue_district,
            v.province AS venue_province, v.latitude AS venue_latitude,
            v.longitude AS venue_longitude,
            (SELECT json_group_array(json_object(
               'id', m.id, 'r2_key', m.r2_key, 'kind', m.kind,
               'alt_text', m.alt_text, 'width', m.width, 'height', m.height
             ) ORDER BY m.sort_order)
             FROM listing_media m WHERE m.listing_id = l.id) AS media_json,
            (SELECT json_group_array(json_object(
               'slug', a.slug, 'name', a.name, 'image_url', a.image_url
             ) ORDER BY la.billing_order)
             FROM listing_artists la JOIN artists a ON a.id = la.artist_id
             WHERE la.listing_id = l.id) AS artists_json
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
                     AND COALESCE(l.ends_at, l.starts_at) >= ?) AS upcoming_listing_count
          FROM venues v WHERE v.slug = ? LIMIT 1`,
    params: [now, slug],
  }
}

export function organizerBySlugQuery(slug: string, now: string): SqlStatement {
  return {
    sql: `SELECT o.id, o.slug, o.name, o.description, o.logo_url, o.website_url,
                 o.is_verified,
                 (SELECT COUNT(*) FROM listings l
                   WHERE l.organization_id = o.id AND l.status = 'published'
                     AND COALESCE(l.ends_at, l.starts_at) >= ?) AS upcoming_listing_count
          FROM organizations o WHERE o.slug = ? LIMIT 1`,
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

/** LIKE wildcards in user input are literals, not operators. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
