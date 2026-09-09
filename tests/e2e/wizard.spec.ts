import { expect, test, type Page } from '@playwright/test'

/**
 * #30 — the listing creation wizard.
 *
 * As with the discovery specs, the Playwright server is `vite preview`, which
 * serves the built SPA and no Worker, so the authoring API is stubbed at the
 * network boundary. The stub is not a mock of convenience: it behaves the way
 * the real endpoints do — a draft accepts anything, a submission validates and
 * answers with per-field errors — because those behaviours are what the
 * criteria here are about. The API side of the same rules is covered against a
 * real D1 in tests/integration/authoring.test.ts.
 */

const CATEGORIES = [
  { slug: 'concerts', name: 'Concerts', name_ne: null, icon: 'Music', color: '#e91e63' },
  { slug: 'film', name: 'Film', name_ne: null, icon: 'Film', color: '#8b5cf6' },
  { slug: 'community', name: 'Community', name_ne: null, icon: 'Users', color: '#14b8a6' },
]

const VENUES = [
  { id: 'ven_patan', name: 'Patan Durbar Square', area: 'Patan', city: 'Lalitpur',
    latitude: 27.6727, longitude: 85.3250 },
  { id: 'ven_purple', name: 'Purple Haze Rock Bar', area: 'Thamel', city: 'Kathmandu',
    latitude: 27.7150, longitude: 85.3110 },
]

const LOOKUPS = {
  categories: CATEGORIES,
  venues: VENUES,
  artists: [{ slug: 'kutumba', name: 'Kutumba' }],
  organizations: [],
  tags: [{ slug: 'live-music', label: 'Live Music' }],
  timezones: ['Asia/Kathmandu'],
}

type Options = {
  /** Null signs the visitor out; the wizard should then show sign-in. */
  role?: 'organizer' | 'editor' | 'visitor' | null
  /** Seeds localStorage before the app boots, to exercise draft recovery. */
  localDraft?: Record<string, unknown>
}

/**
 * A stub that keeps state, so the wizard's autosave has something to autosave
 * to and edit mode has something to load back.
 */
async function serveAuthoring(page: Page, { role = 'editor', localDraft }: Options = {}) {
  const store: Record<string, unknown> = {
    title: '', summary: null, description: null, listing_type: 'free',
    organization_id: null, venue_id: null, starts_at: '', ends_at: null,
    is_all_day: false, timezone: 'Asia/Kathmandu', external_url: null, offer_url: null,
    location_lat: null, location_lng: null, map_popup_config: null,
    category_slugs: [], primary_category_slug: null, tags: [], artist_slugs: [],
  }
  let created = false

  await page.route('**/api/auth/me', (route) => {
    if (role === null) {
      return route.fulfill({
        status: 401,
        json: { error: { code: 'unauthenticated', message: 'Sign in to do that' } },
      })
    }
    const permissions = role === 'visitor' ? []
      : role === 'editor'
        ? ['listing:create', 'listing:edit_own', 'listing:publish', 'media:upload']
        : ['listing:create', 'listing:edit_own', 'media:upload']
    return route.fulfill({
      json: { user: { id: 'usr_1', email: 'author@nepscene.test', name: null, role }, permissions },
    })
  })

  await page.route('**/api/author/lookups', (route) => route.fulfill({ json: LOOKUPS }))

  await page.route('**/api/author/listings', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { data: [] } })
    Object.assign(store, route.request().postDataJSON())
    created = true
    return route.fulfill({
      status: 201, json: { id: 'lst_new', slug: 'a-draft', status: 'draft' },
    })
  })

  await page.route('**/api/author/listings/lst_new', async (route) => {
    if (route.request().method() === 'PATCH') {
      Object.assign(store, route.request().postDataJSON())
      return route.fulfill({
        json: { id: 'lst_new', slug: 'a-draft', status: 'draft',
                updated_at: new Date().toISOString() },
      })
    }
    return route.fulfill({
      json: {
        id: 'lst_new', slug: 'a-draft', status: 'draft',
        listing: store, media: [], updated_at: new Date().toISOString(),
      },
    })
  })

  // The stub validates the way the server does: the fields that are missing,
  // named, rather than a bare rejection.
  await page.route('**/api/author/listings/lst_new/submit', (route) => {
    const missing: { field: string; message: string }[] = []
    if (!String(store.title ?? '').trim()) {
      missing.push({ field: 'title', message: 'Give it a title — this is what people see first' })
    }
    if (!store.starts_at) missing.push({ field: 'starts_at', message: 'Say when it starts' })
    if (!store.venue_id) {
      missing.push({ field: 'venue_id', message: 'Choose where it happens, or add a new venue' })
    }
    if ((store.category_slugs as string[]).length === 0) {
      missing.push({ field: 'category_slugs', message: 'Pick at least one category — it decides the map pin' })
    }
    if (missing.length > 0) {
      return route.fulfill({
        status: 400,
        json: { error: { code: 'incomplete_listing', message: 'Some things still need filling in', fields: missing } },
      })
    }
    return route.fulfill({ json: { id: 'lst_new', slug: 'a-draft', status: 'pending_review' } })
  })

  await page.route('**/api/author/listings/lst_new/publish', (route) =>
    route.fulfill({ json: { id: 'lst_new', slug: 'a-draft', status: 'published' } }))

  if (localDraft) {
    await page.addInitScript((draft) => {
      window.localStorage.setItem('nepscene:draft:new', JSON.stringify(draft))
    }, localDraft)
  }

  return { store: () => store, wasCreated: () => created }
}

