import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'
import { bboxParam, padBounds, type Bounds } from '../../app/map/viewport'

/**
 * #36's integration criteria, through real HTTP against a real D1:
 *
 * - "Panning loads listings for the new viewport without refetching everything"
 * - "Confirm no unbounded catalogue request is ever issued"
 *
 * The seed puts two venues 140km apart — Purple Haze in Thamel and Lakeside in
 * Pokhara — which is what makes "somewhere else" expressible as a rectangle.
 */
const get = async (path: string) => {
  const response = await SELF.fetch(`https://nepscene.test${path}`)
  return { response, body: (await response.json()) as any }
}

const slugs = (body: any): string[] => body.data.map((l: any) => l.slug)

/** What the map asks, given a viewport: padded, then serialised. */
const mapRequest = (viewport: Bounds, extra = '') =>
  get(`/api/catalog/search?bbox=${bboxParam(padBounds(viewport))}&limit=50${extra}`)

const KATHMANDU: Bounds = { west: 85.20, south: 27.62, east: 85.42, north: 27.80 }
const POKHARA: Bounds = { west: 83.88, south: 28.15, east: 84.03, north: 28.27 }

beforeAll(seedCatalogue)

describe('the map asks only for what is in view', () => {
  it('returns the listings inside the viewport', async () => {
    const { response, body } = await mapRequest(KATHMANDU)
    expect(response.status).toBe(200)
    expect(slugs(body).sort()).toEqual(['art-week', 'rock-night'])
  })

  it('leaves out everything outside it', async () => {
    const { body } = await mapRequest(KATHMANDU)
    // 140km away, and the whole point of scoping the query.
    expect(slugs(body)).not.toContain('lakeside-live')
    expect(slugs(body)).not.toContain('lake-cleanup')
  })

  it('returns the other region when the map is panned to it', async () => {
    const { body } = await mapRequest(POKHARA)
    expect(slugs(body).sort()).toEqual(['lake-cleanup', 'lakeside-live'])
    expect(slugs(body)).not.toContain('rock-night')
  })

  it('is empty over open country rather than falling back to everything', async () => {
    // The failure this guards is a bbox that is parsed, ignored, and answered
    // with the unfiltered feed — which looks like a working map.
    const { body } = await mapRequest({ west: 86.5, south: 27.0, east: 86.8, north: 27.2 })
    expect(body.data).toEqual([])
  })

  it('still hides what the catalogue hides — a bbox is not a back door', async () => {
    const { body } = await mapRequest(KATHMANDU, '&include_past=true')
    expect(slugs(body)).not.toContain('secret-draft')
    expect(slugs(body)).not.toContain('awaiting-review')
  })

  it('is upcoming by default inside the box, as everywhere else', async () => {
    const { body } = await mapRequest(KATHMANDU)
    expect(slugs(body)).not.toContain('finished-gig')
  })
})

describe('a viewport request stays bounded', () => {
  it('is capped by the same limit as every other feed', async () => {
    const bbox = bboxParam(padBounds(KATHMANDU))
    expect((await get(`/api/catalog/search?bbox=${bbox}&limit=500`)).response.status).toBe(400)
  })

  it('pages rather than returning the region in one unbounded response', async () => {
    const bbox = bboxParam(padBounds(KATHMANDU))
    const { body } = await get(`/api/catalog/search?bbox=${bbox}&limit=1`)
    expect(body.data).toHaveLength(1)
    expect(body.page.has_more).toBe(true)
    expect(body.page.next_cursor).toBeTruthy()
  })

  it('walks a region with the cursor without repeating or skipping', async () => {
    const bbox = bboxParam(padBounds(KATHMANDU))
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page += 1) {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      const { body } = await get(`/api/catalog/search?bbox=${bbox}&limit=1${query}`)
      seen.push(...slugs(body))
      cursor = body.page.next_cursor
      if (!cursor) break
    }
    expect(seen.sort()).toEqual(['art-week', 'rock-night'])
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('keeps its D1 round trips inside the catalog budget', async () => {
    const { response } = await mapRequest(KATHMANDU)
    expect(Number(response.headers.get('x-d1-round-trips'))).toBeLessThanOrEqual(3)
  })
})

describe('a viewport the API cannot honestly answer', () => {
  it.each([
    ['85.2,27.6,85.4', 'three values'],
    ['85.2,27.8,85.4,27.6', 'south above north'],
    ['179,27.6,-179,27.8', 'an antimeridian crossing'],
    ['85.2,-91,85.4,27.8', 'a latitude off the planet'],
  ])('rejects %s (%s) with a 400', async (bbox) => {
    const { response } = await get(`/api/catalog/search?bbox=${encodeURIComponent(bbox)}`)
    expect(response.status).toBe(400)
  })

  /**
   * A viewport and a radius both write the one SQL box. Letting the last one
   * assigned win would make a map that pans inside a distance filter show
   * the wrong listings and never say so.
   */
  it('refuses a bbox and a radius together rather than picking one', async () => {
    const bbox = bboxParam(padBounds(KATHMANDU))
    const { response, body } = await get(
      `/api/catalog/search?bbox=${bbox}&lat=27.7&lng=85.3&radius_km=5`,
    )
    expect(response.status).toBe(400)
    expect(body.error.message).toMatch(/bbox or lat\/lng/)
  })

  it('does not accept a bbox on the plain feed, whose cache key has no room for one', async () => {
    // `/listings` caches on FEED_PARAMS. Honouring a bbox there would either
    // fragment the feed cache or, worse, serve one viewport's rows to another.
    const bbox = bboxParam(padBounds(KATHMANDU))
    const { body } = await get(`/api/catalog/listings?bbox=${bbox}&limit=50`)
    expect(slugs(body)).toContain('lakeside-live')
  })
})
