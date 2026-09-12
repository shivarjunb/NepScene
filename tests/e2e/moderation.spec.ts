import { expect, test, type Page } from '@playwright/test'

/**
 * #33 — the moderation queue in a browser.
 *
 * The rules underneath are tested against a real D1 in
 * tests/integration/moderation.test.ts. What is settled here is the part only
 * a browser can settle: that a rejection cannot be sent without a reason, that
 * the duplicate flag is on the row rather than behind a click, that a bulk
 * action reaches the API as one call, and that all of it works from a keyboard
 * at 320px.
 */

type Row = {
  id: string; slug: string; title: string; status: string
  listing_type: string; source: string; starts_at: string; updated_at: string
  venue_name: string | null
  author: { email: string; name: string | null } | null
  organization_name: string | null; media_count: number; category_slugs: string[]
  duplicate: { id: string; slug: string; title: string; status: string; score: number } | null
}

const WAITING: Row[] = [
  {
    id: 'lst_a', slug: 'kutumba-live', title: 'Kutumba at Patan Durbar',
    status: 'pending_review', listing_type: 'free', source: 'organizer',
    starts_at: '2027-03-14T13:00:00Z', updated_at: '2026-09-01T10:00:00Z',
    venue_name: 'Patan Durbar Square',
    author: { email: 'author@nepscene.test', name: null },
    organization_name: null, media_count: 1, category_slugs: ['concerts'],
    duplicate: null,
  },
  {
    id: 'lst_b', slug: 'rock-night-again', title: 'Rock Night',
    status: 'pending_review', listing_type: 'free', source: 'submission',
    starts_at: '2027-03-15T13:00:00Z', updated_at: '2026-09-02T10:00:00Z',
    venue_name: 'Purple Haze Rock Bar',
    author: { email: 'someone@nepscene.test', name: null },
    organization_name: null, media_count: 0, category_slugs: ['concerts'],
    duplicate: { id: 'lst_live', slug: 'rock-night', title: 'Rock Night', status: 'published', score: 0.92 },
  },
]

/** An import as it lands in the queue: a draft, scraped, with no category yet. */
const IMPORT: Row = {
  id: 'lst_import', slug: 'imported-gig', title: 'Imported Gig',
  status: 'draft', listing_type: 'free', source: 'import',
  starts_at: '2027-04-01T13:00:00Z', updated_at: '2026-09-03T10:00:00Z',
  venue_name: 'Purple Haze Rock Bar',
  author: null, organization_name: null, media_count: 0, category_slugs: [],
  duplicate: null,
}

type Refusal = {
  id: string; title: string | null; reason: string
  fields?: { field: string; message: string }[]
}

type Call = { action?: string; ids?: string[]; reason?: string; into?: string; path: string }

async function serveQueue(page: Page, {
  role = 'editor', rows: initial = WAITING, refuse = {},
}: {
  role?: 'editor' | 'organizer'
  rows?: Row[]
  /** Rows the bulk action turns down, by id — the server's per-row refusal. */
  refuse?: Record<string, Refusal>
} = {}) {
  const calls: Call[] = []
  let rows = [...initial]

  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: {
      user: { id: 'usr_e', email: 'editor@nepscene.test', name: null, role },
      permissions: role === 'editor'
        ? ['listing:create', 'listing:edit_own', 'listing:publish', 'listing:moderate']
        : ['listing:create', 'listing:edit_own'],
    },
  }))

  await page.route('**/api/author/queue?**', (route) => {
    const status = new URL(route.request().url()).searchParams.get('status')
    return route.fulfill({
      json: {
        data: rows.filter((row) => row.status === status),
        counts: { pending_review: rows.length, published: 12, rejected: 1, draft: 3, archived: 4 },
        next: null,
      },
    })
  })

  await page.route('**/api/author/queue/actions', async (route) => {
    const body = route.request().postDataJSON() as Call
    calls.push({ ...body, path: 'actions' })
    // The server refuses a rejection with no reason; so does the stub, because
    // that refusal is what the form in front of it exists for.
    if (body.action === 'reject' && (body.reason ?? '').trim().length < 10) {
      return route.fulfill({
        status: 400,
        json: { error: { code: 'reason_required', message: 'Say why' } },
      })
    }
    const refused = (body.ids ?? []).filter((id) => id in refuse).map((id) => refuse[id])
    const applied = (body.ids ?? []).filter((id) => !(id in refuse))
    rows = rows.filter((row) => !applied.includes(row.id))
    // The API answers with the state reached, not the verb sent — `publish`
    // becomes `published` — and the queue puts that word straight into the
    // confirmation, so the stub has to make the same turn.
    const reached = { publish: 'published', reject: 'rejected', archive: 'archived' }[
      body.action as 'publish' | 'reject' | 'archive'
    ]
    return route.fulfill({ json: { applied, refused, status: reached } })
  })

  // Enough of the authoring API for the editor dialog to open on one listing
  // and publish it. The wizard itself is driven in full in wizard.spec.ts.
  const stored = {
    title: 'Kutumba at Patan Durbar', summary: null, description: null, listing_type: 'free',
    organization_id: null, venue_id: 'ven_patan', starts_at: '2027-03-14T13:00:00Z',
    ends_at: null, is_all_day: false, timezone: 'Asia/Kathmandu',
    external_url: null, offer_url: null, location_lat: null, location_lng: null,
    map_popup_config: null, category_slugs: ['concerts'], primary_category_slug: 'concerts',
    tags: [], artist_slugs: [],
  }
  await page.route('**/api/author/lookups', (route) => route.fulfill({
    json: {
      categories: [{ slug: 'concerts', name: 'Concerts', name_ne: null, icon: 'Music', color: '#e91e63' }],
      venues: [{ id: 'ven_patan', name: 'Patan Durbar Square', area: 'Patan', city: 'Lalitpur',
                 latitude: 27.6727, longitude: 85.3250 }],
      artists: [], organizations: [], tags: [], timezones: ['Asia/Kathmandu'],
    },
  }))
  await page.route('**/api/author/listings/lst_a', (route) => {
    if (route.request().method() === 'PATCH') {
      Object.assign(stored, route.request().postDataJSON())
      return route.fulfill({
        json: { id: 'lst_a', slug: 'kutumba-live', status: 'pending_review',
                updated_at: new Date().toISOString() },
      })
    }
    return route.fulfill({
      json: { id: 'lst_a', slug: 'kutumba-live', status: 'pending_review',
              listing: stored, media: [], updated_at: '2026-09-01T10:00:00Z' },
    })
  })
  await page.route('**/api/author/listings/lst_a/publish', (route) => {
    calls.push({ path: 'publish', ids: ['lst_a'] })
    rows = rows.filter((row) => row.id !== 'lst_a')
    return route.fulfill({ json: { id: 'lst_a', slug: 'kutumba-live', status: 'published' } })
  })

  await page.route('**/api/author/listings/*/merge', (route) => {
    const body = route.request().postDataJSON() as Call
    calls.push({ ...body, path: route.request().url() })
    rows = rows.filter((row) => row.id !== 'lst_b')
    return route.fulfill({ json: { merged: 'lst_b', into: body.into, slug: 'rock-night', inherited: [] } })
  })

  return { calls: () => calls }
}

