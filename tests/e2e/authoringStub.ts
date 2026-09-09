import type { Page } from '@playwright/test'

/**
 * The authoring API, stubbed at the network boundary, shared by every spec
 * that drives the wizard (#30, #31).
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
  /**
   * Installs a fake `google.maps` before the app boots (#31). Off by default:
   * most wizard specs never reach the map, and the picker is built to work
   * without one, which is the state a keyless preview build is in.
   */
  maps?: boolean
}

/**
 * A stub that keeps state, so the wizard's autosave has something to autosave
 * to and edit mode has something to load back.
 */
export async function serveAuthoring(
  page: Page, { role = 'editor', localDraft, maps = false }: Options = {},
) {
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

  /**
   * Venue search and creation (#31).
   *
   * The stub reproduces the two behaviours the picker is built around, because
   * they are what the specs are about: `suggest_create` is false when a venue
   * matches exactly, and a create that looks like a duplicate is refused with
   * 409 rather than accepted with a warning attached. The real rules and their
   * thresholds are tested against a live D1 in tests/integration/venues.test.ts.
   */
  const createdVenues: Record<string, unknown>[] = []

  await page.route('**/api/author/venues?*', (route) => {
    const query = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase()
    const pool = [...VENUES, ...createdVenues] as typeof VENUES
    const data = pool
      .filter((venue) => venue.name.toLowerCase().includes(query)
        || (venue.area ?? '').toLowerCase().includes(query)
        || (venue.city ?? '').toLowerCase().includes(query))
      .map((venue) => ({ ...venue, slug: venue.id, address: null, tier: 0, similarity: 1,
                         upcoming_listing_count: 0, listing_count: 0 }))
    return route.fulfill({
      json: {
        query, normalised_query: query, data,
        suggest_create: !pool.some((venue) => venue.name.toLowerCase() === query),
      },
    })
  })

  await page.route('**/api/author/venues', (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON() as Record<string, unknown>
    const name = String(body.name ?? '')

    // "Purple Haze" against "Purple Haze Rock Bar" is the containment case the
    // real detector catches and a bare similarity score does not.
    const near = VENUES.find((venue) =>
      venue.name.toLowerCase().includes(name.toLowerCase()) && name.trim() !== '')
    if (near && body.confirm_duplicate !== true) {
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'possible_duplicate',
            message: `That looks like “${near.name}”, already in the catalogue`,
            fields: [{ field: 'name', message: 'This may already exist' }],
          },
          duplicates: [{
            id: near.id, slug: near.id, name: near.name, city: near.city,
            reason: 'name', similarity: 0.9, distance_m: 40,
          }],
        },
      })
    }

    const created = {
      id: `ven_${createdVenues.length + 1}`, name,
      area: body.area ?? null, city: body.city ?? null,
      latitude: body.latitude ?? null, longitude: body.longitude ?? null,
    }
    createdVenues.push(created)
    return route.fulfill({ status: 201, json: { ...created, slug: created.id, duplicates: [] } })
  })

  if (maps) await stubGoogleMaps(page)

  if (localDraft) {
    await page.addInitScript((draft) => {
      window.localStorage.setItem('nepscene:draft:new', JSON.stringify(draft))
    }, localDraft)
  }

  return { store: () => store, wasCreated: () => created, venues: () => createdVenues }
}

/**
 * A `google.maps` that draws nothing.
 *
 * Installed as an init script, so it is on `window` before the app boots and
 * `loadGoogleMaps` returns it without ever reaching Google — no key, no
 * network, no flake. It implements only what `MapLocationPicker` calls, and it
 * records the click listener so a spec can fire a map click, which is the one
 * interaction there is no other way to reach.
 */
export async function stubGoogleMaps(page: Page) {
  await page.addInitScript(() => {
    type Listener = (event: unknown) => void
    const listeners: Record<string, Listener[]> = {}
    const on = (key: string) => (event: string, handler: Listener) => {
      (listeners[`${key}:${event}`] ??= []).push(handler)
      return { remove: () => {} }
    }

    class FakeLatLng {
      constructor(private readonly a: number, private readonly b: number) {}
      lat() { return this.a }
      lng() { return this.b }
    }

    class FakeMarker {
      position: { lat: number; lng: number }
      constructor(options: { position: { lat: number; lng: number } }) {
        this.position = options.position
      }
      setPosition(position: { lat: number; lng: number }) { this.position = position }
      getPosition() { return new FakeLatLng(this.position.lat, this.position.lng) }
      setMap() {}
      addListener = on('marker')
    }

    class FakeMap {
      constructor(container: HTMLElement) { container.dataset.fakeMap = 'ready' }
      addListener = on('map')
      setZoom() {}
      panTo() {}
      getBounds() { return null }
    }

    class FakeGeocoder {
      geocode(
        request: { location?: { lat: number; lng: number }; placeId?: string },
        callback: (results: unknown[], status: string) => void,
      ) {
        const location = request.location ?? { lat: 27.71501, lng: 85.31102 }
        callback([{
          formatted_address: 'Thamel Marg, Kathmandu 44600, Nepal',
          place_id: request.placeId ?? 'ChIJ_stub',
          address_components: [
            { long_name: 'Thamel', short_name: 'Thamel', types: ['sublocality_level_1'] },
            { long_name: 'Kathmandu', short_name: 'Kathmandu', types: ['locality'] },
            { long_name: 'Nepal', short_name: 'NP', types: ['country'] },
          ],
          geometry: { location: new FakeLatLng(location.lat, location.lng) },
        }], 'OK')
      }
    }

    class FakeAutocompleteService {
      getPlacePredictions(
        request: { input: string },
        callback: (predictions: unknown[]) => void,
      ) {
        callback([{
          place_id: 'ChIJ_prediction',
          structured_formatting: {
            main_text: request.input,
            secondary_text: 'Kathmandu, Nepal',
          },
        }])
      }
    }

    const win = window as unknown as Record<string, unknown>
    win.google = {
      maps: {
        Map: FakeMap, Marker: FakeMarker, Geocoder: FakeGeocoder,
        places: { AutocompleteService: FakeAutocompleteService },
        // The spec's handle on the map's own click listener.
        __fire: (event: string, payload: unknown) => {
          for (const handler of listeners[`map:${event}`] ?? []) handler(payload)
        },
        __latLng: (lat: number, lng: number) => new FakeLatLng(lat, lng),
      },
    }
  })
}

/**
 * Choose an existing venue through the picker. Every spec that needs a venue
 * goes through this rather than through the control, so a change to the
 * interaction is one edit rather than nine.
 */
export async function pickVenue(page: Page, name: string) {
  await page.getByLabel('Venue', { exact: true }).fill(name)
  await page.getByRole('button', { name: new RegExp(name) }).click()
}
