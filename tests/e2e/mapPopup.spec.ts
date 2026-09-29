import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  KATHMANDU_LISTINGS, listing, PURPLE_HAZE_PIN, serveMapCatalog, stubMapsSdk, venue,
} from './mapStub'

/**
 * The popup and the pins, as a phone sees them.
 *
 * Two bugs reached staging that every spec in `map.spec.ts` passed through,
 * because they asserted the popup was *there* and never that it could be
 * *read*:
 *
 *  - The card inherited the homepage hero's light-on-dark text, so its title
 *    and values were white on a white card — "WHERE" and "WHEN" with nothing
 *    after them.
 *  - It was anchored above the pin, inside a short `overflow: hidden` map, so
 *    a pin in the top half put the card's head past the map's edge.
 *
 * And the pins themselves piled on top of each other at city zoom on a narrow
 * screen, which is the congestion the overlap clustering answers.
 */

const PHONE = { width: 390, height: 844 }

const gesture = (page: Page, expression: string) => page.evaluate(expression)

/** WCAG contrast of an element's text against the nearest opaque background. */
async function contrastOf(locator: Locator) {
  return locator.evaluate((element) => {
    const parse = (value: string) => {
      const [r, g, b, a = 1] = (value.match(/[\d.]+/g) ?? []).map(Number)
      return { r: r!, g: g!, b: b!, a }
    }
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const channel = (c: number) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    let ground: Element | null = element
    let background = parse(getComputedStyle(element).backgroundColor)
    while (ground && background.a < 1) {
      ground = ground.parentElement
      if (ground) background = parse(getComputedStyle(ground).backgroundColor)
    }
    const text = luminance(parse(getComputedStyle(element).color))
    const back = luminance(background)
    return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05)
  })
}

/**
 * The popup sits wholly inside the map, at its top: across it on a phone,
 * leaving the lower part for the place it is about, and down the right-hand
 * side where there is room, leaving the left.
 */
async function expectAtTopOfMap(page: Page) {
  const map = (await page.locator('.nepal-map').boundingBox())!
  const popup = (await page.locator('.nepal-map__popup').boundingBox())!

  expect(popup.x).toBeGreaterThanOrEqual(map.x)
  expect(popup.y).toBeGreaterThanOrEqual(map.y)
  expect(popup.x + popup.width).toBeLessThanOrEqual(map.x + map.width + 0.5)
  expect(popup.y + popup.height).toBeLessThanOrEqual(map.y + map.height + 0.5)
  expect(popup.y - map.y).toBeLessThan(20)

  const wide = (page.viewportSize()?.width ?? 0) >= 768
  if (wide) {
    expect((map.x + map.width) - (popup.x + popup.width)).toBeLessThan(20)
    expect(popup.width).toBeLessThan(map.width * 0.6)
  } else {
    expect(Math.abs((popup.x + popup.width / 2) - (map.x + map.width / 2))).toBeLessThan(2)
    // Room is left below it for the pin the map moves there.
    expect(popup.y + popup.height).toBeLessThan(map.y + map.height * 0.75)
  }
}

async function openHero(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize(PHONE)
  await stubMapsSdk(page)
  await serveMapCatalog(page)
  // The homepage renders its hero only once the feed has something in it.
  await page.route('**/api/catalog/bootstrap', (route) => route.fulfill({
    json: { categories: [], featured: [], upcoming: KATHMANDU_LISTINGS },
  }))
  await page.goto('/')
  await expect(page.locator('.hero .nepal-map')).toBeVisible()
  await expect(page.getByText(/3 listings in view/)).toBeVisible()
}

test.describe('the popup in the homepage hero, on a phone', () => {
  test('opens across the top of the map, not clipped by its edge', async ({ page }) => {
    await openHero(page)
    await gesture(page, "window.google.maps.__clickMarker('Art Week')")
    await expect(page.locator('.nepal-map__popup')).toBeVisible()

    await expectAtTopOfMap(page)
    // The whole card is reachable, the action at its foot included.
    await expect(page.getByRole('button', { name: /see the listing/i })).toBeInViewport()
  })

  test('has readable text, not the hero’s white on a white card', async ({ page }) => {
    await openHero(page)
    await gesture(page, "window.google.maps.__clickMarker('Art Week')")

    const popup = page.locator('.nepal-map__popup')
    const title = popup.getByRole('heading', { name: 'Art Week' })
    const venueLine = popup.getByText('Patan Durbar Square, Mangal Bazaar')
    await expect(title).toBeVisible()
    await expect(venueLine).toBeVisible()

    expect(await contrastOf(title)).toBeGreaterThanOrEqual(4.5)
    expect(await contrastOf(venueLine)).toBeGreaterThanOrEqual(4.5)
  })

  test('a venue stack fits too, and its rows are readable', async ({ page }) => {
    await openHero(page)
    await gesture(page, `window.google.maps.__clickMarker(${JSON.stringify(PURPLE_HAZE_PIN)})`)
    await expect(page.locator('.venue-stack')).toBeVisible()

    await expectAtTopOfMap(page)
    const title = page.locator('.venue-stack__title')
    expect(await contrastOf(title)).toBeGreaterThanOrEqual(4.5)
    expect(await contrastOf(page.locator('.venue-stack__name').first())).toBeGreaterThanOrEqual(4.5)
  })

  test('tapping the map around the card closes it', async ({ page }) => {
    await openHero(page)
    await gesture(page, "window.google.maps.__clickMarker('Art Week')")
    await expect(page.locator('.nepal-map__popup')).toBeVisible()

    // A corner of the map: outside the card, and over the controls, which the
    // scrim sits above so that the tap means "close" and not "full screen".
    const map = (await page.locator('.nepal-map').boundingBox())!
    await page.mouse.click(map.x + map.width - 8, map.y + 8)

    await expect(page.locator('.nepal-map__popup')).toHaveCount(0)
    await expect(page.locator('.nepal-map--fullscreen')).toHaveCount(0)
  })

  test('the card still leads to the listing', async ({ page }) => {
    await openHero(page)
    await gesture(page, "window.google.maps.__clickMarker('Art Week')")
    await page.getByRole('button', { name: /see the listing/i }).click()
    await expect(page).toHaveURL(/\/listings\/art-week$/)
  })
})

