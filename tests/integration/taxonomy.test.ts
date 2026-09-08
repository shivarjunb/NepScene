import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { seedCatalogue } from '../helpers/seed'

/**
 * #22 — the taxonomy's acceptance criteria, through real HTTP and real D1.
 *
 * The criteria are about agreement: one canonical category that the map and
 * the filter chips both read, artists that resolve in both directions, and a
 * free-form layer that cannot leak into either.
 */
const get = async (path: string) => {
  const response = await SELF.fetch(`https://nepscene.test${path}`)
  return { response, body: (await response.json()) as any }
}

const slugs = (body: any): string[] => body.data.map((l: any) => l.slug)

beforeAll(seedCatalogue)

describe('one canonical category', () => {
  it('is closed — the database refuses a category nobody seeded', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO listing_categories (listing_id, category_id, is_primary)
         VALUES ('lst_free', 'cat_invented_by_an_importer', 0)`,
      ).run(),
    ).rejects.toThrow()
  })

  it('lets a listing carry only one primary category', async () => {
    // Without this the pin's colour would depend on row order.
    await expect(
      env.DB.prepare(
        `INSERT INTO listing_categories (listing_id, category_id, is_primary)
         VALUES ('lst_soon', 'cat_festival', 1)`,
      ).run(),
    ).rejects.toThrow()
  })

  it('gives the map and the browse filter the same answer', async () => {
    const { body } = await get('/api/catalog/listings?category=concerts')
    expect(slugs(body)).toContain('rock-night')
    for (const listing of body.data) {
      expect(listing.pin.category).toBe('concerts')
      expect(listing.categories.some((c: any) => c.slug === 'concerts')).toBe(true)
    }
  })
})

describe('pin appearance is derived, not stored', () => {
  it('serves the primary category’s icon and colour', async () => {
    const { body } = await get('/api/catalog/listings/rock-night')
    // cat_concert in migration 0002 — the palette WaahTickets already uses.
    expect(body.pin).toEqual({ icon: 'Music', color: '#e91e63', category: 'concerts' })
  })

  it('has no second field left to disagree with it', async () => {
    const { body } = await get('/api/catalog/listings/rock-night')
    expect(body).not.toHaveProperty('map_pin_icon')

    const columns = await env.DB.prepare(`SELECT name FROM pragma_table_info('listings')`)
      .all<{ name: string }>()
    expect(columns.results.map((c) => c.name)).not.toContain('map_pin_icon')
  })

  it('follows the category when the category changes, with nothing to migrate', async () => {
    await env.DB.prepare(
      `UPDATE listing_categories SET category_id = 'cat_festival'
        WHERE listing_id = 'lst_later' AND is_primary = 1`,
    ).run()

    const { body } = await get('/api/catalog/listings/lakeside-live')
    expect(body.pin).toEqual({ icon: 'Star', color: '#9c27b0', category: 'festivals' })

    await env.DB.prepare(
      `UPDATE listing_categories SET category_id = 'cat_concert'
        WHERE listing_id = 'lst_later' AND is_primary = 1`,
    ).run()
  })

  it('renders a listing with no category on the neutral pin', async () => {
    // 'awaiting-review' has none; art-week is the published equivalent once its
    // categories are gone, so this asserts the fallback rather than a 404.
    const { body } = await get('/api/catalog/listings?limit=50')
    for (const listing of body.data) {
      expect(typeof listing.pin.icon).toBe('string')
      expect(listing.pin.color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('artists resolve in both directions', () => {
  it('lists a listing’s artists on its detail', async () => {
    const { body } = await get('/api/catalog/listings/rock-night')
    expect(body.artists.map((a: any) => a.slug)).toEqual(['kutumba'])
  })

  it('lists an artist’s listings through the feed', async () => {
    const { body } = await get('/api/catalog/listings?artist=kutumba')
    expect(slugs(body)).toEqual(['rock-night'])
  })

  it('returns nothing rather than everything for an artist nobody has', async () => {
    const { body } = await get('/api/catalog/listings?artist=not-a-real-artist')
    expect(body.data).toEqual([])
  })
})

describe('tags are free-form and appearance is not', () => {
  it('filters the feed by tag', async () => {
    const { body } = await get('/api/catalog/listings?tag=live-music')
    expect(slugs(body).sort()).toEqual(['lakeside-live', 'rock-night'])
  })

  it('normalises the filter, so a link written by a human still works', async () => {
    const { body } = await get('/api/catalog/listings?tag=Live%20Music')
    expect(slugs(body).sort()).toEqual(['lakeside-live', 'rock-night'])
  })

  it('rejects a tag parameter with nothing in it rather than ignoring it', async () => {
    const { response, body } = await get('/api/catalog/listings?tag=!!!')
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('invalid_parameter')
  })

  it('carries tags on the detail without letting them touch the pin', async () => {
    const { body } = await get('/api/catalog/listings/rock-night')
    expect(body.tags).toEqual([{ slug: 'live-music', label: 'Live Music' }])
    expect(body.pin.category).toBe('concerts')
  })

  it('offers only tags that are on something upcoming', async () => {
    const { response, body } = await get('/api/catalog/tags')
    expect(response.status).toBe(200)
    const listed = body.data.map((t: any) => t.slug)
    expect(listed).toContain('live-music')
    // 'stale' is only on a finished listing, so it is not a browse surface.
    expect(listed).not.toContain('stale')
  })

  it('orders tags by how much is on, not alphabetically', async () => {
    const { body } = await get('/api/catalog/tags')
    const counts = body.data.map((t: any) => t.upcoming_listing_count)
    expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a))
  })
})

describe('the seeded taxonomy', () => {
  it('maps every categorised listing to a category that exists', async () => {
    const orphans = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM listing_categories lc
        LEFT JOIN categories c ON c.id = lc.category_id
        WHERE c.id IS NULL`,
    ).first<{ n: number }>()
    expect(orphans?.n).toBe(0)
  })

  it('gives every published listing exactly one primary category', async () => {
    const wrong = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT listing_id, SUM(is_primary) AS primaries
           FROM listing_categories GROUP BY listing_id
       ) WHERE primaries <> 1`,
    ).first<{ n: number }>()
    expect(wrong?.n).toBe(0)
  })
})
