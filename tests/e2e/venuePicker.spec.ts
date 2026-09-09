import { expect, test } from '@playwright/test'
import { pickVenue, serveAuthoring } from './authoringStub'

/**
 * #31 — the venue picker and the map.
 *
 * The acceptance criteria here are all interaction: *searching returns the
 * existing venue before offering to create one*, *a near-duplicate raises a
 * warning*, *coordinates can be set three ways and agree*. None of those can be
 * settled by a unit test, and the mapping underneath them is settled by one
 * (tests/unit/geocode.test.ts).
 *
 * Google's SDK is replaced by a stub installed before the app boots, so these
 * need no key and never leave the machine.
 */

/** Walk the two steps in front of Where. */
async function toWhere(page: import('@playwright/test').Page) {
  await page.getByLabel('Title').fill('Kutumba live')
  await page.getByRole('button', { name: 'Concerts' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Starts').fill('2027-03-14T18:45')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { name: 'Where' })).toBeVisible()
}

test('searching finds the venue that exists before offering to add one', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')
  await toWhere(page)

  await page.getByLabel('Venue', { exact: true }).fill('Patan')

  // The result is a real target, and the offer to create sits below it.
  const result = page.getByRole('button', { name: /Patan Durbar Square/ })
  await expect(result).toBeVisible()
  const create = page.getByRole('button', { name: /Add .* as a new venue/ })
  await expect(create).toBeVisible()

  const resultBox = await result.boundingBox()
  const createBox = await create.boundingBox()
  expect(resultBox!.y).toBeLessThan(createBox!.y)
})

test('a name that already exists exactly is not offered as a new venue', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')
  await toWhere(page)

  await page.getByLabel('Venue', { exact: true }).fill('Patan Durbar Square')

  await expect(page.getByText(/already in the catalogue/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Add .* as a new venue/ })).toHaveCount(0)
})

test('choosing a venue puts it on the listing and shows what was chosen', async ({ page }) => {
  const api = await serveAuthoring(page)
  await page.goto('/submit')
  await toWhere(page)

  await pickVenue(page, 'Purple Haze Rock Bar')

  await expect(page.getByText('Purple Haze Rock Bar')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change venue' })).toBeVisible()
  await expect.poll(() => api.store().venue_id).toBe('ven_purple')
})

test('a room is recorded on the listing, not as a venue of its own', async ({ page }) => {
  const api = await serveAuthoring(page)
  await page.goto('/submit')
  await toWhere(page)

  // The room box does not exist until a venue does: a room belongs to one.
  await expect(page.getByLabel(/Room, hall or stage/)).toHaveCount(0)

  await pickVenue(page, 'Patan Durbar Square')
  await page.getByLabel(/Room, hall or stage/).fill('Hall B')

  await expect.poll(() => api.store().venue_room).toBe('Hall B')
  // And no second venue was invented to hold it.
  expect(api.venues()).toHaveLength(0)
})

test('creating a venue that resembles an existing one is refused, with a way out', async ({ page }) => {
  const api = await serveAuthoring(page)
  await page.goto('/submit')
  await toWhere(page)

  await page.getByLabel('Venue', { exact: true }).fill('Purple Haze')
  await page.getByRole('button', { name: /Add .* as a new venue/ }).click()

  await expect(page.getByRole('heading', { name: 'Add a venue' })).toBeVisible()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Purple Haze')

  await page.getByRole('button', { name: 'Save this venue' }).click()

  // Refused, not created-and-warned: the duplicate never enters the catalogue.
  await expect(page.getByText(/looks like a venue already in the catalogue/i)).toBeVisible()
  await expect(page.getByText(/40 m away/)).toBeVisible()
  expect(api.venues()).toHaveLength(0)

  // And the way out is the one that fixes the catalogue rather than grows it.
  await page.getByRole('button', { name: 'Use this one' }).click()
  await expect(page.getByRole('button', { name: 'Change venue' })).toBeVisible()
  await expect.poll(() => api.store().venue_id).toBe('ven_purple')
})

test('the author can override the warning, and then the venue is created', async ({ page }) => {
  const api = await serveAuthoring(page)
  await page.goto('/submit')
  await toWhere(page)

  await page.getByLabel('Venue', { exact: true }).fill('Purple Haze')
  await page.getByRole('button', { name: /Add .* as a new venue/ }).click()
  await page.getByRole('button', { name: 'Save this venue' }).click()
  await expect(page.getByText(/looks like a venue already/i)).toBeVisible()

  await page.getByRole('button', { name: 'None of these — add it anyway' }).click()

  await expect(page.getByRole('button', { name: 'Change venue' })).toBeVisible()
  expect(api.venues()).toHaveLength(1)
  // A venue the wizard has never seen in its lookups still shows its name.
  await expect(page.getByText('Purple Haze', { exact: false })).toBeVisible()
})

test('editing a field withdraws a duplicate warning rather than letting it be confirmed', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')
  await toWhere(page)

  await page.getByLabel('Venue', { exact: true }).fill('Purple Haze')
  await page.getByRole('button', { name: /Add .* as a new venue/ }).click()
  await page.getByRole('button', { name: 'Save this venue' }).click()
  await expect(page.getByText(/looks like a venue already/i)).toBeVisible()

  // The warning was about the venue as it was. Renaming it makes the warning
  // stale, and confirming past a stale warning is how a duplicate gets in.
  await page.getByLabel('Name', { exact: true }).fill('Something Else Entirely')
  await expect(page.getByText(/looks like a venue already/i)).toBeHidden()
})