test.describe('the popup on /map', () => {
  for (const size of [{ width: 320, height: 568 }, { width: 1280, height: 800 }]) {
    test(`is at the top and whole at ${size.width}×${size.height}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.setViewportSize(size)
      await stubMapsSdk(page)
      await serveMapCatalog(page)
      await page.goto('/map')
      await expect(page.getByText(/3 listings in view/)).toBeVisible()

      await gesture(page, "window.google.maps.__clickMarker('Art Week')")
      await expect(page.locator('.nepal-map__popup')).toBeVisible()
      await expectAtTopOfMap(page)

      // A listing reached through the stack opens in the same place.
      await page.keyboard.press('Escape')
      await gesture(page, `window.google.maps.__clickMarker(${JSON.stringify(PURPLE_HAZE_PIN)})`)
      await page.locator('.venue-stack__row').first().click()
      await expect(page.locator('.pin-card')).toBeVisible()
      await expectAtTopOfMap(page)
    })
  }
})

/*
 * Congestion. Pins close enough to overlap on screen are one bubble; zooming
 * in pulls them apart; places no zoom can separate open as one stack.
 */

const CENTRE = { lat: 27.7172, lng: 85.324 }

/** Serves `data` for any viewport, and nothing else. */
async function serveListings(page: Page, data: unknown[]) {
  await page.route('**/api/catalog/search*', (route) => route.fulfill({
    json: { data, page: { limit: 50, has_more: false, next_cursor: null } },
  }))
}

const CAFE = venue('v_cafe', 'cafe', 'Corner Cafe', 'Jhamsikhel', 'Lalitpur')
const HALL = venue('v_hall', 'hall', 'Town Hall', 'Jhamsikhel', 'Lalitpur')
const FAR = venue('v_far', 'far', 'Far Field', 'Bhaktapur', 'Bhaktapur')

async function openCrowded(page: Page, apart: number) {
  await stubMapsSdk(page)
  await serveListings(page, [
    listing({ id: 'cafe-gig', title: 'Cafe Gig', venue: CAFE, latitude: CENTRE.lat, longitude: CENTRE.lng - apart / 2 }),
    listing({ id: 'hall-talk', title: 'Hall Talk', venue: HALL, latitude: CENTRE.lat, longitude: CENTRE.lng + apart / 2 }),
    listing({ id: 'far-fair', title: 'Far Fair', venue: FAR, latitude: CENTRE.lat + 0.06, longitude: CENTRE.lng + 0.06 }),
  ])
  await page.goto('/map')
  await expect(page.getByText(/3 listings in view/)).toBeVisible()
}

test('pins that would overlap on screen are drawn as one bubble', async ({ page }) => {
  // 40m apart, on a city-wide view: the same pixel, give or take.
  await openCrowded(page, 0.0004)

  const titles = await gesture(page, 'window.google.maps.__markerTitles()')
  expect(titles).toEqual(expect.arrayContaining(['2 listings in this area', 'Far Fair']))
  expect(titles).toHaveLength(2)
  // Merging overlaps is not the density fallback, and must not tell the
  // viewer to zoom in to see places they can already see.
  await expect(page.getByText(/zoom in to see places/)).toHaveCount(0)
})

test('tapping the bubble zooms to it, and zooming in pulls the pins apart', async ({ page }) => {
  await openCrowded(page, 0.0004)

  await gesture(page, "window.google.maps.__clickMarker('2 listings in this area')")
  const centre = await gesture(page, 'window.google.maps.__centre()') as { lat: number; lng: number }
  expect(centre.lat).toBeCloseTo(CENTRE.lat, 4)
  expect(centre.lng).toBeCloseTo(CENTRE.lng, 4)

  // The stub cannot zoom by itself, so the zoom the tap asked for is played
  // out here: a street-level span, in which 40m is most of the screen.
  await gesture(page, 'window.google.maps.__setSpan(0.001)')
  await expect.poll(() => gesture(page, 'window.google.maps.__markerTitles()'))
    .toEqual(expect.arrayContaining(['Cafe Gig', 'Hall Talk']))
})

test('places no zoom can separate open as one stack', async ({ page }) => {
  // Two venues geocoded to the very same point.
  await openCrowded(page, 0)

  await gesture(page, "window.google.maps.__clickMarker('2 listings in this area')")

  const stack = page.getByRole('dialog', { name: /Listings at this place/ })
  await expect(stack).toBeVisible()
  await expect(stack.locator('.venue-stack__row')).toHaveCount(2)
  await stack.locator('.venue-stack__row').filter({ hasText: 'Hall Talk' }).click()
  await page.getByRole('button', { name: /see the listing/i }).click()
  await expect(page).toHaveURL(/\/listings\/hall-talk$/)
})

test('pins far enough apart stay pins', async ({ page }) => {
  // 4km apart: never merged at a city view, even on a narrow phone.
  await page.setViewportSize({ width: 320, height: 640 })
  await openCrowded(page, 0.04)

  const titles = await gesture(page, 'window.google.maps.__markerTitles()')
  expect(titles).toEqual(expect.arrayContaining(['Cafe Gig', 'Hall Talk', 'Far Fair']))
})
