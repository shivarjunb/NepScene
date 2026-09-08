import { expect, test, type Page } from '@playwright/test'

/**
 * #41 — the discovery feed.
 *
 * The Playwright server is `vite preview`, which serves the built SPA and no
 * Worker, so the catalogue is stubbed at the network boundary. That is not a
 * compromise here: it is the only way to drive the cases the acceptance
 * criteria actually name — an empty catalogue, a row whose rule matches
 * nothing, and a catalogue that fails to load — none of which the seed can
 * produce on demand.
 *
 * The clock is frozen to Monday 7 September 2026 so "this weekend" is a fixed
 * pair of days (Friday the 11th, Saturday the 12th) rather than whatever it
 * happens to be on the day CI runs.
 */

const MONDAY = new Date('2026-09-07T06:00:00Z')

const category = (slug: string, name: string, count: number) =>
  ({ slug, name, name_ne: null, color: '#c1121f', icon: null, upcoming_listing_count: count })

const listing = (over: Record<string, unknown> & { id: string; starts_at: string }) => ({
  slug: over.id,
  title: over.id,
  summary: null,
  listing_type: 'ticketed_internal',
  source: 'organizer',
  ends_at: null,
  is_all_day: false,
  timezone: 'Asia/Kathmandu',
  cover_image_url: null,
  external_url: null,
  is_featured: false,
  latitude: null,
  longitude: null,
  map_pin_icon: null,
  venue: { id: 'v', slug: 'v', name: 'Purple Haze', area: 'Thamel', city: 'Kathmandu' },
  organizer: null,
  categories: [{ slug: 'concerts', name: 'Concerts', color: '#c1121f', icon: null }],
  offer: null,
  ...over,
})

const FULL = {
  categories: [category('concerts', 'Concerts', 4), category('film', 'Film', 1),
               category('markets', 'Markets', 0)],
  featured: [listing({ id: 'featured-one', starts_at: '2026-09-25T13:00:00Z', is_featured: true })],
  upcoming: [
    listing({ id: 'friday-gig', starts_at: '2026-09-11T13:00:00Z',
              offer: { purchasable: true, price_from: 80000, currency: 'NPR',
                       url: null, provider: 'waahtickets', sold_out: false, checked_at: null } }),
    listing({ id: 'saturday-market', starts_at: '2026-09-12T04:00:00Z', listing_type: 'free' }),
    listing({ id: 'next-week', starts_at: '2026-09-22T13:00:00Z' }),
    listing({ id: 'pokhara-film', starts_at: '2026-09-23T13:00:00Z',
              venue: { id: 'p', slug: 'p', name: 'Lakeside', area: null, city: 'Pokhara' },
              categories: [{ slug: 'film', name: 'Film', color: '#1121c1', icon: null }] }),
  ],
}

const EMPTY = { categories: [], featured: [], upcoming: [] }

async function serveCatalogue(page: Page, bootstrap: unknown) {
  await page.clock.install({ time: MONDAY })
  await page.route('**/api/catalog/bootstrap', (route) =>
    route.fulfill({ json: bootstrap }))
  await page.route('**/api/catalog/listings*', (route) => {
    const url = new URL(route.request().url())
    const wanted = url.searchParams.get('category')
    const data = (bootstrap as typeof FULL).upcoming.filter((entry) =>
      !wanted || entry.categories.some((c: { slug: string }) => c.slug === wanted))
    return route.fulfill({ json: { data, page: { limit: 50, has_more: false, next_cursor: null } } })
  })
}

test('the homepage renders the hero and four populated rows', async ({ page }) => {
  await serveCatalogue(page, FULL)
  await page.goto('/')

  await expect(page.getByRole('heading', { level: 1, name: /What.s happening around Nepal/ }))
    .toBeVisible()

  for (const row of ['Featured', 'This weekend', 'In Kathmandu', 'Free entry', 'Concerts']) {
    await expect(page.getByRole('heading', { level: 2, name: row, exact: true })).toBeVisible()
  }

  // Populated, not merely present.
  const rails = page.locator('.rail__track')
  expect(await rails.count()).toBeGreaterThanOrEqual(4)
})

