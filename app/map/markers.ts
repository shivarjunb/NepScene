import type { Listing } from '../lib/catalog'
import type { PinAppearance } from '../../api/catalog/types'
import { offerLine, startDay, startTime, venueLine } from '../lib/format'

/**
 * Turning a catalogue listing into something that can be drawn at a point
 * (#36).
 *
 * Separate from the map component because it is the part with rules in it, and
 * rules deserve tests that do not need an SDK. The component's job is
 * lifecycle — construct, attach, tear down; this one's is meaning.
 */

/**
 * What `ListingPopup` renders. Every field is a string somebody else formatted
 * — the popup computes nothing, which is what lets the wizard's preview and
 * the live map be one component rather than two that drift.
 */
export type PopupListing = {
  slug: string
  title: string
  pin: PinAppearance
  venue: string | null
  when: string | null
  category: string | null
  summary: string | null
  /** Already formatted by whoever knows the currency; never computed here. */
  offer: { label: string; url: string | null } | null
}

export type MapPin = {
  id: string
  slug: string
  lat: number
  lng: number
  /**
   * The venue this listing sits at, or null where it has only coordinates.
   *
   * Grouping (#37) keys on this. WaahTickets could not — venues were not
   * entities there, so it rounded coordinates to three decimals and hoped.
   * That buckets by roughly 100 metres, which is both wrong (two venues on
   * opposite sides of one street merge; one venue whose listings carry
   * slightly different coordinates splits) and more expensive than reading an
   * id that the row already carries.
   */
  venueId: string | null
  /** Sort inputs for a grouped pin's stack. See `rankOf` in venueGrouping.ts. */
  rank: PinRank
  /**
   * "2 OCT" — the compact badge a stack row carries (#37), so a viewer
   * scanning ten listings at one venue reads dates down a column rather than
   * hunting for them inside ten sentences. The popup's own `when` is the
   * sentence; this is the chip.
   */
  dateChip: string
  /** Derived from the primary category by the API (api/catalog/pin.ts). */
  pin: PinAppearance
  popup: PopupListing
  /**
   * The author's popup customisation (#32), untouched. It is parsed at render
   * time rather than here so that `parsePopupConfig` — the one validator the
   * wizard and the Worker already share — stays the only thing that decides
   * what a malformed config means.
   */
  popupConfig: unknown
}

/**
 * What decides a listing's place in a venue stack.
 *
 * Held on the pin rather than recomputed during the sort because `live`
 * depends on the clock: sorting a list twice in one render must not put a
 * listing in two different places because a second elapsed between the
 * comparisons.
 */
export type PinRank = {
  /** Running right now — started, and not yet finished. */
  live: boolean
  featured: boolean
  /** The offer's snapshot, not a judgement of our own (docs/SCOPE.md). */
  soldOut: boolean
  /** ISO instant, for the tie-break. Soonest first. */
  startsAt: string
}

/**
 * A listing with no coordinates is not a map failure — an announcement with no
 * venue yet is a legitimate row that the feed shows and the map cannot. It is
 * dropped here, once, rather than guarded against at every point downstream.
 *
 * `latitude` already falls back to the venue's position in SQL
 * (`COALESCE(l.location_lat, v.latitude)`), so by the time a listing is here
 * there is nowhere else left to look.
 */
export function toMapPin(listing: Listing, now = new Date()): MapPin | null {
  if (listing.latitude === null || listing.longitude === null) return null

  return {
    id: listing.id,
    slug: listing.slug,
    lat: listing.latitude,
    lng: listing.longitude,
    venueId: listing.venue?.id ?? null,
    dateChip: dateChipOf(listing),
    rank: {
      live: isLive(listing, now),
      featured: listing.is_featured,
      soldOut: listing.offer?.sold_out ?? false,
      startsAt: listing.starts_at,
    },
    // Passed through, never recomputed. The chip and the pin read one value.
    pin: listing.pin,
    popup: toPopupListing(listing),
    popupConfig: listing.map_popup_config,
  }
}

/** Only the listings that can be drawn, in the order the feed gave them. */
export const toMapPins = (listings: Listing[], now = new Date()): MapPin[] =>
  listings.flatMap((listing) => toMapPin(listing, now) ?? [])

/**
 * How long a listing with no end time is treated as running.
 *
 * Ported from WaahTickets, which used six hours and was right to: a gig with
 * no stated finish is over by the small hours, and treating it as live for the
 * rest of the week would put every under-specified listing at the top of every
 * stack forever.
 */
const OPEN_ENDED_HOURS = 6

/** "2 OCT", in the listing's own timezone — never the reader's. */
function dateChipOf(listing: Listing): string {
  const { day, month } = startDay(listing)
  return `${day} ${month.toUpperCase()}`
}

function isLive(listing: Listing, now: Date): boolean {
  const start = Date.parse(listing.starts_at)
  if (Number.isNaN(start)) return false
  const at = now.getTime()
  if (at < start) return false

  const end = listing.ends_at === null ? Number.NaN : Date.parse(listing.ends_at)
  if (!Number.isNaN(end)) return at <= end
  return at - start <= OPEN_ENDED_HOURS * 60 * 60 * 1000
}

/**
 * The popup's view of a listing.
 *
 * Every field is formatted here, where the timezone and the currency are
 * known, so that `ListingPopup` renders strings it was handed and computes
 * nothing — which is what lets the wizard's preview and the live map share one
 * component (see the note in `ListingPopup.tsx`).
 */
export function toPopupListing(listing: Listing): PopupListing {
  const { day, month, weekday } = startDay(listing)
  const primary = listing.categories.find((category) => category.is_primary)
    ?? listing.categories[0]
    ?? null

  return {
    slug: listing.slug,
    title: listing.title,
    pin: listing.pin,
    venue: venueLine(listing),
    when: `${weekday} ${day} ${month}, ${startTime(listing)}`,
    category: primary?.name ?? null,
    summary: listing.summary,
    offer: offerFor(listing),
  }
}

/**
 * The seam again (docs/SCOPE.md). `offerLine` formats the snapshot the
 * catalogue was given; the URL is whatever it was told to link to. Nothing
 * here decides whether a thing can be bought.
 */
function offerFor(listing: Listing): PopupListing['offer'] {
  const label = offerLine(listing)
  if (!label) return null
  return { label, url: listing.offer?.url ?? listing.external_url ?? null }
}

/**
 * Pins keyed by identity, so a pan that returns rows already on the map reuses
 * the markers instead of tearing them down and rebuilding them.
 *
 * Rebuilding is what makes a map flicker on every drag, and it is also what
 * closes the popup the viewer was reading.
 *
 * `limit` bounds what is kept (#39). A `Map` preserves insertion order and
 * re-setting an existing key does *not* move it, so the oldest pins are at the
 * front — but a pin the current viewport just returned is re-set on every
 * page, which would leave it looking old. So a re-set is deleted first: what
 * survives an overflow is what has been seen most recently, which is what the
 * viewer is looking at.
 */
export function mergePins(
  existing: MapPin[], incoming: MapPin[], limit = Infinity,
): MapPin[] {
  const byId = new Map(existing.map((pin) => [pin.id, pin]))
  for (const pin of incoming) {
    byId.delete(pin.id)
    byId.set(pin.id, pin)
  }
  if (byId.size <= limit) return [...byId.values()]
  return [...byId.values()].slice(byId.size - limit)
}
