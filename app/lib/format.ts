import type { Listing, Offer } from './catalog'

/**
 * Display formatting. Every listing carries its own IANA timezone, and the
 * catalogue is Nepal-wide, so times are formatted in the listing's zone rather
 * than the reader's: an event in Pokhara starts when it starts there.
 */

const inZone = (listing: Listing, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: listing.timezone, ...options })

export function startDay(listing: Listing) {
  const start = new Date(listing.starts_at)
  return {
    day: inZone(listing, { day: 'numeric' }).format(start),
    month: inZone(listing, { month: 'short' }).format(start),
    weekday: inZone(listing, { weekday: 'short' }).format(start),
  }
}

export function startTime(listing: Listing): string {
  if (listing.is_all_day) return 'All day'
  return inZone(listing, { hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(listing.starts_at))
    .toLowerCase()
}

/** "Purple Haze Rock Bar, Thamel" — the area only when it adds something. */
export function venueLine(listing: Listing): string | null {
  const venue = listing.venue
  if (!venue) return null
  const place = venue.area ?? venue.city
  return place && place !== venue.name ? `${venue.name}, ${place}` : venue.name
}

/**
 * The seam (docs/SCOPE.md): this reads a snapshot the catalogue was given and
 * formats it. It does not decide a price, apply a discount, or check
 * availability — `price_from` arrives as integer paisa and the only arithmetic
 * permitted is the hundred that turns paisa into rupees for display.
 */
export function offerLine(listing: Listing): string | null {
  if (listing.listing_type === 'free') return 'Free'
  const offer: Offer | null = listing.offer
  if (!offer) return null
  if (offer.sold_out) return 'Sold out'
  if (offer.price_from == null) return null
  // A zero snapshot means free, and "From NPR 0" is how a catalogue tells
  // someone it does not understand its own data.
  if (offer.price_from === 0) return 'Free'
  const rupees = offer.price_from / 100
  return `From ${offer.currency} ${rupees.toLocaleString('en-NP', { maximumFractionDigits: 0 })}`
}

export const LISTING_TYPE_LABEL: Record<Listing['listing_type'], string | null> = {
  ticketed_internal: null,
  ticketed_external: 'Tickets elsewhere',
  free: 'Free',
  announcement: 'Announcement',
}
