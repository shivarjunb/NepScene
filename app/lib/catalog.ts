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
  name_ne: string | null
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
  summary: string | null
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

export type Bootstrap = {
  categories: Category[]
  upcoming: Listing[]
  featured: Listing[]
}

export type Page<T> = {
  data: T[]
  page: { limit: number; has_more: boolean; next_cursor: string | null }
}
