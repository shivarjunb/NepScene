/** Wire shapes for the Catalog API. These are a contract — change them additively. */

export type CategoryRef = {
  slug: string
  name: string
  color: string | null
  icon: string | null
}

export type VenueRef = {
  id: string
  slug: string
  name: string
  area: string | null
  city: string | null
}

export type OrganizerRef = {
  id: string
  slug: string
  name: string
  is_verified: boolean
}

/**
 * The seam (docs/SCOPE.md). NepScene renders this and never computes it:
 * `price_from` is a display snapshot in integer paisa, taken at
 * `checked_at`, and nothing downstream treats it as an authority.
 */
export type Offer = {
  purchasable: boolean
  price_from: number | null
  currency: string
  url: string | null
  provider: 'waahtickets' | 'external'
  sold_out: boolean
  checked_at: string | null
}

export type ListingSummary = {
  id: string
  slug: string
  title: string
  summary: string | null
  listing_type: 'ticketed_internal' | 'ticketed_external' | 'free' | 'announcement'
  source: 'organizer' | 'submission' | 'import' | 'editorial'
  starts_at: string
  ends_at: string | null
  is_all_day: boolean
  timezone: string
  cover_image_url: string | null
  external_url: string | null
  is_featured: boolean
  latitude: number | null
  longitude: number | null
  map_pin_icon: string | null
  venue: VenueRef | null
  organizer: OrganizerRef | null
  categories: CategoryRef[]
  offer: Offer | null
  /** Present only on distance-filtered searches. */
  distance_km?: number
}

export type MediaItem = {
  id: string
  url: string
  kind: 'image' | 'video'
  alt_text: string | null
  width: number | null
  height: number | null
}

export type ArtistRef = {
  slug: string
  name: string
  image_url: string | null
}

export type ListingDetail = ListingSummary & {
  description: string | null
  map_popup_config: unknown | null
  published_at: string | null
  venue: (VenueRef & {
    address: string | null
    district: string | null
    province: string | null
    latitude: number | null
    longitude: number | null
  }) | null
  media: MediaItem[]
  artists: ArtistRef[]
}

export type VenueSummary = {
  id: string
  slug: string
  name: string
  area: string | null
  city: string | null
  district: string | null
  province: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
  cover_image_url: string | null
  is_verified: boolean
  upcoming_listing_count: number
}

export type Page<T> = {
  data: T[]
  page: { limit: number; has_more: boolean; next_cursor: string | null }
}
