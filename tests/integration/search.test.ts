import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { seedCatalogue, seedPublicSite } from '../helpers/seed'

/**
 * #42 — search against a real catalogue, through the real Worker.
 *
 * The unit tests pin the ranking function and the alias table; these pin what
 * the endpoint actually does with them, including the two things only an
 * end-to-end read can show: that facet counts match the filtered set, and that
 * the correction pass costs nothing on the requests that did not need it.
 */
const get = async (path: string) => {
  const response = await SELF.fetch(`https://nepscene.test${path}`)
  return { response, body: await response.json() as any }
}

const slugs = (body: any): string[] => body.data.map((listing: any) => listing.slug)
const search = (query: string) => get(`/api/catalog/search?q=${encodeURIComponent(query)}`)

beforeAll(async () => {
  await seedCatalogue()
  await seedPublicSite()
})

describe('what a query finds', () => {
  it('matches a title', async () => {
    expect(slugs((await search('rock')).body)).toEqual(['rock-night'])
  })

  it('matches the venue, the area and the city, not only the listing', async () => {
    expect(slugs((await search('purple')).body).sort())
      .toEqual(['art-week', 'kutumba-live', 'rock-night'])
    // People search neighbourhoods, not cities.
    expect(slugs((await search('thamel')).body)).toContain('rock-night')
    expect(slugs((await search('pokhara')).body).sort())
      .toEqual(['lake-cleanup', 'lakeside-live'])
  })

  it('matches a category and a tag', async () => {
    expect(slugs((await search('concerts')).body)).toContain('rock-night')
    expect(slugs((await search('live music')).body)).toContain('rock-night')
  })

  it('ANDs the words: both must match, not either', async () => {
    expect(slugs((await search('rock night')).body)).toEqual(['rock-night'])
    expect(slugs((await search('rock pokhara')).body)).toEqual([])
  })

  it('hides what the catalogue hides — search is not a back door', async () => {
    expect(slugs((await search('secret')).body)).toEqual([])
    expect(slugs((await search('awaiting')).body)).toEqual([])
  })

  it('is upcoming by default, like every other read', async () => {
    expect(slugs((await search('finished')).body)).toEqual([])
  })

  it('treats a wildcard in the query as a literal, not as "everything"', async () => {
    expect((await search('%')).body.data).toEqual([])
  })
})

describe('Nepali place names and spelling', () => {
  it('finds Kathmandu listings from an abbreviation', async () => {
    expect(slugs((await search('ktm')).body)).toContain('rock-night')
  })

  it('finds them from the Devanagari spelling', async () => {
    expect(slugs((await search('काठमाडौं')).body)).toContain('rock-night')
  })

  it('finds a Devanagari title from a Latin query and back again (#46)', async () => {
    // Rock Night carries a Nepali title; both spellings reach it.
    expect(slugs((await search('रक नाइट')).body)).toContain('rock-night')
    expect(slugs((await search('rock')).body)).toContain('rock-night')
  })

  it('survives the misspellings that arrive from a phone keyboard', async () => {
    for (const misspelling of ['kathmndu', 'kahtmandu', 'pokhra', 'pokahra']) {
      const { body } = await search(misspelling)
      expect(body.data.length, misspelling).toBeGreaterThan(0)
    }
  })

  it('says when it corrected the spelling, and offers the original back', async () => {
    const { body } = await search('kutumbaa')
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.corrected_from).toBe('kutumbaa')
  })

  it('does not second-guess a query that found something', async () => {
    expect((await search('rock')).body.corrected_from).toBeNull()
  })

  it('leaves the spelling alone when the reader insists', async () => {
    const { body } = await get('/api/catalog/search?q=kutumbaa&exact=1')
    expect(body.data).toEqual([])
    expect(body.corrected_from).toBeNull()
  })
})

describe('ranking', () => {
  it('puts a match that is sooner above the same match further out', async () => {
    // Both are at Purple Haze; Rock Night is in two days, Kutumba Live in nine.
    const order = slugs((await search('purple')).body)
    expect(order.indexOf('rock-night')).toBeLessThan(order.indexOf('kutumba-live'))
  })

  it('reports distance when a centre is given, and ranks by it', async () => {
    const { body } = await get('/api/catalog/search?q=live&lat=28.2096&lng=83.9556&radius_km=20')
    expect(slugs(body)[0]).toBe('lakeside-live')
    expect(body.data[0].distance_km).toBeLessThan(1)
  })
})

describe('a search that found nothing', () => {
  it('offers alternatives rather than a dead end', async () => {
    const { body } = await search('zzzzqqq')
    expect(body.data).toEqual([])
    expect(body.alternatives.length).toBeGreaterThan(0)
  })

  it('offers near-misses when the query resembles something', async () => {
    const { body } = await get('/api/catalog/search?q=lakesyde&exact=1')
    expect(body.data).toEqual([])
    expect(body.alternatives.map((entry: any) => entry.label)).toContain('Lakeside')
  })
})

