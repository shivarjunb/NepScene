import { describe, expect, it } from 'vitest'
import type { Listing } from '../../app/lib/catalog'
import { toMapPin, toMapPins, type MapPin } from '../../app/map/markers'
import {
  bubbleLabel, compareInStack, groupByVenue, groupKey, rankOf,
} from '../../app/map/venueGrouping'

/**
 * #37's unit criteria, and the fifteen tests ported from WaahTickets'
 * `tests/venue-stack.test.ts` — every one of them, restated against the
 * venue-identity key rather than the rounded-coordinate one.
 *
 * The four sold-out cases are the ones worth reading. That priority was tuned
 * once against real listings and is easy to break by "tidying" the ternary in
 * `rankOf` into something that looks more symmetrical.
 */

const NOW = new Date('2026-10-02T12:00:00.000Z')

/** A pin, described by what the grouping actually reads. */
const pin = (over: Partial<MapPin> & { id: string }): MapPin => ({
  slug: over.id,
  dateChip: '2 OCT',
  lat: 27.7154,
  lng: 85.3105,
  venueId: 'v1',
  pin: { icon: 'Music', color: '#e91e63', category: 'concerts' },
  popup: {
    slug: over.id, title: over.id, pin: { icon: 'Music', color: '#e91e63', category: 'concerts' },
    venue: 'Jazz Upstairs', when: 'Fri 2 Oct, 7:15 PM', category: 'Concerts',
    summary: null, offer: null,
  },
  popupConfig: null,
  ...over,
  rank: {
    live: false, featured: false, soldOut: false,
    startsAt: '2026-10-02T13:15:00.000Z',
    ...over.rank,
  },
})

