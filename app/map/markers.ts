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
 * A listing with no coordinates is not a map failure — an announcement with no
 * venue yet is a legitimate row that the feed shows and the map cannot. It is
 * dropped here, once, rather than guarded against at every point downstream.
 *
 * `latitude` already falls back to the venue's position in SQL
 * (`COALESCE(l.location_lat, v.latitude)`), so by the time a listing is here
 * there is nowhere else left to look.
 */
export function toMapPin(listing: Listing): MapPin | null {
  if (listing.latitude === null || listing.longitude === null) return null

  return {
    id: listing.id,
    slug: listing.slug,
    lat: listing.latitude,
    lng: listing.longitude,
    // Passed through, never recomputed. The chip and the pin read one value.
    pin: listing.pin,
    popup: toPopupListing(listing),
    popupConfig: listing.map_popup_config,
  }
}

/** Only the listings that can be drawn, in the order the feed gave them. */
export const toMapPins = (listings: Listing[]): MapPin[] =>
  listings.flatMap((listing) => toMapPin(listing) ?? [])

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
 */
export function mergePins(existing: MapPin[], incoming: MapPin[]): MapPin[] {
  const byId = new Map(existing.map((pin) => [pin.id, pin]))
  for (const pin of incoming) byId.set(pin.id, pin)
  return [...byId.values()]
}
