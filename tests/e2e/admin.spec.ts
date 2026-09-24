import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/**
 * #28 — the admin console in a browser.
 *
 * The rules are tested against a real D1 in tests/integration/admin.test.ts.
 * What is settled here is what only a browser can settle: that a role change
 * is one select and one call, that the row updates in place rather than the
 * list reloading, that an admin cannot reach for their own switch, that the
 * section is the URL, and that all of it passes axe and fits 320px.
 */

type User = {
  id: string; email: string; name: string | null; role: string
  is_active: boolean; email_verified: boolean; has_password: boolean; has_google: boolean
  last_login_at: string | null; created_at: string; listing_count: number; organization_count: number
}

const USERS: User[] = [
  { id: 'usr_admin', email: 'admin@nepscene.test', name: 'The admin', role: 'admin',
    is_active: true, email_verified: true, has_password: true, has_google: false,
    last_login_at: '2026-09-10T08:00:00Z', created_at: '2026-01-01T00:00:00Z',
    listing_count: 0, organization_count: 0 },
  { id: 'usr_binaya', email: 'binaya@nepscene.test', name: null, role: 'visitor',
    is_active: true, email_verified: false, has_password: true, has_google: true,
    last_login_at: null, created_at: '2026-09-01T00:00:00Z',
    listing_count: 3, organization_count: 1 },
]

type Call = { method: string; path: string; body?: Record<string, unknown> }

async function serveAdmin(page: Page, { role = 'admin' }: { role?: 'admin' | 'organizer' } = {}) {
  const calls: Call[] = []
  const users = USERS.map((user) => ({ ...user }))

  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: {
      user: { id: 'usr_admin', email: 'admin@nepscene.test', name: 'The admin', role },
      permissions: role === 'admin'
        ? ['listing:moderate', 'listing:publish', 'user:manage', 'organization:manage']
        : ['listing:create', 'listing:edit_own'],
    },
  }))

  await page.route('**/api/admin/overview', (route) => route.fulfill({
    json: {
      users: { visitor: { total: 1, inactive: 0 }, organizer: { total: 0, inactive: 0 },
               editor: { total: 0, inactive: 0 }, admin: { total: 1, inactive: 0 } },
      listings: { pending_review: 2, published: 12, draft: 3 },
      organizations: { total: 2, verified: 1 },
      recent: [],
      waiting: [
        { id: 'lst_a', slug: 'kutumba-live', title: 'Kutumba at Patan Durbar', source: 'organizer',
          starts_at: '2027-03-14T13:00:00Z', updated_at: '2026-09-01T10:00:00Z',
          venue_name: 'Patan Durbar Square', organization_name: null, has_duplicate: false },
        { id: 'lst_b', slug: 'rock-night-again', title: 'Rock Night', source: 'submission',
          starts_at: '2027-03-15T13:00:00Z', updated_at: '2026-09-02T10:00:00Z',
          venue_name: 'Purple Haze Rock Bar', organization_name: null, has_duplicate: true },
      ],
      last_scrape: {
        id: 'run_1', trigger: 'schedule', requested_by: null, requested_by_name: null,
        status: 'succeeded', apply_env: 'staging', github_run_url: null,
        summary: { complete: true, jobs: [
          { name: 'ticketsanjal', success: true, exit_code: 0, error: null },
          { name: 'katajaam', success: false, exit_code: 1, error: 'timed out' },
        ] },
        drafts_created: 4, output_key: null, error: null,
        requested_at: '2026-09-10T00:15:00Z', started_at: '2026-09-10T00:16:00Z',
        finished_at: '2026-09-10T00:40:00Z',
      },
    },
  }))

  await page.route('**/api/author/queue/actions', (route) => {
    const body = route.request().postDataJSON() as { action: string; ids: string[] }
    calls.push({ method: 'POST', path: 'queue/actions', body })
    return route.fulfill({ json: { applied: body.ids, refused: [], status: 'published' } })
  })

  await page.route('**/api/admin/users?**', (route) => {
    const url = new URL(route.request().url())
    const q = url.searchParams.get('q') ?? ''
    const which = url.searchParams.get('role')
    return route.fulfill({
      json: {
        data: users.filter((user) => (!which || user.role === which) && user.email.includes(q)),
        counts: { visitor: users.filter((u) => u.role === 'visitor').length, organizer: 0,
                  editor: users.filter((u) => u.role === 'editor').length, admin: 1 },
        page: { limit: 25, offset: 0, has_more: false },
      },
    })
  })

  await page.route('**/api/admin/users/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!
    const body = route.request().postDataJSON() as Record<string, unknown>
    calls.push({ method: route.request().method(), path: `users/${id}`, body })
    const user = users.find((u) => u.id === id)!
    if (typeof body.role === 'string') user.role = body.role
    if (typeof body.is_active === 'boolean') user.is_active = body.is_active
    return route.fulfill({ json: user })
  })

  await page.route('**/api/admin/organizations?**', (route) => route.fulfill({
    json: { data: [], page: { limit: 25, offset: 0, has_more: false } },
  }))
  await page.route('**/api/admin/audit?**', (route) => route.fulfill({
    json: { data: [], page: { limit: 50, offset: 0, has_more: false } },
  }))

  return { calls: () => calls }
}

test('an account that cannot moderate is turned away, and pointed at its listings', async ({ page }) => {
  await serveAdmin(page, { role: 'organizer' })
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Not for this account' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'your dashboard' })).toHaveAttribute('href', '/dashboard')
})

