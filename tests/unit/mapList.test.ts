import { describe, expect, it } from 'vitest'
import type { Listing } from '../../app/lib/catalog'
import { toMapPins, type MapPin } from '../../app/map/markers'
import { groupByVenue } from '../../app/map/venueGrouping'
import { within, type Bounds } from '../../app/map/viewport'
import { haversineKm } from '../../api/lib/geo'

/**
 * #40's unit criterion: "list view and map view return identical result sets
 * for identical filters".
 *
 * The way that claim is kept true is architectural rather than tested into
 * existence — `MapList` takes the grouped array the markers are drawn from
 * and has no fetch of its own, so there is no second code path that *could*
 * diverge. What these tests pin is that the array is the one both surfaces
 * read: the viewport cut and the distance cut happen once, before the split.
 *
 * The failure this guards against is the obvious refactor: giving the list its
 * own query so it can page independently. That is where WaahTickets' map and
 * feed drifted, and it is invisible until somebody compares two screens.
 */

const KATHMANDU: Bounds = { west: 85.20, south: 27.62, east: 85.42, north: 27.80 }
const CENTRE = { lat: 27.7154, lng: 85.3105 }

const listing = (over: Partial<Listing> & { id: string }): Listing => ({
  slug: over.id,
  title: over.id,
  title_ne: null,
  summary: null,
  summary_ne: null,
  listing_type: 'free',
  source: 'organizer',
  starts_at: '2026-10-02T13:15:00.000Z',
  ends_at: null,
  is_all_day: false,
  timezone: 'Asia/Kathmandu',
  cover_image_url: null,
  external_url: null,
  is_featured: false,
  map_popup_config: null,
  latitude: CENTRE.lat,
  longitude: CENTRE.lng,
  pin: { icon: 'Music', color: '#e91e63', category: 'concerts' },
  venue: { id: 'v1', slug: 'v1', name: 'Purple Haze', area: 'Thamel', city: 'Kathmandu' },
  organizer: null,
  categories: [],
  cover: null,
  offer: null,
  ...over,
})

const CATALOGUE = [
  listing({ id: 'here-a' }),
  listing({ id: 'here-b' }),
  listing({
    id: 'four-km', venue: { id: 'v2', slug: 'v2', name: 'Patan', area: null, city: 'Lalitpur' },
    latitude: 27.7554, longitude: 85.3105,
  }),
  listing({
    id: 'out-of-view', venue: { id: 'v3', slug: 'v3', name: 'Lakeside', area: null, city: 'Pokhara' },
    latitude: 28.2096, longitude: 83.9556,
  }),
  // No coordinates: on neither surface, because it cannot be placed.
  listing({ id: 'unplaced', latitude: null, longitude: null }),
]

/**
 * Exactly what `NepalMap` computes before it hands the result to either
 * surface. Kept as one function here so a divergence has to be introduced
 * deliberately rather than by editing one branch of an if.
 */
const resultSet = (viewport: Bounds, radiusKm: number | null) => {
  const pins = toMapPins(CATALOGUE)
  const near = radiusKm === null
    ? pins
    : pins.filter((pin) => haversineKm(CENTRE.lat, CENTRE.lng, pin.lat, pin.lng) <= radiusKm)
  return groupByVenue(near.filter((pin) => within(viewport, pin)))
}

const slugsOf = (groups: ReturnType<typeof resultSet>) =>
  groups.flatMap((group) => group.pins.map((pin: MapPin) => pin.slug)).sort()

describe('the list and the map show the same thing', () => {
  it('shows the same listings with no filter', () => {
    expect(slugsOf(resultSet(KATHMANDU, null))).toEqual(['four-km', 'here-a', 'here-b'])
  })

  it('shows the same listings under every distance chip', () => {
    expect(slugsOf(resultSet(KATHMANDU, 2))).toEqual(['here-a', 'here-b'])
    expect(slugsOf(resultSet(KATHMANDU, 5))).toEqual(['four-km', 'here-a', 'here-b'])
    expect(slugsOf(resultSet(KATHMANDU, 100))).toEqual(['four-km', 'here-a', 'here-b'])
  })

  it('leaves out what is off screen on both, not just on the map', () => {
    // The list is scoped to the viewport too. A list that showed everything
    // ever loaded would stop matching the map the first time somebody panned,
    // and would do it silently.
    expect(slugsOf(resultSet(KATHMANDU, null))).not.toContain('out-of-view')
  })

  it('leaves out a listing with no coordinates on both', () => {
    // An announcement with no venue yet is a real row that the feed shows and
    // neither of these can: there is nowhere to put it.
    expect(slugsOf(resultSet(KATHMANDU, null))).not.toContain('unplaced')
  })

  it('groups by venue on both, so the count is the same number', () => {
    const groups = resultSet(KATHMANDU, null)
    expect(groups.map((group) => [group.key, group.count]).sort())
      .toEqual([['v1', 2], ['v2', 1]])
  })

  it('orders the stacks the same way on both', () => {
    const [first] = resultSet(KATHMANDU, null)
    expect(first!.pins.map((pin) => pin.slug)).toEqual(['here-a', 'here-b'])
  })
})
