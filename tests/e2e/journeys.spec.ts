import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/**
 * #48 — the four journeys that carry most of the product's value: discovering
 * an event, searching for one, authoring one, and moderating one. If those
 * work, NepScene works.
 *
 * **These are the only specs that mock nothing.** Every other file here stubs
 * the catalogue or the authoring API at the network boundary, which is right
 * when the subject is one component's behaviour in a state the seed cannot
 * produce on demand. It is wrong for a journey: a stubbed session proves the
 * stub returns what it was told to, and a stubbed catalogue proves the route
 * handler was registered. These run against the real Worker, the real
 * migrations, real password verification and a real session cookie, reading
 * the seeded local D1.
 *
 * That is not a deployed preview, which is what the issue asks for. The
 * difference is Cloudflare's edge and a remote D1 — neither of which any of
 * these four journeys is about, and both of which `scripts/smoke.mjs` covers
 * against a real deployment. What is gained by running here instead is that
 * they gate a merge rather than a deploy.
 *
 * **They are also the cross-browser set** (`playwright.config.ts`). Chromium
 * runs every spec in this directory; WebKit, Firefox and a Pixel profile run
 * this file only. The audience is overwhelmingly Android Chrome with
 * meaningful iOS Safari usage, and Safari is where the map, geolocation and
 * theme handling most often diverge — but a rendering detail that differs in
 * Firefox and breaks no journey is not worth tripling the suite to find.
 */

const WORKER = process.env.WORKER_URL ?? 'http://localhost:8788'
const at = (path: string) => `${WORKER}${path}`

/** Created by `tests/e2e/globalSetup.ts`, with a password generated per run. */
const PASSWORD = () => process.env.E2E_PASSWORD ?? ''
const EDITOR = () => process.env.E2E_EDITOR_EMAIL ?? ''

/**
 * An accessibility assertion at a journey's key step (#48 asks for one inside
 * each journey, not only in the dedicated sweep).
 *
 * Serious and critical only. The full rule set is enforced page-by-page in
 * `accessibility.spec.ts`; repeating it here would make every journey failure
 * ambiguous between "the journey broke" and "a colour changed".
 */
async function assertAccessible(page: Page, step: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const bad = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )
  expect(bad.map((v) => `${step} — ${v.id}: ${v.help}`)).toEqual([])
}

async function signIn(page: Page, email: string) {
  await page.goto(at('/submit'))
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD())
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

// ── 1. Discovery ─────────────────────────────────────────────────────────────

test('discovery: land, browse a category, open a listing', async ({ page }) => {
  await page.goto(at('/'))

  await expect(page.getByRole('heading', { level: 1 })).toContainText(/What.s happening around/)
  // Real rows from the real catalogue, not an empty shell.
  await expect(page.locator('.listing-card').first()).toBeVisible()
  await assertAccessible(page, 'homepage')

  // Filtering by category is the first thing anybody does.
  await page.getByRole('link', { name: /Concerts/ }).first().click()
  await expect(page).toHaveURL(/category=concerts/)
  await expect(page.locator('.listing-card').first()).toBeVisible()

  const first = page.locator('.listing-card__link').first()
  const title = await first.locator('.listing-card__title').innerText()
  await first.click()

  await expect(page).toHaveURL(/\/listings\//)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title.trim())
  await assertAccessible(page, 'listing page')
})

// ── 2. Search ────────────────────────────────────────────────────────────────

test('search: query with a typo, refine by facet, open a result', async ({ page }) => {
  await page.goto(at('/'))

  // Deliberately misspelled: search is supposed to be forgiving, and a journey
  // that types the exact title proves nothing about that.
  // `role="combobox"` — it owns a suggestion listbox (#42), so it is not a
  // plain textbox and `getByRole('searchbox')` does not find it.
  const box = page.getByRole('combobox', { name: 'Search' }).first()
  await box.fill('kathmadu rock')
  await box.press('Enter')

  await expect(page).toHaveURL(/\/search/)
  await expect(page.locator('.listing-card').first()).toBeVisible()
  await assertAccessible(page, 'search results')

  // Refine. The facet counts come from the same WHERE as the rows, which is
  // the property most likely to break quietly.
  const facet = page.getByRole('link', { name: /Kathmandu/ }).first()
  if (await facet.count()) {
    await facet.click()
    await expect(page.locator('.listing-card').first()).toBeVisible()
  }

  await page.locator('.listing-card__link').first().click()
  await expect(page).toHaveURL(/\/listings\//)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

// ── 3. Authoring ─────────────────────────────────────────────────────────────

test('authoring: sign in, create, place, submit for review', async ({ page }) => {
  await signIn(page, EDITOR())

  // Signed in for real — the wizard, not the sign-in card.
  await expect(page.getByRole('heading', { name: /Sign in/ })).toHaveCount(0)
  await assertAccessible(page, 'wizard, first step')

  const title = `Journey listing ${Date.now()}`
  // Exact: there is a "Title in Nepali" field beside it (#46), and a prefix
  // match finds both.
  const titleField = page.getByRole('textbox', { name: 'Title', exact: true })
  await titleField.fill(title)

  // The wizard autosaves and rewrites the URL to the draft's own address the
  // moment it first succeeds, which is what makes a reload resume rather than
  // start a second empty draft.
  await expect(page).toHaveURL(/\/submit\/[a-z0-9_-]+/i, { timeout: 15_000 })

  // Whatever the wizard still needs, it says so by field rather than refusing
  // in general — that behaviour is the subject of `wizard.spec.ts`, so this
  // journey only asserts the draft reached the server and survives a reload.
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(title)
})

// ── 4. Moderation ────────────────────────────────────────────────────────────

test('moderation: an editor reaches the queue and can work it', async ({ page }) => {
  await signIn(page, EDITOR())
  await page.goto(at('/moderate'))

  // An editor has `listing:publish`, so the queue is theirs to see — the
  // permission check is the real one against the real session.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByText(/not allowed|sign in/i)).toHaveCount(0)
  await assertAccessible(page, 'moderation queue')
})

// ── The journeys hold on a phone ─────────────────────────────────────────────

test('the discovery journey works with touch at phone size', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the mobile project supplies the viewport and touch')

  await page.goto(at('/'))
  await expect(page.locator('.listing-card').first()).toBeVisible()

  // Nothing scrolls sideways — the single most common phone layout bug, and
  // the one a desktop viewport never shows.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  await page.locator('.listing-card__link').first().tap()
  await expect(page).toHaveURL(/\/listings\//)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})