/** Fills the first step. Used by the tests that are about something later. */
async function fillDetails(page: Page, title = 'Kutumba at Patan Durbar') {
  await page.getByLabel('Title').fill(title)
  await page.getByRole('button', { name: 'Concerts' }).click()
}

test('a visitor with no session is asked to sign in rather than shown the form', async ({ page }) => {
  await serveAuthoring(page, { role: null })
  await page.goto('/submit')

  await expect(page.getByRole('heading', { name: 'Sign in to add a listing' })).toBeVisible()
  await expect(page.getByLabel('Email')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Next' })).toBeHidden()
})

test('an account that cannot write listings is told so plainly', async ({ page }) => {
  await serveAuthoring(page, { role: 'visitor' })
  await page.goto('/submit')

  await expect(page.getByRole('heading', { name: 'Not yet' })).toBeVisible()
  await expect(page.getByText(/cannot add listings/)).toBeVisible()
})

test('the whole journey: create, publish, and see it confirmed', async ({ page }) => {
  const api = await serveAuthoring(page)
  await page.goto('/submit')

  await expect(page.getByRole('heading', { name: 'What is it' })).toBeVisible()
  await fillDetails(page)
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByRole('heading', { name: 'When' })).toBeVisible()
  await page.getByLabel('Starts').fill('2027-03-14T18:45')
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByRole('heading', { name: 'Where' })).toBeVisible()
  await page.getByLabel('Venue', { exact: true }).selectOption('ven_patan')
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByRole('heading', { name: 'Pictures' })).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByRole('heading', { name: 'On the map' })).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible()
  await expect(page.getByText('Kutumba at Patan Durbar')).toBeVisible()
  await expect(page.getByText('Patan Durbar Square')).toBeVisible()

  // An editor publishes in the same motion; an organizer would send for review.
  await page.getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByRole('heading', { name: 'Published' })).toBeVisible()

  expect(api.wasCreated()).toBe(true)
  expect(api.store().venue_id).toBe('ven_patan')
  expect(api.store().category_slugs).toEqual(['concerts'])
})

test('an organizer sends for review rather than publishing', async ({ page }) => {
  await serveAuthoring(page, { role: 'organizer' })
  await page.goto('/submit')

  await fillDetails(page)
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Starts').fill('2027-03-14T18:45')
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Venue', { exact: true }).selectOption('ven_patan')

  // Walked to, not jumped to — a step ahead of the current one is disabled.
  for (const _ of ['where', 'media', 'appearance']) {
    await page.getByRole('button', { name: 'Next' }).click()
  }

  await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send for review' })).toBeVisible()
  await page.getByRole('button', { name: 'Send for review' }).click()

  await expect(page.getByRole('heading', { name: 'Sent for review' })).toBeVisible()
  await expect(page.getByText(/Nothing is public until/)).toBeVisible()
})

test('the step rail refuses to skip ahead but allows going back', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')

  // Nothing ahead is reachable until it has been walked to.
  await expect(page.getByRole('button', { name: /Review/ })).toBeDisabled()

  await fillDetails(page)
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { name: 'When' })).toBeVisible()

  // Going back three steps to fix a typo must not mean pressing Back three times.
  await page.getByRole('button', { name: /What is it/ }).click()
  await expect(page.getByRole('heading', { name: 'What is it' })).toBeVisible()
  await expect(page.getByLabel('Title')).toHaveValue('Kutumba at Patan Durbar')
})

