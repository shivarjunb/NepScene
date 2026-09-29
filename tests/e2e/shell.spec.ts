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

    // The document check alone is not enough: the body clips overflow, so a
    // header bar wider than the screen shows no scrollbar — it just loses
    // whatever is at its end, which at 320px was the menu button. Measure
    // the bar itself, and that the last control in it is on screen.
    const bar = await page.locator('.site-header__bar').evaluate((el) => ({
      overflow: el.scrollWidth - el.clientWidth,
      lastControlRight: [...el.querySelectorAll('.site-header__actions > *')]
        .filter((child) => getComputedStyle(child).display !== 'none')
        .map((child) => Math.round(child.getBoundingClientRect().right))
        .at(-1),
    }))
    expect(bar.overflow, `${width}px header bar overflows by ${bar.overflow}px`).toBe(0)
    expect(bar.lastControlRight, `${width}px last header control is off screen`)
      .toBeLessThanOrEqual(width)
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

  // The panel is fixed to the viewport, not to the header: a backdrop-filter
  // on the header once made it the containing block, and the menu collapsed
  // into a strip the page painted over.
  const box = (await menu.boundingBox())!
  expect(box.height).toBeGreaterThan(400)
  await expect(menu.locator('.mobile-menu__link', { hasText: 'Venues' })).toBeInViewport()

  // Language and theme live here on a phone — the header has no room for
  // them beside the brand word — and nowhere else, or there would be two
  // pressed states to keep in step.
  await expect(menu.locator('.lang-toggle')).toBeVisible()
  await expect(menu.locator('.theme-toggle')).toBeVisible()
  await expect(page.locator('.site-header .lang-toggle')).toBeHidden()
  await expect(page.locator('.site-header .theme-toggle')).toBeHidden()

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

// The header is the one place a visitor can find out whether they are signed
// in — and until now the only place to sign out was nowhere.
test.describe('account controls', () => {
  test('a visitor is offered sign-in, in the header and in the menu', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({
      status: 401, json: { error: { code: 'unauthenticated', message: 'Sign in' } },
    }))
    await page.goto('/')
    const header = page.locator('.site-header')
    await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible()
    await expect(header.getByRole('button', { name: 'Sign out' })).toHaveCount(0)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.site-header__menu-button').click()
    await expect(page.locator('#mobile-menu').getByRole('link', { name: 'Sign in' })).toBeVisible()
  })

  test('signing in from the header returns you to the page you were on', async ({ page }) => {
    let signedIn = false
    await page.route('**/api/auth/me', (route) => signedIn
      ? route.fulfill({ json: {
          user: { id: 'usr_1', email: 'organizer@nepscene.test', name: null, role: 'organizer' },
          permissions: ['listing:create'],
        } })
      : route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'Sign in' } } }))
    await page.route('**/api/auth/login', (route) => {
      signedIn = true
      return route.fulfill({ json: { ok: true } })
    })

    await page.goto('/venues')
    await page.locator('.site-header').getByRole('link', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/login\?next=%2Fvenues$/)
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

    await page.getByLabel('Email').fill('organizer@nepscene.test')
    await page.getByLabel('Password').fill('correct horse battery staple')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL(/\/venues$/)
    await expect(page.locator('.site-header').getByRole('link', { name: 'My listings' })).toBeVisible()
  })

  test('/login with an off-site next still lands on this site', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: {
      user: { id: 'usr_1', email: 'organizer@nepscene.test', name: null, role: 'organizer' },
      permissions: ['listing:create'],
    } }))
    await page.route('**/api/author/dashboard**', (route) => route.fulfill({ json: { listings: [], next: null } }))
    await page.goto('/login?next=https://evil.example/')
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('someone signed in sees their listings and can sign out', async ({ page }) => {
    let signedIn = true
    await page.route('**/api/auth/me', (route) => signedIn
      ? route.fulfill({ json: {
          user: { id: 'usr_1', email: 'organizer@nepscene.test', name: null, role: 'organizer' },
          permissions: ['listing:create'],
        } })
      : route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'Sign in' } } }))
    let logoutCalls = 0
    await page.route('**/api/auth/logout', (route) => {
      logoutCalls++
      signedIn = false
      return route.fulfill({ json: { ok: true } })
    })

    await page.goto('/')
    const header = page.locator('.site-header')
    await expect(header.getByRole('link', { name: 'My listings' })).toBeVisible()
    await expect(header.getByRole('link', { name: 'Sign in' })).toHaveCount(0)

    await header.getByRole('button', { name: 'Sign out' }).click()
    await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible()
    expect(logoutCalls).toBe(1)
  })
})
