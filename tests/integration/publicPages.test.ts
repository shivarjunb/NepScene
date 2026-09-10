import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { seedCatalogue, seedPublicSite } from '../helpers/seed'

/**
 * #43 and #44 — what the listing, venue, organizer and artist pages are served.
 *
 * The two things worth pinning here rather than in a browser: that every page
 * is one round trip, and that the rules about *which* listings appear —
 * related excludes itself, past and upcoming are partitioned at the right
 * boundary — hold against real rows rather than against a fixture list.
 */
const get = async (path: string) => {
  const response = await SELF.fetch(`https://nepscene.test${path}`)
  return { response, body: await response.json() as any }
}

const slugs = (listings: any[]): string[] => listings.map((listing) => listing.slug)

beforeAll(async () => {
  await seedCatalogue()
  await seedPublicSite()
})

describe('a listing page', () => {
  it('serves the full record, in one round trip', async () => {
    const { response, body } = await get('/api/catalog/listings/rock-night')
    expect(response.status).toBe(200)
    expect(body.title).toBe('Rock Night')
    expect(body.venue.address ?? null).not.toBeUndefined()
    expect(body.artists.length).toBeGreaterThan(0)
    expect(response.headers.get('x-d1-round-trips')).toBe('1')
  })

  it('carries the Nepali half where the listing has one (#46)', async () => {
    const { body } = await get('/api/catalog/listings/rock-night')
    expect(body.title_ne).toBe('रक नाइट')
    expect(body.summary_ne).toBeTruthy()
  })

  it('leaves the Nepali fields null rather than empty where it has none', async () => {
    const { body } = await get('/api/catalog/listings/lakeside-live')
    expect(body.title_ne).toBeNull()
    // The English title is what every language-less surface reads, and it is
    // always there.
    expect(body.title).toBeTruthy()
  })

  it('tells the page whether an artist has a page of their own', async () => {
    const { body } = await get('/api/catalog/listings/rock-night')
    const kutumba = body.artists.find((artist: any) => artist.slug === 'kutumba')
    expect(kutumba.listing_count).toBe(2)
  })

  it('recommends related listings and never itself', async () => {
    const { body } = await get('/api/catalog/listings/rock-night')
    expect(body.related.length).toBeGreaterThan(0)
    expect(slugs(body.related)).not.toContain('rock-night')
  })

  it('ranks the same venue above a merely shared category', async () => {
    const { body } = await get('/api/catalog/listings/rock-night')
    const related = slugs(body.related)
    // Kutumba Live is at the same venue; Lakeside Live only shares a category.
    expect(related.indexOf('kutumba-live')).toBeLessThan(related.indexOf('lakeside-live'))
  })

  it('never relates a listing to something finished', async () => {
    const { body } = await get('/api/catalog/listings/rock-night')
    expect(slugs(body.related)).not.toContain('finished-gig')
  })

  it('still resolves an old slug', async () => {
    const response = await SELF.fetch(
      'https://nepscene.test/api/catalog/listings/rock-night-2025', { redirect: 'manual' },
    )
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/api/catalog/listings/rock-night')
  })

  it('is a 404 for a draft, not a peek at one', async () => {
    expect((await get('/api/catalog/listings/secret-draft')).response.status).toBe(404)
  })
})

describe('the offer, and its absence', () => {
  it('carries the snapshot when there is one', async () => {
    const { body } = await get('/api/catalog/listings/rock-night')
    expect(body.offer.price_from).toBe(80000)
    expect(body.offer.url).toContain('waahtickets')
  })

  it('renders a free listing with no offer at all, which is not an offer of zero', async () => {
    const { body } = await get('/api/catalog/listings/lake-cleanup')
    expect(body.offer).toBeNull()
    expect(body.listing_type).toBe('free')
  })

  it('serves the whole record even when the offer could not be resolved', async () => {
    // A ticketed listing whose offer columns were never filled: the page still
    // has everything above the buy button, which is what #43 asks for.
    const { response, body } = await get('/api/catalog/listings/kutumba-live')
    expect(response.status).toBe(200)
    expect(body.listing_type).toBe('ticketed_internal')
    expect(body.offer).toBeNull()
    expect(body.title).toBe('Kutumba Live')
    expect(body.venue.name).toBe('Purple Haze')
  })
})

