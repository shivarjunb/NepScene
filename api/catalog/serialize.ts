import type {
  ArtistRef, ArtistSummary, CategoryRef, ListingDetail, ListingSummary, MediaItem, MediaSource,
  Offer, OrganizerSummary, TagRef, VenueSummary,
} from './types'
import { resolvePin } from './pin'
import { FORMAT_ORDER, MIME_BY_FORMAT, type Format } from '../media/pipeline'

/** Public URL for an R2 object. Derived, never stored (see migration 0001). */
export function mediaUrl(r2Key: string): string {
  return `/api/media/${r2Key.split('/').map(encodeURIComponent).join('/')}`
}

const bool = (value: unknown): boolean => value === 1 || value === true

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

/**
 * An offer exists when someone can act on it. A free community event has no
 * offer at all, which is different from an offer of zero — the UI renders the
 * two differently and conflating them is how "FREE" ends up on a sold-out gig.
 */
function toOffer(row: Record<string, unknown>): Offer | null {
  const url = (row.offer_url as string | null) ?? null
  const priceFrom = (row.offer_price_from_paisa as number | null) ?? null
  if (!url && priceFrom === null) return null
  return {
    purchasable: Boolean(url) && !bool(row.offer_sold_out),
    price_from: priceFrom,
    currency: (row.offer_currency as string) ?? 'NPR',
    url,
    provider: (row.offer_provider as 'waahtickets' | 'external' | null) ?? 'external',
    sold_out: bool(row.offer_sold_out),
    checked_at: (row.offer_checked_at as string | null) ?? null,
  }
}

type MediaRow = {
  id: string
  r2_key: string
  kind: 'image' | 'video'
  mime_type?: string | null
  alt_text: string | null
  width: number | null
  height: number | null
  derivatives?: { r2_key: string; format: Format; width: number }[] | null
}

/**
 * The srcset the browser gets. Derivatives are grouped by format and ordered
 * best-compression-first, so a browser that understands AVIF never downloads
 * the JPEG — and one that does not falls through to `url`, which is always
 * there.
 *
 * The original joins the srcset of its own format at its own width: on a small
 * image it may be the only rung, and a `<source>` that omits it would make the
 * browser pick a *smaller* image than one it already has.
 */
