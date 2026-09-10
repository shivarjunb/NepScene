import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  serveBootstrap, serveHere, serveMapCatalog, stubGeolocation, stubMapsSdk, THAMEL,
} from './mapStub'

/**
 * #40 — the discovery surface without a map.
 *
 * The principle the whole feature rests on: a map is an inherently visual
 * interface and discovery is this product's entire function, so if pins are
 * the only way to find out what is on, a screen-reader user is excluded from
 * the point of NepScene. The answer is not a screen-reader-navigable canvas of
 * tiles — it is an equivalent list, and "equivalent" has to mean the same
 * filters and the same results rather than a reduced summary.
 */

/** Kathmandu, so the map opens on the region this spec's fixtures are in. */
const HERE = { city: 'Kathmandu', lat: THAMEL.lat, lng: THAMEL.lng, source: 'ip' as const }

async function openMap(page: Page, options: { maps?: boolean } = {}) {
  if (options.maps !== false) await stubMapsSdk(page)
  await stubGeolocation(page, 'granted', THAMEL)
  await serveHere(page, HERE)
  await serveBootstrap(page)
  await serveMapCatalog(page)
  await page.goto('/map')
  // The first `idle` has fired and the markers are drawn. Every spec below
  // acts on them, so waiting here rather than in each one keeps them honest
  // about what they are asserting.
  await expect(page.getByText(/listings? in view|map is not available/i)).toBeVisible()
}

test('the list shows the same listings the pins do', async ({ page }) => {
  await openMap(page)
  await expect(page.getByText(/3 listings in view/)).toBeVisible()

  await page.getByRole('button', { name: 'List', exact: true }).click()

  // The same three listings, grouped by the same two venues.
  const rows = page.locator('.map-list__row')
  await expect(rows).toHaveCount(3)
  await expect(page.getByRole('heading', { level: 3, name: /Purple Haze/ })).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: /Patan/ })).toBeVisible()
  for (const title of ['Rock Night', 'Late Set', 'Art Week']) {
    await expect(rows.filter({ hasText: title })).toHaveCount(1)
  }
})

test('the list obeys the same distance filter as the map', async ({ page }) => {
  await openMap(page)
  await page.getByRole('button', { name: 'Near me' }).click()
  await page.getByRole('button', { name: 'List', exact: true }).click()

  await expect(page.locator('.map-list__row')).toHaveCount(3)

  // Art Week is 4.4km from Purple Haze, so 2km drops it on the list exactly as
  // it drops it from the map.
  await page.getByRole('button', { name: '2 km' }).click()
  await expect(page.locator('.map-list__row')).toHaveCount(2)
  await expect(page.locator('.map-list__row').filter({ hasText: 'Art Week' })).toHaveCount(0)
  await expect(page.getByText(/2 listings within 2 km/)).toBeVisible()
})

test('a blocked Maps API leaves a working list, not a dead end', async ({ page }) => {
  // No SDK stub and no key: the Maps API never loads, which is what a blocked
  // script, an exhausted quota, or a keyless preview build all look like.
  await openMap(page, { maps: false })

  await expect(page.getByText(/map is not available/i)).toBeVisible()

  // The criterion: the list renders with an explanation and no broken layout.
  await expect(page.locator('.map-list__row')).toHaveCount(3)
  await expect(page.getByRole('heading', { level: 3, name: /Purple Haze/ })).toBeVisible()

  // And it still leads somewhere.
  await page.locator('.map-list__row').filter({ hasText: 'Rock Night' }).click()
  await expect(page).toHaveURL(/\/listings\/rock-night$/)

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the core discovery journey is completable by keyboard alone', async ({ page }) => {
  await openMap(page)
  await expect(page.getByText(/3 listings in view/)).toBeVisible()

  // Tab to the list toggle and switch surfaces without touching a pointer.
  const toggle = page.getByRole('button', { name: 'List', exact: true })
  await toggle.focus()
  await expect(toggle).toBeFocused()
  await page.keyboard.press('Enter')

  // Then tab to a listing and open it.
  const row = page.locator('.map-list__row').filter({ hasText: 'Art Week' })
  await row.focus()
  await expect(row).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(/\/listings\/art-week$/)
})