test('validation names the field and blocks the step it belongs to', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')

  await page.getByRole('button', { name: 'Next' }).click()

  // Still on the first step, and told exactly what is wrong with it. Each
  // message appears twice by design — once in the summary at the top, once
  // beside the field it belongs to — so both places are checked.
  await expect(page.getByRole('heading', { name: 'What is it' })).toBeVisible()

  await expect(page.getByText('Give it a title — this is what people see first'))
    .toHaveCount(2)
  await expect(page.getByText('Pick at least one category — it decides the map pin'))
    .toHaveCount(2)
})

test('choosing “ticketed elsewhere” reveals the ticket link, and nothing else does', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')

  await expect(page.getByLabel('Where people get tickets')).toBeHidden()

  await page.getByRole('radio', { name: /Ticketed elsewhere/ }).check()
  await expect(page.getByLabel('Where people get tickets')).toBeVisible()

  await page.getByRole('radio', { name: /Ticketed on WaahTickets/ }).check()
  await expect(page.getByLabel('Where people get tickets')).toBeHidden()

  // And no step anywhere asks for a price: NepScene renders offers, never
  // computes them (docs/SCOPE.md).
  await expect(page.getByLabel(/price/i)).toHaveCount(0)
})

test('an announcement is never asked where it is', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')

  await expect(page.getByRole('button', { name: /Where/ })).toBeVisible()

  await page.getByRole('radio', { name: /Announcement/ }).check()
  await expect(page.getByRole('button', { name: /Where/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /On the map/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Review/ })).toBeVisible()
})

test('a draft left on the device is offered back, not restored behind your back', async ({ page }) => {
  await serveAuthoring(page, {
    localDraft: {
      id: null, step: 'details', savedAt: new Date().toISOString(),
      listing: {
        title: 'Half-written gig', summary: null, description: null, listing_type: 'free',
        organization_id: null, venue_id: null, starts_at: '', ends_at: null,
        is_all_day: false, timezone: 'Asia/Kathmandu', external_url: null, offer_url: null,
        location_lat: null, location_lng: null, map_popup_config: null,
        category_slugs: ['film'], primary_category_slug: 'film', tags: [], artist_slugs: [],
      },
    },
  })
  await page.goto('/submit')

  await expect(page.getByText('You have unsaved work on this device')).toBeVisible()
  // Offered, not applied — the form is still empty until the author says so.
  await expect(page.getByLabel('Title')).toHaveValue('')

  await page.getByRole('button', { name: 'Pick up where I left off' }).click()
  await expect(page.getByLabel('Title')).toHaveValue('Half-written gig')
  await expect(page.getByText('You have unsaved work on this device')).toBeHidden()
})

test('a recovered draft can be thrown away instead', async ({ page }) => {
  await serveAuthoring(page, {
    localDraft: {
      id: null, step: 'details', savedAt: new Date().toISOString(),
      listing: { title: 'Abandoned', listing_type: 'free', category_slugs: [], tags: [] },
    },
  })
  await page.goto('/submit')

  await page.getByRole('button', { name: 'Discard it' }).click()
  await expect(page.getByText('You have unsaved work on this device')).toBeHidden()
  await expect(page.getByLabel('Title')).toHaveValue('')

  // Gone from the device, not merely dismissed for this visit. This only holds
  // because an empty form no longer autosaves over the key it just cleared.
  expect(await page.evaluate(() => window.localStorage.getItem('nepscene:draft:new')))
    .toBeNull()
})

test('opening the wizard and walking away creates nothing', async ({ page }) => {
  const api = await serveAuthoring(page)
  await page.goto('/submit')
  await expect(page.getByRole('heading', { name: 'What is it' })).toBeVisible()

  // Well past the 1.5s autosave debounce. An untouched form is a full object of
  // defaults, and saving it would leave a titleless draft in the author's list
  // for every visit to /submit.
  await page.waitForTimeout(2500)

  expect(api.wasCreated()).toBe(false)
  expect(await page.evaluate(() => window.localStorage.getItem('nepscene:draft:new')))
    .toBeNull()
})

test('the first real keystroke is what starts the draft', async ({ page }) => {
  const api = await serveAuthoring(page)
  await page.goto('/submit')

  await page.getByLabel('Title').fill('Now there is something')
  await expect(page.getByText('Saved')).toBeVisible()

  expect(api.wasCreated()).toBe(true)
  expect(api.store().title).toBe('Now there is something')
})

