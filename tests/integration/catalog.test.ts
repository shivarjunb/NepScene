import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { seedCatalogue, UPCOMING_SLUGS } from '../helpers/seed'

/**
 * Real HTTP against a real local D1 (docs/CONTRIBUTING.md). The WaahTickets
 * audit's three critical defects all lived in code that had unit tests around
 * it and no request-level test through it.
 */
const get = async (path: string) => {
  const response = await SELF.fetch(`https://nepscene.test${path}`)
  return { response, body: (await response.json()) as any }
}

const slugs = (body: any): string[] => body.data.map((l: any) => l.slug)

beforeAll(seedCatalogue)

describe('GET /api/catalog/listings', () => {
  it('returns published upcoming listings, soonest first', async () => {
    const { response, body } = await get('/api/catalog/listings')
    expect(response.status).toBe(200)
    expect(slugs(body)).toEqual(UPCOMING_SLUGS)
  })

  it('excludes finished listings — the F4 regression this endpoint exists to avoid', async () => {
    const { body } = await get('/api/catalog/listings')
    expect(slugs(body)).not.toContain('finished-gig')
  })

  it('keeps a listing that has started but not ended', async () => {
    const { body } = await get('/api/catalog/listings')
    expect(slugs(body)).toContain('art-week')
  })

  it('never leaks a draft or a submission awaiting moderation', async () => {
    const { body } = await get('/api/catalog/listings?include_past=true&limit=50')
    expect(slugs(body)).not.toContain('secret-draft')
    expect(slugs(body)).not.toContain('awaiting-review')
  })

  it('includes past listings only when asked', async () => {
    const { body } = await get('/api/catalog/listings?include_past=true')
    expect(slugs(body)).toContain('finished-gig')
  })

  it('is bounded: limit is capped and a bad limit is rejected', async () => {
    expect((await get('/api/catalog/listings?limit=500')).response.status).toBe(400)
    expect((await get('/api/catalog/listings?limit=abc')).response.status).toBe(400)
    const { body } = await get('/api/catalog/listings?limit=2')
    expect(body.data).toHaveLength(2)
    expect(body.page.has_more).toBe(true)
    expect(body.page.next_cursor).toBeTruthy()
  })

  it('pages through the whole catalogue without repeating or skipping', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const { body } = await get(`/api/catalog/listings?limit=2${query}`)
      seen.push(...slugs(body))
      cursor = body.page.next_cursor
      if (!cursor) break
    }
    expect(seen).toEqual(UPCOMING_SLUGS)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('rejects a cursor it did not issue', async () => {
    const { response, body } = await get('/api/catalog/listings?cursor=%21%21%21')
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('invalid_cursor')
  })

  it('filters by category, city, type and featured', async () => {
    expect(slugs((await get('/api/catalog/listings?category=concerts')).body))
      .toEqual(['rock-night', 'lakeside-live'])
    expect(slugs((await get('/api/catalog/listings?city=Pokhara')).body))
      .toEqual(['lakeside-live', 'lake-cleanup'])
    expect(slugs((await get('/api/catalog/listings?type=free')).body))
      .toEqual(['art-week', 'lake-cleanup'])
    expect(slugs((await get('/api/catalog/listings?featured=true')).body))
      .toEqual(['rock-night'])
  })

  it('rejects an unknown listing type instead of returning everything', async () => {
    expect((await get('/api/catalog/listings?type=vip')).response.status).toBe(400)
  })

  it('embeds venue, organizer and categories without a second request', async () => {
    const { body } = await get('/api/catalog/listings?category=concerts')
    const rockNight = body.data[0]
    expect(rockNight.venue.name).toBe('Purple Haze')
    expect(rockNight.venue.city).toBe('Kathmandu')
    expect(rockNight.organizer.slug).toBe('himalayan-sound')
    expect(rockNight.categories.map((c: any) => c.slug).sort()).toEqual(['concerts', 'nightlife'])
    // Coordinates fall back to the venue's when the listing has none.
    expect(rockNight.latitude).toBeCloseTo(27.7154, 3)
  })

  it('renders an offer as a link-out and never as a computed price', async () => {
    const { body } = await get('/api/catalog/listings?featured=true')
    expect(body.data[0].offer).toMatchObject({
      purchasable: true,
      price_from: 80000,
      currency: 'NPR',
      provider: 'waahtickets',
      sold_out: false,
    })
    expect(body.data[0].offer.url).toContain('waahtickets.example')
  })

  it('gives a free listing no offer at all, rather than an offer of zero', async () => {
    const { body } = await get('/api/catalog/listings?type=free')
    expect(body.data.every((l: any) => l.offer === null)).toBe(true)
  })

  it('stays within its D1 round-trip budget', async () => {
    const { response } = await get('/api/catalog/listings?limit=3')
    expect(Number(response.headers.get('x-d1-round-trips'))).toBeLessThanOrEqual(1)
  })

  it('serves a repeat request from the edge cache', async () => {
    const first = await SELF.fetch('https://nepscene.test/api/catalog/listings?limit=5')
    expect(first.headers.get('x-cache')).toBe('MISS')
    const second = await SELF.fetch('https://nepscene.test/api/catalog/listings?limit=5')
    expect(second.headers.get('x-cache')).toBe('HIT')
    expect(second.headers.get('x-d1-round-trips')).toBe('0')
  })
})

