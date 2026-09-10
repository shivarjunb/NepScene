import { describe, expect, it } from 'vitest'
import {
  emptyListing, needsTicketUrl, stepsFor, validateListing, validateStep,
  type ListingInput, type ListingType,
} from '../../api/author/validate'

/** A listing that passes everything, so each test can break exactly one thing. */
const complete = (overrides: Partial<ListingInput> = {}): ListingInput => ({
  ...emptyListing(),
  title: 'Kutumba at Patan Durbar',
  summary: 'An evening of folk instrumental',
  listing_type: 'free',
  venue_id: 'ven_thamel',
  starts_at: '2026-11-02T12:00:00Z',
  category_slugs: ['concert'],
  primary_category_slug: 'concert',
  ...overrides,
})

const fields = (input: Partial<ListingInput>) => validateListing(input).map((e) => e.field)

describe('conditional steps', () => {
  it('asks an announcement for no place at all', () => {
    expect(stepsFor('announcement')).toEqual(['details', 'when', 'media', 'review'])
  })

  it('asks everything else where it is and how its pin looks', () => {
    for (const type of ['ticketed_internal', 'ticketed_external', 'free'] as ListingType[]) {
      expect(stepsFor(type)).toEqual(['details', 'when', 'where', 'media', 'appearance', 'review'])
    }
  })

  it('reveals the ticket link for external listings only', () => {
    expect(needsTicketUrl('ticketed_external')).toBe(true)
    for (const type of ['ticketed_internal', 'free', 'announcement'] as ListingType[]) {
      expect(needsTicketUrl(type)).toBe(false)
    }
  })
})

describe('the details step', () => {
  it('names the field and says what to do', () => {
    const [error] = validateStep('details', { ...complete(), title: '   ' })
    expect(error?.field).toBe('title')
    expect(error?.message).toMatch(/title/i)
  })

  it('requires a ticket link on an external listing and nowhere else', () => {
    expect(fields(complete({ listing_type: 'ticketed_external' }))).toContain('offer_url')
    expect(fields(complete({ listing_type: 'ticketed_external', offer_url: 'https://tickets.example/e/1' })))
      .toEqual([])
    expect(fields(complete({ listing_type: 'free' }))).not.toContain('offer_url')
    expect(fields(complete({ listing_type: 'ticketed_internal' }))).not.toContain('offer_url')
  })

  it('refuses a link that is not http', () => {
    const bad = ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.np', 'example.np']
    for (const offer_url of bad) {
      expect(fields(complete({ listing_type: 'ticketed_external', offer_url })))
        .toContain('offer_url')
    }
  })

  it('requires a category, because the pin is derived from it', () => {
    expect(fields(complete({ category_slugs: [], primary_category_slug: null })))
      .toContain('category_slugs')
  })

  it('refuses a primary category that was not selected', () => {
    expect(fields(complete({ category_slugs: ['concert'], primary_category_slug: 'film' })))
      .toContain('primary_category_slug')
  })
})

describe('the when step', () => {
  it('insists on a start', () => {
    expect(fields(complete({ starts_at: '' }))).toContain('starts_at')
  })

  it('rejects a date it cannot read', () => {
    expect(fields(complete({ starts_at: 'next tuesday' }))).toContain('starts_at')
  })

  it('rejects an end before its start', () => {
    expect(fields(complete({
      starts_at: '2026-11-02T12:00:00Z', ends_at: '2026-11-02T09:00:00Z',
    }))).toContain('ends_at')
  })

  it('accepts an end after its start', () => {
    expect(fields(complete({
      starts_at: '2026-11-02T12:00:00Z', ends_at: '2026-11-02T16:00:00Z',
    }))).toEqual([])
  })
})

describe('the where step', () => {
  it('asks a placed listing for a venue', () => {
    expect(fields(complete({ venue_id: null }))).toContain('venue_id')
  })

  it('never asks an announcement for one', () => {
    expect(fields(complete({ listing_type: 'announcement', venue_id: null }))).toEqual([])
  })

  it('refuses half a coordinate pair', () => {
    expect(fields(complete({ location_lat: 27.7 }))).toContain('location_lat')
    expect(fields(complete({ location_lng: 85.3 }))).toContain('location_lat')
    expect(fields(complete({ location_lat: 27.7, location_lng: 85.3 }))).toEqual([])
  })

  it('refuses coordinates off the planet', () => {
    expect(fields(complete({ location_lat: 91, location_lng: 85.3 }))).toContain('location_lat')
    expect(fields(complete({ location_lat: 27.7, location_lng: 181 }))).toContain('location_lng')
  })

  // #31: a room is an attribute of a listing, and it only means anything once
  // the venue it is inside has been picked.
  it('takes a room inside the chosen venue', () => {
    expect(fields(complete({ venue_room: 'Hall B' }))).toEqual([])
  })

  it('refuses a room with no venue, which is a venue about to be duplicated', () => {
    expect(fields(complete({ venue_id: null, venue_room: 'Hall B' })))
      .toEqual(expect.arrayContaining(['venue_id', 'venue_room']))
  })

  it('refuses a room name long enough to be the whole address', () => {
    expect(fields(complete({ venue_room: 'x'.repeat(121) }))).toContain('venue_room')
  })
})

describe('a complete listing of each type', () => {
  const cases: [ListingType, Partial<ListingInput>][] = [
    ['free', {}],
    ['ticketed_internal', {}],
    ['ticketed_external', { offer_url: 'https://tickets.example/e/1' }],
    ['announcement', { venue_id: null }],
  ]

  for (const [listing_type, extra] of cases) {
    it(`passes for ${listing_type}`, () => {
      expect(validateListing(complete({ listing_type, ...extra }))).toEqual([])
    })
  }
})

describe('an empty listing', () => {
  it('is reported against the fields the author can still see', () => {
    // With no type chosen only the unconditional steps can be judged; asking
    // for a venue before knowing whether it is an announcement would be wrong.
    const errors = fields({ ...emptyListing(), listing_type: undefined })
    expect(errors).toContain('title')
    expect(errors).toContain('listing_type')
    expect(errors).toContain('starts_at')
    expect(errors).not.toContain('venue_id')
  })
})
