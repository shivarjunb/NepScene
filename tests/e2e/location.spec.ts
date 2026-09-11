import { expect, test, type Page } from '@playwright/test'
import {
  POKHARA, serveBootstrap, serveHere, serveMapCatalog, stubGeolocation, stubMapsSdk, THAMEL,
} from './mapStub'

/**
 * #38's integration and end-to-end criteria: "simulate permission granted,
 * denied and timed out, and assert each fallback", and "deny location and
 * confirm the map still renders usefully".
 *
 * The failure mode all of these guard is the one WaahTickets shipped: a
 * staged resolution where the middle stage was dead — `http://ip-api.com`
 * from an HTTPS page — and where `watchPosition` had no `timeout`, so an
 * unanswered permission prompt hung the stage that was supposed to rescue it.
 * Every case below ends with a map showing a real city.
 */

const POKHARA_HERE = { city: 'Pokhara', lat: POKHARA.lat, lng: POKHARA.lng, source: 'ip' as const }

async function open(page: Page, options: {
  geolocation: 'granted' | 'denied' | 'timeout' | 'missing'
  here?: { city: string; city_ne?: string; lat: number; lng: number; source: 'ip' | 'default' } | null
  at?: { lat: number; lng: number }
}) {
  await stubMapsSdk(page)
  await stubGeolocation(page, options.geolocation, options.at)
  await serveHere(page, options.here === undefined ? POKHARA_HERE : options.here)
  await serveBootstrap(page)
  const catalog = await serveMapCatalog(page)
  await page.goto('/')
  return catalog
}

test('the IP stage names the city and moves the map, with no location permission asked for', async ({ page }) => {
  await open(page, { geolocation: 'denied' })

  // Nothing was asked of the browser: the headline is the IP's answer.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/around Pokhara/)

  const centre = await page.evaluate('window.google.maps.__centre()') as { lat: number }
  expect(centre.lat).toBeCloseTo(POKHARA.lat, 1)
})

test('granting permission recentres the map and offers distance filtering', async ({ page }) => {
  await open(page, { geolocation: 'granted', at: THAMEL })

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/around Pokhara/)
  // No chips until there is a position precise enough for them to mean
  // anything — a geo-IP centroid is accurate to a district.
  await expect(page.getByRole('group', { name: /distance/i })).toHaveCount(0)

  await page.getByRole('button', { name: 'Near me' }).click()

  await expect(page.getByRole('button', { name: 'Centred on you' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/around Kathmandu/)
  await expect(page.getByRole('group', { name: /distance/i })).toBeVisible()

  const centre = await page.evaluate('window.google.maps.__centre()') as { lat: number }
  expect(centre.lat).toBeCloseTo(THAMEL.lat, 1)
})

test('denying permission says what changed, and leaves a working map', async ({ page }) => {
  await open(page, { geolocation: 'denied' })

  await page.getByRole('button', { name: 'Near me' }).click()

  // Not an error, and not a dead end: the city it fell back to is named, and
  // the way to get filtering back is stated.
  const notice = page.locator('.nepal-map__denied')
  await expect(notice).toContainText('Pokhara')
  await expect(notice).toContainText(/turn it on/i)

  // The criterion: the map is still useful. Listings are on it.
  await expect(page.getByText(/listings? in view/)).toBeVisible()
  // And no distance chips, because there is no position to measure from.
  await expect(page.getByRole('group', { name: /distance/i })).toHaveCount(0)
})

test('an unanswered permission prompt does not hang the map', async ({ page }) => {
  await open(page, { geolocation: 'timeout' });

  // The IP stage runs alongside the browser stage rather than behind it, so
  // the headline is right immediately — no six-second wait for a prompt
  // nobody is going to answer.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/around Pokhara/)
  await expect(page.getByText(/listings? in view/)).toBeVisible()

  await page.getByRole('button', { name: 'Near me' }).click()
  await expect(page.getByRole('button', { name: /finding you/i })).toBeVisible()

  // Still usable while the prompt sits there unanswered.
  await expect(page.getByText(/listings? in view/)).toBeVisible()
})

test('a browser with no geolocation at all falls back rather than throwing', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await open(page, { geolocation: 'missing' })
  await page.getByRole('button', { name: 'Near me' }).click()

  await expect(page.locator('.nepal-map__denied')).toBeVisible()
  expect(errors).toEqual([])
})

test('a failed IP lookup leaves the default city and never blocks the map', async ({ page }) => {
  await open(page, { geolocation: 'denied', here: null })

  // The whole chain failed, and the result is still a map of Kathmandu with
  // listings on it — never a spinner, an error card, or an empty page.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/around Kathmandu/)
  await expect(page.getByText(/listings? in view/)).toBeVisible()
})

test('a distance chip filters the listings and says so', async ({ page }) => {
  await open(page, { geolocation: 'granted', at: THAMEL })
  await page.getByRole('button', { name: 'Near me' }).click()

  const chips = page.getByRole('group', { name: /distance/i })
  await expect(chips).toBeVisible()

  // Art Week is 4.4km from Purple Haze, so a 2km circle around Purple Haze
  // excludes it and keeps the two listings at Purple Haze itself.
  await chips.getByRole('button', { name: '2 km' }).click()
  await expect(page.getByText(/2 listings within 2 km/)).toBeVisible()

  // 5km reaches it. The chips are nested, so widening never loses a listing.
  await chips.getByRole('button', { name: '5 km' }).click()
  await expect(page.getByText(/3 listings within 5 km/)).toBeVisible()

  // Pressing the active chip again clears it, as every chip row in the app does.
  await chips.getByRole('button', { name: '5 km' }).click()
  await expect(page.getByText(/3 listings in view/)).toBeVisible()
})

test('the map draws before location resolution has finished', async ({ page }) => {
  await stubMapsSdk(page)
  await stubGeolocation(page, 'timeout')
  // The IP endpoint never answers either: both stages are outstanding.
  await page.route('**/api/catalog/here', () => { /* hangs */ })
  await serveBootstrap(page)
  await serveMapCatalog(page)

  await page.goto('/')

  // "Location resolution never blocks the map from rendering."
  await expect(page.locator('.nepal-map__canvas')).toBeVisible()
  await expect(page.getByText(/listings? in view/)).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/around Kathmandu/)
})

test('reduced motion suppresses the headline reveal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page, { geolocation: 'denied' })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/around Pokhara/)

  const animation = await page.locator('.hero__title-reveal').evaluate(
    (el) => getComputedStyle(el).animationName)
  expect(animation).toBe('none')
})
