import { expect, test, type Page } from '@playwright/test'

/**
 * #34 — the organizer dashboard.
 *
 * The scoping rule is a server one and is tested against a real D1 in
 * tests/integration/dashboard.test.ts. What is settled here is what the
 * criteria say about the screen: that quick actions do not navigate, that the
 * empty state leads a first-time organizer into the wizard, that a search
 * miss does not pretend to be an empty catalogue, and that unfinished work on
 * the device is offered somewhere the author will actually look.
 */

const LISTINGS = [
  {
    id: 'lst_live', slug: 'rock-night', title: 'Rock Night', status: 'published',
    listing_type: 'free', starts_at: '2027-03-14T13:00:00Z',
    updated_at: '2026-09-05T00:00:00Z', published_at: '2026-09-01T00:00:00Z',
    rejection_reason: null, venue_name: 'Purple Haze', media_count: 1,
    views: 412, clicks: 63,
  },
  {
    id: 'lst_back', slug: 'sent-back', title: 'Ghazal Evening', status: 'rejected',
    listing_type: 'free', starts_at: '2027-04-01T13:00:00Z',
    updated_at: '2026-09-04T00:00:00Z', published_at: null,
    rejection_reason: 'The venue address does not match the map pin.',
    venue_name: null, media_count: 0, views: 0, clicks: 0,
  },
]

type Options = {
  listings?: typeof LISTINGS
  permissions?: string[]
  signedIn?: boolean
  localDraft?: Record<string, unknown>
}

async function serveDashboard(page: Page, {
  listings = LISTINGS,
  permissions = ['listing:create', 'listing:edit_own', 'media:upload'],
  signedIn = true,
  localDraft,
}: Options = {}) {
  const calls: string[] = []

  await page.route('**/api/auth/me', (route) => signedIn
    ? route.fulfill({
        json: {
          user: { id: 'usr_1', email: 'organizer@nepscene.test', name: null, role: 'organizer' },
          permissions,
        },
      })
    : route.fulfill({
        status: 401, json: { error: { code: 'unauthenticated', message: 'Sign in' } },
      }))

  await page.route('**/api/author/dashboard**', (route) => {
    const url = new URL(route.request().url())
    calls.push(url.search)
    const status = url.searchParams.get('status')
    const query = (url.searchParams.get('q') ?? '').toLowerCase()
    const data = listings
      .filter((row) => !status || row.status === status)
      .filter((row) => !query || row.title.toLowerCase().includes(query))
    return route.fulfill({
      json: {
        data,
        counts: listings.reduce<Record<string, number>>((counts, row) => {
          counts[row.status] = (counts[row.status] ?? 0) + 1
          return counts
        }, {}),
        page: { limit: 25, offset: 0, has_more: false },
      },
    })
  })

  await page.route('**/api/author/listings/*/duplicate', (route) => {
    calls.push('duplicate')
    return route.fulfill({ status: 201, json: { id: 'lst_copy', slug: 'copy', status: 'draft' } })
  })
  await page.route('**/api/author/listings/*/archive', (route) => {
    calls.push('archive')
    return route.fulfill({ json: { id: 'lst_live', slug: 'rock-night', status: 'archived' } })
  })
  await page.route('**/api/author/listings/*/submit', (route) => {
    calls.push('submit')
    return route.fulfill({
      json: { id: 'lst_back', slug: 'sent-back', status: 'pending_review', duplicate: null },
    })
  })

  if (localDraft) {
    await page.addInitScript((draft) => {
      window.localStorage.setItem('nepscene:draft:lst_wip', JSON.stringify(draft))
    }, localDraft)
  }

  return { calls: () => calls }
}

test('a visitor with no session is asked to sign in', async ({ page }) => {
  await serveDashboard(page, { signedIn: false })
  await page.goto('/dashboard')

  await expect(page.getByRole('heading', { name: 'Sign in to see your listings' })).toBeVisible()
})

test('the listings show their state, their venue and how many people looked', async ({ page }) => {
  await serveDashboard(page)
  await page.goto('/dashboard')

  await expect(page.getByRole('heading', { name: 'Rock Night' })).toBeVisible()
  await expect(page.getByText('412')).toBeVisible()
  await expect(page.getByText('63')).toBeVisible()
  // The ratio is the part that says whether the listing worked, as opposed to
  // merely having been found.
  await expect(page.getByText('15%')).toBeVisible()
})

test('a listing nobody can see yet says so instead of showing a zero', async ({ page }) => {
  await serveDashboard(page)
  await page.goto('/dashboard')

  // Printing "0 views" against a rejected listing reads as failure rather than
  // as the absence of a public page.
  await expect(page.getByText('Counts start once it is published.')).toBeVisible()
})

test('a rejection reason is on the row, where the author will act on it', async ({ page }) => {
  await serveDashboard(page)
  await page.goto('/dashboard')

  await expect(page.getByText('The venue address does not match the map pin.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send again' })).toBeVisible()
})

test('filtering by state asks the server for that state', async ({ page }) => {
  const api = await serveDashboard(page)
  await page.goto('/dashboard')

  await page.getByRole('button', { name: /Published/ }).click()
  await expect(page.getByRole('heading', { name: 'Ghazal Evening' })).toHaveCount(0)
  expect(api.calls().at(-1)).toContain('status=published')
})

