import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/**
 * #49 — WCAG 2.1 AA across the whole product.
 *
 * Most of the accessibility work lives inside the features that own each
 * surface: the primitives (#16), the shell (#18), the map's equivalent list
 * (#40). This file is the sweep that catches what those missed, and the
 * automation that stops them regressing.
 *
 * **Against the real Worker, not the stubbed preview server.** Every other
 * spec here stubs the catalogue, which is right when the subject is the
 * client. It is wrong here: an axe scan of a page whose content never arrived
 * is a scan of an empty box, and it passes. These read the seeded local D1, so
 * the headings, links, images and tables being scanned are the real ones.
 */
const WORKER = process.env.WORKER_URL ?? 'http://localhost:8788'
const at = (path: string) => `${WORKER}${path}`

/**
 * The rule sets. `wcag2a`/`wcag2aa` plus the 2.1 additions, which is exactly
 * what the criterion names — and `best-practice` is deliberately excluded:
 * it flags things that are not WCAG failures, and a suite that fails on
 * opinions gets its assertions loosened until it fails on nothing.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

const scan = (page: Page) => new AxeBuilder({ page }).withTags(TAGS).analyze()

/**
 * Every page type, named by what makes it structurally different from the
 * others rather than by its URL — a second listing page would find nothing a
 * first one did not.
 */
const PAGES: [name: string, path: string][] = [
  ['the homepage', '/'],
  ['search results', '/search?q=rock'],
  ['a search that found nothing', '/search?q=zzzznothing'],
  ['the map page', '/map'],
  ['the venue index', '/venues'],
  ['the organizer index', '/organizers'],
  ['a listing page', '/listings/kathmandu-rock-night'],
  ['a venue page', '/venues/purple-haze-rock-bar'],
  ['an organizer page', '/organizers/himalayan-sound'],
  ['an artist page', '/artists/1974-ad'],
  ['the accessibility statement', '/accessibility'],
  ['a page that does not exist', '/nothing-is-here'],
  ['the design system', '/design-system'],
]

for (const [name, path] of PAGES) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${name} passes axe in the ${theme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(at(path))
      // The shell is server-rendered, so `main` exists before hydration. Waiting
      // for it rather than for `networkidle` means the scan runs against a page
      // that has actually painted without waiting on the map's tile requests,
      // which never settle.
      await expect(page.locator('main')).toBeVisible()

      const results = await scan(page)
      expect(
        results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`),
      ).toEqual([])
    })
  }
}

/**
 * The criterion is "no serious or critical issues", and best-practice rules
 * are excluded above. This checks the exclusion is not hiding a real failure:
 * anything axe rates serious or critical fails here whatever tag it carries.
 */
test('no page carries a serious or critical issue under any rule', async ({ page }) => {
  for (const [name, path] of PAGES) {
    await page.goto(at(path))
    await expect(page.locator('main')).toBeVisible()

    const results = await new AxeBuilder({ page }).analyze()
    const bad = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    )
    expect(bad.map((v) => `${name} — ${v.id}: ${v.help}`)).toEqual([])
  }
})

/**
 * #49's focus criterion: "focus moves sensibly on route change".
 *
 * A single-page app replaces the document without the browser doing anything
 * about focus, so a keyboard user who follows a link stays on a link that no
 * longer exists — and a screen-reader user is told nothing happened at all.
 */
test.describe('focus on navigation', () => {
  test('moves to the new page, not back to the top of the document', async ({ page }) => {
    await page.goto(at('/'))
    await expect(page.locator('main')).toBeVisible()

    await page.getByRole('link', { name: 'Venues', exact: true }).first().click()
    await expect(page).toHaveURL(/\/venues$/)

    // `main` carries tabIndex={-1} precisely so it can receive focus here.
    await expect(page.locator('main#main')).toBeFocused()
  })

  test('the skip link reaches the content it promises', async ({ page }) => {
    await page.goto(at('/'))
    await page.keyboard.press('Tab')

    const skip = page.getByRole('link', { name: /skip to content/i })
    await expect(skip).toBeFocused()
    // Visible only once focused — it is off-screen otherwise, which is the
    // point, and a skip link that stays invisible when focused is useless.
    await expect(skip).toBeInViewport()

    await page.keyboard.press('Enter')
    await expect(page.locator('main#main')).toBeFocused()
  })
})

/**
 * #49's headings criterion, via structure rather than via axe — `heading-order`
 * is a best-practice rule, so the scans above do not enforce it, and a page
 * that jumps h1 → h3 is genuinely harder to navigate by heading.
 */
test('every page has exactly one h1 and skips no heading level', async ({ page }) => {
  for (const [name, path] of PAGES) {
    await page.goto(at(path))
    await expect(page.locator('main')).toBeVisible()

    const levels = await page.locator('main :is(h1,h2,h3,h4,h5,h6)').evaluateAll(
      (nodes) => nodes.map((node) => Number(node.tagName[1])),
    )

    expect(levels.filter((level) => level === 1), `${name}: h1 count`).toHaveLength(1)
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]! - levels[i - 1]!, `${name}: ${levels[i - 1]} → ${levels[i]}`)
        .toBeLessThanOrEqual(1)
    }
  }
})

/**
 * The document has to declare what language it is in, or a screen reader reads
 * Devanagari with an English voice — which is not "accented", it is unintelligible.
 */
test('the document declares its language, in both languages', async ({ page }) => {
  await page.goto(at('/'))
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')

  await page.goto(at('/?lang=ne'))
  await expect(page.locator('html')).toHaveAttribute('lang', 'ne')
})
