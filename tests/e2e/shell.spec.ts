import { expect, test } from '@playwright/test'

/** #18 — the shell holds from 320px to 2560px with no horizontal scroll. */
const WIDTHS = [
  { width: 320, label: 'narrowest supported' },
  { width: 372, label: 'Z Fold cover screen' },
  { width: 414, label: 'large phone' },
  { width: 768, label: 'tablet' },
  { width: 1280, label: 'laptop' },
  { width: 2560, label: 'wide desktop' },
]

for (const { width, label } of WIDTHS) {
  test(`no horizontal scroll at ${width}px (${label})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await page.waitForSelector('main')

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth, `${width}px scrolls horizontally`)
      .toBeLessThanOrEqual(overflow.clientWidth + 1)
  })
}

test('landmarks let a screen reader navigate by region', async ({ page }) => {
  await page.goto('/')
  // By role, not by tag: a <header> inside <main> is a section header, not a
  // second banner, and asserting on tags would fail for the wrong reason.
  await expect(page.getByRole('banner')).toHaveCount(1)
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.getByRole('contentinfo')).toHaveCount(1)

  // Every nav is named, or "navigation" appears three times with no way to tell them apart.
  const navs = page.getByRole('navigation')
  const count = await navs.count()
  expect(count).toBeGreaterThan(0)
  for (let i = 0; i < count; i++) {
    await expect(navs.nth(i)).toHaveAttribute('aria-label', /.+/)
  }
})

test('skip link is hidden until focused, then jumps to content', async ({ page }) => {
  await page.goto('/')
  const skip = page.locator('.skip-link')

  const before = await skip.boundingBox()
  expect(before!.y).toBeLessThan(0)          // parked off-screen

  await page.keyboard.press('Tab')
  await expect(skip).toBeFocused()
  // Poll rather than measure once: the reveal is a transition, and reading the
  // box on the same tick measures the start of it.
  await expect.poll(async () => (await skip.boundingBox())!.y).toBeGreaterThanOrEqual(0)

  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#main$/)
})

test('the header stays put when the page scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 })
  await page.goto('/')
  await page.evaluate(() => window.scrollTo(0, 600))

  // getBoundingClientRect is viewport-relative, which is the question being
  // asked; Playwright's boundingBox() is relative to the document.
  const top = await page.evaluate(
    () => document.querySelector('.site-header')!.getBoundingClientRect().top,
  )
  expect(top).toBeCloseTo(0, 0)
})

test('mobile menu is keyboard operable and traps focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  const toggle = page.locator('.site-header__menu-button')
  await expect(toggle).toBeVisible()
  await toggle.click()

  const menu = page.locator('#mobile-menu')
  await expect(menu).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  // Focus moved into the dialog rather than being left behind it.
  const focusedInMenu = await page.evaluate(
    () => document.querySelector('#mobile-menu')!.contains(document.activeElement),
  )
  expect(focusedInMenu).toBe(true)

  // Tab all the way round; focus must never leave the dialog.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    const stillInside = await page.evaluate(
      () => document.querySelector('#mobile-menu')?.contains(document.activeElement) ?? false,
    )
    expect(stillInside, `focus escaped after ${i + 1} tabs`).toBe(true)
  }

  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(toggle).toBeFocused()   // focus came back to what opened it
})
