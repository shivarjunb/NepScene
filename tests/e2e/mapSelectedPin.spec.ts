import { expect, test, type Page } from '@playwright/test'
import {
  KATHMANDU_LISTINGS, listing, POKHARA, PURPLE_HAZE_PIN, serveMapCatalog, stubMapsSdk, THAMEL,
  venue,
} from './mapStub'

/**
 * The marker whose card is open is picked out from the rest.
 *
 * The card opens across the top of the map, not above its pin, so on a busy
 * map nothing said which pin it belonged to. The tapped marker is now drawn
 * larger, ringed in the site's accent and above its neighbours, until the card
 * closes. Nothing is drawn under the stub, so these read what each marker was
 * told to look like (`__markerLook`); the drawing itself is unit-tested in
 * `tests/unit/selectedPin.test.ts`.
 */

/** `--accent` in each theme (tokens.css), which the selected ring is drawn in. */
const ACCENT = { light: '#7c3aed', dark: '#a78bfa' }
/** A resting pin's size, from pinMarker.ts. */
const PIN_SIZE = 40

type Look = { svg: string; size: number | null; zIndex: number | null }

const look = (page: Page, title: string) =>
  page.evaluate(`window.google.maps.__markerLook(${JSON.stringify(title)})`) as Promise<Look | null>

const tap = (page: Page, title: string) =>
  page.evaluate(`window.google.maps.__clickMarker(${JSON.stringify(title)})`)

const onTop = (page: Page) =>
  page.evaluate('window.google.maps.__topMarkers()') as Promise<string[]>

/** Larger than a resting marker, ringed in the accent, and alone on top. */
async function expectPickedOut(page: Page, title: string, accent = ACCENT.light) {
  await expect.poll(async () => (await look(page, title))?.svg ?? '').toContain(`stroke="${accent}"`)
  const now = (await look(page, title))!
  expect(now.size).toBeGreaterThan(PIN_SIZE)
  expect(await onTop(page)).toEqual([title])
}

/** Exactly as the map drew it before anything was tapped. */
async function expectAtRest(page: Page, title: string, before: Look) {
  await expect.poll(() => look(page, title)).toEqual(before)
  expect(before.svg).not.toContain(ACCENT.light)
  expect(before.svg).not.toContain(ACCENT.dark)
}

async function openMap(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await stubMapsSdk(page)
  await serveMapCatalog(page)
  await page.goto('/map')
  await expect(page.getByText(/3 listings in view/)).toBeVisible()
}

test('tapping a pin picks it out: larger, ringed in the accent, on top', async ({ page }) => {
  await openMap(page)
  const stackBefore = (await look(page, PURPLE_HAZE_PIN))!
  expect((await look(page, 'Art Week'))!.size).toBe(PIN_SIZE)

  await tap(page, 'Art Week')
  await expect(page.getByRole('dialog', { name: 'Art Week' })).toBeVisible()

  await expectPickedOut(page, 'Art Week')
  // Only the one: its neighbour is untouched.
  await expectAtRest(page, PURPLE_HAZE_PIN, stackBefore)
})

const CLOSES: [string, (page: Page) => Promise<unknown>][] = [
  ['its close button', (page) => page.locator('.nepal-map__popup-close').click()],
  ['Escape', (page) => page.keyboard.press('Escape')],
  ['a tap on the map beside it', async (page) => {
    // The left edge, halfway down: clear of the card, which takes the right
    // of a wide map and the top of a narrow one.
    const map = (await page.locator('.nepal-map').boundingBox())!
    await page.mouse.click(map.x + 8, map.y + map.height / 2)
  }],
]

for (const [how, close] of CLOSES) {
  test(`the pin goes back to rest when the card is closed with ${how}`, async ({ page }) => {
    await openMap(page)
    const before = (await look(page, 'Art Week'))!

    await tap(page, 'Art Week')
    await expectPickedOut(page, 'Art Week')

    await close(page)
    await expect(page.locator('.nepal-map__popup')).toHaveCount(0)
    await expectAtRest(page, 'Art Week', before)
  })
}

test('tapping another pin moves the pick to it', async ({ page }) => {
  await openMap(page)
  const artWeek = (await look(page, 'Art Week'))!
  const stack = (await look(page, PURPLE_HAZE_PIN))!

  await tap(page, 'Art Week')
  await expectPickedOut(page, 'Art Week')

  await tap(page, PURPLE_HAZE_PIN)
  await expect(page.locator('.venue-stack')).toBeVisible()
  await expectPickedOut(page, PURPLE_HAZE_PIN)
  await expectAtRest(page, 'Art Week', artWeek)

  // And back again, after closing in between.
  await page.keyboard.press('Escape')
  await expectAtRest(page, PURPLE_HAZE_PIN, stack)
  await tap(page, 'Art Week')
  await expectPickedOut(page, 'Art Week')
  await expectAtRest(page, PURPLE_HAZE_PIN, stack)
})

test('a stack stays picked out while one of its listings is read', async ({ page }) => {
  await openMap(page)
  await tap(page, PURPLE_HAZE_PIN)
  await expectPickedOut(page, PURPLE_HAZE_PIN)
  // Still the grouped pin, count and all, only larger.
  expect((await look(page, PURPLE_HAZE_PIN))!.svg).toContain('>2</text>')

  // The card now shows one listing, but it came from the stack's marker.
  await page.locator('.venue-stack__row').first().click()
  await expect(page.locator('.pin-card')).toBeVisible()
  await expectPickedOut(page, PURPLE_HAZE_PIN)
})