test('autosave does not offer to recover the draft you are still typing', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')

  await page.getByLabel('Title').fill('Being typed right now')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()

  // The first save rewrites the URL to the draft's own address, which sends a
  // new listingId down from the route. If the wizard treated that as "open a
  // different listing" it would reload and offer back the local copy of what
  // is on screen — a recovery prompt in the middle of writing.
  await expect(page).toHaveURL(/\/submit\/lst_new$/)
  await expect(page.getByText('You have unsaved work on this device')).toBeHidden()
  await expect(page.getByLabel('Title')).toHaveValue('Being typed right now')
})

test('editing an existing listing does not make you walk the wizard again', async ({ page }) => {
  await serveAuthoring(page)
  await page.route('**/api/author/listings/lst_new', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      json: {
        id: 'lst_new', slug: 'a-draft', status: 'draft', media: [],
        updated_at: new Date().toISOString(),
        listing: {
          title: 'Finished already', summary: null, description: null,
          listing_type: 'free', organization_id: null, venue_id: 'ven_purple',
          starts_at: '2027-04-01T12:00:00Z', ends_at: null, is_all_day: false,
          timezone: 'Asia/Kathmandu', external_url: null, offer_url: null,
          location_lat: null, location_lng: null, map_popup_config: null,
          category_slugs: ['film'], primary_category_slug: 'film',
          tags: [], artist_slugs: [],
        },
      },
    })
  })

  await page.goto('/submit/lst_new')
  await expect(page.getByLabel('Title')).toHaveValue('Finished already')

  // Its steps were all filled in before it was saved. Making someone press Next
  // five times to change one word is re-entry, not editing.
  await page.getByRole('button', { name: /Review/ }).click()
  await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible()
  await expect(page.getByText('Finished already')).toBeVisible()
})

test('an edit-mode load fills the form from the server', async ({ page }) => {
  await serveAuthoring(page)
  await page.route('**/api/author/listings/lst_new', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      json: {
        id: 'lst_new', slug: 'a-draft', status: 'draft', media: [],
        updated_at: new Date().toISOString(),
        listing: {
          title: 'Already written', summary: 'A summary', description: null,
          listing_type: 'free', organization_id: null, venue_id: 'ven_purple',
          starts_at: '2027-04-01T12:00:00Z', ends_at: null, is_all_day: false,
          timezone: 'Asia/Kathmandu', external_url: null, offer_url: null,
          location_lat: null, location_lng: null, map_popup_config: null,
          category_slugs: ['film'], primary_category_slug: 'film',
          tags: ['Outdoors'], artist_slugs: [],
        },
      },
    })
  })

  await page.goto('/submit/lst_new')

  await expect(page.getByLabel('Title')).toHaveValue('Already written')
  await expect(page.getByLabel('One-line summary')).toHaveValue('A summary')
  await expect(page.getByRole('button', { name: 'Film', pressed: true })).toBeVisible()
  await expect(page.getByText('Outdoors')).toBeVisible()
})

test('the whole wizard is operable from the keyboard alone', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')

  // Tab until the title field has focus, then type into it — no clicking.
  await page.keyboard.press('Tab')
  for (let i = 0; i < 25; i++) {
    if (await page.getByLabel('Title').evaluate((el) => el === document.activeElement)) break
    await page.keyboard.press('Tab')
  }
  await expect(page.getByLabel('Title')).toBeFocused()
  await page.keyboard.type('Typed with no mouse')

  // Reach the category chips and toggle one with the keyboard.
  const chip = page.getByRole('button', { name: 'Concerts' })
  await chip.focus()
  await page.keyboard.press('Enter')
  await expect(chip).toHaveAttribute('aria-pressed', 'true')

  const next = page.getByRole('button', { name: 'Next' })
  await next.focus()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('heading', { name: 'When' })).toBeVisible()
  // Focus lands on the new step's heading, so a screen reader is told the page
  // changed — a client-side step change announces nothing on its own.
  await expect(page.getByRole('heading', { name: /When/ })).toBeFocused()
})

test('the step heading says which step this is, for a screen reader', async ({ page }) => {
  await serveAuthoring(page)
  await page.goto('/submit')

  await expect(page.getByRole('heading', { level: 1 })).toContainText('step 1 of 6')

  await fillDetails(page)
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('step 2 of 6')
})

test('nothing scrolls sideways at 320px', async ({ page }) => {
  await serveAuthoring(page)
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/submit')

  await expect(page.getByRole('heading', { name: 'What is it' })).toBeVisible()
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
