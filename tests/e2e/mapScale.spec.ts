import { expect, test, type Page } from '@playwright/test'
import { serveBootstrap, serveHere, stubGeolocation, stubMapsSdk, THAMEL } from './mapStub'

/**
 * #39 — the map at catalogue scale.
 *
 * The target is 10,000 listings on a mid-range Android, which is the device
 * most of Nepal is actually using. The architecture that would fail first is
 * one marker per listing: fine at fifty, unusable at five thousand, and with
 * a lower ceiling than it looks because WaahTickets' pins were rich HTML
 * elements rather than sprites.
 *
 * What is settled here is the *marker count* and the *request count*, which
 * are the two numbers that decide whether that happens. Frame rate on a real
 * Android over throttled 3G is the manual line in the test plan and stays
 * there — nothing in a headless Chromium on a developer's laptop can honestly
 * claim to have measured it.
 */

/** One dense area, so a single viewport genuinely holds thousands. */
const DENSE = Array.from({ length: 4_000 }, (_, i) => ({
  id: `dense-${i}`,
  slug: `dense-${i}`,
  title: `Dense ${i}`,
  summary: null,
  listing_type: 'free',
  source: 'import',
  starts_at: '2027-03-14T13:15:00.000Z',
  ends_at: null,
  is_all_day: false,
  timezone: 'Asia/Kathmandu',
  cover_image_url: null,
  external_url: null,
  is_featured: false,
  map_popup_config: null,
  // Spread across the valley, each at its own venue — the worst case for
  // grouping, because nothing collapses.
  latitude: 27.65 + (i % 80) * 0.0015,
  longitude: 85.26 + Math.floor(i / 80) * 0.0015,
  pin: { icon: 'Music', color: '#e91e63', category: 'concerts' },
  cover: null,
  venue: { id: `v${i}`, slug: `v${i}`, name: `Venue ${i}`, area: 'Thamel', city: 'Kathmandu' },
  organizer: null,
  categories: [{ slug: 'concerts', name: 'Concerts', color: '#e91e63', icon: 'Music', is_primary: true }],
  offer: null,
}))

async function openDenseMap(page: Page) {
  const requested: string[] = []
  await page.route('**/api/catalog/search*', (route) => {
    const url = new URL(route.request().url())
    requested.push(url.searchParams.get('bbox') ?? '')
    const cursor = Number(url.searchParams.get('cursor') ?? '0')
    const data = DENSE.slice(cursor, cursor + 50)
    const next = cursor + 50
    return route.fulfill({
      json: {
        data,
        page: { limit: 50, has_more: next < DENSE.length, next_cursor: String(next) },
      },
    })
  })

  await stubMapsSdk(page)
  await stubGeolocation(page, 'denied')
  await serveHere(page, { city: 'Kathmandu', lat: THAMEL.lat, lng: THAMEL.lng, source: 'ip' })
  await serveBootstrap(page)
  await page.goto('/map')
  return { requested: () => requested }
}

const evaluate = (page: Page, expression: string) => page.evaluate(expression)

test('a dense viewport draws bubbles, not thousands of pins', async ({ page }) => {
  await openDenseMap(page)
  await expect(page.getByText(/zoom in to see places/)).toBeVisible()

  // The claim the whole feature rests on: the marker count is bounded by the
  // screen, not by the catalogue. 200 listings arrive (four pages of fifty)
  // at 200 distinct venues, and the map draws a grid's worth of bubbles.
  const markers = await evaluate(page, 'window.google.maps.__markerCount()') as number
  expect(markers).toBeGreaterThan(0)
  expect(markers).toBeLessThanOrEqual(144)
})

test('the first pins are drawn before the last page has landed', async ({ page }) => {
  let released: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { released = resolve })

  await stubMapsSdk(page)
  await stubGeolocation(page, 'denied')
  await serveHere(page, { city: 'Kathmandu', lat: THAMEL.lat, lng: THAMEL.lng, source: 'ip' })
  await serveBootstrap(page)
  await page.route('**/api/catalog/search*', async (route) => {
    const cursor = Number(new URL(route.request().url()).searchParams.get('cursor') ?? '0')
    // Every page after the first waits until the test lets it through.
    if (cursor > 0) await gate
    return route.fulfill({
      json: {
        data: DENSE.slice(cursor, cursor + 50),
        page: { limit: 50, has_more: true, next_cursor: String(cursor + 50) },
      },
    })
  })
  await page.goto('/map')

  // Progressive rendering (#39): the first fifty are on the map while the next
  // fifty are still in flight. Collecting all four pages and setting state once
  // made time-to-first-pin the sum of every request the map was going to make.
  // The status leads with the running count rather than a bare "loading",
  // because the map already works.
  await expect(page.getByText(/50 listings so far/)).toBeVisible()
  expect(await evaluate(page, 'window.google.maps.__markerCount()')).toBeGreaterThan(0)

  released!()
  await expect(page.getByText(/zoom in to see places/)).toBeVisible()
})

test('a burst of gestures costs one request, not one per pause', async ({ page }) => {
  const catalog = await openDenseMap(page)
  await expect(page.getByText(/zoom in to see places/)).toBeVisible()
  const before = catalog.requested().length

  // Four flicks in immediate succession — a real pan gesture settles several
  // times, and each settling is a box `needsFetch` would honestly say needs
  // fetching.
  await evaluate(page, 'window.google.maps.__flurry(4)')
  await page.waitForTimeout(700)

  // One box's worth of paging, not four.
  const boxes = new Set(catalog.requested().slice(before))
  expect(boxes.size).toBe(1)
})

test('panning away does not leave the markers behind', async ({ page }) => {
  await openDenseMap(page)
  await expect(page.getByText(/zoom in to see places/)).toBeVisible()
  const dense = await evaluate(page, 'window.google.maps.__markerCount()') as number

  // Somewhere with nothing in it. The pins stay *held* — that is what stops a
  // pan rebuilding the map — but they stop being drawn, which is the whole of
  // virtualisation.
  await evaluate(page, 'window.google.maps.__panTo(28.9, 80.2)')
  await page.waitForTimeout(700)

  const away = await evaluate(page, 'window.google.maps.__markerCount()') as number
  expect(away).toBeLessThan(dense)
})
