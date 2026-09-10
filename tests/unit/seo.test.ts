import { describe, expect, it } from 'vitest'
import {
  artistMetadata, homeMetadata, indexMetadata, listingMetadata, organizerMetadata,
  searchMetadata, titleOf, truncate, venueMetadata,
} from '../../api/render/metadata'
import { compact, eventOf, placeOf, serialiseJsonLd, websiteOf } from '../../api/render/structured'
import type { ArtistSummary, ListingDetail, OrganizerSummary, VenueSummary } from '../../api/catalog/types'

/**
 * #45's unit plan: metadata generated from content, handling a missing field
 * and a very long title, and structured data for every listing type.
 */
const ORIGIN = 'https://nepscene.test'

const listing = (over: Partial<ListingDetail> = {}): ListingDetail => ({
  id: 'lst_1',
  slug: 'rock-night',
  title: 'Rock Night',
  title_ne: null,
  summary: 'Three bands, one stage.',
  summary_ne: null,
  listing_type: 'ticketed_internal',
  source: 'organizer',
  starts_at: '2026-09-11T13:15:00.000Z',
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
  venue: {
    id: 'v1', slug: 'purple-haze', name: 'Purple Haze', area: 'Thamel', city: 'Kathmandu',
    address: 'Bhagwan Bahal', district: 'Kathmandu', province: 'Bagmati',
    latitude: 27.7154, longitude: 85.3105,
  },
  organizer: { id: 'o1', slug: 'himalayan-sound', name: 'Himalayan Sound', is_verified: true },
  categories: [],
  cover: null,
  offer: {
    purchasable: true, price_from: 80000, currency: 'NPR',
    url: 'https://waahtickets.example/e/rock-night', provider: 'waahtickets',
    sold_out: false, checked_at: '2026-09-09T00:00:00.000Z',
  },
  description: 'A monthly showcase.',
  description_ne: null,
  published_at: '2026-09-01T00:00:00.000Z',
  venue_room: null,
  media: [],
  artists: [],
  tags: [],
  ...over,
})

describe('truncation', () => {
  it('leaves a short string alone', () => {
    expect(truncate('Rock Night', 60)).toBe('Rock Night')
  })

  it('cuts a long one at a word, not mid-syllable', () => {
    const long = 'An extremely long listing title that keeps going well past any sensible limit'
    const cut = truncate(long, 40)
    expect(cut.length).toBeLessThanOrEqual(40)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).not.toMatch(/\s…$/)
  })

  it('cuts mid-word only when the first word is longer than the limit', () => {
    expect(truncate('Supercalifragilisticexpialidocious', 12)).toBe('Supercalifr…')
  })

  it('collapses whitespace, so a description with newlines is one line', () => {
    expect(truncate('one\n\n  two', 40)).toBe('one two')
  })
})

