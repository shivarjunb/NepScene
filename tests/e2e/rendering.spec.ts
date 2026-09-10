import { expect, test } from '@playwright/test'

/**
 * #45, in a browser — the two things only a browser can settle.
 *
 * **These run against the Worker, not `vite preview`.** Every other spec here
 * uses the preview server and stubs the catalogue at the network boundary,
 * which is right when the subject is the client. It is useless here: the
 * preview server serves the static shell and does no rendering, so a test of
 * server rendering against it would pass while proving nothing.
 *
 * The Worker is started by `webServer` in playwright.config.ts against the
 * seeded local D1, so these read the demo catalogue.
 */
/** The Worker's own origin — see playwright.config.ts for why it is separate. */
const WORKER = process.env.WORKER_URL ?? 'http://localhost:8788'
const worker = (path: string) => `${WORKER}${path}`

test.describe('with JavaScript disabled', () => {
  // The acceptance criterion, literally: a reader whose bundle never arrives —
  // a slow 3G connection, a corporate proxy, a crawler's first pass — still
  // gets the listing.
  test.use({ javaScriptEnabled: false })

  test('a listing page shows the listing', async ({ page }) => {
    await page.goto(worker('/listings/kathmandu-rock-night'))

    await expect(page.getByRole('heading', { level: 1, name: 'Kathmandu Rock Night' }))
      .toBeVisible()
    await expect(page.getByRole('link', { name: /Purple Haze/ }).first()).toBeVisible()
    // The offer, which is the part most likely to be client-only.
    await expect(page.getByRole('link', { name: 'Get tickets' })).toBeVisible()
  })

  test('a venue page shows what is on there', async ({ page }) => {
    await page.goto(worker('/venues/purple-haze-rock-bar'))
    await expect(page.getByRole('heading', { level: 1, name: 'Purple Haze Rock Bar' }))
      .toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'What’s on' })).toBeVisible()
  })

  test('the homepage shows the feed', async ({ page }) => {
    await page.goto(worker('/'))
    // The server renders the default city, not the requester's (#38). The
    // rendered page is cached at the edge, so a headline that varied by IP
    // would hand one visitor's city to the next; the client refines it after
    // hydration, from its own `/here` call.
    await expect(page.getByRole('heading', { level: 1, name: /What.s happening around Kathmandu/ }))
      .toBeVisible()
    // A rail with cards in it, not an empty shell.
    await expect(page.locator('.listing-card').first()).toBeVisible()
  })

  test('navigation is real links, so it works without a router', async ({ page }) => {
    await page.goto(worker('/listings/kathmandu-rock-night'))
    await page.getByRole('link', { name: /Purple Haze/ }).first().click()
    await expect(page).toHaveURL(/\/venues\//)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })
})

test.describe('with JavaScript', () => {
  test('hydrates the server markup instead of rebuilding it', async ({ page }) => {
    const problems: string[] = []
    page.on('console', (message) => {
      const text = message.text()
      // React reports a mismatch as an error and then rebuilds the tree — the
      // failure mode that makes server rendering cost a round trip and buy
      // nothing. It is invisible without watching for it.
      if (/hydrat|did not match|Minified React error #41[89]/i.test(text)) problems.push(text)
    })
    page.on('pageerror', (error) => problems.push(String(error)))

    await page.goto(worker('/listings/kathmandu-rock-night'))
    await expect(page.getByRole('heading', { level: 1, name: 'Kathmandu Rock Night' }))
      .toBeVisible()
    // Give React time to hydrate and complain if it is going to.
    await page.waitForTimeout(1200)

    expect(problems).toEqual([])
  })

  test('does not refetch what the server already sent', async ({ page }) => {
    const calls: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/catalog/')) calls.push(url.pathname)
    })

    await page.goto(worker('/listings/kathmandu-rock-night'))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.waitForTimeout(1200)

    // The view beacon is a POST and is expected; the listing itself must not
    // be fetched again, because it is already in the document.
    expect(calls.filter((path) => path === '/api/catalog/listings/kathmandu-rock-night'))
      .toEqual([])
  })

  test('still works as an SPA once it has hydrated', async ({ page }) => {
    await page.goto(worker('/listings/kathmandu-rock-night'))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.waitForTimeout(800)

    // A client-side navigation after a server-rendered first paint is the seam
    // most likely to be broken by hydration going wrong.
    await page.getByRole('link', { name: /Purple Haze/ }).first().click()
    await expect(page).toHaveURL(/\/venues\//)
    await expect(page.getByRole('heading', { level: 2, name: 'What’s on' })).toBeVisible()
  })

  test('serves the Nepali document when asked, and keeps the toggle working', async ({ page }) => {
    await page.goto(worker('/listings/kathmandu-rock-night?lang=ne'))
    await expect(page.locator('html')).toHaveAttribute('lang', 'ne')
    await expect(page.getByRole('button', { name: 'EN' })).toBeVisible()

    await page.getByRole('button', { name: 'EN' }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })
})
