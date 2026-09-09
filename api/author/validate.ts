/**
 * The listing input contract and its rules (#30).
 *
 * Imported by the browser as well as the Worker, which is the one place this
 * codebase shares a file across the two halves. `app/lib/catalog.ts` mirrors
 * the read types rather than importing them, because a *type* contract is
 * additive and a copy drifts loudly — a removed field stops compiling. Rules
 * are not additive: two copies of "an external listing needs a ticket URL"
 * drift silently, and the half that drifts is whichever one is not the last
 * line of defence. So there is one copy, and it is this one.
 *
 * That is only safe because nothing here touches a platform global — no DOM,
 * no Workers types, no fetch, no crypto. Keep it that way.
 */

export const LISTING_TYPES = [
  'ticketed_internal', 'ticketed_external', 'free', 'announcement',
] as const
export type ListingType = (typeof LISTING_TYPES)[number]

/** What an author may write. Status is not here: it moves through transitions. */
export type ListingInput = {
  title: string
  summary: string | null
  description: string | null
  listing_type: ListingType
  organization_id: string | null
  venue_id: string | null
  starts_at: string
  ends_at: string | null
  is_all_day: boolean
  timezone: string
  external_url: string | null
  offer_url: string | null
  location_lat: number | null
  location_lng: number | null
  map_popup_config: unknown | null
  category_slugs: string[]
  primary_category_slug: string | null
  tags: string[]
  artist_slugs: string[]
}

export type FieldError = { field: keyof ListingInput | 'form'; message: string }

/**
 * The wizard's steps. Order is the order they are walked; `appliesTo` is what
 * makes the walk conditional, so an announcement never asks where it is.
 *
 * There is no pricing step and there never will be — docs/SCOPE.md. What the
 * type controls is whether a listing links *out* to somewhere selling entry.
 */
export const WIZARD_STEPS = [
  { id: 'details',    title: 'What is it',   appliesTo: LISTING_TYPES },
  { id: 'when',       title: 'When',         appliesTo: LISTING_TYPES },
  { id: 'where',      title: 'Where',        appliesTo: ['ticketed_internal', 'ticketed_external', 'free'] },
  { id: 'media',      title: 'Pictures',     appliesTo: LISTING_TYPES },
  { id: 'appearance', title: 'On the map',   appliesTo: ['ticketed_internal', 'ticketed_external', 'free'] },
  { id: 'review',     title: 'Review',       appliesTo: LISTING_TYPES },
] as const satisfies readonly { id: string; title: string; appliesTo: readonly ListingType[] }[]

export type StepId = (typeof WIZARD_STEPS)[number]['id']

export function stepsFor(type: ListingType): StepId[] {
  return WIZARD_STEPS
    .filter((step) => (step.appliesTo as readonly ListingType[]).includes(type))
    .map((step) => step.id)
}

/** An external listing links out to whoever sells entry; an internal one to us. */
export const needsTicketUrl = (type: ListingType) => type === 'ticketed_external'
export const hasPlace = (type: ListingType) => type !== 'announcement'

const MAX = {
  title: 200, summary: 300, description: 20_000, url: 2000,
  venueName: 200, address: 300, phone: 40, capacity: 500_000,
} as const

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function isHttpUrl(value: string): boolean {
  // Deliberately not `new URL`: it accepts javascript: and data: happily, and
  // this string ends up in an href.
  return /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(value) && value.length <= MAX.url
}

const blank = (value: string | null | undefined): boolean =>
  value === null || value === undefined || value.trim() === ''

/**
 * Validation per step, so the wizard can block Next on the step that is wrong
 * rather than dumping every error at the end. Each message names the field and
 * says what to do about it — "Add a title" beats "title: required".
 */