describe('titles', () => {
  it('always keeps the site name, however long the subject', () => {
    const title = titleOf('An extremely long listing title that will certainly not fit anywhere')
    expect(title.endsWith(' — NepScene')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(60)
  })

  it('names the listing, the venue and the city', () => {
    expect(listingMetadata(listing(), ORIGIN).title)
      .toBe('Rock Night at Purple Haze in Kathmandu — NepScene')
  })

  it('drops the venue clause for a listing that has no venue', () => {
    expect(listingMetadata(listing({ venue: null }), ORIGIN).title).toBe('Rock Night — NepScene')
  })
})

describe('descriptions', () => {
  it('uses the listing’s own words when it has them', () => {
    expect(listingMetadata(listing(), ORIGIN).description).toBe('Three bands, one stage.')
  })

  it('writes a sentence from the facts when it does not', () => {
    const description = listingMetadata(
      listing({ summary: null, description: null }), ORIGIN,
    ).description
    // Still unique to this listing: the name, the place and the date are.
    expect(description).toContain('Rock Night')
    expect(description).toContain('Purple Haze')
    expect(description).toContain('September 2026')
  })

  it('reads the date in the listing’s zone, not the server’s', () => {
    // 18:30Z on the 11th is already the 12th in Kathmandu.
    const description = listingMetadata(
      listing({ summary: null, description: null, starts_at: '2026-09-11T18:30:00.000Z' }),
      ORIGIN,
    ).description
    expect(description).toContain('12 September 2026')
  })

  it('is capped, so a long description is not sent whole', () => {
    const description = listingMetadata(
      listing({ summary: 'x'.repeat(400) }), ORIGIN,
    ).description
    expect(description.length).toBeLessThanOrEqual(160)
  })
})

describe('the Nepali document', () => {
  it('uses the Nepali title and summary where the listing has them', () => {
    const metadata = listingMetadata(
      listing({ title_ne: 'रक नाइट', summary_ne: 'तीन ब्यान्ड' }), ORIGIN, 'ne',
    )
    expect(metadata.title).toContain('रक नाइट')
    expect(metadata.description).toBe('तीन ब्यान्ड')
  })

  it('falls back to English rather than to nothing', () => {
    expect(listingMetadata(listing(), ORIGIN, 'ne').title).toContain('Rock Night')
  })

  it('declares both variants and a default', () => {
    const alternates = listingMetadata(listing(), ORIGIN).alternates
    expect(alternates.map((entry) => entry.hreflang)).toEqual(['en', 'ne', 'x-default'])
    expect(alternates[1]?.href).toBe(`${ORIGIN}/listings/rock-night?lang=ne`)
  })
})

describe('canonical URLs', () => {
  it('are absolute, because a crawler resolves nothing', () => {
    for (const metadata of [
      listingMetadata(listing(), ORIGIN),
      homeMetadata(ORIGIN),
      indexMetadata('venues', ORIGIN),
    ]) {
      expect(metadata.canonical.startsWith('https://')).toBe(true)
      expect(metadata.image.startsWith('https://')).toBe(true)
    }
  })

  it('point a search page at the unfiltered one, and keep it out of the index', () => {
    const metadata = searchMetadata('rock', ORIGIN)
    expect(metadata.canonical).toBe(`${ORIGIN}/search`)
    expect(metadata.noindex).toBe(true)
  })
})

const venue: VenueSummary & { description: string | null } = {
  id: 'v1', slug: 'purple-haze', name: 'Purple Haze', area: 'Thamel', city: 'Kathmandu',
  district: 'Kathmandu', province: 'Bagmati', address: 'Bhagwan Bahal',
  latitude: 27.7154, longitude: 85.3105, cover_image_url: null, is_verified: true,
  upcoming_listing_count: 3, past_listing_count: 1, description: null,
}

describe('the other page types', () => {
  it('asks the question people search for on a venue page', () => {
    expect(venueMetadata(venue, ORIGIN).title)
      .toBe("What's on at Purple Haze, Thamel, Kathmandu — NepScene")
  })

  it('counts what is on when the venue has no description', () => {
    expect(venueMetadata(venue, ORIGIN).description).toContain('3 events coming up')
  })

  it('says one event rather than 1 events', () => {
    expect(venueMetadata({ ...venue, upcoming_listing_count: 1 }, ORIGIN).description)
      .toContain('1 event coming up')
  })

  it('names an organizer and an artist in their own titles', () => {
    const organizer: OrganizerSummary = {
      id: 'o1', slug: 'himalayan-sound', name: 'Himalayan Sound', description: null,
      logo_url: null, website_url: null, is_verified: true,
      upcoming_listing_count: 2, past_listing_count: 0,
    }
    const artist: ArtistSummary = {
      id: 'a1', slug: 'kutumba', name: 'Kutumba', bio: null, image_url: null,
      links: {}, upcoming_listing_count: 2, listing_count: 4,
    }
    expect(organizerMetadata(organizer, ORIGIN).title).toContain('Himalayan Sound')
    expect(artistMetadata(artist, ORIGIN).title).toContain('Kutumba')
  })
})

describe('structured data', () => {
  it('drops empty branches rather than emitting nulls a validator objects to', () => {
    expect(compact({ a: 1, b: null, c: undefined, d: {}, e: [], f: { g: null } }))
      .toEqual({ a: 1 })
  })

  it('keeps a nested object that still has something in it', () => {
    expect(compact({ a: { b: 1, c: null } })).toEqual({ a: { b: 1 } })
  })

  it('emits the fields a rich result requires', () => {
    const event = eventOf(listing(), ORIGIN)
    for (const field of ['@context', '@type', 'name', 'startDate', 'location', 'eventStatus']) {
      expect(event[field], field).toBeDefined()
    }
  })

  it('turns paisa into rupees, and nothing else', () => {
    const offers = eventOf(listing(), ORIGIN).offers as Record<string, unknown>
    expect(offers.price).toBe(800)
  })

  it('marks a sold-out listing sold out rather than omitting it', () => {
    const soldOut = eventOf(listing({
      offer: { ...listing().offer!, sold_out: true },
    }), ORIGIN)
    expect((soldOut.offers as Record<string, unknown>).availability)
      .toBe('https://schema.org/SoldOut')
  })

  it('says nothing about price when the offer could not be resolved', () => {
    expect(eventOf(listing({ offer: null }), ORIGIN).offers).toBeUndefined()
  })

  it('prices a free listing at zero, which is not the same as silence', () => {
    const free = eventOf(listing({ listing_type: 'free', offer: null }), ORIGIN)
    expect((free.offers as Record<string, unknown>).price).toBe(0)
  })

  it('omits an end date rather than inventing one', () => {
    expect(eventOf(listing(), ORIGIN).endDate).toBeUndefined()
    expect(eventOf(listing({ ends_at: '2026-09-11T18:00:00Z' }), ORIGIN).endDate)
      .toBe('2026-09-11T18:00:00Z')
  })

  it('always states the country, which is the one part of an address we know', () => {
    const place = placeOf({ name: 'Somewhere', city: null }, ORIGIN)
    expect((place.address as Record<string, unknown>).addressCountry).toBe('NP')
  })

  it('omits coordinates rather than sending nulls', () => {
    expect(placeOf({ name: 'Somewhere', latitude: null, longitude: null }, ORIGIN).geo)
      .toBeUndefined()
  })

  it('links a performer only where they have a page', () => {
    const event = eventOf(listing({
      artists: [
        { slug: 'kutumba', name: 'Kutumba', image_url: null, listing_count: 4, has_page: true },
        { slug: 'newcomer', name: 'Newcomer', image_url: null, listing_count: 1, has_page: false },
      ],
    }), ORIGIN)
    const performers = event.performer as Record<string, unknown>[]
    expect(performers[0]!.url).toBe(`${ORIGIN}/artists/kutumba`)
    expect(performers[1]!.url).toBeUndefined()
  })

  it('offers a search action from the homepage', () => {
    const action = websiteOf(ORIGIN).potentialAction as Record<string, unknown>
    expect((action.target as Record<string, unknown>).urlTemplate)
      .toBe(`${ORIGIN}/search?q={search_term_string}`)
  })

  it('escapes a closing tag hidden in the content', () => {
    // A description containing `</script>` would otherwise close the tag the
    // JSON-LD is sitting in — the one injection this can suffer.
    const serialised = serialiseJsonLd([eventOf(
      listing({ summary: 'Bring </script><script>alert(1)</script> a friend' }), ORIGIN,
    )])
    expect(serialised).not.toContain('</script>')
    expect(serialised).toContain('\\u003c/script')
  })
})
