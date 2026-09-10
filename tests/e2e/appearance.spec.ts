import { expect, test } from '@playwright/test'
import { pickVenue, serveAuthoring } from './authoringStub'

/**
 * #32 — pin appearance and popup customisation.
 *
 * The shape of the configuration and what it refuses are unit-tested
 * (tests/unit/popupConfig.test.ts). What is settled here is the criterion that
 * needs a browser: that the preview is the real components rather than a
 * mock-up of them, and that reordering, hiding and renaming reach the server.
 */

async function toAppearance(page: import('@playwright/test').Page) {
  await page.getByLabel('Title', { exact: true }).fill('Kutumba live')
  await page.getByRole('button', { name: 'Concerts' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Starts').fill('2027-03-14T18:45')
  await page.getByRole('button', { name: 'Next' }).click()
  await pickVenue(page, 'Patan Durbar Square')
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  // Level 1: the step's own heading, not the "Preview" sub-heading below it.
  await expect(page.getByRole('heading', { level: 1, name: /On the map/ })).toBeVisible()
}

test('the pin comes from the category, and there is no way to set it separately', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')
  await toAppearance(page)

  await expect(page.getByText(/Colour and icon come from the main category/)).toBeVisible()

  // WaahTickets had an icon grid and a colour picker here, which is why its
  // map needed a separate pinCategory to reconcile the two. There is one value.
  await expect(page.getByRole('button', { name: /Food & Drink/ })).toHaveCount(0)
  await expect(page.locator('input[type="color"]')).toHaveCount(0)
})

test('the previewed pin is the marker image itself, in the category colour', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')
  await toAppearance(page)

  // Concerts is #e91e63 with the Lucide `Music` glyph (migration 0002).
  const svg = page.locator('.appearance__pin svg')
  await expect(svg).toBeVisible()
  expect(await svg.innerHTML()).toContain('M9 18V5l12-2v13')
  expect(await page.locator('.appearance__pin path').first().getAttribute('fill'))
    .toBe('#e91e63')
})

test('hiding a field takes it out of the popup being previewed', async ({ page }) => {
  const api = await serveAuthoring(page)
  await page.goto('/submit')
  await toAppearance(page)

  const popup = page.locator('.pin-card')
  await expect(popup.getByText('Where')).toBeVisible()

  await page.getByRole('button', { name: 'Shown' }).first().click()

  await expect(popup.getByText('Where')).toBeHidden()
  await expect.poll(() =>
    (api.store().map_popup_config as { fields: { field: string; visible: boolean }[] } | null)
      ?.fields.find((field) => field.field === 'venue')?.visible,
  ).toBe(false)
})

test('reordering moves the row in the preview and is saved', async ({ page }) => {
  const api = await serveAuthoring(page)
  await page.goto('/submit')
  await toAppearance(page)

  await page.getByRole('button', { name: 'Move When up' }).click()

  const labels = page.locator('.pin-card__row dt')
  await expect(labels.first()).toHaveText('When')
  await expect.poll(() =>
    (api.store().map_popup_config as { fields: { field: string }[] } | null)?.fields[0]?.field,
  ).toBe('when')
})

test('renaming a field renames it in the popup', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')
  await toAppearance(page)

  await page.getByLabel('Label for venue').fill('Venue')
  await expect(page.locator('.pin-card').getByText('Venue')).toBeVisible()
  await expect(page.locator('.pin-card').getByText('Where')).toHaveCount(0)
})

test('reset is offered only once something has changed, and clears the override', async ({ page }) => {
  const api = await serveAuthoring(page)
  await page.goto('/submit')
  await toAppearance(page)

  const reset = page.getByRole('button', { name: 'Reset to the defaults' })
  await expect(reset).toBeDisabled()

  await page.getByRole('button', { name: 'Move When up' }).click()
  await expect(reset).toBeEnabled()
  await reset.click()

  await expect(page.locator('.pin-card__row dt').first()).toHaveText('Where')
  // Stored as nothing, not as a copy of today's defaults — so a later change
  // to the defaults still reaches this listing.
  await expect.poll(() => api.store().map_popup_config).toBeNull()
})

test('the popup preview shows what the listing actually says', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')
  await toAppearance(page)

  const popup = page.locator('.pin-card')
  await expect(popup.getByRole('heading', { name: 'Kutumba live' })).toBeVisible()
  await expect(popup.getByText('Patan Durbar Square')).toBeVisible()
})

test('without a map key the pin is still shown and the absence is explained', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')
  await toAppearance(page)

  await expect(page.getByText(/needs a Google Maps key/)).toBeVisible()
  // The pin itself is not a mock-up of the marker; it is the marker.
  await expect(page.locator('.appearance__pin svg')).toBeVisible()
})

test('with a map key the preview is a real map carrying the real marker', async ({ page }) => {
  await serveAuthoring(page, { maps: true })
  await page.goto('/submit')
  await toAppearance(page)

  // The stub map stamps the container it was constructed into, so this asserts
  // a google.maps.Map was built rather than that a div exists.
  await expect(page.locator('.appearance__map[data-fake-map="ready"]')).toBeVisible()
  await expect(page.getByText(/needs a Google Maps key/)).toHaveCount(0)
})

test('the appearance step is operable from the keyboard at 320px', async ({ page }) => {
  await serveAuthoring(page)
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/submit')
  await toAppearance(page)

  const move = page.getByRole('button', { name: 'Move When up' })
  await move.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.pin-card__row dt').first()).toHaveText('When')

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
