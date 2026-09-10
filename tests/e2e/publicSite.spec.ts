import { expect, test, type Page } from '@playwright/test'

/**
 * The public site's journeys (#42, #43, #44, #46).
 *
 * The Playwright server is `vite preview`, which serves the built SPA and no
 * Worker, so the catalogue is stubbed at the network boundary — the same
 * arrangement discover.spec.ts uses, and for the same reason: the cases the
 * acceptance criteria name (an offer that cannot be resolved, a venue with
 * nothing coming up, a search that corrects a spelling) are states, and a seed
 * cannot be asked to be in one on demand.
 *
 * The clock is frozen so "this weekend" and the date on every card are fixed
 * rather than being whatever they are on the day CI runs.
 */
const THURSDAY = new Date('2026-09-10T06:00:00Z')

const listing = (over: Record<string, unknown> & { slug: string }) => ({
  id: over.slug,
  title: over.slug,
  title_ne: null,
  summary: null,
  summary_ne: null,
  listing_type: 'ticketed_internal',
  source: 'organizer',
  starts_at: '2026-09-11T13:00:00Z',
  ends_at: null,
  is_all_day: false,
  timezone: 'Asia/Kathmandu',
  cover_image_url: null,
  external_url: null,
  is_featured: false,
  map_popup_config: null,
  latitude: 27.7154,
  longitude: 85.3105,
  pin: { icon: 'MapPin', color: '#64748b', category: null },
  cover: null,
  venue: { id: 'v1', slug: 'purple-haze', name: 'Purple Haze', area: 'Thamel', city: 'Kathmandu' },
  organizer: { id: 'o1', slug: 'himalayan-sound', name: 'Himalayan Sound', is_verified: true },
  categories: [{ slug: 'concerts', name: 'Concerts', name_ne: 'कन्सर्ट', color: '#e91e63', icon: null, is_primary: true }],
  offer: null,
  ...over,
})

const detail = (over: Record<string, unknown> & { slug: string }) => ({
  ...listing(over),
  description: 'Two sets, doors at seven.\n\nBring a friend.',
  description_ne: null,
  published_at: '2026-09-01T00:00:00Z',
  venue_room: null,
  venue: {
    id: 'v1', slug: 'purple-haze', name: 'Purple Haze', area: 'Thamel', city: 'Kathmandu',
    address: 'Bhagwan Bahal', district: 'Kathmandu', province: 'Bagmati',
    latitude: 27.7154, longitude: 85.3105,
  },
  media: [],
  artists: [{ slug: 'kutumba', name: 'Kutumba', image_url: null, listing_count: 3, has_page: true }],
  tags: [{ slug: 'live-music', label: 'Live Music' }],
  related: [listing({ slug: 'kutumba-live', title: 'Kutumba Live' })],
  ...over,
})

const TICKETED = detail({
  slug: 'rock-night',
  title: 'Rock Night',
  title_ne: 'रक नाइट',
  summary: 'Four bands, one night.',
  summary_ne: 'चार ब्यान्ड, एक रात।',
  offer: {
    purchasable: true, price_from: 80000, currency: 'NPR',
    url: 'https://waahtickets.example/e/rock-night', provider: 'waahtickets',
    sold_out: false, checked_at: '2026-09-09T00:00:00Z',
  },
})

const FREE = detail({
  slug: 'lake-cleanup', title: 'Lake Clean-up', listing_type: 'free', offer: null,
  external_url: 'https://example.org/cleanup',
})

/** A ticketed listing whose offer could not be resolved — #43's degradation. */
const UNRESOLVED = detail({
  slug: 'kutumba-live', title: 'Kutumba Live', offer: null,
  external_url: 'https://example.org/kutumba',
})

const RESULTS = {
  data: [listing({ slug: 'rock-night', title: 'Rock Night' }),
         listing({ slug: 'kutumba-live', title: 'Kutumba Live' })],
  page: { limit: 20, has_more: false, next_cursor: null },
  facets: {
    city: [{ value: 'Kathmandu', label: 'Kathmandu', count: 2 },
           { value: 'Pokhara', label: 'Pokhara', count: 1 }],
    category: [{ value: 'concerts', label: 'Concerts', label_ne: 'कन्सर्ट', count: 2 },
               { value: 'markets', label: 'Markets', label_ne: 'बजार', count: 1 }],
    price: [{ value: 'ticketed', label: 'Ticketed', count: 2 },
            { value: 'free', label: 'Free', count: 1 }],
    when: [{ value: 'today', label: 'Today', count: 1, from: null, to: '2026-09-10T18:15:00Z' },
           { value: 'later', label: 'Later', count: 2, from: '2026-09-30T18:15:00Z', to: null }],
  },
  corrected_from: null,
  alternatives: [],
}