test('searching a title narrows the list and is one request, not one per letter', async ({ page }) => {
  const api = await serveDashboard(page)
  await page.goto('/dashboard')
  const before = api.calls().length

  await page.getByLabel('Search your listings').fill('Ghazal')
  await expect(page.getByRole('heading', { name: 'Rock Night' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Ghazal Evening' })).toBeVisible()

  expect(api.calls().length - before).toBeLessThanOrEqual(2)
})

test('a search that finds nothing does not pretend the catalogue is empty', async ({ page }) => {
  await serveDashboard(page)
  await page.goto('/dashboard')

  await page.getByLabel('Search your listings').fill('nothing like this')

  // Sending someone with fifty listings to "add your first listing" because a
  // search missed would be absurd.
  await expect(page.getByRole('heading', { name: 'Nothing matches' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add your first listing' })).toHaveCount(0)
})

test('a first-time organizer is led into the wizard', async ({ page }) => {
  await serveDashboard(page, { listings: [] })
  await page.goto('/dashboard')

  await expect(page.getByRole('heading', { name: 'Nothing listed yet' })).toBeVisible()
  await page.getByRole('button', { name: 'Add your first listing' }).click()
  await expect(page).toHaveURL(/\/submit$/)
})

test('archiving happens in place, without a page navigation', async ({ page }) => {
  const api = await serveDashboard(page)
  await page.goto('/dashboard')

  // `exact`, or the substring match picks up the "Archived" tab first.
  await page.getByRole('button', { name: 'Archive', exact: true }).first().click()

  await expect(page.getByText('Archived.')).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard$/)
  expect(api.calls()).toContain('archive')
})

test('duplicating opens the copy, because the copy exists to be edited', async ({ page }) => {
  const api = await serveDashboard(page)
  await page.goto('/dashboard')

  await page.getByRole('button', { name: 'Duplicate' }).first().click()

  expect(api.calls()).toContain('duplicate')
  await expect(page).toHaveURL(/\/submit\/lst_copy$/)
})

test('an organizer sends a rejected listing back for review rather than publishing it', async ({ page }) => {
  const api = await serveDashboard(page)
  await page.goto('/dashboard')

  await page.getByRole('button', { name: 'Send again' }).click()

  await expect(page.getByText(/Sent for review/)).toBeVisible()
  expect(api.calls()).toContain('submit')
})

test('unfinished work on the device is offered here, not only on its own page', async ({ page }) => {
  await serveDashboard(page, {
    localDraft: {
      id: 'lst_wip', step: 'details', savedAt: new Date().toISOString(),
      listing: { title: 'Half-written gig', listing_type: 'free', category_slugs: [], tags: [] },
    },
  })
  await page.goto('/dashboard')

  // The wizard's own prompt only fires on the page the draft belongs to, which
  // is the page somebody who abandoned it is not going to open again.
  await expect(page.getByText('Unfinished on this device')).toBeVisible()
  await expect(page.getByText('Half-written gig')).toBeVisible()

  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByText('Unfinished on this device')).toBeHidden()
  expect(await page.evaluate(() => window.localStorage.getItem('nepscene:draft:lst_wip')))
    .toBeNull()
})

test('an editor is offered the queue; an organizer is not', async ({ page }) => {
  await serveDashboard(page, {
    permissions: ['listing:create', 'listing:edit_own', 'listing:moderate', 'listing:publish'],
  })
  await page.goto('/dashboard')
  await expect(page.getByRole('button', { name: 'Moderation queue' })).toBeVisible()

  await page.unrouteAll()
  await serveDashboard(page)
  await page.goto('/dashboard')
  await expect(page.getByRole('button', { name: 'Moderation queue' })).toHaveCount(0)
})

test('nothing scrolls sideways at 320px', async ({ page }) => {
  await serveDashboard(page)
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/dashboard')

  await expect(page.getByRole('heading', { name: 'Your listings' })).toBeVisible()
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

/** The minimum a listing page needs to render; the beacon is what is measured. */
const viewedListing = (slug: string) => ({
  id: slug, slug, title: slug, title_ne: null, summary: null, summary_ne: null,
  listing_type: 'free', source: 'organizer', starts_at: '2026-09-11T13:00:00Z',
  ends_at: null, is_all_day: false, timezone: 'Asia/Kathmandu', cover_image_url: null,
  external_url: null, is_featured: false, map_popup_config: null,
  latitude: null, longitude: null,
  pin: { icon: 'MapPin', color: '#64748b', category: null },
  cover: null, venue: null, organizer: null, categories: [], offer: null,
  description: null, description_ne: null, published_at: null, venue_room: null,
  media: [], artists: [], tags: [], related: [],
})

test('opening a listing counts one view, and a reload does not count another', async ({ page }) => {
  const beacons: string[] = []

  /*
   * The listing itself has to be served, because the beacon now waits for the
   * record to arrive before it fires (#43). That is deliberate: counting a
   * view for a slug the catalogue has never heard of teaches the dashboard
   * that a mistyped URL is a visitor.
   *
   * Registered before the beacon route: Playwright matches the most recently
   * registered handler first, so the wildcard on the listing path would
   * otherwise swallow the events path nested under it.
   */
  await page.route('**/api/catalog/listings/*', (route) =>
    route.fulfill({ json: viewedListing(new URL(route.request().url()).pathname.split('/').pop()!) }))
  await page.route('**/api/catalog/listings/*/events', (route) => {
    beacons.push(route.request().url())
    return route.fulfill({ status: 202, body: '' })
  })

  await page.goto('/listings/rock-night')
  await expect.poll(() => beacons.length).toBe(1)

  // A reload is not a second person. Without the guard, the number an
  // organizer is asked to trust is inflated by their own refreshing.
  await page.reload()
  await page.waitForTimeout(300)
  expect(beacons).toHaveLength(1)

  // A different listing is a different view.
  await page.goto('/listings/lakeside-live')
  await expect.poll(() => beacons.length).toBe(2)
})
