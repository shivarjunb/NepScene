/**
 * The wire shapes the browser reads, mirroring api/catalog/types.ts.
 *
 * Deliberately a copy rather than an import: the Worker's tsconfig has no DOM
 * lib and the browser's has no Workers types, so the two halves cannot share a
 * file without one of them dragging in globals that hide real errors. The
 * contract is additive (api/catalog/types.ts), so a copy drifts loudly — a
 * removed field fails to compile here — rather than silently.
 *
 * DOM-free on purpose: tests/unit runs in workerd, and the row rules that
 * import these types have to be testable there.
 */

export type CategoryRef = {
  slug: string
  name: string
  /** The taxonomy's Nepali label. Null falls back to `name` (#46). */
  name_ne: string | null
  color: string | null
  icon: string | null
  is_primary: boolean
}

/** Derived from the primary category by the API; there is no stored icon. */
export type PinAppearance = {
  icon: string
  color: string
  category: string | null
}

export type TagRef = {
  slug: string
  label: string
}

/**
 * The taxonomy itself, as /api/catalog/categories returns it. `is_primary`
 * belongs to a listing's use of a category, not to the category, so it is not
 * here — the two shapes are deliberately not interchangeable.
 */
export type Category = Omit<CategoryRef, 'is_primary'> & {
  upcoming_listing_count: number
}

/** As /api/catalog/tags returns it. */
export type Tag = TagRef & {
  upcoming_listing_count: number
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
 * The seam (docs/SCOPE.md). NepScene renders this and never computes it.
 * `price_from` is a display snapshot in integer paisa; formatting it for
 * display is all that ever happens to it here.
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

export type ListingType = 'ticketed_internal' | 'ticketed_external' | 'free' | 'announcement'

export type Listing = {
  id: string
  slug: string
  title: string
  /**
   * The Nepali title and teaser where the listing carries them (#46). Null is
   * the normal case and means "show the English one" — never "show nothing".
   */
  title_ne: string | null
  summary: string | null
  summary_ne: string | null
  listing_type: ListingType
  source: 'organizer' | 'submission' | 'import' | 'editorial'
  starts_at: string
  ends_at: string | null
  is_all_day: boolean
  timezone: string
  cover_image_url: string | null
  external_url: string | null
  is_featured: boolean
  /** The author's popup customisation (#32), or null where they kept the default. */
  map_popup_config: unknown | null
  latitude: number | null
  longitude: number | null
  pin: PinAppearance
  venue: VenueRef | null
  organizer: OrganizerRef | null
  categories: CategoryRef[]
  cover: MediaItem | null
  offer: Offer | null
  distance_km?: number
}

export type MediaSource = {
  type: string
  srcset: string
}

export type MediaItem = {
  id: string
  url: string
  kind: 'image' | 'video'
  alt_text: string | null
  width: number | null
  height: number | null
  aspect_ratio: number | null
  sources: MediaSource[]
}

/** The full record behind a listing page (#43). */
export type ListingDetail = Listing & {
  description: string | null
  description_ne: string | null
  published_at: string | null
  venue_room: string | null
  venue: (VenueRef & {
    address: string | null
    district: string | null
    province: string | null
    latitude: number | null
    longitude: number | null
  }) | null
  media: MediaItem[]
  artists: ArtistRef[]
  tags: TagRef[]
  /** Ranked same-venue, same-organizer, then shared category. Never itself. */
  related: Listing[]
}

export type ArtistRef = {
  slug: string
  name: string
  image_url: string | null
  listing_count: number
  /** Whether /artists/:slug will answer. Below it the name is text (#44). */
  has_page: boolean
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
  past_listing_count: number
}

export type VenueDetail = VenueSummary & {
  description: string | null
  website_url: string | null
  phone: string | null
  capacity: number | null
  google_place_id: string | null
}

export type OrganizerSummary = {
  id: string
  slug: string
  name: string
  description: string | null
  logo_url: string | null
  website_url: string | null
  is_verified: boolean
  upcoming_listing_count: number
  past_listing_count: number
}

export type ArtistSummary = {
  id: string
  slug: string
  name: string
  bio: string | null
  image_url: string | null
  links: Record<string, string>
  upcoming_listing_count: number
  listing_count: number
}

/** An entity page: the thing, what is on, and what has been (#44). */
export type PlacePage<T, K extends string> = { listings: Listing[]; past: Listing[] } & {
  [key in K]: T
}

/** What a search says beyond the rows (#42). */
export type Facet = {
  value: string
  label: string
  /** Present on category facets, where the taxonomy carries a Nepali name. */
  label_ne?: string | null
  count: number
  from?: string | null
  to?: string | null
}

export type SearchFacets = {
  city: Facet[]
  category: Facet[]
  price: Facet[]
  when: Facet[]
}

export type Suggestion = {
  kind: 'listing' | 'venue' | 'city' | 'area' | 'organizer' | 'artist' | 'category' | 'tag'
  slug: string
  label: string
}

export type SearchResult = Page<Listing> & {
  facets: SearchFacets
  /** The query the results are really for, when it is not the one typed. */
  corrected_from: string | null
  alternatives: Suggestion[]
}

export type Bootstrap = {
  categories: Category[]
  upcoming: Listing[]
  featured: Listing[]
}

export type Page<T> = {
  data: T[]
  page: { limit: number; has_more: boolean; next_cursor: string | null }
}
