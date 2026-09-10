/** Wire shapes for the Catalog API. These are a contract — change them additively. */

export type CategoryRef = {
  slug: string
  name: string
  /** The taxonomy's Nepali label (migration 0002). Null falls back to `name`. */
  name_ne: string | null
  color: string | null
  icon: string | null
  /** Exactly one category per listing carries this (migration 0005). */
  is_primary: boolean
}

/**
 * Derived from the primary category, never stored. See api/catalog/pin.ts for
 * why there is no `map_pin_icon` column to keep in sync with it.
 */
export type PinAppearance = {
  icon: string
  color: string
  category: string | null
}

/** Free-form, author-supplied, and deliberately not an input to appearance. */
export type TagRef = {
  slug: string
  label: string
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
  /**
   * The Nepali title and teaser, where the listing carries them (#46). Null is
   * the normal case and means "render the English one" — never "render
   * nothing". The English fields stay authoritative for slugs, metadata and
   * every surface that has no language of its own.
   */
  title_ne: string | null
  summary: string | null
  summary_ne: string | null
  listing_type: 'ticketed_internal' | 'ticketed_external' | 'free' | 'announcement'
  source: 'organizer' | 'submission' | 'import' | 'editorial'
  starts_at: string
  ends_at: string | null
  is_all_day: boolean
  timezone: string
  cover_image_url: string | null
  external_url: string | null
  is_featured: boolean
  /**
   * The author's popup customisation (#32), or null where they kept the
   * default. It rides on the summary because the map builds popups from feed
   * rows (#36) and never fetches the detail payload to draw one.
   */
  map_popup_config: unknown | null
  latitude: number | null
  longitude: number | null
  pin: PinAppearance
  venue: VenueRef | null
  organizer: OrganizerRef | null
  categories: CategoryRef[]
  /**
   * The listing's first image, with its derivatives. `cover_image_url` above is
   * the authored fallback for listings whose picture never went through the
   * pipeline — an import, mostly.
   */
  cover: MediaItem | null
  offer: Offer | null
  /** Present only on distance-filtered searches. */
  distance_km?: number
}

/**
 * One `<source>` in a `<picture>`: every derivative of one image in one format,
 * narrowest first, as a ready-to-render srcset. The browser chooses; the API
 * does not guess at a viewport it cannot see.
 */
export type MediaSource = {
  type: string
  srcset: string
}

export type MediaItem = {
  id: string
  /** The original. The `<img>` src, and the last resort in every `<picture>`. */
  url: string
  kind: 'image' | 'video'
  alt_text: string | null
  width: number | null
  height: number | null
  /**
   * Present so the page can reserve the box before the bytes arrive. Sent
   * rather than left to the client to divide, because a card that computes it
   * from a null width silently reserves nothing.
   */
  aspect_ratio: number | null
  sources: MediaSource[]
}

export type ArtistRef = {
  slug: string
  name: string
  image_url: string | null
  /** How many published listings this artist is on. */
  listing_count: number
  /**
   * Whether `/artists/:slug` will answer for them. The API decides, because it
   * owns the threshold — a page that compared the count against a number of
   * its own would link to a 404 the day the threshold moved.
   */
  has_page: boolean
}

export type ListingDetail = ListingSummary & {
  description: string | null
  description_ne: string | null
  published_at: string | null
  /** Which room or stage inside the venue (#31). The venue is not duplicated. */
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

/**
 * What a search says about itself beyond the rows (#42): the counts the reader
 * can refine by, and — when the query was corrected or found nothing — what
 * was done about it.
 */
export type Facet = {
  value: string
  label: string
  /** Present on category facets, where the taxonomy carries a Nepali name. */
  label_ne?: string | null
  count: number
  /** Present on date facets: the window the count was taken over. */
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

/**
 * The taxonomy as `/api/catalog/categories` returns it. `is_primary` belongs to
 * a listing's *use* of a category, not to the category, so it is not here.
 */
export type Category = Omit<CategoryRef, 'is_primary'> & {
  upcoming_listing_count: number
}

/** Everything the homepage's first paint needs, in one response. */
export type Bootstrap = {
  categories: Category[]
  upcoming: ListingSummary[]
  featured: ListingSummary[]
}

export type Page<T> = {
  data: T[]
  page: { limit: number; has_more: boolean; next_cursor: string | null }
}