const VENUE = {
  venue: {
    id: 'v1', slug: 'purple-haze', name: 'Purple Haze', area: 'Thamel', city: 'Kathmandu',
    district: 'Kathmandu', province: 'Bagmati', address: 'Bhagwan Bahal',
    latitude: 27.7154, longitude: 85.3105, cover_image_url: null, is_verified: true,
    upcoming_listing_count: 1, past_listing_count: 1,
    description: 'A basement with a good PA.', website_url: null, phone: null,
    capacity: 180, google_place_id: null,
  },
  listings: [listing({ slug: 'kutumba-live', title: 'Kutumba Live' })],
  past: [listing({ slug: 'finished-gig', title: 'Finished Gig', starts_at: '2026-08-01T13:00:00Z' })],
}

/** #44's case: nothing coming up, so the page shows what has been. */
const QUIET_VENUE = {
  venue: { ...VENUE.venue, slug: 'quiet-hall', name: 'Quiet Hall', upcoming_listing_count: 0 },
  listings: [],
  past: [listing({ slug: 'quiet-recital', title: 'Quiet Recital', starts_at: '2026-08-01T13:00:00Z' })],
}

const BOOTSTRAP = {
  categories: [{ slug: 'concerts', name: 'Concerts', name_ne: 'कन्सर्ट', color: '#e91e63', icon: null, upcoming_listing_count: 2 }],
  featured: [],
  upcoming: [listing({ slug: 'rock-night', title: 'Rock Night' })],
}

async function serve(page: Page, overrides: Record<string, unknown> = {}) {
  await page.clock.install({ time: THURSDAY })
  const details: Record<string, unknown> = {
    'rock-night': TICKETED, 'lake-cleanup': FREE, 'kutumba-live': UNRESOLVED,
    ...(overrides.details as Record<string, unknown> ?? {}),
  }

  await page.route('**/api/catalog/bootstrap', (route) => route.fulfill({ json: BOOTSTRAP }))
  await page.route('**/api/catalog/suggest*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? ''
    const all = [
      { kind: 'listing', slug: 'rock-night', label: 'Rock Night' },
      { kind: 'venue', slug: 'purple-haze', label: 'Purple Haze' },
      { kind: 'city', slug: 'kathmandu', label: 'Kathmandu' },
    ]
    return route.fulfill({
      json: { data: all.filter((entry) => entry.label.toLowerCase().includes(q.toLowerCase())) },
    })
  })
  await page.route('**/api/catalog/search*', (route) => {
    const params = new URL(route.request().url()).searchParams
    const json = overrides.search
      ? overrides.search
      : {
          ...RESULTS,
          data: params.get('city') === 'Pokhara' ? [RESULTS.data[1]] : RESULTS.data,
        }
    return route.fulfill({ json })
  })
  await page.route('**/api/catalog/listings/*', (route) => {
    const slug = new URL(route.request().url()).pathname.split('/').pop() ?? ''
    const body = details[slug]
    return body
      ? route.fulfill({ json: body })
      : route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'No such listing' } } })
  })
  await page.route('**/api/catalog/listings*', (route) =>
    route.fulfill({ json: { data: RESULTS.data, page: { limit: 20, has_more: false, next_cursor: null } } }))
  await page.route('**/api/catalog/venues/*', (route) => {
    const slug = new URL(route.request().url()).pathname.split('/').pop() ?? ''
    return route.fulfill({ json: slug === 'quiet-hall' ? QUIET_VENUE : VENUE })
  })
  await page.route('**/api/catalog/venues*', (route) => route.fulfill({
    json: { data: [VENUE.venue, QUIET_VENUE.venue], page: { limit: 50, has_more: false, next_cursor: null } },
  }))
  await page.route('**/api/catalog/organizers*', (route) => route.fulfill({
    json: { data: [], page: { limit: 50, has_more: false, next_cursor: null } },
  }))
  // The beacon is fire-and-forget; nothing on the page waits on it.
  await page.route('**/events', (route) => route.fulfill({ status: 202, body: '' }))
}

