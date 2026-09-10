import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

/**
 * #42's latency criterion: p95 under 200ms at ten thousand listings.
 *
 * **What this can and cannot measure, stated plainly.** It runs against
 * `env.DB` — SQLite in the same process — so it measures query time without
 * the network. Production adds one D1 round trip, the ~200ms from Kathmandu
 * that the whole architecture is arranged around (docs/ARCHITECTURE.md, rule
 * 4), and no test in this repository can measure that.
 *
 * **And it asserts a ratio rather than a millisecond count.** Vitest runs
 * fifty files at once, so wall-clock here largely measures what else the
 * machine is doing: the same search takes 60ms alone and 270ms under a full
 * suite. A number tuned to pass on a loaded laptop fails on a loaded CI runner
 * and vice versa, and a test that flakes gets deleted rather than fixed.
 *
 * So the budget is **the same endpoint with and without a text query**. Both
 * requests do the identical work — the same filters, the same facet counts
 * over the same ten thousand rows — except for matching the words, which is
 * the only part that has ever regressed here. Both absorb the same background
 * load, so what is left in the ratio is the shape of the query.
 *
 * The numbers this was calibrated against, measured directly against `env.DB`
 * at ten thousand listings: matching each spelling against eight columns
 * separately cost 114ms, and repeating the WHERE in four facet aggregates cost
 * 664ms — together about 19× a query-less search. Computing the haystack once
 * per row and materialising the matched set brought both to under 35ms, which
 * is a little over 2×.
 *
 * Ten thousand rows is the number #42 names, and it is worth seeding rather
 * than approximating: the correlated subqueries on every row (categories,
 * cover, popularity) are exactly what degrades with row count.
 */
const LISTINGS = 10_000
/**
 * Matching the words may cost a small multiple of the rest of a search. Four
 * is the ceiling; the shipped shape sits a little over two, and the version
 * this replaced was at nineteen.
 */
const TEXT_MATCHING_BUDGET = 4

const get = (path: string) => SELF.fetch(`https://nepscene.test${path}`)

/** A distinct `from` per round, so the query-less side's cache key changes too. */
const isoFrom = (round: number) =>
  new Date(Date.now() - round * 86_400_000).toISOString().slice(0, 10)

async function timed(path: string): Promise<number> {
  const started = Date.now()
  const response = await get(path)
  const elapsed = Date.now() - started
  if (response.status !== 200) throw new Error(`${path} answered ${response.status}`)
  return elapsed
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number
}

beforeAll(async () => {
  await seedCatalogue()

  const now = Date.now()
  const cities = ['Kathmandu', 'Pokhara', 'Lalitpur', 'Bhaktapur', 'Biratnagar', 'Dharan']
  const words = ['Jazz', 'Rock', 'Folk', 'Comedy', 'Market', 'Festival', 'Cup', 'Night']

  // Venues first, so every listing has somewhere to be and the joins are real.
  await env.DB.batch(cities.map((city, index) => env.DB.prepare(
    `INSERT INTO venues (id, slug, name, area, city, latitude, longitude, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
  ).bind(
    `ven_bulk_${index}`, `bulk-venue-${index}`, `${city} Hall`, `Area ${index}`, city,
    27 + index * 0.2, 85 + index * 0.2, new Date(now).toISOString(),
  )))

  // Batched in chunks: one batch of ten thousand statements exhausts the
  // isolate's memory before it reaches the database.
  const CHUNK = 500
  for (let start = 0; start < LISTINGS; start += CHUNK) {
    const statements = []
    for (let index = start; index < start + CHUNK; index++) {
      const startsAt = new Date(now + (index % 400) * 3_600_000 * 6).toISOString()
      statements.push(env.DB.prepare(
        `INSERT INTO listings
          (id, slug, title, summary, listing_type, source, status, venue_id,
           starts_at, is_all_day, timezone, is_featured, published_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'import', 'published', ?6, ?7, 0, 'Asia/Kathmandu', 0, ?8, ?8, ?8)`,
      ).bind(
        `lst_bulk_${index}`, `bulk-${index}`,
        `${words[index % words.length]} ${index}`,
        `A ${words[(index + 3) % words.length]} evening`,
        index % 3 === 0 ? 'free' : 'ticketed_internal',
        `ven_bulk_${index % cities.length}`,
        startsAt, new Date(now).toISOString(),
      ))
      statements.push(env.DB.prepare(
        `INSERT INTO listing_categories (listing_id, category_id, is_primary)
         VALUES (?1, ?2, 1)`,
      ).bind(`lst_bulk_${index}`, index % 2 === 0 ? 'cat_concert' : 'cat_market'))
    }
    await env.DB.batch(statements)
  }
}, 120_000)

describe(`search at ${LISTINGS.toLocaleString('en')} listings`, () => {
  it('still searches the whole catalogue, not a downloaded page', async () => {
    // A title that exists exactly once, four hundred slots deep.
    const response = await get('/api/catalog/search?q=' + encodeURIComponent('Folk 9002'))
    const body = await response.json() as any
    expect(body.data.map((listing: any) => listing.slug)).toContain('bulk-9002')
  })

  it('keeps the cost of matching the words to a small multiple of the rest', async () => {
    const queries = [
      'jazz', 'rock night', 'kathmandu', 'ktm', 'pokhara comedy', 'festival',
      'market', 'folk', 'thamel', 'biratnagar cup',
    ]

    // Both sides are measured in the same loop, interleaved, so a burst of
    // load from another test file lands on both rather than on one.
    const withText: number[] = []
    const withoutText: number[] = []
    for (let round = 0; round < 4; round++) {
      for (const query of queries) {
        // A fresh parameter per round defeats the edge cache, which would
        // otherwise measure the cache rather than the query.
        const limit = 20 + round
        withText.push(await timed(
          `/api/catalog/search?q=${encodeURIComponent(query)}&limit=${limit}`))
        withoutText.push(await timed(
          `/api/catalog/search?limit=${limit}&from=${isoFrom(round)}`))
      }
    }

    const text = percentile(withText, 95)
    const base = Math.max(1, percentile(withoutText, 95))
    expect(text / base).toBeLessThan(TEXT_MATCHING_BUDGET)
  }, 120_000)

  it('counts facets over the whole matching set without a second pass', async () => {
    const response = await get('/api/catalog/search?q=jazz')
    const body = await response.json() as any
    const total = body.facets.city.reduce((sum: number, facet: any) => sum + facet.count, 0)
    // Far more matches than a page, which is the case a facet has to survive.
    expect(total).toBeGreaterThan(body.data.length)
    expect(response.headers.get('x-d1-round-trips')).toBe('1')
  })

  it('stays bounded: a broad query returns a page, not the catalogue', async () => {
    const body = await (await get('/api/catalog/search?q=a')).json() as any
    expect(body.data.length).toBeLessThanOrEqual(20)
  })
})