describe('grouping keys on venue identity', () => {
  it('wraps a single listing in a group of one', () => {
    const groups = groupByVenue([pin({ id: 'a' })])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(1)
    expect(groups[0]!.primary.id).toBe('a')
  })

  it('groups listings sharing a venue id into one group', () => {
    const groups = groupByVenue([
      pin({ id: 'a', venueId: 'v1' }),
      pin({ id: 'b', venueId: 'v1' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(2)
  })

  it('groups venue-less listings at the same point into one group', () => {
    const groups = groupByVenue([
      pin({ id: 'a', venueId: null, lat: 27.7, lng: 85.3 }),
      pin({ id: 'b', venueId: null, lat: 27.7, lng: 85.3 }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe('@27.7,85.3')
  })

  it('keeps different venues in separate groups', () => {
    const groups = groupByVenue([
      pin({ id: 'a', venueId: 'v1' }),
      pin({ id: 'b', venueId: 'v2' }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.every((group) => group.count === 1)).toBe(true)
  })

  it('groups one venue whose listings carry slightly different coordinates', () => {
    // The case the rounded-coordinate key got wrong: same place, two
    // geocodings a few metres apart, and a cell boundary between them.
    const groups = groupByVenue([
      pin({ id: 'a', venueId: 'v1', lat: 27.71549, lng: 85.31051 }),
      pin({ id: 'b', venueId: 'v1', lat: 27.71562, lng: 85.31048 }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(2)
  })

  it('keeps two venues 80 metres apart separate', () => {
    // The other direction: close enough that a ~100m grid would merge them,
    // and they are still two different places with two different doors.
    const groups = groupByVenue([
      pin({ id: 'a', venueId: 'v1', lat: 27.7154, lng: 85.3105 }),
      pin({ id: 'b', venueId: 'v2', lat: 27.7161, lng: 85.3105 }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('groups only genuinely co-located listings', () => {
    const groups = groupByVenue([
      pin({ id: 'a', venueId: 'v1' }),
      pin({ id: 'b', venueId: 'v1' }),
      pin({ id: 'c', venueId: 'v2' }),
    ])
    const sizes = groups.map((group) => group.count).sort()
    expect(sizes).toEqual([1, 2])
  })

  it('returns an empty array for no pins', () => {
    expect(groupByVenue([])).toEqual([])
  })

  it('preserves the coordinates through grouping', () => {
    const groups = groupByVenue([pin({ id: 'a', lat: 27.6588, lng: 85.3247 })])
    expect(groups[0]!.lat).toBe(27.6588)
    expect(groups[0]!.lng).toBe(85.3247)
  })

  it('carries the full pin into the stack, not a reduced copy', () => {
    // The popup renders from these; a group that dropped them would leave the
    // stack picker showing titles and nothing else.
    const source = pin({ id: 'a' })
    const [group] = groupByVenue([source])
    expect(group!.pins[0]).toBe(source)
    expect(group!.pins[0]!.popup.venue).toBe('Jazz Upstairs')
    expect(group!.pins[0]!.popup.when).toBe('Fri 2 Oct, 7:15 PM')
  })
})

describe('the tuned sort priority', () => {
  it('puts the featured listing first in a multi-listing group', () => {
    const groups = groupByVenue([
      pin({ id: 'plain' }),
      pin({ id: 'featured', rank: { featured: true } as MapPin['rank'] }),
    ])
    expect(groups[0]!.primary.id).toBe('featured')
  })

  it('puts a live listing before a plain one', () => {
    const groups = groupByVenue([
      pin({ id: 'plain' }),
      pin({ id: 'live', rank: { live: true } as MapPin['rank'] }),
    ])
    expect(groups[0]!.primary.id).toBe('live')
  })

  it('puts a live listing before a featured one', () => {
    const groups = groupByVenue([
      pin({ id: 'featured', rank: { featured: true } as MapPin['rank'] }),
      pin({ id: 'live', rank: { live: true } as MapPin['rank'] }),
    ])
    expect(groups[0]!.primary.id).toBe('live')
  })

  it('puts a plain sold-out listing last', () => {
    const groups = groupByVenue([
      pin({ id: 'sold', rank: { soldOut: true } as MapPin['rank'] }),
      pin({ id: 'plain' }),
    ])
    expect(groups[0]!.pins.map((p) => p.id)).toEqual(['plain', 'sold'])
  })

  it('does not demote a sold-out live listing to last place', () => {
    const groups = groupByVenue([
      pin({ id: 'plain' }),
      pin({ id: 'live-sold', rank: { live: true, soldOut: true } as MapPin['rank'] }),
    ])
    expect(groups[0]!.primary.id).toBe('live-sold')
  })

  it('does not demote a sold-out featured listing to last place', () => {
    const groups = groupByVenue([
      pin({ id: 'plain' }),
      pin({ id: 'featured-sold', rank: { featured: true, soldOut: true } as MapPin['rank'] }),
    ])
    expect(groups[0]!.primary.id).toBe('featured-sold')
  })

  it('orders live, then featured, then regular, then sold-out', () => {
    const groups = groupByVenue([
      pin({ id: 'sold', rank: { soldOut: true } as MapPin['rank'] }),
      pin({ id: 'plain' }),
      pin({ id: 'featured', rank: { featured: true } as MapPin['rank'] }),
      pin({ id: 'live', rank: { live: true } as MapPin['rank'] }),
    ])
    expect(groups[0]!.pins.map((p) => p.id)).toEqual(['live', 'featured', 'plain', 'sold'])
  })

  it('ranks every combination of live, featured and sold-out', () => {
    const rank = (live: boolean, featured: boolean, soldOut: boolean) =>
      rankOf(pin({ id: 'x', rank: { live, featured, soldOut, startsAt: '2026-10-02T13:15:00.000Z' } }))

    expect(rank(true, true, true)).toBe(0)
    expect(rank(true, true, false)).toBe(0)
    expect(rank(true, false, true)).toBe(0)
    expect(rank(true, false, false)).toBe(0)
    expect(rank(false, true, true)).toBe(1)
    expect(rank(false, true, false)).toBe(1)
    expect(rank(false, false, true)).toBe(3)
    expect(rank(false, false, false)).toBe(2)
  })

  it('breaks a tie on the start instant, soonest first', () => {
    const groups = groupByVenue([
      pin({ id: 'later', rank: { startsAt: '2026-10-04T13:00:00.000Z' } as MapPin['rank'] }),
      pin({ id: 'sooner', rank: { startsAt: '2026-10-03T13:00:00.000Z' } as MapPin['rank'] }),
    ])
    expect(groups[0]!.pins.map((p) => p.id)).toEqual(['sooner', 'later'])
  })

  it('breaks a same-instant tie on identity, so the order is stable', () => {
    const a = pin({ id: 'a' })
    const b = pin({ id: 'b' })
    expect(compareInStack(a, b)).toBeLessThan(0)
    expect(compareInStack(b, a)).toBeGreaterThan(0)
    expect(compareInStack(a, a)).toBe(0)
  })
})

describe('the count bubble', () => {
  it('counts groups of 2, 3 and 10 accurately', () => {
    for (const size of [2, 3, 10]) {
      const pins = Array.from({ length: size }, (_, i) => pin({ id: `p${i}` }))
      const [group] = groupByVenue(pins)
      expect(group!.count).toBe(size)
      expect(group!.pins).toHaveLength(size)
    }
  })

  it('shows no bubble on a single pin', () => {
    expect(bubbleLabel(1)).toBeNull()
    expect(bubbleLabel(0)).toBeNull()
  })

  it('shows the count, and caps the label at 99+', () => {
    expect(bubbleLabel(2)).toBe('2')
    expect(bubbleLabel(99)).toBe('99')
    expect(bubbleLabel(100)).toBe('99+')
  })
})

// ── The rank a listing arrives with ──────────────────────────────────────────

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: 'listing-1',
  slug: 'jazz-at-the-house',
  title: 'Jazz at the House',
  title_ne: null,
  summary: null,
  summary_ne: null,
  listing_type: 'ticketed_internal',
  source: 'organizer',
  starts_at: '2026-10-02T11:00:00.000Z',
  ends_at: null,
  is_all_day: false,
  timezone: 'Asia/Kathmandu',
  cover_image_url: null,
  external_url: null,
  is_featured: false,
  map_popup_config: null,
  latitude: 27.7154,
  longitude: 85.3105,
  pin: { icon: 'Music', color: '#e91e63', category: 'concerts' },
  venue: { id: 'v1', slug: 'jazz-house', name: 'Jazz Upstairs', area: 'Lazimpat', city: 'Kathmandu' },
  organizer: null,
  categories: [],
  cover: null,
  offer: null,
  ...over,
})

describe('a listing carries its rank onto the pin', () => {
  it('takes the venue id from the listing, so grouping has a key', () => {
    expect(toMapPin(listing(), NOW)?.venueId).toBe('v1')
    expect(toMapPin(listing({ venue: null }), NOW)?.venueId).toBeNull()
  })

  it('is live between its start and its stated end', () => {
    const between = listing({
      starts_at: '2026-10-02T11:00:00.000Z', ends_at: '2026-10-02T14:00:00.000Z',
    })
    expect(toMapPin(between, NOW)?.rank.live).toBe(true)
    expect(toMapPin(between, new Date('2026-10-02T15:00:00.000Z'))?.rank.live).toBe(false)
    expect(toMapPin(between, new Date('2026-10-02T10:00:00.000Z'))?.rank.live).toBe(false)
  })

  it('treats an open-ended listing as live for six hours and no longer', () => {
    const open = listing({ starts_at: '2026-10-02T11:00:00.000Z', ends_at: null })
    expect(toMapPin(open, new Date('2026-10-02T16:59:00.000Z'))?.rank.live).toBe(true)
    expect(toMapPin(open, new Date('2026-10-02T17:01:00.000Z'))?.rank.live).toBe(false)
  })

  it('reads sold-out from the offer snapshot, and never invents one', () => {
    expect(toMapPin(listing(), NOW)?.rank.soldOut).toBe(false)
    const sold = listing({
      offer: {
        purchasable: false, price_from: null, currency: 'NPR',
        url: 'https://example.test', provider: 'external', sold_out: true,
      } as Listing['offer'],
    })
    expect(toMapPin(sold, NOW)?.rank.soldOut).toBe(true)
  })

  it('groups the pins a feed page produced', () => {
    const pins = toMapPins([
      listing({ id: 'a', venue: { id: 'v1', slug: 'a', name: 'A', area: null, city: null } }),
      listing({ id: 'b', venue: { id: 'v1', slug: 'a', name: 'A', area: null, city: null } }),
      listing({ id: 'c', venue: { id: 'v2', slug: 'b', name: 'B', area: null, city: null } }),
      listing({ id: 'd', latitude: null, longitude: null }),
    ], NOW)
    expect(pins).toHaveLength(3)
    const groups = groupByVenue(pins)
    expect(groups.map((group) => [group.key, group.count])).toEqual([['v1', 2], ['v2', 1]])
  })

  it('keys a venue-less pin on its exact point', () => {
    const pinned = toMapPin(listing({ venue: null, latitude: 27.7, longitude: 85.3 }), NOW)!
    expect(groupKey(pinned)).toBe('@27.7,85.3')
  })
})
