import { emptyListing, LISTING_TYPES, type ListingInput } from '../../api/author/validate'

/**
 * Crash recovery for the wizard (#30).
 *
 * There are two layers of saving and they protect against different things.
 * The server PATCH is the real one, but it is debounced, so the seconds between
 * the last keystroke and the request landing are exactly the window in which a
 * closed tab loses work. This layer covers that window: it writes synchronously
 * on every change, locally, and costs nothing.
 *
 * Storage is injected rather than reached for. `localStorage` throws outright in
 * a private window and in some embedded webviews, and it does not exist in the
 * workerd runtime the unit tests run in — a module that assumes it is a module
 * that cannot be tested and that takes the wizard down with it when it is
 * missing.
 */

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type StoredDraft = {
  /** Null before the first server save — a draft can predate its own id. */
  id: string | null
  listing: ListingInput
  step: string
  savedAt: string
}

const PREFIX = 'nepscene:draft:'
const NEW = 'new'

/**
 * A draft nobody came back for in a fortnight is not recovery, it is clutter —
 * and offering it is worse than dropping it, because the author has long since
 * forgotten what it was.
 */
const MAX_AGE_DAYS = 14

const keyFor = (id: string | null) => `${PREFIX}${id ?? NEW}`

/**
 * Every storage call is wrapped. Safari in private mode throws on `setItem`
 * rather than returning, and an uncaught throw here would take down the whole
 * wizard on a keystroke — the opposite of what a safety net is for.
 */
function quietly<T>(action: () => T, fallback: T): T {
  try {
    return action()
  } catch {
    return fallback
  }
}

export function saveDraft(storage: DraftStorage, draft: StoredDraft): void {
  quietly(() => storage.setItem(keyFor(draft.id), JSON.stringify(draft)), undefined)
}

export function clearDraft(storage: DraftStorage, id: string | null): void {
  quietly(() => storage.removeItem(keyFor(id)), undefined)
}

/**
 * Reads a draft back, or null if there is nothing usable there. "Usable" is
 * checked field by field rather than trusted: this string was last touched by
 * a different version of the wizard, possibly months ago, and a half-shaped
 * object restored into the form is a crash with a stack trace nobody can read.
 */
export function loadDraft(
  storage: DraftStorage, id: string | null, now = Date.now(),
): StoredDraft | null {
  const raw = quietly(() => storage.getItem(keyFor(id)), null)
  if (!raw) return null

  const parsed = quietly<unknown>(() => JSON.parse(raw), null)
  if (typeof parsed !== 'object' || parsed === null) return null

  const draft = parsed as Record<string, unknown>
  const savedAt = typeof draft.savedAt === 'string' ? draft.savedAt : null
  if (!savedAt || Number.isNaN(Date.parse(savedAt))) return null

  if (now - Date.parse(savedAt) > MAX_AGE_DAYS * 86_400_000) {
    clearDraft(storage, id)
    return null
  }

  const listing = reviveListing(draft.listing)
  if (!listing) return null

  return {
    id: typeof draft.id === 'string' ? draft.id : null,
    listing,
    step: typeof draft.step === 'string' ? draft.step : 'details',
    savedAt,
  }
}

/**
 * Fills a stored object out to a whole `ListingInput`, taking each field only
 * when it is the right type. A field the stored draft never had comes back at
 * its default, so a draft written before a field existed still opens.
 */
function reviveListing(value: unknown): ListingInput | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const base = emptyListing()

  const text = (key: keyof ListingInput, fallback: string | null) =>
    typeof raw[key] === 'string' ? raw[key] : fallback
  const number = (key: keyof ListingInput) =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? raw[key] : null
  const list = (key: keyof ListingInput) =>
    Array.isArray(raw[key]) ? raw[key].filter((v): v is string => typeof v === 'string') : []

  const type = typeof raw.listing_type === 'string'
    && (LISTING_TYPES as readonly string[]).includes(raw.listing_type)
    ? raw.listing_type as ListingInput['listing_type']
    : base.listing_type

  return {
    title: text('title', '') ?? '',
    summary: text('summary', null),
    description: text('description', null),
    listing_type: type,
    organization_id: text('organization_id', null),
    venue_id: text('venue_id', null),
    starts_at: text('starts_at', '') ?? '',
    ends_at: text('ends_at', null),
    is_all_day: raw.is_all_day === true,
    timezone: text('timezone', base.timezone) ?? base.timezone,
    external_url: text('external_url', null),
    offer_url: text('offer_url', null),
    location_lat: number('location_lat'),
    location_lng: number('location_lng'),
    map_popup_config: raw.map_popup_config ?? null,
    category_slugs: list('category_slugs'),
    primary_category_slug: text('primary_category_slug', null),
    tags: list('tags'),
    artist_slugs: list('artist_slugs'),
  }
}

/**
 * Whether a recovered draft is worth interrupting the author about. An
 * untouched form autosaves itself the moment the wizard opens, and offering to
 * recover *that* trains people to dismiss the prompt without reading it.
 */
export function isWorthRecovering(draft: StoredDraft): boolean {
  const { listing } = draft
  return Boolean(
    listing.title.trim()
    || listing.summary
    || listing.description
    || listing.venue_id
    || listing.category_slugs.length > 0
    || listing.tags.length > 0,
  )
}

/** An in-memory `DraftStorage`, for tests and for when the real one throws. */
export function memoryStorage(): DraftStorage {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
  }
}

/**
 * The browser's storage when it works, an in-memory stand-in when it does not.
 * Reaching for `window.localStorage` can itself throw, so even the check is
 * guarded.
 */
export function browserStorage(): DraftStorage {
  return quietly<DraftStorage>(() => {
    const probe = `${PREFIX}probe`
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  }, memoryStorage())
}