function toMediaItem(row: MediaRow): MediaItem {
  const byFormat = new Map<Format, { key: string; width: number }[]>()

  for (const derivative of row.derivatives ?? []) {
    const rungs = byFormat.get(derivative.format) ?? []
    rungs.push({ key: derivative.r2_key, width: derivative.width })
    byFormat.set(derivative.format, rungs)
  }

  const originalFormat = FORMAT_ORDER.find((format) => MIME_BY_FORMAT[format] === row.mime_type)
  if (originalFormat && row.width) {
    const rungs = byFormat.get(originalFormat) ?? []
    if (!rungs.some((rung) => rung.width === row.width)) {
      rungs.push({ key: row.r2_key, width: row.width })
    }
    byFormat.set(originalFormat, rungs)
  }

  const sources = FORMAT_ORDER.flatMap<MediaSource>((format) => {
    const rungs = byFormat.get(format)
    if (!rungs || rungs.length === 0) return []
    return [{
      type: MIME_BY_FORMAT[format],
      srcset: rungs
        .sort((a, b) => a.width - b.width)
        .map((rung) => `${mediaUrl(rung.key)} ${rung.width}w`)
        .join(', '),
    }]
  })

  return {
    id: row.id,
    url: mediaUrl(row.r2_key),
    kind: row.kind,
    alt_text: row.alt_text ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    aspect_ratio: row.width && row.height ? round4(row.width / row.height) : null,
    sources,
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000

export function toListingSummary(row: Record<string, unknown>): ListingSummary {
  // Ordered primary-first by the query, so the pin is a read, not a search.
  const categories = parseJsonArray<Record<string, unknown>>(row.categories_json)
    .map<CategoryRef>((category) => ({
      slug: category.slug as string,
      name: category.name as string,
      name_ne: (category.name_ne as string | null) ?? null,
      color: (category.color as string | null) ?? null,
      icon: (category.icon as string | null) ?? null,
      is_primary: bool(category.is_primary),
    }))

  return {
    id: row.id as string,
    slug: row.slug as string,
    title: row.title as string,
    title_ne: (row.title_ne as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    summary_ne: (row.summary_ne as string | null) ?? null,
    listing_type: row.listing_type as ListingSummary['listing_type'],
    source: row.source as ListingSummary['source'],
    starts_at: row.starts_at as string,
    ends_at: (row.ends_at as string | null) ?? null,
    is_all_day: bool(row.is_all_day),
    timezone: (row.timezone as string) ?? 'Asia/Kathmandu',
    cover_image_url: (row.cover_image_url as string | null) ?? null,
    external_url: (row.external_url as string | null) ?? null,
    is_featured: bool(row.is_featured),
    map_popup_config: parseJsonObject(row.map_popup_config),
    latitude: (row.latitude as number | null) ?? null,
    longitude: (row.longitude as number | null) ?? null,
    venue: row.venue_id
      ? {
          id: row.venue_id as string,
          slug: row.venue_slug as string,
          name: row.venue_name as string,
          area: (row.venue_area as string | null) ?? null,
          city: (row.venue_city as string | null) ?? null,
        }
      : null,
    organizer: row.organizer_id
      ? {
          id: row.organizer_id as string,
          slug: row.organizer_slug as string,
          name: row.organizer_name as string,
          is_verified: bool(row.organizer_verified),
        }
      : null,
    categories,
    pin: resolvePin(categories),
    cover: parseCover(row.cover_json),
    offer: toOffer(row),
  }
}

function parseCover(raw: unknown): MediaItem | null {
  const row = parseJsonObject(raw) as MediaRow | null
  return row?.r2_key ? toMediaItem(row) : null
}

/**
 * How many published listings an artist needs before they get a page. Declared
 * here rather than imported from the route file, because the route imports the
 * serializer and the other direction would be a cycle; `places.ts` re-exports
 * it as `ARTIST_PAGE_THRESHOLD` and both read this one value.
 */
export const ARTIST_PAGE_MINIMUM = 2

export function toListingDetail(row: Record<string, unknown>): ListingDetail {
  const summary = toListingSummary(row)
  const media = parseJsonArray<MediaRow>(row.media_json)

  return {
    ...summary,
    description: (row.description as string | null) ?? null,
    description_ne: (row.description_ne as string | null) ?? null,
    published_at: (row.published_at as string | null) ?? null,
    venue_room: (row.venue_room as string | null) ?? null,
    venue: summary.venue
      ? {
          ...summary.venue,
          address: (row.venue_address as string | null) ?? null,
          district: (row.venue_district as string | null) ?? null,
          province: (row.venue_province as string | null) ?? null,
          latitude: (row.venue_latitude as number | null) ?? null,
          longitude: (row.venue_longitude as number | null) ?? null,
        }
      : null,
    media: media.map(toMediaItem),
    // `has_page` rather than a count the client has to compare against a
    // threshold of its own: the API is the only place that knows whether
    // /artists/:slug will answer, and a listing must not link to a 404.
    artists: parseJsonArray<Record<string, unknown>>(row.artists_json).map<ArtistRef>((artist) => ({
      slug: artist.slug as string,
      name: artist.name as string,
      image_url: (artist.image_url as string | null) ?? null,
      listing_count: (artist.listing_count as number | null) ?? 0,
      has_page: ((artist.listing_count as number | null) ?? 0) >= ARTIST_PAGE_MINIMUM,
    })),
    tags: parseJsonArray<TagRef>(row.tags_json),
  }
}

export function toVenueSummary(row: Record<string, unknown>): VenueSummary {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    area: (row.area as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    district: (row.district as string | null) ?? null,
    province: (row.province as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    latitude: (row.latitude as number | null) ?? null,
    longitude: (row.longitude as number | null) ?? null,
    cover_image_url: (row.cover_image_url as string | null) ?? null,
    is_verified: bool(row.is_verified),
    upcoming_listing_count: (row.upcoming_listing_count as number | null) ?? 0,
    past_listing_count: (row.past_listing_count as number | null) ?? 0,
  }
}

export function toOrganizerSummary(row: Record<string, unknown>): OrganizerSummary {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    logo_url: (row.logo_url as string | null) ?? null,
    website_url: (row.website_url as string | null) ?? null,
    is_verified: bool(row.is_verified),
    upcoming_listing_count: (row.upcoming_listing_count as number | null) ?? 0,
    past_listing_count: (row.past_listing_count as number | null) ?? 0,
  }
}

export function toArtistSummary(row: Record<string, unknown>): ArtistSummary {
  const links = parseJsonObject(row.links)
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    bio: (row.bio as string | null) ?? null,
    image_url: (row.image_url as string | null) ?? null,
    // Stored as free-form JSON (migration 0001); anything that is not a string
    // map is dropped rather than rendered as "[object Object]".
    links: links && typeof links === 'object' && !Array.isArray(links)
      ? Object.fromEntries(
          Object.entries(links as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      : {},
    upcoming_listing_count: (row.upcoming_listing_count as number | null) ?? 0,
    listing_count: (row.listing_count as number | null) ?? 0,
  }
}

function parseJsonObject(raw: unknown): unknown | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
