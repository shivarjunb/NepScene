import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

/**
 * #39's integration criteria, at ten thousand listings.
 *
 * The measurement convention is `searchScale.test.ts`'s and the reasoning is
 * the same: Vitest runs fifty files at once, so wall-clock here largely
 * measures what else the machine is doing, and a millisecond budget tuned on a
 * quiet laptop flakes on a loaded CI runner. So this asserts **ratios and row
 * counts**, which are properties of the query rather than of the box it ran on.
 */

const VOLUME = 10_000

/**
 * Ten thousand published listings across a hundred venues, spread over Nepal.
 *
 * Written straight to `env.DB` in batches rather than through the API: the
 * subject is what a *read* costs at volume, and paying for ten thousand
 * authenticated writes to get there would dominate the run.
 */
async function seedVolume(): Promise<void> {
  const now = new Date().toISOString()
  // Deterministic, so a measurement taken today is comparable with one taken
  // next month — the same generator `scripts/seed-volume.mjs` uses.
  let seed = 20260902
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  const venues: string[] = []
  const venueRows: D1PreparedStatement[] = []
  for (let i = 0; i < 100; i += 1) {
    const id = `vol_ven_${i}`
    venues.push(id)
    venueRows.push(env.DB.prepare(
      `INSERT INTO venues (id, slug, name, city, district, province, latitude, longitude, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Kathmandu', 'Kathmandu', 'Bagmati', ?4, ?5, ?6, ?6)`,
    ).bind(id, `vol-venue-${i}`, `Volume Venue ${i}`,
           // Spread across the valley, which is where a real catalogue is dense.
           27.60 + random() * 0.25, 85.20 + random() * 0.30, now))
  }
  await env.DB.batch(venueRows)

  const statements: D1PreparedStatement[] = []
  for (let i = 0; i < VOLUME; i += 1) {
    const startsAt = new Date(Date.now() + (1 + Math.floor(random() * 300)) * 86_400_000).toISOString()
    statements.push(env.DB.prepare(
      `INSERT INTO listings
        (id, slug, title, summary, listing_type, source, status, venue_id,
         starts_at, is_featured, published_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'free', 'import', 'published', ?5, ?6, 0, ?7, ?7, ?7)`,
    ).bind(`vol_${i}`, `vol-listing-${i}`, `Volume Listing ${i}`, 'Generated.',
           venues[Math.floor(random() * venues.length)]!, startsAt, now))
  }
  // D1's batch has a statement ceiling well below ten thousand.
  for (let at = 0; at < statements.length; at += 500) {
    await env.DB.batch(statements.slice(at, at + 500))
  }
}

const get = async (path: string) => {
  const started = Date.now()
  const response = await SELF.fetch(`https://nepscene.test${path}`)
  const body = (await response.json()) as any
  return { response, body, ms: Date.now() - started }
}

/** The valley: where the ten thousand are. */
const VALLEY = '85.20,27.60,85.50,27.85'
/** A quarter of it. */
const CORNER = '85.20,27.60,85.27,27.66'

beforeAll(async () => {
  await seedCatalogue()
  await seedVolume()
})

describe('the map read at ten thousand listings', () => {
  it('really has ten thousand published listings behind it', async () => {
    // The test above this one would pass against fourteen rows, and a seed
    // that silently inserted nothing is the most boring way for a scale test
    // to be worthless.
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM listings WHERE status = 'published'",
    ).all<{ n: number }>()
    expect(results[0]!.n).toBeGreaterThanOrEqual(VOLUME)
  })

  it('never returns more than one page, whatever is in the box', async () => {
    // The ceiling is the whole point. WaahTickets' equivalent endpoint would
    // have returned all ten thousand, and the map would have drawn them.
    const { response, body } = await get(`/api/catalog/search?bbox=${VALLEY}&limit=50`)
    expect(response.status).toBe(200)
    expect(body.data).toHaveLength(50)
    expect(body.page.has_more).toBe(true)
  })

  it('returns fewer rows for a smaller box, so the query is really scoped', async () => {
    // The failure this catches is a box that parses but does not filter — the
    // map would look right at every zoom and cost the same at all of them.
    const { body: wide } = await get(`/api/catalog/search?bbox=${VALLEY}&limit=50&cursor=`)
    const { body: narrow } = await get(`/api/catalog/search?bbox=${CORNER}&limit=50`)
    expect(narrow.data.length).toBeLessThanOrEqual(wide.data.length)
    // And every row it did return is genuinely inside the smaller box.
    for (const listing of narrow.data) {
      expect(listing.latitude).toBeGreaterThanOrEqual(27.60)
      expect(listing.latitude).toBeLessThanOrEqual(27.66)
      expect(listing.longitude).toBeGreaterThanOrEqual(85.20)
      expect(listing.longitude).toBeLessThanOrEqual(85.27)
    }
  })

  it('stays within the D1 round-trip budget at volume', async () => {
    // The budget is 1–3 (docs/ARCHITECTURE.md, rule 4) and it does not get to
    // grow with the catalogue. A query that fanned out per row would pass every
    // correctness test in this file and be unusable from Kathmandu.
    const { response } = await get(`/api/catalog/search?bbox=${VALLEY}&limit=50`)
    expect(Number(response.headers.get('x-d1-round-trips'))).toBeLessThanOrEqual(3)
  })

  it('costs no more for a dense box than the same query unbounded', async () => {
    // A ratio rather than a millisecond count, for the reason at the top. If
    // the box filter were doing something pathological — a per-row subquery,
    // a sort over the whole table — this is where it would show, because the
    // unbounded query does strictly more work and should never be faster.
    const bounded = await get(`/api/catalog/search?bbox=${VALLEY}&limit=50`)
    const unbounded = await get('/api/catalog/search?limit=50')
    expect(bounded.ms).toBeLessThan(Math.max(unbounded.ms * 4, 250))
  })
})
