import { expect, test } from '@playwright/test'

/**
 * Routing. Before this existed, the SPA fallback served index.html for every
 * path and index.html rendered the design system, so /organizers — and every
 * other link in the shell — showed the component gallery.
 */

const LINKED_PATHS = ['/', '/map', '/venues', '/organizers', '/about', '/submit',
                      '/privacy', '/design-system']

test('every path the shell links to renders its own page', async ({ page }) => {
  for (const path of LINKED_PATHS) {
    await page.goto(path)
    await expect(page.getByRole('main')).toBeVisible()
    // The gallery is one page among many now, not the answer to every URL.
    if (path !== '/design-system') {
      await expect(page.getByRole('heading', { name: 'NepScene design system' }))
        .toHaveCount(0)
    }
  }
})

test('a direct hit on a deep link works, not just navigation to it', async ({ page }) => {
  // This is the case the user reported: typing /organizers into the address bar.
  await page.goto('/organizers')
  await expect(page.getByRole('heading', { level: 1, name: 'Organizers' })).toBeVisible()
  await expect(page).toHaveTitle(/Organizers/)
})

test('header navigation does not reload the document', async ({ page }) => {
  await page.goto('/')
  // A full reload discards this; a client-side navigation keeps it.
  await page.evaluate(() => { (window as unknown as { marker?: number }).marker = 1 })

  await page.getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Venues' }).click()

  await expect(page).toHaveURL(/\/venues$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Venues' })).toBeVisible()
  const survived = await page.evaluate(() => (window as unknown as { marker?: number }).marker)
  expect(survived, 'the navigation reloaded the document').toBe(1)
})

test('the current page is marked in the navigation', async ({ page }) => {
  await page.goto('/venues')
  const nav = page.getByRole('navigation', { name: 'Primary' })
  await expect(nav.getByRole('link', { name: 'Venues' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'Map' })).not.toHaveAttribute('aria-current', 'page')
})

test('back and forward move between pages', async ({ page }) => {
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: 'Primary' })
  await nav.getByRole('link', { name: 'Organizers' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Organizers' })).toBeVisible()

  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'Discover' })).toBeVisible()

  await page.goForward()
  await expect(page.getByRole('heading', { level: 1, name: 'Organizers' })).toBeVisible()
})

test('navigating moves focus to the main landmark', async ({ page }) => {
  // Otherwise focus stays on the link and a screen reader is told nothing happened.
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Map' }).click()

  await expect(page.locator('main')).toBeFocused()
})

test('an unknown path says so instead of rendering a real page', async ({ page }) => {
  await page.goto('/no-such-page')
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()
})

test('a trailing slash is the same page, not a missing one', async ({ page }) => {
  await page.goto('/venues/')
  await expect(page.getByRole('heading', { level: 1, name: 'Venues' })).toBeVisible()
})