test('the dark theme rings it in the dark theme’s accent', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await openMap(page)

  await tap(page, 'Art Week')
  await expectPickedOut(page, 'Art Week', ACCENT.dark)
  expect((await look(page, 'Art Week'))!.svg).not.toContain(ACCENT.light)
})

test.describe('the pick survives the marker being redrawn under the open card', () => {
  test('when a pan finds the venue another listing, and its pin is redrawn', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await stubMapsSdk(page)
    // The first viewport is the fixture; every later one has a third listing
    // at Purple Haze, so its pin is torn down and drawn again saying 3.
    let requests = 0
    await page.route('**/api/catalog/search*', (route) => {
      requests += 1
      const data = requests === 1 ? KATHMANDU_LISTINGS : [
        ...KATHMANDU_LISTINGS,
        listing({
          id: 'encore', title: 'Encore', venue: KATHMANDU_LISTINGS[0]!.venue,
          latitude: THAMEL.lat, longitude: THAMEL.lng,
        }),
      ]
      return route.fulfill({ json: { data, page: { limit: 50, has_more: false, next_cursor: null } } })
    })
    await page.goto('/map')
    await expect(page.getByText(/3 listings in view/)).toBeVisible()

    await tap(page, PURPLE_HAZE_PIN)
    await expectPickedOut(page, PURPLE_HAZE_PIN)

    // Far enough to leave the padded box and fetch, near enough to keep
    // Purple Haze in view.
    await page.evaluate(`window.google.maps.__panTo(${THAMEL.lat + 0.06}, ${THAMEL.lng})`)
    const redrawn = 'Purple Haze, Thamel — 3 listings'
    await expect.poll(() => look(page, PURPLE_HAZE_PIN)).toBeNull()
    await expectPickedOut(page, redrawn)
    await expect(page.locator('.venue-stack')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect.poll(async () => (await look(page, redrawn))?.size).toBe(PIN_SIZE)
    expect((await look(page, redrawn))!.svg).not.toContain(ACCENT.light)
  })

  test('when the pin leaves the screen and comes back', async ({ page }) => {
    await openMap(page)
    const before = (await look(page, 'Art Week'))!
    await tap(page, 'Art Week')
    await expectPickedOut(page, 'Art Week')

    // Away to Pokhara, which takes Kathmandu's markers off the map, and back,
    // which draws them again as new markers — the card open throughout.
    await page.evaluate(`window.google.maps.__panTo(${POKHARA.lat}, ${POKHARA.lng})`)
    await expect.poll(() => look(page, 'Art Week')).toBeNull()
    await page.evaluate('window.google.maps.__panTo(27.7172, 85.324)')
    await expectPickedOut(page, 'Art Week')
    await expect(page.getByRole('dialog', { name: 'Art Week' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expectAtRest(page, 'Art Week', before)
  })
})

test.describe('bubbles', () => {
  const CENTRE = { lat: 27.7172, lng: 85.324 }
  const CAFE = venue('v_cafe', 'cafe', 'Corner Cafe', 'Jhamsikhel', 'Lalitpur')
  const HALL = venue('v_hall', 'hall', 'Town Hall', 'Jhamsikhel', 'Lalitpur')
  const BUBBLE = '2 listings in this area'

  async function openCrowded(page: Page, apart: number) {
    await stubMapsSdk(page)
    await page.route('**/api/catalog/search*', (route) => route.fulfill({
      json: {
        data: [
          listing({ id: 'cafe-gig', title: 'Cafe Gig', venue: CAFE, latitude: CENTRE.lat, longitude: CENTRE.lng - apart / 2 }),
          listing({ id: 'hall-talk', title: 'Hall Talk', venue: HALL, latitude: CENTRE.lat, longitude: CENTRE.lng + apart / 2 }),
        ],
        page: { limit: 50, has_more: false, next_cursor: null },
      },
    }))
    await page.goto('/map')
    await expect.poll(() => look(page, BUBBLE)).not.toBeNull()
  }

  test('one that zooms opens no card, and is not picked out', async ({ page }) => {
    await openCrowded(page, 0.0004)
    const before = (await look(page, BUBBLE))!

    await tap(page, BUBBLE)
    await expect(page.locator('.nepal-map__popup')).toHaveCount(0)
    // The stub cannot zoom, so the bubble is still there after the tap.
    expect(await look(page, BUBBLE)).toEqual(before)
  })

  test('one that opens a stack is picked out like a pin', async ({ page }) => {
    // Two venues at the very same point: no zoom pulls them apart.
    await openCrowded(page, 0)
    const before = (await look(page, BUBBLE))!

    await tap(page, BUBBLE)
    await expect(page.getByRole('dialog', { name: /Listings at this place/ })).toBeVisible()
    await expectPickedOut(page, BUBBLE)
    expect((await look(page, BUBBLE))!.size).toBeGreaterThan(before.size!)

    await page.keyboard.press('Escape')
    await expectAtRest(page, BUBBLE, before)
  })
})