describe('a venue page', () => {
  it('separates what is on from what has been, in one round trip', async () => {
    const { response, body } = await get('/api/catalog/venues/purple-haze')
    expect(response.headers.get('x-d1-round-trips')).toBe('1')
    expect(slugs(body.listings)).toContain('rock-night')
    expect(slugs(body.past)).toEqual(['finished-gig'])
  })

  it('orders the past backwards — the most recent thing that happened first', async () => {
    const { body } = await get('/api/catalog/venues/purple-haze')
    const starts = body.past.map((listing: any) => listing.starts_at)
    expect([...starts].sort().reverse()).toEqual(starts)
  })

  it('counts a running listing as on, not as past', async () => {
    // Art Week started yesterday and ends tomorrow.
    const { body } = await get('/api/catalog/venues/purple-haze')
    expect(slugs(body.listings)).toContain('art-week')
    expect(slugs(body.past)).not.toContain('art-week')
  })

  it('shows past listings rather than an empty page when nothing is coming up', async () => {
    const { body } = await get('/api/catalog/venues/quiet-hall')
    expect(body.listings).toEqual([])
    expect(slugs(body.past)).toEqual(['quiet-recital'])
    expect(body.venue.upcoming_listing_count).toBe(0)
    expect(body.venue.past_listing_count).toBe(1)
  })

  it('carries what a page needs to give directions', async () => {
    const { body } = await get('/api/catalog/venues/quiet-hall')
    expect(body.venue.address).toBe('Pulchowk Road')
    expect(body.venue.capacity).toBe(200)
    expect(body.venue.latitude).not.toBeNull()
  })

  it('is a 404 for a venue that does not exist', async () => {
    expect((await get('/api/catalog/venues/nowhere')).response.status).toBe(404)
  })
})

describe('an organizer page', () => {
  it('separates upcoming from past, in one round trip', async () => {
    const { response, body } = await get('/api/catalog/organizers/himalayan-sound')
    expect(response.headers.get('x-d1-round-trips')).toBe('1')
    expect(slugs(body.listings)).toContain('rock-night')
    expect(slugs(body.past)).toEqual(['finished-gig'])
    expect(body.organizer.is_verified).toBe(true)
  })

  it('lists only organizers with something published', async () => {
    const { body } = await get('/api/catalog/organizers')
    expect(body.data.map((organizer: any) => organizer.slug)).toEqual(['himalayan-sound'])
    expect(body.data[0].upcoming_listing_count).toBeGreaterThan(0)
  })
})

describe('an artist page', () => {
  it('exists once the artist is on more than one listing', async () => {
    const { response, body } = await get('/api/catalog/artists/kutumba')
    expect(response.status).toBe(200)
    expect(response.headers.get('x-d1-round-trips')).toBe('1')
    expect(slugs(body.listings).sort()).toEqual(['kutumba-live', 'rock-night'])
    expect(body.artist.listing_count).toBe(2)
  })

  it('serves the artist’s links, dropping anything that is not a link', async () => {
    const { body } = await get('/api/catalog/artists/kutumba')
    // Stored as free-form JSON (migration 0001); a numeric value is not a URL
    // and would render as "[object Object]" or worse.
    expect(body.artist.links).toEqual({ instagram: 'https://instagram.example/kutumba' })
  })

  it('is a 404 for an artist with nothing, so no listing links to a thin page', async () => {
    expect((await get('/api/catalog/artists/nobody')).response.status).toBe(404)
  })
})