test('an account that cannot moderate is turned away, and pointed somewhere useful', async ({ page }) => {
  await serveQueue(page, { role: 'organizer' })
  await page.goto('/moderate')

  await expect(page.getByRole('heading', { name: 'Not for this account' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'your dashboard' })).toBeVisible()
})

test('the queue shows what is waiting, with the counts on the tabs', async ({ page }) => {
  await serveQueue(page)
  await page.goto('/moderate')

  await expect(page.getByRole('heading', { name: 'Moderation queue' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Kutumba at Patan Durbar' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Waiting\s*2/ })).toBeVisible()
})

test('a flagged duplicate is on the row, not behind a click', async ({ page }) => {
  await serveQueue(page)
  await page.goto('/moderate')

  // The whole point of flagging at submission is that the person about to
  // approve both can see it without opening anything.
  await expect(page.getByText('This may already be in the catalogue')).toBeVisible()
  await expect(page.getByText('92% match')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Merge into it' })).toBeVisible()
})

test('merging sends the flagged listing into the one it matched', async ({ page }) => {
  const api = await serveQueue(page)
  await page.goto('/moderate')

  await page.getByRole('button', { name: 'Merge into it' }).click()

  await expect(page.getByText(/Merged into/)).toBeVisible()
  expect(api.calls().at(-1)).toMatchObject({ into: 'lst_live' })
  await expect(page.getByRole('heading', { name: 'Rock Night' })).toHaveCount(0)
})

test('publishing one listing is one call, and the row goes', async ({ page }) => {
  const api = await serveQueue(page)
  await page.goto('/moderate')

  // `exact`, because getByRole matches an accessible name by substring by
  // default and "Publish" is inside the "Published 12" tab, which comes first.
  await page.getByRole('button', { name: 'Publish', exact: true }).first().click()

  await expect(page.getByText('1 listing published.')).toBeVisible()
  expect(api.calls().at(-1)).toMatchObject({ action: 'publish', ids: ['lst_a'] })
})

test('a refused publish opens a dialog that names the listing and what to fix', async ({ page }) => {
  // The scenario as reported: an imported draft, selected and published from
  // the queue. The old answer was "1 could not move: A listing cannot go from
  // draft to published" in the success banner.
  await serveQueue(page, {
    rows: [...WAITING, IMPORT],
    refuse: {
      lst_import: {
        id: 'lst_import', title: 'Imported Gig',
        reason: 'Some things still need filling in before this can be published',
        fields: [{ field: 'category_slugs', message: 'Pick at least one category — it decides the map pin' }],
      },
    },
  })
  await page.goto('/moderate')
  await page.getByRole('button', { name: 'Drafts' }).click()
  await page.getByRole('checkbox', { name: 'Select “Imported Gig”' }).check()
  await page.getByRole('group', { name: 'Actions for the selected listings' })
    .getByRole('button', { name: 'Publish', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'This one could not be published' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Imported Gig' })).toBeVisible()
  await expect(dialog.getByText('Some things still need filling in before this can be published')).toBeVisible()
  await expect(dialog.getByText('Pick at least one category — it decides the map pin')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Edit' })).toBeVisible()
  // Nothing was done, so nothing claims to have been.
  await expect(page.getByText('Done')).toHaveCount(0)

  // Edit from the dialog opens the editor in place of it — one dialog at a time.
  await dialog.getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('dialog', { name: 'Imported Gig' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'This one could not be published' })).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/moderate')
})

test('editing opens the wizard over the queue, and publishing from it closes it', async ({ page }) => {
  const api = await serveQueue(page)
  await page.goto('/moderate')

  await page.getByRole('button', { name: 'Edit' }).first().click()

  const dialog = page.getByRole('dialog', { name: 'Kutumba at Patan Durbar' })
  await expect(dialog).toBeVisible()
  // Still the queue underneath: no navigation to /submit/:id.
  expect(new URL(page.url()).pathname).toBe('/moderate')
  await expect(dialog.getByRole('heading', { name: /What is it/ })).toBeVisible()

  // A loaded listing has every step unlocked, so Review is one click away.
  await dialog.getByRole('button', { name: 'Review' }).click()
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click()

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('“Kutumba at Patan Durbar” is published.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Kutumba at Patan Durbar' })).toHaveCount(0)
  // A listing already waiting for review is published, not submitted again.
  expect(api.calls().map((call) => call.path)).toEqual(['publish'])
})

test('a rejection cannot be sent without a reason', async ({ page }) => {
  const api = await serveQueue(page)
  await page.goto('/moderate')

  await page.getByRole('button', { name: 'Reject…' }).first().click()
  await expect(page.getByRole('heading', { name: /Why is this coming back/ })).toBeVisible()

  // Disabled until there is a sentence: the author reads this verbatim, and
  // "rejected" on its own tells them nothing they can act on.
  const send = page.getByRole('button', { name: 'Send it back' })
  await expect(send).toBeDisabled()

  await page.getByLabel('Reason').fill('no')
  await expect(send).toBeDisabled()
  await expect(page.getByText('A sentence, not a word')).toBeVisible()

  await page.getByLabel('Reason').fill('The date is next month, not this one.')
  await expect(send).toBeEnabled()
  await send.click()

  await expect(page.getByText('1 listing rejected.')).toBeVisible()
  expect(api.calls().at(-1)).toMatchObject({
    action: 'reject', ids: ['lst_a'], reason: 'The date is next month, not this one.',
  })
})

test('a bulk action covers every selected row in one call', async ({ page }) => {
  const api = await serveQueue(page)
  await page.goto('/moderate')

  await page.getByLabel('Select everything on this page').check()
  await expect(page.getByText('2 selected')).toBeVisible()

  await page.getByRole('button', { name: 'Publish', exact: true }).first().click()

  await expect(page.getByText('2 listings published.')).toBeVisible()
  const last = api.calls().at(-1)
  expect(last?.action).toBe('publish')
  expect(last?.ids?.sort()).toEqual(['lst_a', 'lst_b'])
  // One request, not one per row: fifty rejections must not be fifty calls.
  expect(api.calls().filter((call) => call.path === 'actions')).toHaveLength(1)
})

test('a bulk rejection asks once and applies the same reason to all of them', async ({ page }) => {
  const api = await serveQueue(page)
  await page.goto('/moderate')

  await page.getByLabel('Select everything on this page').check()
  await page.getByRole('button', { name: 'Reject…' }).first().click()

  await expect(page.getByRole('heading', { name: /Why is each of these 2 coming back/ }))
    .toBeVisible()
  await page.getByLabel('Reason').fill('These are duplicates of listings already published.')
  await page.getByRole('button', { name: 'Send it back' }).click()

  expect(api.calls().at(-1)).toMatchObject({ action: 'reject', ids: ['lst_a', 'lst_b'] })
})

test('the queue is worked through from the keyboard alone', async ({ page }) => {
  const api = await serveQueue(page)
  await page.goto('/moderate')

  const first = page.getByRole('checkbox', { name: 'Select “Kutumba at Patan Durbar”' })
  await first.focus()
  await page.keyboard.press('Space')
  await expect(page.getByText('1 selected')).toBeVisible()

  const publish = page.getByRole('button', { name: 'Publish', exact: true }).first()
  await publish.focus()
  await page.keyboard.press('Enter')

  await expect(page.getByText('1 listing published.')).toBeVisible()
  expect(api.calls().at(-1)).toMatchObject({ ids: ['lst_a'] })
})

test('an empty queue says so rather than showing an empty box', async ({ page }) => {
  await serveQueue(page)
  await page.goto('/moderate')

  await page.getByRole('button', { name: /Drafts/ }).click()
  await expect(page.getByText('Nothing here.')).toBeVisible()
})

test('nothing scrolls sideways at 320px', async ({ page }) => {
  await serveQueue(page)
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/moderate')

  await expect(page.getByRole('heading', { name: 'Moderation queue' })).toBeVisible()
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