// ── #42 ──────────────────────────────────────────────────────────────────────
test('search, refine by facet, open a result', async ({ page }) => {
  await serve(page)
  await page.goto('/search')

  await page.getByRole('combobox', { name: 'Search' }).first().fill('rock')
  await page.getByRole('combobox', { name: 'Search' }).first().press('Enter')
  await expect(page).toHaveURL(/\/search\?q=rock/)
  await expect(page.getByRole('heading', { level: 2, name: /Results for/ })).toBeVisible()

  // The facet count is the server's, and clicking it puts the filter in the URL
  // — which is what makes a refined search shareable.
  await page.getByRole('link', { name: /Pokhara 1/ }).click()
  await expect(page).toHaveURL(/city=Pokhara/)
  await expect(page.locator('.grid > li')).toHaveCount(1)

  await page.getByRole('heading', { name: 'Kutumba Live' }).click()
  await expect(page).toHaveURL(/\/listings\/kutumba-live/)
})

test('suggestions appear as you type and go straight to the thing', async ({ page }) => {
  await serve(page)
  await page.goto('/search')

  const box = page.getByRole('combobox', { name: 'Search' }).first()
  await box.fill('purp')
  await expect(page.getByRole('option', { name: /Purple Haze/ })).toBeVisible()

  // Arrow and Enter, not a click: the combobox has to be operable from the
  // keyboard, which is the half of the pattern that is easy to leave out.
  await box.press('ArrowDown')
  await box.press('Enter')
  await expect(page).toHaveURL(/\/venues\/purple-haze/)
})

test('a search that found nothing offers somewhere to go', async ({ page }) => {
  await serve(page, {
    search: {
      data: [], page: { limit: 20, has_more: false, next_cursor: null },
      facets: { city: [], category: [], price: [], when: [] },
      corrected_from: null,
      alternatives: [{ kind: 'category', slug: 'concerts', label: 'Concerts' }],
    },
  })
  await page.goto('/search?q=zzzz')

  await expect(page.getByText(/Nothing matched/)).toBeVisible()
  await page.getByRole('link', { name: 'Concerts' }).click()
  await expect(page).toHaveURL(/category=concerts/)
})

test('a corrected spelling is announced, and the original is offered back', async ({ page }) => {
  await serve(page, { search: { ...RESULTS, corrected_from: 'kutumbaa' } })
  await page.goto('/search?q=kutumbaa')

  await expect(page.getByText(/corrected spelling of .kutumbaa./)).toBeVisible()
  await page.getByRole('link', { name: /Search for .kutumbaa. instead/ }).click()
  await expect(page).toHaveURL(/exact=1/)
})

// ── #43 ──────────────────────────────────────────────────────────────────────
test('a ticketed listing shows a price and a buy hand-off', async ({ page }) => {
  await serve(page)
  await page.goto('/listings/rock-night')

  await expect(page.getByRole('heading', { level: 1, name: 'Rock Night' })).toBeVisible()
  await expect(page.getByText('From NPR 800')).toBeVisible()

  const tickets = page.getByRole('link', { name: 'Get tickets' })
  await expect(tickets).toHaveAttribute('href', 'https://waahtickets.example/e/rock-night')
  // A hand-off, not a checkout: it leaves the site, and it leaves it safely.
  await expect(tickets).toHaveAttribute('rel', /noopener/)
})