test('every map control is reachable and operable by keyboard', async ({ page }) => {
  await openMap(page)
  await page.getByRole('button', { name: 'Near me' }).click()
  await expect(page.getByRole('group', { name: /distance/i })).toBeVisible()

  // 'Near me' has become 'Centred on you' — the control reports its own state,
  // which is why it is named by what it says now rather than what it said.
  for (const name of ['List', 'Centred on you', 'Full screen', '2 km', '100 km']) {
    const control = page.getByRole('button', { name, exact: true })
    await control.focus()
    await expect(control).toBeFocused()
  }
})

test('focus is visible on every map control, in both themes', async ({ page }) => {
  await openMap(page)

  // Reached and activated by keyboard throughout. The ring is `:focus-visible`
  // rather than `:focus` — deliberately, so a mouse click leaves none — and
  // Chromium only applies it when the last interaction was a keyboard one. A
  // spec that clicked first would find no ring and would be right not to.
  await page.getByRole('button', { name: 'Near me' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('group', { name: /distance/i })).toBeVisible()

  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const name of ['List', 'Full screen', '2 km', '100 km']) {
      const control = page.getByRole('button', { name, exact: true })
      await control.focus()
      const ring = await control.evaluate((el) => {
        const style = getComputedStyle(el)
        return {
          visible: el.matches(':focus-visible'),
          width: style.outlineWidth,
          style: style.outlineStyle,
          // The halo that keeps the ring legible over map tiles, whose colour
          // is Google's rather than ours.
          halo: style.boxShadow,
        }
      })
      expect(ring.visible, `${name} in ${theme}`).toBe(true)
      expect(ring.style, `${name} in ${theme}`).not.toBe('none')
      expect(parseFloat(ring.width), `${name} in ${theme}`).toBeGreaterThan(0)
      expect(ring.halo, `${name} in ${theme}`).not.toBe('none')
    }
  }
})

test('a popup takes focus, announces itself, and gives focus back', async ({ page }) => {
  await openMap(page)
  const opener = page.getByRole('button', { name: 'Full screen' })
  await opener.focus()

  await page.evaluate("window.google.maps.__clickMarker('Art Week')")

  // A card that opens over the map and traps focus is a dialog, and saying so
  // is what makes a screen reader announce it rather than leaving it to be
  // discovered.
  const dialog = page.getByRole('dialog', { name: 'Art Week' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator(':focus')).toHaveCount(1)

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  // Back where they were, not at the top of the document.
  await expect(opener).toBeFocused()
})

test('a venue stack announces which place it is for', async ({ page }) => {
  await openMap(page)
  await page.evaluate("window.google.maps.__clickMarker('Purple Haze, Thamel — 2 listings')")

  await expect(page.getByRole('dialog', { name: /Listings at Purple Haze/ })).toBeVisible()
})

test('reduced motion suppresses the map animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openMap(page)

  await page.evaluate("window.google.maps.__clickMarker('Art Week')")
  const popup = page.locator('.nepal-map__popup')
  await expect(popup).toBeVisible()

  expect(await popup.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
})

test('the map page passes an axe scan, on the map and on the list', async ({ page }) => {
  await openMap(page)
  await expect(page.getByText(/3 listings in view/)).toBeVisible()

  const scan = () => new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  expect((await scan()).violations).toEqual([])

  await page.getByRole('button', { name: 'List', exact: true }).click()
  await expect(page.locator('.map-list__row').first()).toBeVisible()
  expect((await scan()).violations).toEqual([])
})

test('the fallback list passes an axe scan too', async ({ page }) => {
  await openMap(page, { maps: false })
  await expect(page.locator('.map-list__row').first()).toBeVisible()

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations).toEqual([])
})
