import { describe, expect, it } from 'vitest'
import {
  dateScore, distanceScore, popularityScore, rankListings, scoreListing, textScore,
} from '../../api/catalog/ranking'
import { parseTerms } from '../../api/catalog/terms'
import type { ListingSummary } from '../../api/catalog/types'

/**
 * #42's ranking criteria, stated as orderings over known inputs. This is the
 * whole reason ranking is a pure function in the Worker rather than an ORDER BY
 * expression spliced into a query string.
 */
const NOW = new Date('2026-09-10T06:00:00Z')
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString()

const listing = (over: Partial<ListingSummary> & { id: string }): ListingSummary => ({
  slug: over.id,
  title: over.id,
  title_ne: null,
  summary: null,
  summary_ne: null,
  listing_type: 'ticketed_internal',
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
})

const order = (listings: ListingSummary[], query: string, extra = {}) =>
  rankListings(listings, { terms: parseTerms(query), now: NOW, ...extra })
    .map((entry) => entry.id)

describe('date proximity', () => {
  it('is the acceptance criterion: tomorrow beats six months out', () => {
    expect(dateScore(listing({ id: 'a', starts_at: inDays(1) }), NOW))
      .toBeGreaterThan(dateScore(listing({ id: 'b', starts_at: inDays(180) }), NOW))
  })

  it('treats something already running as being as close as it gets', () => {
    expect(dateScore(listing({ id: 'a', starts_at: inDays(-2) }), NOW)).toBe(1)
  })

  it('ranks a matching listing tomorrow above the same match in six months', () => {
    expect(order([
      listing({ id: 'far', title: 'Jazz Night', starts_at: inDays(180) }),
      listing({ id: 'soon', title: 'Jazz Night', starts_at: inDays(1) }),
    ], 'jazz')).toEqual(['soon', 'far'])
  })
})

describe('where a word matched', () => {
  it('scores a title match above a category match', () => {
    const [terms] = [parseTerms('concerts')]
    const titled = listing({ id: 'a', title: 'Concerts by the lake' })
    const categorised = listing({
      id: 'b',
      categories: [{ slug: 'concerts', name: 'Concerts', name_ne: null, color: null, icon: null, is_primary: true }],
    })
    expect(textScore(titled, terms)).toBeGreaterThan(textScore(categorised, terms))
  })

  it('scores a whole word above the same letters inside a longer one', () => {
    const [terms] = [parseTerms('art')]
    expect(textScore(listing({ id: 'a', title: 'Art Week' }), terms))
      .toBeGreaterThan(textScore(listing({ id: 'b', title: 'Departure' }), terms))
  })

  it('puts the band above the city when the band is what was typed', () => {
    expect(order([
      listing({
        id: 'city-match',
        title: 'Lakeside Festival',
        venue: { id: 'v', slug: 'v', name: 'Kutumba Hall', area: null, city: 'Kathmandu' },
      }),
      listing({ id: 'title-match', title: 'Kutumba Live' }),
    ], 'kutumba')).toEqual(['title-match', 'city-match'])
  })

  it('reads the Nepali title as well as the English one (#46)', () => {
    const [terms] = [parseTerms(String.fromCodePoint(0x92a, 0x94b, 0x916, 0x930, 0x93e))]
    expect(textScore(listing({ id: 'a', title_ne: 'पोखरा महोत्सव' }), terms)).toBeGreaterThan(0)
  })
})

describe('distance', () => {
  const thamel = { lat: 27.7154, lng: 85.3105 }

  it('falls off with kilometres', () => {
    const near = listing({ id: 'near', latitude: 27.716, longitude: 85.311 })
    const far = listing({ id: 'far', latitude: 28.2096, longitude: 83.9556 })
    expect(distanceScore(near, thamel)!).toBeGreaterThan(distanceScore(far, thamel)!)
  })

  it('is absent, not zero, for a listing with no coordinates', () => {
    expect(distanceScore(listing({ id: 'a' }), thamel)).toBeNull()
  })

  it('does not bury a listing with no coordinates in a located search', () => {
    // The pin-less listing keeps its other signals rather than scoring zero on
    // a quarter of the blend.
    const ranked = order([
      listing({ id: 'nowhere', title: 'Jazz Night', starts_at: inDays(1) }),
      listing({ id: 'far', title: 'Jazz Night', starts_at: inDays(120), latitude: 28.2, longitude: 83.9 }),
    ], 'jazz', { centre: thamel })
    expect(ranked[0]).toBe('nowhere')
  })
})

describe('popularity', () => {
  it('saturates rather than compounding', () => {
    expect(popularityScore(0)).toBe(0)
    expect(popularityScore(50)).toBeCloseTo(0.5)
    expect(popularityScore(5000)).toBeLessThan(1)
    expect(popularityScore(5000) - popularityScore(500)).toBeLessThan(0.1)
  })

  it('breaks a tie between two identical listings', () => {
    const ranked = rankListings([
      listing({ id: 'quiet', title: 'Jazz', starts_at: inDays(3) }),
      listing({ id: 'busy', title: 'Jazz', starts_at: inDays(3) }),
    ], {
      terms: parseTerms('jazz'), now: NOW,
      popularity: new Map([['busy', 400]]),
    })
    expect(ranked.map((entry) => entry.id)).toEqual(['busy', 'quiet'])
  })
})

describe('one listing on its own', () => {
  it('scores between nothing and everything', () => {
    const score = scoreListing(listing({ id: 'a', title: 'Jazz Night', starts_at: inDays(1) }), {
      terms: parseTerms('jazz'), now: NOW,
    })
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('scores a listing that matches nothing below one that matches', () => {
    const context = { terms: parseTerms('jazz'), now: NOW }
    expect(scoreListing(listing({ id: 'a', title: 'Jazz Night' }), context))
      .toBeGreaterThan(scoreListing(listing({ id: 'b', title: 'Sunday Market' }), context))
  })
})

describe('the order is total', () => {
  it('breaks a dead tie by start then by id, so paging never repeats a row', () => {
    const identical = [
      listing({ id: 'b', title: 'Same', starts_at: inDays(4) }),
      listing({ id: 'a', title: 'Same', starts_at: inDays(4) }),
    ]
    expect(order(identical, 'same')).toEqual(['a', 'b'])
    expect(order([...identical].reverse(), 'same')).toEqual(['a', 'b'])
  })

  it('ranks a query-less search on date and popularity alone', () => {
    expect(order([
      listing({ id: 'later', starts_at: inDays(30) }),
      listing({ id: 'sooner', starts_at: inDays(2) }),
    ], '')).toEqual(['sooner', 'later'])
  })
})