describe('GET /api/catalog/listings/:slug', () => {
  it('returns the full listing with media, artists and venue detail', async () => {
    const { response, body } = await get('/api/catalog/listings/rock-night')
    expect(response.status).toBe(200)
    expect(body.title).toBe('Rock Night')
    expect(body.venue.address ?? null).toBeDefined()
    expect(body.artists.map((a: any) => a.slug)).toEqual(['kutumba'])
    expect(body.media).toEqual([])
  })

  it('301s an old slug to its current one, so a published URL keeps working', async () => {
    const response = await SELF.fetch(
      'https://nepscene.test/api/catalog/listings/rock-night-2025',
      { redirect: 'manual' },
    )
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/api/catalog/listings/rock-night')
  })

  it('404s an unpublished listing rather than revealing that it exists', async () => {
    const { response, body } = await get('/api/catalog/listings/secret-draft')
    expect(response.status).toBe(404)
    expect(body.error.code).toBe('not_found')
  })
})

describe('GET /api/catalog/search', () => {
  it('matches on title', async () => {
    expect(slugs((await get('/api/catalog/search?q=rock')).body)).toEqual(['rock-night'])
  })

  it('matches on venue, area and city, not just the listing itself', async () => {
    expect(slugs((await get('/api/catalog/search?q=purple')).body))
      .toEqual(['art-week', 'rock-night'])
    expect(slugs((await get('/api/catalog/search?q=pokhara')).body))
      .toEqual(['lakeside-live', 'lake-cleanup'])
    // People search neighbourhoods, not cities.
    expect(slugs((await get('/api/catalog/search?q=thamel')).body))
      .toEqual(['art-week', 'rock-night'])
  })

  it('treats a wildcard in the query as a literal', async () => {
    const { body } = await get('/api/catalog/search?q=%25')
    expect(body.data).toEqual([])
  })

  it('filters by distance and reports it', async () => {
    // 20km around Thamel reaches the Kathmandu listings and not Pokhara's.
    const { body } = await get('/api/catalog/search?lat=27.7154&lng=85.3105&radius_km=20')
    expect(slugs(body).sort()).toEqual(['art-week', 'rock-night'])
    expect(body.data[0].distance_km).toBeLessThan(1)
  })

  it('requires lat and lng together', async () => {
    expect((await get('/api/catalog/search?lat=27.7')).response.status).toBe(400)
  })
})

describe('GET /api/catalog/venues', () => {
  it('lists venues with a count of what is on there', async () => {
    const { body } = await get('/api/catalog/venues')
    const purpleHaze = body.data.find((v: any) => v.slug === 'purple-haze')
    // Rock Night and Art Week are upcoming there; the finished gig is not counted.
    expect(purpleHaze.upcoming_listing_count).toBe(2)
  })

  it('returns a venue with its upcoming listings in one round trip', async () => {
    const { response, body } = await get('/api/catalog/venues/purple-haze')
    expect(response.status).toBe(200)
    expect(body.venue.name).toBe('Purple Haze')
    expect(body.listings.map((l: any) => l.slug)).toEqual(['art-week', 'rock-night'])
    expect(Number(response.headers.get('x-d1-round-trips'))).toBeLessThanOrEqual(1)
  })

  it('404s an unknown venue', async () => {
    expect((await get('/api/catalog/venues/nowhere')).response.status).toBe(404)
  })
})

describe('GET /api/catalog/organizers/:slug', () => {
  it('returns the organizer and their upcoming listings', async () => {
    const { body } = await get('/api/catalog/organizers/himalayan-sound')
    expect(body.organizer.is_verified).toBe(true)
    expect(body.listings.map((l: any) => l.slug)).toEqual(['art-week', 'rock-night', 'lakeside-live'])
  })
})

describe('GET /api/catalog/categories', () => {
  it('returns the reference categories with upcoming counts', async () => {
    const { body } = await get('/api/catalog/categories')
    const concerts = body.data.find((c: any) => c.slug === 'concerts')
    expect(concerts.name).toBe('Concerts')
    expect(concerts.upcoming_listing_count).toBe(2)
  })
})

describe('GET /api/catalog/bootstrap', () => {
  it('gives the homepage everything it needs in one request and one round trip', async () => {
    const { response, body } = await get('/api/catalog/bootstrap')
    expect(body.categories.length).toBeGreaterThan(0)
    expect(body.upcoming.map((l: any) => l.slug)).toEqual(UPCOMING_SLUGS)
    expect(body.featured.map((l: any) => l.slug)).toEqual(['rock-night'])
    expect(Number(response.headers.get('x-d1-round-trips'))).toBeLessThanOrEqual(1)
  })
})

describe('response headers', () => {
  it('carries a correlation id and CORS on a cached read as well as a fresh one', async () => {
    // Regression: both were staged on the Hono context, which a handler
    // returning a raw Response silently discards.
    for (const attempt of [1, 2]) {
      const response = await SELF.fetch('https://nepscene.test/api/catalog/categories')
      expect(response.headers.get('x-request-id'), `attempt ${attempt}`).toBeTruthy()
      expect(response.headers.get('access-control-allow-origin'), `attempt ${attempt}`).toBe('*')
    }
  })
})

describe('scope', () => {
  it('has no commerce endpoint mounted', async () => {
    for (const path of ['/api/checkout', '/api/orders', '/api/payments', '/api/cart']) {
      expect((await SELF.fetch(`https://nepscene.test${path}`)).status).toBe(404)
    }
  })
})