export function validateStep(step: StepId, input: Partial<ListingInput>): FieldError[] {
  const errors: FieldError[] = []
  const type = input.listing_type

  if (step === 'details') {
    if (blank(input.title)) {
      errors.push({ field: 'title', message: 'Give it a title — this is what people see first' })
    } else if (input.title!.trim().length > MAX.title) {
      errors.push({ field: 'title', message: `Shorten the title to ${MAX.title} characters or fewer` })
    }
    if (!type || !LISTING_TYPES.includes(type)) {
      errors.push({ field: 'listing_type', message: 'Choose what kind of listing this is' })
    }
    if (!blank(input.summary) && input.summary!.trim().length > MAX.summary) {
      errors.push({ field: 'summary', message: `Shorten the one-line summary to ${MAX.summary} characters` })
    }
    if (!blank(input.description) && input.description!.length > MAX.description) {
      errors.push({ field: 'description', message: 'The description is too long' })
    }
    if (!blank(input.external_url) && !isHttpUrl(input.external_url!.trim())) {
      errors.push({ field: 'external_url', message: 'The event website must start with http:// or https://' })
    }
    // The conditional field the wizard reveals: only external listings carry a
    // ticket link, and for them it is the point of the listing.
    if (type && needsTicketUrl(type)) {
      if (blank(input.offer_url)) {
        errors.push({ field: 'offer_url', message: 'Add the link where people get tickets' })
      } else if (!isHttpUrl(input.offer_url!.trim())) {
        errors.push({ field: 'offer_url', message: 'The ticket link must start with http:// or https://' })
      }
    }
    if (input.category_slugs && input.category_slugs.length === 0) {
      errors.push({ field: 'category_slugs', message: 'Pick at least one category — it decides the map pin' })
    }
    if (input.primary_category_slug && input.category_slugs
        && !input.category_slugs.includes(input.primary_category_slug)) {
      errors.push({ field: 'primary_category_slug', message: 'The main category must be one you selected' })
    }
  }

  if (step === 'when') {
    if (blank(input.starts_at)) {
      errors.push({ field: 'starts_at', message: 'Say when it starts' })
    } else if (!ISO.test(input.starts_at!) || Number.isNaN(Date.parse(input.starts_at!))) {
      errors.push({ field: 'starts_at', message: 'That start date could not be read' })
    }
    if (!blank(input.ends_at)) {
      if (!ISO.test(input.ends_at!) || Number.isNaN(Date.parse(input.ends_at!))) {
        errors.push({ field: 'ends_at', message: 'That end date could not be read' })
      } else if (!blank(input.starts_at) && Date.parse(input.ends_at!) <= Date.parse(input.starts_at!)) {
        errors.push({ field: 'ends_at', message: 'It has to end after it starts' })
      }
    }
    if (blank(input.timezone)) {
      errors.push({ field: 'timezone', message: 'Choose a timezone' })
    }
  }

  if (step === 'where' && type && hasPlace(type)) {
    if (blank(input.venue_id)) {
      errors.push({ field: 'venue_id', message: 'Choose where it happens, or add a new venue' })
    }
    // Coordinates are optional here — they override the venue's — but a half
    // pair is always a bug rather than a choice.
    const lat = input.location_lat ?? null
    const lng = input.location_lng ?? null
    if ((lat === null) !== (lng === null)) {
      errors.push({ field: 'location_lat', message: 'A pin needs both a latitude and a longitude' })
    }
    if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
      errors.push({ field: 'location_lat', message: 'Latitude must be between -90 and 90' })
    }
    if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) {
      errors.push({ field: 'location_lng', message: 'Longitude must be between -180 and 180' })
    }
  }

  return errors
}

/**
 * Everything, for the server and for the review step. Steps that do not apply
 * to the type are not walked, which is what stops an announcement being asked
 * for a venue it cannot have.
 */
export function validateListing(input: Partial<ListingInput>): FieldError[] {
  const type = input.listing_type && LISTING_TYPES.includes(input.listing_type)
    ? input.listing_type
    : null
  // With no valid type the only steps that can be judged are the unconditional
  // ones; `details` reports the missing type itself.
  const steps: StepId[] = type ? stepsFor(type) : ['details', 'when']
  return steps.flatMap((step) => validateStep(step, input))
}

/** A blank listing, so the wizard and its tests start from the same place. */
export function emptyListing(): ListingInput {
  return {
    title: '', summary: null, description: null,
    listing_type: 'free',
    organization_id: null, venue_id: null,
    starts_at: '', ends_at: null, is_all_day: false, timezone: 'Asia/Kathmandu',
    external_url: null, offer_url: null,
    location_lat: null, location_lng: null, map_popup_config: null,
    category_slugs: [], primary_category_slug: null, tags: [], artist_slugs: [],
  }
}

