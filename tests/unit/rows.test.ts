import { describe, expect, it } from 'vitest'
import type { Bootstrap, Category, Listing } from '../../app/lib/catalog'
import { buildRows, entryCategories, nepalDay, weekendDays } from '../../app/lib/rows'

/**
 * #41 — the row rules. These are the whole reason the homepage does not need a
 * hand-maintained list of event IDs, so they are pinned down here rather than
 * eyeballed on staging.
 */

const listing = (over: Partial<Listing> & { id: string; starts_at: string }): Listing => ({
  slug: over.id,
  title: over.id,
  summary: null,
  listing_type: 'ticketed_internal',
  source: 'organizer',
  ends_at: null,
  is_all_day: false,
  timezone: 'Asia/Kathmandu',
  cover_image_url: null,
  external_url: null,
  is_featured: false,
  latitude: null,
  longitude: null,
  pin: { icon: 'MapPin', color: '#64748b', category: null },
  cover: null,
  venue: null,
  organizer: null,
  categories: [],
  offer: null,
  ...over,
})

const venue = (city: string) => ({ id: city, slug: city, name: `${city} Hall`, area: null, city })

const category = (slug: string, count = 1): Category => ({
  slug, name: slug, name_ne: null, color: null, icon: null, upcoming_listing_count: count,
})

// A Monday. The weekend that follows is Friday the 11th and Saturday the 12th.
const MONDAY = new Date('2026-09-07T06:00:00Z')

const bootstrap = (over: Partial<Bootstrap> = {}): Bootstrap => ({
  categories: [], upcoming: [], featured: [], ...over,
})

describe('the weekend is Nepal’s, not the calendar’s', () => {
  it('is Friday and Saturday, seen from a Monday', () => {
    expect(weekendDays(MONDAY)).toEqual(['2026-09-11', '2026-09-12'])
  })

  it('still includes today when today is the Friday', () => {
    expect(weekendDays(new Date('2026-09-11T06:00:00Z')))
      .toEqual(['2026-09-11', '2026-09-12'])
  })

  it('drops the Friday once it has gone', () => {
    // On the Saturday, "this weekend" is today — not yesterday as well.
    expect(weekendDays(new Date('2026-09-12T06:00:00Z'))).toEqual(['2026-09-12'])
  })

  it('looks forward to the next one from a Sunday', () => {
    expect(weekendDays(new Date('2026-09-13T06:00:00Z')))
      .toEqual(['2026-09-18', '2026-09-19'])
  })
})

describe('a day is the day it is in Nepal', () => {
  it('counts an event just after Nepali midnight as the next day', () => {
    // 18:30Z is 00:15 the following morning in Kathmandu (UTC+05:45). Treating
    // this as Saturday — as any UTC comparison would — puts a Sunday event in
    // the weekend row.
    expect(nepalDay('2026-09-12T18:30:00Z')).toBe('2026-09-13')
    expect(nepalDay('2026-09-12T17:00:00Z')).toBe('2026-09-12')
  })

  it('excludes that event from the weekend row', () => {
    const rows = buildRows(bootstrap({
      upcoming: [
        listing({ id: 'saturday-night', starts_at: '2026-09-12T17:00:00Z' }),
        listing({ id: 'sunday-morning', starts_at: '2026-09-12T18:30:00Z' }),
      ],
    }), MONDAY)

    const weekend = rows.find((row) => row.id === 'weekend')!
    expect(weekend.listings.map((entry) => entry.id)).toEqual(['saturday-night'])
  })
})

describe('every row is a rule over the catalogue', () => {
  const full = bootstrap({
    categories: [category('concerts', 3), category('film', 1), category('quiet', 0)],
    featured: [listing({ id: 'featured-1', starts_at: '2026-09-20T12:00:00Z' })],
    upcoming: [
      listing({ id: 'ktm-weekend', starts_at: '2026-09-11T13:00:00Z',
                venue: venue('Kathmandu'), categories: [{ slug: 'concerts', name: 'concerts', color: null, icon: null, is_primary: true }] }),
      listing({ id: 'ktm-later', starts_at: '2026-09-20T13:00:00Z',
                venue: venue('Kathmandu'), categories: [{ slug: 'concerts', name: 'concerts', color: null, icon: null, is_primary: true }] }),
      listing({ id: 'ktm-free', starts_at: '2026-09-21T13:00:00Z',
                listing_type: 'free', venue: venue('Kathmandu'),
                categories: [{ slug: 'concerts', name: 'concerts', color: null, icon: null, is_primary: true }] }),
      listing({ id: 'pokhara', starts_at: '2026-09-22T13:00:00Z',
                venue: venue('Pokhara'), categories: [{ slug: 'film', name: 'film', color: null, icon: null, is_primary: true }] }),
    ],
  })

  const rows = buildRows(full, MONDAY)
  const row = (id: string) => rows.find((entry) => entry.id === id)!

  it('features what the catalogue marked as featured', () => {
    expect(row('featured').listings.map((entry) => entry.id)).toEqual(['featured-1'])
  })

  it('selects the weekend by day, not by position in the list', () => {
    expect(row('weekend').listings.map((entry) => entry.id)).toEqual(['ktm-weekend'])
  })

  it('picks the city with the most on, and takes all of it', () => {
    expect(row('city').title).toBe('In Kathmandu')
    expect(row('city').listings.map((entry) => entry.id))
      .toEqual(['ktm-weekend', 'ktm-later', 'ktm-free'])
  })

  it('finds free entry by listing type', () => {
    expect(row('free').listings.map((entry) => entry.id)).toEqual(['ktm-free'])
  })

  it('picks the busiest category and takes every listing in it', () => {
    expect(row('category-concerts').listings.map((entry) => entry.id))
      .toEqual(['ktm-weekend', 'ktm-later', 'ktm-free'])
  })

  it('names no listing anywhere — that was the WaahTickets failure', () => {
    // Every row must be derivable from the catalogue alone.
    expect(rows.every((entry) => entry.rule.length > 0)).toBe(true)
  })
})

describe('a row that matches nothing still says so', () => {
  it('keeps its row and carries an empty message', () => {
    const rows = buildRows(bootstrap({
      upcoming: [listing({ id: 'far-off', starts_at: '2026-10-20T12:00:00Z' })],
    }), MONDAY)

    const weekend = rows.find((entry) => entry.id === 'weekend')!
    expect(weekend.listings).toEqual([])
    expect(weekend.empty).toMatch(/Friday or Saturday/)
  })

  it('omits a row whose rule has no subject at all', () => {
    // No listing has a venue, so there is no "most common city" to name.
    const rows = buildRows(bootstrap({
      upcoming: [listing({ id: 'nowhere', starts_at: '2026-09-20T12:00:00Z' })],
    }), MONDAY)

    expect(rows.find((entry) => entry.id === 'city')).toBeUndefined()
  })

  it('survives an entirely empty catalogue', () => {
    const rows = buildRows(bootstrap(), MONDAY)
    expect(rows.every((entry) => entry.listings.length === 0)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('category entry points lead somewhere', () => {
  it('drops empty categories and orders by how much is on', () => {
    const entries = entryCategories([category('film', 1), category('quiet', 0), category('concerts', 9)])
    expect(entries.map((entry) => entry.slug)).toEqual(['concerts', 'film'])
  })
})
