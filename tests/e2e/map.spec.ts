import { expect, test, type Page } from '@playwright/test'
import { POKHARA, PURPLE_HAZE_PIN, serveMapCatalog, stubMapsSdk } from './mapStub'

/**
 * #36's end-to-end criterion: "load the map, pan, zoom, open a popup, click
 * through to detail".
 *
 * What is settled here and nowhere else is that the pieces are wired to each
 * other — that `idle` reaches the fetch, the fetch reaches the markers, a
 * marker reaches the popup, and the popup reaches the router. Each piece on
 * its own is covered by a cheaper test; none of those can catch a map that
 * renders beautifully and never asks for anything.
 */

/**
 * Fires a gesture through the SDK stub's test handles. The SDK owns pans and
 * marker clicks, so there is no DOM to drive them from — the handles are the
 * seam, and this keeps every spec below reading as one line.
 */
const gesture = (page: Page, expression: string) => page.evaluate(expression)

async function openMap(page: Page) {
  await stubMapsSdk(page)
  const catalog = await serveMapCatalog(page)
  await page.goto('/map')
  await expect(page.getByRole('heading', { name: /on the map/i })).toBeVisible()
  // The first `idle` has fired and the first page of listings has landed.
  // Three listings, but two pins — Rock Night and Late Set share a venue.
  await expect(page.getByText(/3 listings in view/)).toBeVisible()
  return catalog
}

test('the map loads the listings for the viewport it opens on', async ({ page }) => {
  const catalog = await openMap(page)

  // Exactly one request, and it carried a bbox. The failure this catches is a
  // map that falls back to the unbounded feed when the viewport is unknown.
  expect(catalog.requested()).toHaveLength(1)
  expect(catalog.requested()[0]).toMatch(/^[\d.-]+,[\d.-]+,[\d.-]+,[\d.-]+$/)

  // Two markers for three listings: the shared venue is one pin (#37).
  const titles = await gesture(page, 'window.google.maps.__markerTitles()')
  expect(titles).toEqual(expect.arrayContaining([PURPLE_HAZE_PIN, 'Art Week']))
  expect(titles).toHaveLength(2)
})

test('a small pan inside the loaded area costs no request', async ({ page }) => {
  const catalog = await openMap(page)

  await gesture(page, 'window.google.maps.__nudge()')
  // Give a stray fetch time to be made, so this fails loudly rather than by
  // racing the assertion.
  await page.waitForTimeout(250)

  expect(catalog.requested()).toHaveLength(1)
})

test('panning somewhere else fetches that viewport, and only that one', async ({ page }) => {
  const catalog = await openMap(page)

  await gesture(page, `window.google.maps.__panTo(${POKHARA.lat}, ${POKHARA.lng})`)
  await expect(page.getByText(/1 listing in view/)).toBeVisible()

  expect(catalog.requested()).toHaveLength(2)
  // The second request is a different rectangle — not a refetch of everything.
  expect(catalog.requested()[1]).not.toBe(catalog.requested()[0])

  // The Kathmandu pins are still held: a pan adds to the map rather than
  // rebuilding it, which is what stops the flicker on every drag.
  const titles = await gesture(page, 'window.google.maps.__markerTitles()')
  expect(titles).toContain('Lakeside Live')
})

test('a lone pin opens a popup, and the popup leads to the listing', async ({ page }) => {
  await openMap(page)

  // Art Week is the only listing at Patan, so its pin opens the card directly
  // rather than a list of one.
  await gesture(page, "window.google.maps.__clickMarker('Art Week')")

  const popup = page.locator('.nepal-map__popup')
  await expect(popup).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Art Week' })).toBeVisible()
  // The author's default configuration: where, when, about.
  await expect(popup.getByText('Patan Durbar Square, Mangal Bazaar')).toBeVisible()

  await popup.getByRole('button', { name: /see the listing/i }).click()
  await expect(page).toHaveURL(/\/listings\/art-week$/)
})

