import type {
  Category, CategoryRef, Listing, ListingDetail, MediaItem, Offer, OrganizerRef, VenueRef,
} from '../app/lib/catalog'

/**
 * Test data factories (#47).
 *
 * Nine test files each carried their own hand-rolled `Listing` literal — the
 * same twenty-odd fields, copied, each one a chance to drift. They did drift:
 * adding `title_ne` to the contract meant editing every one, and any that was
 * missed compiled fine because `Partial` swallowed it.
 *
 * The failure that matters is subtler than the maintenance cost. A fixture
 * written by hand is written to suit the test it sits in, so `is_featured` is
 * whatever that file happened to need — and a test asserting "featured sorts
 * first" against a fixture bank where everything is featured passes while
 * proving nothing. One default, stated once, means a test that wants a
 * property has to ask for it, in the test, where a reader can see it.
 *
 * **Everything here is boring on purpose.** A factory's default is the least
 * interesting valid value: not featured, no offer, no categories, no
 * coordinates, one fixed instant. Anything a test cares about, it overrides —
 * and that override is then the visible statement of what the test is about.
 */

/**
 * A fixed instant, so a fixture is the same in January and in July.
 *
 * Dated rather than relative because "in seven days" is a moving target that
 * makes a failing test un-reproducible: a snapshot taken on a Friday and one
 * taken on a Monday disagree about what "this weekend" contains. Tests that
 * need a listing relative to *now* pass a date in.
 */
export const FIXED_NOW = new Date('2026-09-10T06:00:00.000Z')

/** `n` days from {@link FIXED_NOW}, as an ISO instant. */
export const inDays = (days: number, from: Date = FIXED_NOW): string =>
  new Date(from.getTime() + days * 86_400_000).toISOString()

// ── References ───────────────────────────────────────────────────────────────

export const aVenue = (over: Partial<VenueRef> = {}): VenueRef => ({
  id: 'ven_purple',
  slug: 'purple-haze',
  name: 'Purple Haze',
  area: 'Thamel',
  city: 'Kathmandu',
  ...over,
})

export const anOrganizer = (over: Partial<OrganizerRef> = {}): OrganizerRef => ({
  id: 'org_sound',
  slug: 'himalayan-sound',
  name: 'Himalayan Sound',
  is_verified: false,
  ...over,
})

/**
 * A category *as a listing carries it* — which includes `is_primary`, because
 * primacy belongs to the listing's use of the category rather than to the
 * category (api/catalog/types.ts). The first one is primary by default, since
 * a listing with categories and no primary has no pin.
 */
export const aCategoryRef = (over: Partial<CategoryRef> = {}): CategoryRef => ({
  slug: 'concerts',
  name: 'Concerts',
  name_ne: null,
  color: '#e91e63',
  icon: 'Music',
  is_primary: true,
  ...over,
})

/** A category as `/categories` returns it: no `is_primary`, plus a count. */
export const aCategory = (over: Partial<Category> = {}): Category => ({
  slug: 'concerts',
  name: 'Concerts',
  name_ne: null,
  color: '#e91e63',
  icon: 'Music',
  upcoming_listing_count: 1,
  ...over,
})

/**
 * An offer — the one seam NepScene renders and never computes
 * (docs/SCOPE.md). Deliberately not a default on `aListing`: most listings in
 * Nepal are free or ticketed elsewhere, and a fixture bank where everything is
 * purchasable would quietly make the commerce path look like the common one.
 */
export const anOffer = (over: Partial<Offer> = {}): Offer => ({
  purchasable: true,
  price_from: 80_000,
  currency: 'NPR',
  url: 'https://waahtickets.example/e/rock-night',
  provider: 'waahtickets',
  sold_out: false,
  ...over,
} as Offer)

export const aMediaItem = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: 'med_cover',
  url: 'https://media.example/cover.jpg',
  kind: 'image',
  alt_text: 'A crowd, lit from behind.',
  width: 1600,
  height: 900,
  aspect_ratio: 16 / 9,
  sources: [],
  ...over,
})

// ── Listings ─────────────────────────────────────────────────────────────────

/**
 * The least interesting valid listing: free, unfeatured, uncategorised, with
 * no venue, no coordinates and no offer.
 *
 * `id` defaults but is usually worth setting — several helpers derive `slug`
 * and `title` from it, so `aListing({ id: 'rock-night' })` reads as one thing
 * rather than three.
 */
export function aListing(over: Partial<Listing> & { id?: string } = {}): Listing {
  const id = over.id ?? 'lst_one'
  return {
    id,
    slug: id.replace(/^lst_/, ''),
    title: id.replace(/^lst_/, ''),
    title_ne: null,
    summary: null,
    summary_ne: null,
    listing_type: 'free',
    source: 'organizer',
    starts_at: inDays(7),
    ends_at: null,
    is_all_day: false,
    timezone: 'Asia/Kathmandu',
    cover_image_url: null,
    external_url: null,
    is_featured: false,
    map_popup_config: null,
    latitude: null,
    longitude: null,
    pin: { icon: 'MapPin', color: '#64748b', category: null },
    venue: null,
    organizer: null,
    categories: [],
    cover: null,
    offer: null,
    ...over,
  }
}

/**
 * A listing that can be drawn on a map: a venue, a coordinate, and a category
 * for the pin to take its colour from.
 *
 * Separate from `aListing` rather than a default on it, because "has no
 * coordinates" is a real and common state — an announcement with no venue yet
 * is a legitimate row the feed shows and the map cannot — and a factory that
 * placed everything would hide the code that handles it.
 */
export function aPlacedListing(over: Partial<Listing> & { id?: string } = {}): Listing {
  const category = aCategoryRef()
  return aListing({
    latitude: 27.7154,
    longitude: 85.3105,
    venue: aVenue(),
    categories: [category],
    pin: { icon: category.icon!, color: category.color!, category: category.slug },
    ...over,
  })
}

/** The full record behind a listing page (#43). */
export function aListingDetail(
  over: Partial<ListingDetail> & { id?: string } = {},
): ListingDetail {
  return {
    ...aListing(over),
    description: null,
    description_ne: null,
    published_at: inDays(-1),
    venue_room: null,
    media: [],
    artists: [],
    tags: [],
    related: [],
    ...over,
  } as ListingDetail
}