test('the overview counts link to the screens that act on them', async ({ page }) => {
  await serveAdmin(page)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: /Waiting for review\s*2/ })).toHaveAttribute('href', '/admin/moderation')
  // The last scrape names the scraper that did not finish.
  await expect(page.getByRole('link', { name: /Last scrape\s*1 \/ 2/ })).toContainText('katajaam failed')
  await page.getByRole('link', { name: /Accounts\s*2/ }).click()
  await expect(page).toHaveURL(/\/admin\/users$/)
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible()
})

test('the oldest waiting listing can be published from the overview', async ({ page }) => {
  const api = await serveAdmin(page)
  await page.goto('/admin')

  const attention = page.locator('.admin__attention')
  await expect(attention.getByRole('heading', { name: 'Kutumba at Patan Durbar' })).toBeVisible()
  await expect(attention.getByRole('heading', { name: /Rock Night/ })).toContainText('possible duplicate')
  await expect(attention.getByRole('heading', { name: '1 organization is not verified' })).toBeVisible()

  await attention.getByRole('button', { name: 'Publish' }).first().click()
  await expect(page.getByText('“Kutumba at Patan Durbar” is published.')).toBeVisible()
  expect(api.calls()).toEqual([
    { method: 'POST', path: 'queue/actions', body: { action: 'publish', ids: ['lst_a'] } },
  ])
})

test('the overview passes axe', async ({ page }) => {
  await serveAdmin(page)
  await page.goto('/admin')
  await expect(page.locator('.admin__attention')).toBeVisible()

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(results.violations).toEqual([])
})

test('changing a role is one select, one call, and the row updates in place', async ({ page }) => {
  const api = await serveAdmin(page)
  await page.goto('/admin/users')

  const row = page.locator('.admin__row', { hasText: 'binaya@nepscene.test' })
  await expect(row).toContainText('signs in with password and Google')
  await expect(row).toContainText('3 listings')

  await row.getByLabel('Role').selectOption('editor')
  await expect(page.getByText('binaya@nepscene.test is now an editor.')).toBeVisible()
  expect(api.calls()).toEqual([
    { method: 'PATCH', path: 'users/usr_binaya', body: { role: 'editor' } },
  ])
  // The tab counts moved with it, without a reload.
  await expect(page.getByRole('button', { name: /editor\s*1/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /visitor\s*0/ })).toBeVisible()
})

test('deactivating asks first, then switches the row off', async ({ page }) => {
  const api = await serveAdmin(page)
  await page.goto('/admin/users')
  const row = page.locator('.admin__row', { hasText: 'binaya@nepscene.test' })

  page.once('dialog', (dialog) => void dialog.dismiss())
  await row.getByRole('button', { name: 'Deactivate' }).click()
  expect(api.calls()).toEqual([])

  page.once('dialog', (dialog) => void dialog.accept())
  await row.getByRole('button', { name: 'Deactivate' }).click()
  await expect(row).toContainText('deactivated')
  await expect(row.getByRole('button', { name: 'Reactivate' })).toBeVisible()
  expect(api.calls().at(-1)).toMatchObject({ body: { is_active: false } })
})

test('an admin cannot reach for their own role or their own switch', async ({ page }) => {
  await serveAdmin(page)
  await page.goto('/admin/users')
  const me = page.locator('.admin__row', { hasText: 'admin@nepscene.test' })
  await expect(me).toContainText('you')
  await expect(me.getByLabel('Role')).toBeDisabled()
  await expect(me.getByRole('button', { name: 'Deactivate' })).toBeDisabled()
})

test('the section is the URL, and an unknown one falls back to the overview', async ({ page }) => {
  await serveAdmin(page)
  await page.goto('/admin/audit')
  await expect(page.getByRole('heading', { name: 'Audit trail', level: 1 })).toBeVisible()
  await page.getByRole('link', { name: 'Housekeeping' }).click()
  await expect(page).toHaveURL(/\/admin\/system$/)
  await expect(page.getByRole('heading', { name: 'Housekeeping', level: 1 })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Audit trail', level: 1 })).toBeVisible()

  await page.goto('/admin/nonsense')
  await expect(page.getByText('No such section')).toBeVisible()
  await expect(page.getByRole('link', { name: /Waiting for review/ })).toBeVisible()
})

test('accounts pass axe and nothing scrolls sideways at 320px', async ({ page }) => {
  await serveAdmin(page)
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/admin/users')
  await expect(page.locator('.admin__row').first()).toBeVisible()

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(results.violations).toEqual([])
})

test('on a phone the sidebar becomes a tab bar, and nothing scrolls sideways', async ({ page }) => {
  await serveAdmin(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/audit')

  await expect(page.getByRole('navigation', { name: 'Admin sections' })).toBeHidden()
  const tabs = page.getByRole('navigation', { name: 'Admin areas' })
  await expect(tabs.getByRole('link')).toHaveText(['Overview', /Review\s*2/, 'People', 'System'])
  await expect(tabs.getByRole('link', { name: 'System' })).toHaveAttribute('aria-current', 'page')

  // Within a group, the sections are a strip under the heading.
  await page.getByRole('navigation', { name: 'System sections' }).getByRole('link', { name: 'Scrapers' }).click()
  await expect(page).toHaveURL(/\/admin\/scrapers$/)

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