test('rows select by rule — the weekend row holds only Friday and Saturday', async ({ page }) => {
  await serveCatalogue(page, FULL)
  await page.goto('/')

  const weekend = page.locator('section.rail').filter({
    has: page.getByRole('heading', { name: 'This weekend', exact: true }),
  })
  await expect(weekend.getByRole('article')).toHaveCount(2)
  await expect(weekend.getByText('friday-gig')).toBeVisible()
  await expect(weekend.getByText('next-week')).toBeHidden()
})

test('a category entry point filters, and the filter is in the URL', async ({ page }) => {
  await serveCatalogue(page, FULL)
  await page.goto('/')

  await page.getByRole('navigation', { name: 'Browse by category' })
    .getByRole('link', { name: /Film/ }).click()

  await expect(page).toHaveURL(/\?category=film$/)
  await expect(page.getByRole('heading', { level: 2, name: 'Film' })).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(1)
  await expect(page.getByText('pokhara-film')).toBeVisible()
})

test('a filtered page survives being reloaded, because it is a real URL', async ({ page }) => {
  await serveCatalogue(page, FULL)
  await page.goto('/?category=film')

  await expect(page.getByRole('heading', { level: 2, name: 'Film' })).toBeVisible()
  await expect(page.getByText('pokhara-film')).toBeVisible()
})

test('a card links to its listing', async ({ page }) => {
  await serveCatalogue(page, FULL)
  await page.goto('/')

  const card = page.getByRole('article').filter({ hasText: 'friday-gig' }).first()
  await expect(card.getByRole('link')).toHaveAttribute('href', '/listings/friday-gig')
})

test('an offer is rendered, never computed', async ({ page }) => {
  await serveCatalogue(page, FULL)
  await page.goto('/')

  // 80000 paisa arrives as a snapshot; the only arithmetic is paisa to rupees.
  await expect(page.getByText('From NPR 800').first()).toBeVisible()
  await expect(page.getByText('Free').first()).toBeVisible()
})

test('an empty catalogue says so instead of showing empty furniture', async ({ page }) => {
  await serveCatalogue(page, EMPTY)
  await page.goto('/')

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByText('Nothing on yet')).toBeVisible()
})

test('a row whose rule matches nothing keeps its place', async ({ page }) => {
  // Nothing at the weekend, but plenty later: the row must stay and explain.
  await serveCatalogue(page, {
    ...FULL,
    upcoming: [listing({ id: 'far-off', starts_at: '2026-10-20T13:00:00Z' })],
  })
  await page.goto('/')

  const weekend = page.locator('section.rail').filter({
    has: page.getByRole('heading', { name: 'This weekend', exact: true }),
  })
  await expect(weekend).toBeVisible()
  await expect(weekend.getByText(/Nothing on this Friday or Saturday/)).toBeVisible()
})

test('a catalogue that fails to load says so rather than showing a blank page', async ({ page }) => {
  await page.clock.install({ time: MONDAY })
  await page.route('**/api/catalog/bootstrap', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'D1 is unavailable' } } }))
  await page.goto('/')

  await expect(page.getByRole('alert')).toContainText('The catalogue did not load')
})

test('the feed is usable at 320px with no horizontal scroll', async ({ page }) => {
  await serveCatalogue(page, FULL)
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/')
  await expect(page.getByRole('article').first()).toBeVisible()

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
})

test('nothing shifts when the feed arrives', async ({ page }) => {
  await page.clock.install({ time: MONDAY })
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/catalog/bootstrap', async (route) => {
    await held
    await route.fulfill({ json: FULL })
  })

  await page.goto('/')
  // The skeletons are the real cards' dimensions, so the hero must not move
  // when the data lands.
  const before = await page.locator('.hero').boundingBox()
  release()
  await expect(page.getByRole('article').first()).toBeVisible()
  const after = await page.locator('.hero').boundingBox()

  expect(after!.y).toBe(before!.y)
  expect(after!.height).toBe(before!.height)
})
