import { describe, expect, it } from 'vitest'
import type { Listing } from '../../app/lib/catalog'
import { mergePins, toMapPin, toMapPins, toPopupListing } from '../../app/map/markers'
import { aCategoryRef, aPlacedListing, aVenue } from '../factories'

/**
 * #36's unit criterion: "listing to map-marker transformation preserves
 * category and coordinates".
 *
 * The reason that is worth asserting rather than reading is WaahTickets' own
 * history — the map carried a separate `pinCategory` alongside `category`, the
 * two drifted, and the pin stopped agreeing with the chip beside it. Here the
 * pin is passed through from the API untouched, and these are the tests that
 * say so out loud.
 */
const listing = (over: Partial<Listing> = {}): Listing => aPlacedListing({
  id: 'listing-1',
  slug: 'jazz-at-the-house',
  title: 'Jazz at the House',
  summary: 'A quartet, twice through.',
  listing_type: 'ticketed_internal',
  starts_at: '2026-10-02T13:15:00.000Z',
  venue: aVenue({ id: 'v1', slug: 'jazz-house', name: 'Jazz Upstairs', area: 'Lazimpat' }),
  pin: { icon: 'Music', color: '#e91e63', category: 'concerts' },
  categories: [
    aCategoryRef(),
    aCategoryRef({ slug: 'nightlife', name: 'Nightlife', color: '#06b6d4', icon: 'Moon', is_primary: false }),
  ],
  ...over,
})

describe('a listing becomes a pin', () => {
  it('keeps the coordinates exactly as the API gave them', () => {
    const pin = toMapPin(listing())
    expect(pin).not.toBeNull()
    expect(pin?.lat).toBe(27.7154)
    expect(pin?.lng).toBe(85.3105)
  })

  it('passes the API-derived pin through rather than recomputing it', () => {
    // Nothing here may re-derive appearance from the categories: one value,
    // read twice, is what stops the pin and the chip disagreeing.
    const source = listing()
    expect(toMapPin(source)?.pin).toBe(source.pin)
  })

  it('names the primary category in the popup, not the first one listed', () => {
    const secondaryFirst = listing({
      categories: [
        { slug: 'nightlife', name: 'Nightlife', name_ne: null, color: '#06b6d4', icon: 'Moon', is_primary: false },
        { slug: 'concerts', name: 'Concerts', name_ne: null, color: '#e91e63', icon: 'Music', is_primary: true },
      ],
    })
    expect(toPopupListing(secondaryFirst).category).toBe('Concerts')
  })

  it('carries the author’s popup configuration through untouched', () => {
    const config = { fields: [{ field: 'venue', label: 'Spot', visible: true }] }
    expect(toMapPin(listing({ map_popup_config: config }))?.popupConfig).toBe(config)
  })
})

describe('a listing that cannot be drawn', () => {
  /**
   * An announcement with no venue yet is a legitimate catalogue row that the
   * feed shows and the map cannot. Dropping it here, once, is what keeps every
   * point downstream from having to guard against a null coordinate.
   */
  it('is dropped rather than drawn at zero,zero', () => {
    expect(toMapPin(listing({ latitude: null, longitude: null }))).toBeNull()
    expect(toMapPin(listing({ latitude: 27.7, longitude: null }))).toBeNull()
  })

  it('does not take the rest of the page down with it', () => {
    const pins = toMapPins([listing(), listing({ id: 'x', latitude: null, longitude: null })])
    expect(pins).toHaveLength(1)
    expect(pins[0]?.id).toBe('listing-1')
  })
})

describe('the popup reads what it was handed', () => {
  it('formats the time in the listing’s own zone, not the reader’s', () => {
    // 13:15 UTC is 19:00 in Kathmandu (+05:45). An event in Nepal starts when
    // it starts there, whoever is looking.
    expect(toPopupListing(listing()).when).toContain('7:00 pm')
  })

  it('writes the venue with its area when the area adds something', () => {
    expect(toPopupListing(listing()).venue).toBe('Jazz Upstairs, Lazimpat')
  })

  it('says Free for a free listing and nothing at all for an unpriced one', () => {
    expect(toPopupListing(listing({ listing_type: 'free' })).offer?.label).toBe('Free')
    expect(toPopupListing(listing({ listing_type: 'announcement' })).offer).toBeNull()
  })

  it('never computes an offer — it formats the snapshot it was given', () => {
    const priced = listing({
      offer: {
        purchasable: true, price_from: 50_000, currency: 'NPR',
        url: 'https://example.test/tickets', provider: 'external',
        sold_out: false, checked_at: null,
      },
    })
    const popup = toPopupListing(priced)
    expect(popup.offer?.label).toContain('500')
    expect(popup.offer?.url).toBe('https://example.test/tickets')
  })
})

describe('merging pins across pans', () => {
  const pinFor = (id: string) => toMapPin(listing({ id }))!

  it('keeps what is already on the map and adds what is new', () => {
    const merged = mergePins([pinFor('a')], [pinFor('b')])
    expect(merged.map((pin) => pin.id).sort()).toEqual(['a', 'b'])
  })

  it('does not duplicate a listing that comes back in a second viewport', () => {
    // Overlapping fetches are the normal case, not the edge one: the padded
    // box means consecutive pans share rows by design.
    const merged = mergePins([pinFor('a'), pinFor('b')], [pinFor('b'), pinFor('c')])
    expect(merged).toHaveLength(3)
  })

  it('lets a fresher copy of a listing win', () => {
    const stale = pinFor('a')
    const fresh = { ...pinFor('a'), lat: 28.2096 }
    expect(mergePins([stale], [fresh])[0]?.lat).toBe(28.2096)
  })
})