describe('facets', () => {
  it('counts every axis the reader can refine by', async () => {
    const { body } = await get('/api/catalog/search')
    expect(Object.keys(body.facets).sort()).toEqual(['category', 'city', 'price', 'when'])
    const cities = Object.fromEntries(
      body.facets.city.map((facet: any) => [facet.value, facet.count]),
    )
    expect(cities.Kathmandu).toBe(3)
    expect(cities.Pokhara).toBe(2)
  })

  it('counts the filtered set, so a chip leads to what it promised', async () => {
    const { body } = await get('/api/catalog/search?city=Kathmandu')
    const concerts = body.facets.category.find((facet: any) => facet.value === 'concerts')
    const { body: filtered } = await get('/api/catalog/search?city=Kathmandu&category=concerts')
    expect(filtered.data).toHaveLength(concerts.count)
  })

  it('separates free from ticketed', async () => {
    const { body } = await get('/api/catalog/search')
    const bands = Object.fromEntries(
      body.facets.price.map((facet: any) => [facet.value, facet.count]),
    )
    expect(bands.free).toBeGreaterThan(0)
    expect(bands.ticketed).toBeGreaterThan(0)

    const { body: freeOnly } = await get('/api/catalog/search?price=free')
    expect(freeOnly.data).toHaveLength(bands.free)
  })

  it('carries the window a date facet was counted over', async () => {
    const { body } = await get('/api/catalog/search')
    const bucket = body.facets.when.find((facet: any) => facet.count > 0)
    const filter = new URLSearchParams()
    if (bucket.from) filter.set('from', bucket.from)
    if (bucket.to) filter.set('to', bucket.to)
    const { body: filtered } = await get(`/api/catalog/search?${filter}`)
    expect(filtered.data).toHaveLength(bucket.count)
  })

  it('rejects a price band it does not recognise rather than ignoring it', async () => {
    expect((await get('/api/catalog/search?price=cheap')).response.status).toBe(400)
  })
})

describe('suggestions', () => {
  it('suggests from the catalogue itself', async () => {
    const { body } = await get('/api/catalog/suggest?q=roc')
    expect(body.data.map((entry: any) => entry.label)).toContain('Rock Night')
  })

  it('suggests places and categories, each labelled by what it is', async () => {
    const { body } = await get('/api/catalog/suggest?q=pok')
    expect(body.data.some((entry: any) => entry.kind === 'city')).toBe(true)
  })

  it('is empty for an empty query rather than returning the catalogue', async () => {
    expect((await get('/api/catalog/suggest?q=')).body.data).toEqual([])
  })
})

describe('the read-path budget', () => {
  // Queries used nowhere else in this file: a repeat is an edge-cache hit,
  // which costs no round trips at all and would measure nothing.
  it('answers a search in one round trip', async () => {
    const { response } = await search('recital')
    expect(response.headers.get('x-cache')).toBe('MISS')
    expect(response.headers.get('x-d1-round-trips')).toBe('1')
  })

  it('spends a second one only on the query that found nothing', async () => {
    const { response } = await search('kutumbah')
    expect(response.headers.get('x-cache')).toBe('MISS')
    expect(response.headers.get('x-d1-round-trips')).toBe('2')
  })

  it('pages a ranked search without repeating a row', async () => {
    const first = await get('/api/catalog/search?limit=2')
    expect(first.body.data).toHaveLength(2)
    const cursor = first.body.page.next_cursor
    expect(cursor).not.toBeNull()

    const second = await get(`/api/catalog/search?limit=2&cursor=${encodeURIComponent(cursor)}`)
    const seen = new Set([...slugs(first.body), ...slugs(second.body)])
    expect(seen.size).toBe(slugs(first.body).length + slugs(second.body).length)
  })

  it('ignores a cursor it did not issue rather than failing the search', async () => {
    const { response, body } = await get('/api/catalog/search?cursor=not-a-cursor')
    expect(response.status).toBe(200)
    expect(body.data.length).toBeGreaterThan(0)
  })
})

describe('the free-versus-ticketed band', () => {
  it('does not call a ticketed listing free because its price is unknown', async () => {
    // Kutumba Live is ticketed with no resolved offer. Counting a null price
    // as zero would put it under "Free", which is the one thing in this column
    // a reader acts on before finding out it was wrong.
    const { body } = await get('/api/catalog/search?price=free')
    expect(slugs(body)).not.toContain('kutumba-live')
    expect(slugs(body)).not.toContain('lakeside-live')

    const { body: ticketed } = await get('/api/catalog/search?price=ticketed')
    expect(slugs(ticketed)).toContain('kutumba-live')
  })

  it('counts a genuinely free listing as free', async () => {
    expect(slugs((await get('/api/catalog/search?price=free')).body)).toContain('lake-cleanup')
  })
})

describe('a distance search', () => {
  // Purple Haze (Thamel) to Lakeside (Pokhara) is ~140km; the two Kathmandu
  // venues are within a kilometre of the centre used below.
  const thamel = 'lat=27.7154&lng=85.3105'

  it('returns what is inside the circle, not what is inside the box', async () => {
    // A bounding box is 27% larger than the circle it contains, so a radius
    // that is only a prefilter quietly returns listings beyond it.
    const { body } = await get(`/api/catalog/search?${thamel}&radius_km=20`)
    expect(slugs(body).sort()).toEqual(['art-week', 'kutumba-live', 'rock-night'])
    for (const listing of body.data) {
      expect(listing.distance_km, listing.slug).toBeLessThanOrEqual(20)
    }
  })

  it('reports the distance it filtered by', async () => {
    const { body } = await get(`/api/catalog/search?${thamel}&radius_km=20`)
    expect(body.data[0].distance_km).toBeLessThan(1)
  })

  it('excludes a listing just outside the radius', async () => {
    // Lakeside is ~140km away: inside a 200km radius, outside a 100km one.
    expect(slugs((await get(`/api/catalog/search?${thamel}&radius_km=200`)).body))
      .toContain('lakeside-live')
    expect(slugs((await get(`/api/catalog/search?${thamel}&radius_km=100`)).body))
      .not.toContain('lakeside-live')
  })

  it('counts facets over the circle too, so a chip agrees with the results', async () => {
    const { body } = await get(`/api/catalog/search?${thamel}&radius_km=20`)
    const total = body.facets.when.reduce((sum: number, facet: any) => sum + facet.count, 0)
    expect(total).toBe(body.data.length)
    expect(body.facets.city.map((facet: any) => facet.value)).toEqual(['Kathmandu'])
  })
})
