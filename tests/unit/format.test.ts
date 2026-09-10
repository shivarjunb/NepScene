import { describe, expect, it } from 'vitest'
import type { Listing, Offer } from '../../app/lib/catalog'
import { offerLine, startDay, startTime, venueLine } from '../../app/lib/format'

/** #41 — the card has to render every listing type, including those with no price. */

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: 'x', slug: 'x', title: 'x', summary: null,
  listing_type: 'ticketed_internal', source: 'organizer',
  starts_at: '2026-09-11T13:15:00Z', ends_at: null, is_all_day: false,
  timezone: 'Asia/Kathmandu', cover_image_url: null, external_url: null,
  is_featured: false, map_popup_config: null, latitude: null, longitude: null,
  pin: { icon: 'MapPin', color: '#64748b', category: null }, cover: null, venue: null, organizer: null, categories: [], offer: null, ...over,
})

const offer = (over: Partial<Offer> = {}): Offer => ({
  purchasable: true, price_from: 80000, currency: 'NPR', url: null,
  provider: 'waahtickets', sold_out: false, checked_at: null, ...over,
})

describe('an offer is rendered, never computed', () => {
  it('turns a paisa snapshot into rupees and nothing else', () => {
    expect(offerLine(listing({ offer: offer() }))).toBe('From NPR 800')
  })

  it('groups thousands', () => {
    expect(offerLine(listing({ offer: offer({ price_from: 150000 }) }))).toBe('From NPR 1,500')
  })

  it('says free rather than "From NPR 0"', () => {
    // A zero snapshot is how the seed spells a free ticketed listing.
    expect(offerLine(listing({ offer: offer({ price_from: 0 }) }))).toBe('Free')
  })

  it('says free for a free listing carrying no offer at all', () => {
    expect(offerLine(listing({ listing_type: 'free' }))).toBe('Free')
  })

  it('says nothing when there is no price to show', () => {
    expect(offerLine(listing({ offer: offer({ price_from: null }) }))).toBeNull()
    expect(offerLine(listing({ listing_type: 'announcement' }))).toBeNull()
  })

  it('sold out beats a price', () => {
    expect(offerLine(listing({ offer: offer({ sold_out: true }) }))).toBe('Sold out')
  })

  it('honours the currency it was given', () => {
    expect(offerLine(listing({ offer: offer({ currency: 'USD', price_from: 2500 }) })))
      .toBe('From USD 25')
  })
})

describe('times are the listing’s, not the reader’s', () => {
  it('formats in the listing’s own timezone', () => {
    // 13:15Z is 19:00 in Kathmandu; a reader in London must still see 7 pm.
    expect(startTime(listing())).toBe('7:00 pm')
  })

  it('crosses midnight into the right day', () => {
    const late = listing({ starts_at: '2026-09-11T19:00:00Z' })
    // "Sept", not "Sep": en-GB abbreviates September with four letters.
    expect(startDay(late)).toEqual({ day: '12', month: 'Sept', weekday: 'Sat' })
  })

  it('says so when a listing runs all day', () => {
    expect(startTime(listing({ is_all_day: true }))).toBe('All day')
  })
})

describe('the venue line', () => {
  it('adds the area when it says something the name does not', () => {
    expect(venueLine(listing({
      venue: { id: 'v', slug: 'v', name: 'Purple Haze', area: 'Thamel', city: 'Kathmandu' },
    }))).toBe('Purple Haze, Thamel')
  })

  it('falls back to the city when there is no area', () => {
    expect(venueLine(listing({
      venue: { id: 'v', slug: 'v', name: 'Lakeside', area: null, city: 'Pokhara' },
    }))).toBe('Lakeside, Pokhara')
  })

  it('does not repeat the venue name back at itself', () => {
    expect(venueLine(listing({
      venue: { id: 'v', slug: 'v', name: 'Pokhara', area: null, city: 'Pokhara' },
    }))).toBe('Pokhara')
  })

  it('is absent when the listing has no venue', () => {
    expect(venueLine(listing())).toBeNull()
  })
})
