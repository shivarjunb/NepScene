import type {
  ArtistRef, CategoryRef, ListingDetail, ListingSummary, MediaItem, Offer, VenueSummary,
} from './types'

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

export function toListingSummary(row: Record<string, unknown>): ListingSummary {
  return {
    id: row.id as string,
    slug: row.slug as string,
    title: row.title as string,
    summary: (row.summary as string | null) ?? null,
    listing_type: row.listing_type as ListingSummary['listing_type'],
    source: row.source as ListingSummary['source'],
    starts_at: row.starts_at as string,
    ends_at: (row.ends_at as string | null) ?? null,
    is_all_day: bool(row.is_all_day),
    timezone: (row.timezone as string) ?? 'Asia/Kathmandu',
    cover_image_url: (row.cover_image_url as string | null) ?? null,
    external_url: (row.external_url as string | null) ?? null,
    is_featured: bool(row.is_featured),
    latitude: (row.latitude as number | null) ?? null,
    longitude: (row.longitude as number | null) ?? null,
    map_pin_icon: (row.map_pin_icon as string | null) ?? null,
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
    categories: parseJsonArray<CategoryRef>(row.categories_json),
    offer: toOffer(row),
  }
}

export function toListingDetail(row: Record<string, unknown>): ListingDetail {
  const summary = toListingSummary(row)
  const media = parseJsonArray<{
    id: string; r2_key: string; kind: 'image' | 'video'
    alt_text: string | null; width: number | null; height: number | null
  }>(row.media_json)

  return {
    ...summary,
    description: (row.description as string | null) ?? null,
    map_popup_config: parseJsonObject(row.map_popup_config),
    published_at: (row.published_at as string | null) ?? null,
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
    media: media.map<MediaItem>((m) => ({
      id: m.id,
      url: mediaUrl(m.r2_key),
      kind: m.kind,
      alt_text: m.alt_text ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
    })),
    artists: parseJsonArray<ArtistRef>(row.artists_json),
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
