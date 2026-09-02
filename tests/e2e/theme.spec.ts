import { expect, test } from '@playwright/test'

/** #17 — theming, including the one thing only a real first paint can prove. */

const backgroundOf = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor)

test('honours the OS preference when no choice has been made', async ({ browser }) => {
  const dark = await browser.newContext({ colorScheme: 'dark' })
  const darkPage = await dark.newPage()
  await darkPage.goto('/')
  expect(await backgroundOf(darkPage)).toBe('rgb(15, 23, 42)')

  const light = await browser.newContext({ colorScheme: 'light' })
  const lightPage = await light.newPage()
  await lightPage.goto('/')
  expect(await backgroundOf(lightPage)).toBe('rgb(255, 255, 255)')

  await dark.close()
  await light.close()
})

test('paints the stored theme on the first frame, with no flash', async ({ browser }) => {
  // An OS set to light and a stored choice of dark is the case that catches a
  // flash: anything that applies the theme after paint shows white first.
  const context = await browser.newContext({ colorScheme: 'light' })
  await context.addInitScript(() => localStorage.setItem('nepscene-theme', 'dark'))
  const page = await context.newPage()

  const backgrounds: string[] = []
  await page.exposeFunction('recordBackground', (value: string) => { backgrounds.push(value) })
  // Runs before any other script on the page, so it samples the very first
  // opportunity the document has a computed style.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      // @ts-expect-error injected above
      window.recordBackground(getComputedStyle(document.documentElement).colorScheme)
    })
  })

  await page.goto('/')
  await expect.poll(() => backgrounds.length).toBeGreaterThan(0)
  expect(backgrounds[0], 'the document was not dark at DOMContentLoaded').toBe('dark')
  expect(await backgroundOf(page)).toBe('rgb(15, 23, 42)')

  await context.close()
})

test('an explicit choice survives a reload and beats the OS', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' })
  const page = await context.newPage()
  await page.goto('/')
  expect(await backgroundOf(page)).toBe('rgb(15, 23, 42)')

  await page.getByRole('group', { name: 'Colour theme' })
    .getByRole('button', { name: 'Light' }).click()
  expect(await backgroundOf(page)).toBe('rgb(255, 255, 255)')

  await page.reload()
  expect(await backgroundOf(page), 'the choice did not survive a reload')
    .toBe('rgb(255, 255, 255)')

  await context.close()
})

test('returning to System hands control back to the OS', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' })
  const page = await context.newPage()
  await page.goto('/')

  const toggle = page.getByRole('group', { name: 'Colour theme' })
  await toggle.getByRole('button', { name: 'Light' }).click()
  expect(await backgroundOf(page)).toBe('rgb(255, 255, 255)')

  await toggle.getByRole('button', { name: 'System' }).click()
  expect(await backgroundOf(page)).toBe('rgb(15, 23, 42)')

  await context.close()
})

test('toggling the theme does not shift the layout', async ({ page }) => {
  await page.goto('/')
  const before = await page.locator('main').boundingBox()

  await page.getByRole('group', { name: 'Colour theme' })
    .getByRole('button', { name: 'Dark' }).click()
  const after = await page.locator('main').boundingBox()

  expect(after!.width).toBe(before!.width)
  expect(after!.height).toBe(before!.height)
  expect(after!.y).toBe(before!.y)
})

test('reduced motion suppresses animation', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto('/')

  const duration = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--duration-base').trim(),
  )
  expect(duration).toBe('1ms')

  await context.close()
})

test('theme survives storage being unavailable', async ({ browser }) => {
  // Private browsing and locked-down browsers throw on localStorage. A theme
  // toggle is not a reason for a blank page.
  const context = await browser.newContext({ colorScheme: 'dark' })
  await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new Error('storage is disabled') },
    })
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto('/')
  await expect(page.getByRole('main')).toBeVisible()
  expect(await backgroundOf(page)).toBe('rgb(15, 23, 42)')
  expect(errors).toEqual([])

  await context.close()
})