// ─── Venues (#31) ────────────────────────────────────────────────────────────

/**
 * What an author may write when creating a venue.
 *
 * The rules live here rather than in the handler for the same reason the
 * listing's do: the picker has to be able to say "that pin is in the wrong
 * hemisphere" before it costs a round trip, and two copies of that rule drift.
 * Duplicate detection is deliberately *not* here — it needs the catalogue to
 * compare against, so it lives in `venueMatch.ts` and runs on the server only.
 */
export type VenueInput = {
  name: string
  description: string | null
  address: string | null
  area: string | null
  city: string | null
  district: string | null
  province: string | null
  country: string
  latitude: number | null
  longitude: number | null
  google_place_id: string | null
  website_url: string | null
  phone: string | null
  capacity: number | null
}

export type VenueFieldError = { field: keyof VenueInput | 'form'; message: string }

/**
 * Nepal's bounding box, generously drawn: roughly Kanchanpur to Taplejung, and
 * the Terai to the northern border.
 *
 * It is here to catch one specific, common and otherwise invisible mistake —
 * latitude and longitude entered the wrong way round. Kathmandu is 27.7N
 * 85.3E, and the swap gives 85.3N 27.7E, which is a perfectly valid coordinate
 * pair in the Arctic Ocean. Nothing downstream would object: the pin would
 * simply draw somewhere nobody looks. A range check is the only thing that
 * notices.
 *
 * Applied only when the country is Nepal, so the day the catalogue crosses a
 * border this rule stops rather than lies.
 */
const NEPAL_BOUNDS = { minLat: 26.0, maxLat: 30.6, minLng: 79.9, maxLng: 88.3 } as const

export function validateVenue(input: Partial<VenueInput>): VenueFieldError[] {
  const errors: VenueFieldError[] = []

  if (blank(input.name)) {
    errors.push({ field: 'name', message: 'Give the venue a name — this is what authors will search for' })
  } else if (input.name!.trim().length > MAX.venueName) {
    errors.push({ field: 'name', message: `Shorten the name to ${MAX.venueName} characters or fewer` })
  }

  if (!blank(input.address) && input.address!.trim().length > MAX.address) {
    errors.push({ field: 'address', message: `Shorten the address to ${MAX.address} characters` })
  }
  if (!blank(input.phone) && input.phone!.trim().length > MAX.phone) {
    errors.push({ field: 'phone', message: 'That phone number is too long to be one' })
  }
  if (!blank(input.website_url) && !isHttpUrl(input.website_url!.trim())) {
    errors.push({ field: 'website_url', message: 'The website must start with http:// or https://' })
  }
  if (input.capacity !== null && input.capacity !== undefined) {
    if (!Number.isInteger(input.capacity) || input.capacity <= 0 || input.capacity > MAX.capacity) {
      errors.push({ field: 'capacity', message: 'Capacity is a whole number of people, or leave it blank' })
    }
  }

  const lat = input.latitude ?? null
  const lng = input.longitude ?? null
  if ((lat === null) !== (lng === null)) {
    errors.push({ field: 'latitude', message: 'A pin needs both a latitude and a longitude' })
  }
  if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
    errors.push({ field: 'latitude', message: 'Latitude must be between -90 and 90' })
  }
  if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) {
    errors.push({ field: 'longitude', message: 'Longitude must be between -180 and 180' })
  }
  const country = (input.country ?? 'NP').toUpperCase()
  if (country === 'NP' && lat !== null && lng !== null
      && Number.isFinite(lat) && Number.isFinite(lng)
      && (lat < NEPAL_BOUNDS.minLat || lat > NEPAL_BOUNDS.maxLat
          || lng < NEPAL_BOUNDS.minLng || lng > NEPAL_BOUNDS.maxLng)) {
    errors.push({
      field: 'latitude',
      message: 'That pin is outside Nepal — check the latitude and longitude are not swapped',
    })
  }

  return errors
}

/** A blank venue, so the picker and its tests start from the same place. */
export function emptyVenue(): VenueInput {
  return {
    name: '', description: null, address: null, area: null, city: null,
    district: null, province: null, country: 'NP',
    latitude: null, longitude: null, google_place_id: null,
    website_url: null, phone: null, capacity: null,
  }
}