/**
 * #37's end-to-end criterion: "click a grouped pin, confirm the picker, select
 * a listing, reach its page".
 */
test('a grouped pin opens the stack, and the stack leads to a listing', async ({ page }) => {
  await openMap(page)

  await gesture(page, `window.google.maps.__clickMarker(${JSON.stringify(PURPLE_HAZE_PIN)})`)

  const stack = page.locator('.venue-stack')
  await expect(stack).toBeVisible()
  await expect(stack.getByRole('heading', { name: 'Purple Haze, Thamel' })).toBeVisible()
  await expect(stack.getByText('2 listings')).toBeVisible()

  // Both listings are reachable. The thing this catches is the WaahTickets
  // behaviour: the primary opens and the rest are, in practice, not on the map.
  const rows = stack.getByRole('button').filter({ hasNotText: /^×$/ })
  await expect(rows).toHaveCount(2)
  // Soonest first, since neither is live or featured.
  await expect(rows.first()).toContainText('Rock Night')
  await expect(rows.nth(1)).toContainText('Late Set')

  await rows.nth(1).click()

  // Selecting a row replaces the stack with that listing's own card.
  await expect(stack).toHaveCount(0)
  const popup = page.locator('.nepal-map__popup')
  await expect(popup.getByRole('heading', { name: 'Late Set' })).toBeVisible()

  await popup.getByRole('button', { name: /see the listing/i }).click()
  await expect(page).toHaveURL(/\/listings\/late-set$/)
})

test('the stack carries a date chip on every row, so it can be scanned', async ({ page }) => {
  await openMap(page)

  await gesture(page, `window.google.maps.__clickMarker(${JSON.stringify(PURPLE_HAZE_PIN)})`)

  const chips = page.locator('.venue-stack__chip')
  await expect(chips).toHaveCount(2)
  await expect(chips.first()).toHaveText(/^\d+ [A-Z]{3}$/)
})

test('Escape closes the popup before it closes anything else', async ({ page }) => {
  await openMap(page)

  await gesture(page, "window.google.maps.__clickMarker('Art Week')")
  await expect(page.locator('.nepal-map__popup')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.locator('.nepal-map__popup')).toHaveCount(0)
})

test('full screen is a class on the page, not the browser’s own fullscreen', async ({ page }) => {
  await openMap(page)

  await page.getByRole('button', { name: 'Full screen' }).click()

  // The native API would put the map in the browser's fullscreen layer, where
  // a portalled modal renders behind it. The class keeps one stacking context.
  await expect(page.locator('.nepal-map--fullscreen')).toBeVisible()
  await expect(page.locator('body.map-is-fullscreen')).toHaveCount(1)
  expect(await page.evaluate('document.fullscreenElement')).toBeNull()

  await page.keyboard.press('Escape')
  await expect(page.locator('.nepal-map--fullscreen')).toHaveCount(0)
})

test('with no map key at all, the page says so and points somewhere useful', async ({ page }) => {
  // No SDK stub: this is a preview build with no key, which is a real and
  // supported state (docs/DEVOPS.md > Google Maps keys).
  await serveMapCatalog(page)
  await page.goto('/map')

  await expect(page.getByText(/map is not available/i)).toBeVisible()
  await expect(page.getByRole('link', { name: /listings feed/i })).toBeVisible()
})

test('nothing scrolls sideways at 320px, popup included', async ({ page }) => {
  await stubMapsSdk(page)
  await serveMapCatalog(page)
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/map')
  await expect(page.getByText(/3 listings in view/)).toBeVisible()

  // The popup is the thing most likely to push the page wide: it is absolutely
  // positioned at a pin, and a pin near the right edge puts it past the fold.
  // The stack is wider than the card, so it is the one to check.
  await gesture(page, `window.google.maps.__clickMarker(${JSON.stringify(PURPLE_HAZE_PIN)})`)
  await expect(page.locator('.venue-stack')).toBeVisible()

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
