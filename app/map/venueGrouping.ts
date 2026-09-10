import type { MapPin } from './markers'

/**
 * Several listings at one place become one pin (#37).
 *
 * Ported from WaahTickets' `venueGrouping.ts` with one substantive change and
 * everything else preserved deliberately.
 *
 * **The change: the key.** The original bucketed on
 * `venueId ?? "${lat.toFixed(3)},${lng.toFixed(3)}"` — and in practice the
 * fallback was the common path, because venues were not entities there and
 * most events carried coordinates rather than a venue id. Rounding to three
 * decimals is a ~100m grid, which fails in both directions at once: two
 * distinct venues across a narrow street land in one bucket, and one venue
 * whose listings were geocoded a few metres apart lands in two. Worse, the
 * grid is absolute, so whether two points merge depends on where the cell
 * boundary happens to fall rather than on how far apart they are.
 *
 * Venues are first-class here (#21), so the key is the venue's id. The
 * coordinate fallback survives for the genuinely venue-less listing — an
 * announcement pinned to a point — but it now keys on the *exact* coordinate,
 * because two listings at literally the same point are the same place and two
 * that are not should not be guessed at.
 *
 * **What is preserved: the sort.** Live first, then featured, then regular,
 * then sold-out last — with sold-out *not* demoted when it is also live or
 * featured. That was tuned once against real listings and there is no reason
 * to retune it; the shape of the ternary is what encodes it, so the tests
 * below it are what keep it.
 */

export type VenueGroup = {
  /** Venue id, or `@lat,lng` for a listing with no venue. */
  key: string
  lat: number
  lng: number
  /** Every listing at this place, in stack order. Never empty. */
  pins: MapPin[]
  /** `pins[0]`, named because it is what the pin itself draws. */
  primary: MapPin
  /** `pins.length`, named because it is what the bubble shows. */
  count: number
}

/**
 * Sort priority, lowest first.
 *
 * The order of the tests is the whole rule. A sold-out listing that is also
 * live returns 0 and stays at the top, because `live` is asked first — being
 * unable to buy a ticket for something happening now is not a reason to hide
 * that it is happening now. NepScene is a discovery product; the offer is a
 * snapshot it renders, never a filter it applies (docs/SCOPE.md).
 */
export function rankOf(pin: MapPin): number {
  const { live, featured, soldOut } = pin.rank
  if (live) return 0
  if (featured) return 1
  if (soldOut) return 3
  return 2
}

/**
 * Stack order within one venue: priority, then soonest first.
 *
 * The tie-break is on the ISO instant rather than on a formatted time. The
 * original compared `a.time.localeCompare(b.time)` where `time` was a display
 * string like "Fri 2 Oct, 7:15 PM" — which sorts alphabetically by weekday
 * name. It happened to look sorted because the input arrived sorted.
 */
export function compareInStack(a: MapPin, b: MapPin): number {
  const byRank = rankOf(a) - rankOf(b)
  if (byRank !== 0) return byRank
  const byStart = a.rank.startsAt.localeCompare(b.rank.startsAt)
  if (byStart !== 0) return byStart
  // Identity, so the order is total and a re-render cannot reshuffle a stack
  // of listings that start at the same moment.
  return a.id.localeCompare(b.id)
}

/** The key a pin groups under: its venue, or its exact point. */
export function groupKey(pin: MapPin): string {
  return pin.venueId ?? `@${pin.lat},${pin.lng}`
}

/**
 * Group pins by venue identity, preserving the order the feed gave the
 * *groups* — the first listing at a place decides where that place appears.
 *
 * A `Map` rather than a plain object because the keys are venue ids, and an
 * id like `__proto__` in an object literal is a bug waiting for a bad day.
 */
export function groupByVenue(pins: MapPin[]): VenueGroup[] {
  const buckets = new Map<string, MapPin[]>()

  for (const pin of pins) {
    const key = groupKey(pin)
    const held = buckets.get(key)
    if (held) held.push(pin)
    else buckets.set(key, [pin])
  }

  return [...buckets].map(([key, held]) => {
    // Non-empty by construction: a key exists only because a pin created it.
    const [primary, ...rest] = [...held].sort(compareInStack)
    const sorted = [primary!, ...rest]
    // The group draws where its *primary* is, not where the first-seen listing
    // was. For a real venue every member shares a coordinate anyway; for the
    // coordinate fallback they are identical by construction. It matters only
    // when a venue's listings carry slightly different points, and then the
    // pin the viewer clicks should be under the listing they are shown.
    return {
      key,
      lat: primary!.lat,
      lng: primary!.lng,
      pins: sorted,
      primary: primary!,
      count: sorted.length,
    }
  })
}

/** The label on a grouped pin's count bubble. Singles carry no bubble. */
export function bubbleLabel(count: number): string | null {
  if (count < 2) return null
  // Past 99 the bubble stops being a number and starts being a shape.
  return count > 99 ? '99+' : String(count)
}