test('with no map key the coordinates are still settable, and say so', async ({ page }) => {
  const api = await serveAuthoring(page)
  await page.goto('/submit')
  await toWhere(page)

  await page.getByLabel(/somewhere other than/).check()

  // The preview build has no key by design (docs/DEVOPS.md). An author on one
  // must still be able to place the listing.
  await expect(page.getByText(/no map key/i)).toBeVisible()
  await page.getByLabel('Latitude').fill('27.71501')
  await page.getByLabel('Longitude').fill('85.31102')

  await expect(page.getByText('Pin at 27.71501, 85.31102')).toBeVisible()
  await expect.poll(() => api.store().location_lat).toBe(27.71501)
})

test('a pin outside Nepal is questioned, and a swapped one is named as swapped', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')
  await toWhere(page)

  await page.getByLabel(/somewhere other than/).check()
  await page.getByLabel('Latitude').fill('85.324')
  await page.getByLabel('Longitude').fill('27.7172')

  await expect(page.getByText(/swapping the two numbers/)).toBeVisible()

  await page.getByLabel('Latitude').fill('27.7172')
  await page.getByLabel('Longitude').fill('85.324')
  await expect(page.getByText(/swapping the two numbers/)).toBeHidden()
})

test('click, drag and address entry all agree on the same pin', async ({ page }) => {
  const api = await serveAuthoring(page, { maps: true })
  await page.goto('/submit')
  await toWhere(page)

  await page.getByLabel(/somewhere other than/).check()
  await expect(page.getByLabel(/Search for an address/)).toBeVisible()

  // 1. By click on the map.
  await page.evaluate(() => {
    const maps = (window as unknown as {
      google: { maps: { __fire: (event: string, payload: unknown) => void
                        __latLng: (lat: number, lng: number) => unknown } }
    }).google.maps
    maps.__fire('click', { latLng: maps.__latLng(27.71501, 85.31102) })
  })
  await expect(page.getByText('Pin at 27.71501, 85.31102')).toBeVisible()

  // 2. By typing the coordinates, which is the same pin.
  await page.getByLabel('Latitude').fill('27.71501')
  await expect(page.getByText('Pin at 27.71501, 85.31102')).toBeVisible()

  // 3. By address: the stub geocodes every query to the same point, so all
  //    three routes to a coordinate land in the same place — which is the
  //    criterion.
  await page.getByLabel(/Search for an address/).fill('Thamel')
  await page.getByRole('option', { name: /Thamel/ }).click()
  await expect(page.getByText('Pin at 27.71501, 85.31102')).toBeVisible()

  await expect.poll(() => api.store().location_lat).toBe(27.71501)
  await expect.poll(() => api.store().location_lng).toBe(85.31102)
})

test('a dropped pin fills the new venue’s address in by itself', async ({ page }) => {
  await serveAuthoring(page, { maps: true })
  await page.goto('/submit')
  await toWhere(page)

  await page.getByLabel('Venue', { exact: true }).fill('Somewhere New')
  await page.getByRole('button', { name: /Add .* as a new venue/ }).click()

  await page.evaluate(() => {
    const maps = (window as unknown as {
      google: { maps: { __fire: (event: string, payload: unknown) => void
                        __latLng: (lat: number, lng: number) => unknown } }
    }).google.maps
    maps.__fire('click', { latLng: maps.__latLng(27.71501, 85.31102) })
  })

  // `exact` throughout: the map's own search box is labelled "Search for an
  // address…", which a substring match would also hit.
  await expect(page.getByLabel('Address', { exact: true }))
    .toHaveValue('Thamel Marg, Kathmandu 44600, Nepal')
  await expect(page.getByLabel('Area', { exact: true })).toHaveValue('Thamel')
  await expect(page.getByLabel('City', { exact: true })).toHaveValue('Kathmandu')
  // And it did not overwrite the name the author typed.
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Somewhere New')
})

test('the venue picker is operable from the keyboard alone', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')
  await toWhere(page)

  const search = page.getByLabel('Venue', { exact: true })
  await search.focus()
  await page.keyboard.type('Patan')

  const result = page.getByRole('button', { name: /Patan Durbar Square/ })
  await expect(result).toBeVisible()
  await result.focus()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('button', { name: 'Change venue' })).toBeVisible()
})

test('the Where step does not scroll sideways at 320px', async ({ page }) => {
  await serveAuthoring(page, { maps: true })
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/submit')
  await toWhere(page)

  await page.getByLabel('Venue', { exact: true }).fill('Purple Haze')
  await page.getByRole('button', { name: /Add .* as a new venue/ }).click()
  await expect(page.getByRole('heading', { name: 'Add a venue' })).toBeVisible()

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
