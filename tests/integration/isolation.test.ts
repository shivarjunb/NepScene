import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { seedCatalogue, UPCOMING_SLUGS } from '../helpers/seed'
import { bumpCatalogVersion } from '../../api/lib/cache'

/**
 * #47's unit criterion: "fixture isolation — a test's writes are invisible to
 * the next", and "tests run in isolation and in any order without shared
 * state".
 *
 * This is the test that keeps the harness honest about a promise nothing else
 * checks. Fifty-nine files share one D1, and a suite that passes only in the
 * order it happens to run in is a suite that fails on the day somebody adds a
 * file — with a failure pointing at the wrong test.
 *
 * The guarantee is not that writes are rolled back. It is that `seedCatalogue`
 * *truncates before it seeds*, so whatever a previous file left behind is gone
 * before this one looks. That is the weaker promise, and it is the one worth
 * stating out loud, because the stronger one is not true: a file that writes
 * and never re-seeds does leak into the next file that also does not seed.
 *
 * **D1 is not the only shared state.** Catalog reads are cached in the colo,
 * keyed on a version counter that only `bumpCatalogVersion` moves — so a test
 * that writes straight to `env.DB` and re-reads the same URL gets the *previous
 * test's* response, for up to a minute, with no error anywhere. Writing through
 * the API bumps the version as publishing does; writing behind it has to bump
 * the version itself. That is recorded here because it is invisible, it costs
 * an afternoon to rediscover, and every test in this file would pass without
 * it while proving nothing.
 */

const get = async (path: string) => {
  const response = await SELF.fetch(`https://nepscene.test${path}`)
  return { response, body: (await response.json()) as any }
}

describe('the seeded fixture is the same one every time', () => {
  it('starts from exactly the seeded catalogue', async () => {
    await seedCatalogue()
    await bumpCatalogVersion(env)
    const { body } = await get('/api/catalog/listings?limit=50')
    expect(body.data.map((l: any) => l.slug)).toEqual(UPCOMING_SLUGS)
  })

  it('does not see a row an earlier test wrote', async () => {
    await seedCatalogue()
    // The kind of thing an authoring test leaves behind.
    await env.DB.prepare(
      `INSERT INTO listings
         (id, slug, title, listing_type, source, status, starts_at,
          is_featured, published_at, created_at, updated_at)
       VALUES ('leak', 'leaked-listing', 'Leaked', 'free', 'organizer', 'published',
               ?1, 0, ?2, ?2, ?2)`,
    ).bind(new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString()).run()
    // Behind the API, so nothing invalidated the cache. Publishing through the
    // API would have done this; a direct write has to.
    await bumpCatalogVersion(env)

    const { body: dirty } = await get('/api/catalog/listings?limit=50')
    expect(dirty.data.map((l: any) => l.slug)).toContain('leaked-listing')

    // Re-seeding is what makes the next file's view clean, and this is the
    // assertion that it actually truncates rather than merely inserting.
    await seedCatalogue()
    await bumpCatalogVersion(env)
    const { body: clean } = await get('/api/catalog/listings?limit=50')
    expect(clean.data.map((l: any) => l.slug)).toEqual(UPCOMING_SLUGS)
  })

  it('is idempotent, so re-seeding twice is not an error', async () => {
    // A file that seeds in `beforeAll` and again in a `beforeEach` is doing
    // something reasonable, and the harness should not punish it with a
    // UNIQUE constraint failure.
    await seedCatalogue()
    await seedCatalogue()
    await bumpCatalogVersion(env)
    const { body } = await get('/api/catalog/listings?limit=50')
    expect(body.data.map((l: any) => l.slug)).toEqual(UPCOMING_SLUGS)
  })

  it('leaves the schema alone, however many times it runs', async () => {
    // `applyD1Migrations` runs once per worker in tests/setup.ts. A seed that
    // dropped and recreated a table instead of deleting from it would work
    // until a migration added a column.
    await seedCatalogue()
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('listings', 'venues', 'organizations')",
    ).all<{ name: string }>()
    expect(results.map((row) => row.name).sort()).toEqual(['listings', 'organizations', 'venues'])
  })
})
