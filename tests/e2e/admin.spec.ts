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

async function serveAdmin(page: Page, { role = 'admin' }: { role?: 'admin' | 'editor' } = {}) {
  const calls: Call[] = []
  const users = USERS.map((user) => ({ ...user }))

  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: {
      user: { id: 'usr_admin', email: 'admin@nepscene.test', name: 'The admin', role },
      permissions: role === 'admin'
        ? ['listing:moderate', 'listing:publish', 'user:manage', 'organization:manage']
        : ['listing:moderate', 'listing:publish'],
    },
  }))

  await page.route('**/api/admin/overview', (route) => route.fulfill({
    json: {
      users: { visitor: { total: 1, inactive: 0 }, organizer: { total: 0, inactive: 0 },
               editor: { total: 0, inactive: 0 }, admin: { total: 1, inactive: 0 } },
      listings: { pending_review: 2, published: 12, draft: 3 },
      organizations: { total: 1, verified: 1 },
      recent: [],
    },
  }))

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

test('an editor is turned away, and pointed at the queue', async ({ page }) => {
  await serveAdmin(page, { role: 'editor' })
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Not for this account' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'moderation queue' })).toHaveAttribute('href', '/moderate')
})

test('the overview counts link to the screens that act on them', async ({ page }) => {
  await serveAdmin(page)
  await page.goto('/admin')
  await expect(page.getByRole('button', { name: /2\s*waiting for review/ })).toBeVisible()
  await page.getByRole('button', { name: /2\s*accounts/ }).click()
  await expect(page).toHaveURL(/\/admin\/users$/)
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible()
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
  await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible()
  await page.getByRole('link', { name: 'Housekeeping' }).click()
  await expect(page).toHaveURL(/\/admin\/system$/)
  await expect(page.getByRole('heading', { name: 'Housekeeping' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible()

  await page.goto('/admin/nonsense')
  await expect(page.getByText('No such section')).toBeVisible()
  await expect(page.getByRole('button', { name: /waiting for review/ })).toBeVisible()
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
