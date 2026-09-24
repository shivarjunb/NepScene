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
        ? ['listing:moderate', 'listing:publish', 'user:manage', 'organization:manage', 'venue:edit_any']
        : ['listing:create', 'listing:edit_own'],
    },
  }))

  await page.route('**/api/admin/overview', (route) => route.fulfill({
    json: {
      users: { visitor: { total: 1, inactive: 0 }, organizer: { total: 0, inactive: 0 },
               editor: { total: 0, inactive: 0 }, admin: { total: 1, inactive: 0 } },
      listings: { pending_review: 2, published: 12, draft: 3 },
      organizations: { total: 2, verified: 1 },
      venues: { total: 3, unmapped: 1 },
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

  const listings = [
    { id: 'lst_live', slug: 'rock-night', title: 'Rock Night', status: 'published', source: 'organizer',
      listing_type: 'free', starts_at: '2027-03-15T13:00:00Z', updated_at: '2026-09-05T10:00:00Z',
      created_at: '2026-09-01T10:00:00Z', venue_name: 'Purple Haze', venue_slug: 'purple-haze',
      organization_name: null, author_email: 'author@nepscene.test' },
    { id: 'lst_old', slug: 'old-gig', title: 'Old Gig', status: 'draft', source: 'import',
      listing_type: 'free', starts_at: null, updated_at: '2026-09-04T10:00:00Z',
      created_at: '2026-09-01T10:00:00Z', venue_name: null, venue_slug: null,
      organization_name: null, author_email: null },
  ]
  await page.route('**/api/admin/listings?**', (route) => {
    const url = new URL(route.request().url())
    calls.push({ method: 'GET', path: `listings${url.search}` })
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const status = url.searchParams.get('status')
    const matching = listings.filter((row) => row.title.toLowerCase().includes(q))
    return route.fulfill({ json: {
      data: matching.filter((row) => !status || row.status === status),
      counts: { pending_review: 0, published: matching.filter((r) => r.status === 'published').length,
                draft: matching.filter((r) => r.status === 'draft').length, rejected: 0, archived: 0 },
      page: { limit: 25, offset: 0, has_more: false },
    } })
  })

  const venues = [
    { id: 'ven_a', slug: 'purple-haze', name: 'Purple Haze', address: null, area: 'Thamel', city: 'Kathmandu',
      latitude: 27.7154, longitude: 85.3105, website_url: null, phone: null, is_verified: false,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', listing_count: 4, published_count: 3 },
    { id: 'ven_b', slug: 'purple-haze-2', name: 'Purple Haze Bar', address: null, area: 'Thamel', city: 'Kathmandu',
      latitude: null, longitude: null, website_url: null, phone: null, is_verified: false,
      created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', listing_count: 1, published_count: 1 },
  ]
  await page.route('**/api/admin/venues?**', (route) => {
    const url = new URL(route.request().url())
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const filter = url.searchParams.get('filter')
    const matching = venues.filter((row) => row.name.toLowerCase().includes(q))
    return route.fulfill({ json: {
      data: matching.filter((row) => filter !== 'unmapped' || row.latitude === null),
      counts: { all: matching.length, unmapped: matching.filter((r) => r.latitude === null).length,
                unverified: matching.filter((r) => !r.is_verified).length },
      page: { limit: 25, offset: 0, has_more: false },
    } })
  })
  await page.route('**/api/admin/venues/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!
    const body = route.request().postDataJSON() as Record<string, unknown>
    calls.push({ method: 'PATCH', path: `venues/${id}`, body })
    if (body.latitude !== null && typeof body.latitude === 'number' && body.latitude > 40) {
      return route.fulfill({ status: 400, json: { error: {
        code: 'invalid_venue', message: 'Some things need fixing before this venue can be saved',
        fields: [{ field: 'latitude', message: 'That pin is outside Nepal' }],
      } } })
    }
    const venue = venues.find((row) => row.id === id)!
    Object.assign(venue, body)
    return route.fulfill({ json: venue })
  })
  await page.route('**/api/admin/venues/*/merge', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!
    const body = route.request().postDataJSON() as Record<string, unknown>
    calls.push({ method: 'POST', path: `venues/${id}/merge`, body })
    return route.fulfill({ json: { merged: id, into: body.into, slug: 'purple-haze', moved: 1 } })
  })

  await page.route('**/api/author/queue/actions', (route) => {
    const body = route.request().postDataJSON() as { action: string; ids: string[] }
    calls.push({ method: 'POST', path: 'queue/actions', body })
    return route.fulfill({ json: {
      applied: body.ids, refused: [], status: body.action === 'archive' ? 'archived' : 'published',
    } })
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

test('all listings searches every state, and acts on a row in place', async ({ page }) => {
  const api = await serveAdmin(page)
  await page.goto('/admin/listings')
  await expect(page.getByRole('heading', { name: 'All listings', level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: /All\s*2/ })).toBeVisible()

  const draft = page.locator('.admin__row', { hasText: 'Old Gig' })
  await expect(draft).toContainText('Draft')
  await expect(draft.getByRole('button', { name: 'Publish' })).toBeVisible()
  // A published listing can be looked at and archived, not published again.
  const live = page.locator('.admin__row', { hasText: 'Rock Night' })
  await expect(live.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/listings/rock-night')
  await expect(live.getByRole('button', { name: 'Publish' })).toHaveCount(0)

  await page.getByLabel('Find a listing').fill('rock')
  await expect(page.locator('.admin__row')).toHaveCount(1)

  await live.getByRole('button', { name: 'Archive' }).click()
  await expect(page.getByText('“Rock Night” is archived.')).toBeVisible()
  expect(api.calls()).toContainEqual({ method: 'POST', path: 'queue/actions', body: { action: 'archive', ids: ['lst_live'] } })
})

test('venues: the pinless filter, an edit refused per field, and a merge', async ({ page }) => {
  const api = await serveAdmin(page)
  await page.goto('/admin/venues?filter=unmapped')
  await expect(page.getByRole('button', { name: /No map pin\s*1/ })).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('.admin__row')).toHaveCount(1)
  await expect(page.locator('.admin__row')).toContainText('no map pin')

  const row = page.locator('.admin__row', { hasText: 'Purple Haze Bar' })
  await row.getByRole('button', { name: 'Edit' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit Purple Haze Bar' })
  await editor.getByLabel('Latitude').fill('51.5')
  await editor.getByLabel('Longitude').fill('-0.12')
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(editor.getByText('That pin is outside Nepal')).toBeVisible()

  await editor.getByLabel('Latitude').fill('27.7156')
  await editor.getByLabel('Longitude').fill('85.3108')
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Purple Haze Bar is saved.')).toBeVisible()
  expect(api.calls().filter((call) => call.method === 'PATCH').at(-1)?.body)
    .toMatchObject({ latitude: 27.7156, longitude: 85.3108, name: 'Purple Haze Bar' })

  await row.getByRole('button', { name: 'Merge…' }).click()
  const merger = page.getByRole('dialog', { name: 'Merge Purple Haze Bar into…' })
  await merger.getByLabel('Find the venue it duplicates').fill('purple')
  await merger.getByRole('radio', { name: /^Purple Haze\b(?! Bar)/ }).check()
  await merger.getByRole('button', { name: 'Merge into Purple Haze' }).click()
  await expect(page.getByText('Purple Haze Bar is merged into Purple Haze; 1 listing moved.')).toBeVisible()
  expect(api.calls()).toContainEqual({ method: 'POST', path: 'venues/ven_b/merge', body: { into: 'ven_a' } })
})

test('the overview sends the venues with no pin to be fixed', async ({ page }) => {
  await serveAdmin(page)
  await page.goto('/admin')
  const attention = page.locator('.admin__attention')
  await expect(attention.getByRole('heading', { name: '1 venue has no map pin' })).toBeVisible()
  await attention.getByRole('link', { name: 'Fix' }).click()
  await expect(page).toHaveURL(/\/admin\/venues\?filter=unmapped$/)
  await expect(page.getByRole('button', { name: /No map pin/ })).toHaveAttribute('aria-current', 'true')
})

test('venues pass axe, dialogs included', async ({ page }) => {
  await serveAdmin(page)
  await page.goto('/admin/venues')
  await expect(page.locator('.admin__row').first()).toBeVisible()
  await page.locator('.admin__row').first().getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(results.violations).toEqual([])
})