test('a free listing shows no price and no buy affordance', async ({ page }) => {
  await serve(page)
  await page.goto('/listings/lake-cleanup')

  await expect(page.getByText('Free entry')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Get tickets' })).toHaveCount(0)
  await expect(page.getByText(/From NPR/)).toHaveCount(0)
})

test('a listing whose offer cannot be resolved still renders in full', async ({ page }) => {
  await serve(page)
  await page.goto('/listings/kutumba-live')

  // Everything above the offer is catalogue data and is unaffected.
  await expect(page.getByRole('heading', { level: 1, name: 'Kutumba Live' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Purple Haze' }).first()).toBeVisible()
  await expect(page.getByText('Two sets, doors at seven.')).toBeVisible()

  // And the offer says so rather than disappearing or erroring.
  await expect(page.getByText('Ticket details are not available right now.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Get tickets' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Visit the event site' })).toBeVisible()
})

test('a listing offers WhatsApp, a calendar file and related listings', async ({ page }) => {
  await serve(page)
  await page.goto('/listings/rock-night')

  const whatsapp = page.getByRole('link', { name: 'Share on WhatsApp' })
  await expect(whatsapp).toHaveAttribute('href', /api\.whatsapp\.com\/send\?text=/)
  await expect(whatsapp).toHaveAttribute('href', /Rock%20Night/)

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Add to calendar' }).click()
  expect((await download).suggestedFilename()).toBe('rock-night.ics')

  await expect(page.getByRole('heading', { name: 'You might also like' })).toBeVisible()
  // Never itself.
  await expect(page.locator('.grid').getByRole('heading', { name: 'Rock Night' })).toHaveCount(0)
})

test('a listing that is not there says so rather than showing an error', async ({ page }) => {
  await serve(page)
  await page.goto('/listings/nothing-here')

  await expect(page.getByRole('heading', { level: 1, name: 'No such listing' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to the homepage' })).toBeVisible()
})

// ── #44 ──────────────────────────────────────────────────────────────────────
test('from a listing to its venue to another listing', async ({ page }) => {
  await serve(page)
  await page.goto('/listings/rock-night')

  await page.getByRole('link', { name: 'Purple Haze' }).first().click()
  await expect(page).toHaveURL(/\/venues\/purple-haze/)
  await expect(page.getByRole('heading', { level: 1, name: 'Purple Haze' })).toBeVisible()

  await page.getByRole('heading', { name: 'Kutumba Live' }).click()
  await expect(page).toHaveURL(/\/listings\/kutumba-live/)
})

test('a venue page separates what is on from what has been', async ({ page }) => {
  await serve(page)
  await page.goto('/venues/purple-haze')

  await expect(page.getByRole('heading', { level: 2, name: 'What’s on' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Previously here' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Directions' }))
    .toHaveAttribute('href', /google\.com\/maps/)
})

test('a venue with nothing coming up shows past listings, not an empty page', async ({ page }) => {
  await serve(page)
  await page.goto('/venues/quiet-hall')

  await expect(page.getByText('Nothing coming up right now.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Quiet Recital' })).toBeVisible()
})

test('the follow entry point is present and honest about not working yet', async ({ page }) => {
  await serve(page)
  await page.goto('/venues/purple-haze')

  const follow = page.getByRole('button', { name: 'Follow' })
  await expect(follow).toBeDisabled()
  await expect(page.getByText('Following arrives after launch.')).toBeVisible()
})

// ── #46 ──────────────────────────────────────────────────────────────────────
test('switching language mid-journey keeps the page and the filters', async ({ page }) => {
  await serve(page)
  await page.goto('/search?q=rock&city=Pokhara')

  await page.getByRole('button', { name: 'नेपाली' }).click()

  // Same URL, same filter, same query — only the language changed.
  await expect(page).toHaveURL(/\/search\?q=rock&city=Pokhara/)
  await expect(page.locator('html')).toHaveAttribute('lang', 'ne')
  await expect(page.getByRole('heading', { level: 1, name: 'खोज' })).toBeVisible()
})

test('the language choice survives a reload and a navigation', async ({ page }) => {
  await serve(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'नेपाली' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'नेपालभरि के-के भइरहेको छ' })).toBeVisible()

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ne')

  await page.goto('/venues')
  await expect(page.getByRole('heading', { level: 1, name: 'स्थलहरू' })).toBeVisible()
})

test('a listing shows its Nepali title, and falls back where it has none', async ({ page }) => {
  await serve(page)
  await page.goto('/listings/rock-night')
  await page.getByRole('button', { name: 'नेपाली' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'रक नाइट' })).toBeVisible()
  // The related listing has no Nepali title; it keeps its English one and is
  // marked as English so a screen reader does not read it in a Nepali voice.
  const related = page.getByRole('heading', { name: 'Kutumba Live' })
  await expect(related).toBeVisible()
  await expect(related).toHaveAttribute('lang', 'en')
})

test('Bikram Sambat is shown beside the Gregorian date, not instead of it', async ({ page }) => {
  await serve(page)
  await page.goto('/listings/rock-night')

  // 11 September 2026 is 26 Bhadra 2083.
  await expect(page.getByText(/26 Bhadra 2083/)).toBeVisible()
  await expect(page.getByText(/11 September 2026/).first()).toBeVisible()
})

// ── Definition of done: 320px, and one heading structure per page ────────────
/**
 * Every public page at the narrowest supported width, and every one with a
 * single `h1` and a heading order a screen reader can navigate by.
 *
 * These are the two checks that catch the same class of bug twice over: a
 * three-column grid that does not collapse shows up as horizontal scroll, and
 * a section pasted in with the wrong heading level shows up as a skipped
 * level. Both are invisible on a laptop.
 */
const PAGES = [
  { path: '/search?q=rock', heading: 'Search' },
  { path: '/listings/rock-night', heading: 'Rock Night' },
  { path: '/venues', heading: 'Venues' },
  { path: '/venues/purple-haze', heading: 'Purple Haze' },
  { path: '/organizers', heading: 'Organizers' },
]

for (const { path, heading } of PAGES) {
  test(`${path} holds at 320px`, async ({ page }) => {
    await serve(page)
    await page.setViewportSize({ width: 320, height: 720 })
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, `${path} scrolls sideways at 320px`).toBeLessThanOrEqual(1)
  })

  test(`${path} has one h1 and no skipped heading levels`, async ({ page }) => {
    await serve(page)
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()

    const levels = await page.evaluate(() =>
      [...document.querySelectorAll('main h1, main h2, main h3, main h4')]
        .map((node) => Number(node.tagName[1])))

    expect(levels.filter((level) => level === 1)).toHaveLength(1)
    for (let index = 1; index < levels.length; index++) {
      const step = (levels[index] as number) - (levels[index - 1] as number)
      expect(step, `${path} jumps from h${levels[index - 1]} to h${levels[index]}`)
        .toBeLessThanOrEqual(1)
    }
  })
}

test('the filter panel is a disclosure on a phone and open on a laptop', async ({ page }) => {
  await serve(page)

  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/search?q=rock')
  const toggle = page.getByRole('button', { name: 'Filters' })
  await expect(toggle).toBeVisible()
  await expect(page.getByRole('group', { name: 'City' })).toBeHidden()
  await toggle.click()
  await expect(page.getByRole('group', { name: 'City' })).toBeVisible()

  // From 60rem the panel is always there and the button is not rendered at all
  // — one control in the DOM, shown or not by CSS.
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.getByRole('group', { name: 'City' })).toBeVisible()
  await expect(toggle).toBeHidden()
})

test('the search box is a combobox a screen reader can follow', async ({ page }) => {
  await serve(page)
  await page.goto('/search')

  const box = page.getByRole('combobox', { name: 'Search' }).first()
  await expect(box).toHaveAttribute('aria-expanded', 'false')
  await box.fill('purp')
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toBeVisible()
  await expect(box).toHaveAttribute('aria-expanded', 'true')

  // Arrowing moves the active option without moving focus off the input,
  // which is the half of the pattern that makes it usable at all.
  await box.press('ArrowDown')
  await expect(box).toBeFocused()
  await expect(box).toHaveAttribute('aria-activedescendant', /.+/)
  await box.press('Escape')
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toBeHidden()
})

test('a malformed slug does not take the app down', async ({ page }) => {
  await serve(page)
  await page.goto('/listings/rock-night')
  await expect(page.getByRole('heading', { level: 1, name: 'Rock Night' })).toBeVisible()

  /*
   * `%zz` is not a valid escape and `decodeURIComponent` throws on it — during
   * render, which takes the whole app down rather than showing a 404.
   *
   * Reached through `pushState` rather than through `goto`, because the server
   * never lets it through: the Worker's asset handler answers `/listings/%zz`
   * with a 307 to `/listings/%25zz`, which decodes cleanly. A client-side
   * navigation is the path that can carry one, so that is the path tested.
   */
  await page.evaluate(() => {
    history.pushState(null, '', '/listings/%zz')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  await expect(page.getByRole('heading', { level: 1, name: 'No such listing' })).toBeVisible()
})
