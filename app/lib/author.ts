import type { ListingInput, VenueInput } from '../../api/author/validate'
import type { DuplicateWarning, RankedVenue } from '../../api/author/venueMatch'

/**
 * The browser's half of the authoring API.
 *
 * Unlike `client.ts` every call here carries the session cookie and every one
 * can fail on permission, so the error carries a code the wizard can branch on
 * rather than only a sentence to display.
 */

export class AuthorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Present on a refused submission: which field, and what to do about it. */
    readonly fields: { field: string; message: string }[] = [],
  ) {
    super(message)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    // Same origin, but stated rather than assumed: without it a session cookie
    // is silently absent and every write is a 401 nobody can explain.
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      // Only a JSON body gets a JSON content-type. A FormData body must be left
      // alone: the browser sets its own multipart boundary, and overriding the
      // header strips it, which the Worker sees as an unparseable upload.
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

  if (!response.ok) {
    const body = await response.json().catch(() => null) as {
      error?: { code?: string; message?: string; fields?: { field: string; message: string }[] }
    } | null
    throw new AuthorError(
      response.status,
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? `Request failed (${response.status})`,
      body?.error?.fields ?? [],
    )
  }

  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>
}

// ── Who is signed in ────────────────────────────────────────────────────────

export type Account = {
  id: string
  email: string
  name: string | null
  role: 'visitor' | 'organizer' | 'editor' | 'admin'
  /** Flattened from the sibling the API returns, so callers ask one question. */
  permissions: string[]
}

/** Null rather than throwing: not being signed in is a state, not an error. */
export async function fetchAccount(): Promise<Account | null> {
  try {
    const body = await request<{ user: Omit<Account, 'permissions'>; permissions: string[] }>(
      '/api/auth/me',
    )
    return { ...body.user, permissions: body.permissions }
  } catch (error) {
    if (error instanceof AuthorError && error.status === 401) return null
    throw error
  }
}

/**
 * Both of these answer `{ ok: true }` and set the session cookie; the account
 * itself comes from the `/me` that follows, so there is one shape for "who is
 * signed in" rather than two that can disagree.
 */
export const signIn = (email: string, password: string) =>
  request<{ ok: true }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password }),
  })

export const register = (email: string, password: string) =>
  request<{ ok: true }>('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email, password }),
  })

// ── Lookups ─────────────────────────────────────────────────────────────────

export type Lookups = {
  categories: { slug: string; name: string; name_ne: string | null; icon: string | null; color: string | null }[]
  venues: { id: string; name: string; area: string | null; city: string | null; latitude: number | null; longitude: number | null }[]
  artists: { slug: string; name: string }[]
  organizations: { id: string; name: string; org_role: string }[]
  tags: { slug: string; label: string }[]
  timezones: string[]
}

/**
 * One call for every list the wizard renders. Splitting this back into five
 * would reintroduce exactly the waterfall the endpoint was built to remove —
 * see api/author/lookups.ts.
 */
export const fetchLookups = () => request<Lookups>('/api/author/lookups')

// ── Venues ──────────────────────────────────────────────────────────────────

export type VenueMatch = RankedVenue

export type VenueSearch = {
  query: string
  normalised_query: string
  data: VenueMatch[]
  /**
   * The server's answer to "should the picker offer to add a new one?". False
   * means what was typed already exists exactly. Deciding this here rather
   * than in the component keeps the acceptance criterion in one place with a
   * test around it (api/author/venueMatch.ts).
   */
  suggest_create: boolean
}

/**
 * Autocomplete over existing venues, aborted by the caller on the next
 * keystroke. It takes a signal rather than debouncing internally because the
 * component owns the timer either way, and a search that keeps running after
 * its answer stopped mattering is the source of a list that flickers back to a
 * stale result.
 */
export const searchVenues = (query: string, signal?: AbortSignal) =>
  request<VenueSearch>(`/api/author/venues?q=${encodeURIComponent(query)}`, { signal })

export type CreatedVenue = {
  id: string; slug: string; name: string
  city: string | null; latitude: number | null; longitude: number | null
  duplicates: DuplicateWarning[]
}

/**
 * A 409 here is not a failure, it is the duplicate warning (#31), and it
 * carries the venues it resembles. `AuthorError` only keeps the message and the
 * field errors, so the warning is unwrapped into its own error type — the
 * picker has to render the venue it matched, with a button to use that one
 * instead, and a sentence cannot be turned back into a button.
 */
export class DuplicateVenueError extends Error {
  constructor(
    message: string,
    readonly code: 'possible_duplicate' | 'venue_exists',
    readonly duplicates: DuplicateWarning[],
    /** Set on `venue_exists`: Google says this *is* that venue. */
    readonly venue: { id: string; slug: string; name: string } | null,
  ) {
    super(message)
    this.name = 'DuplicateVenueError'
  }
}

export async function createVenue(
  input: Partial<VenueInput>, options: { confirmDuplicate?: boolean } = {},
): Promise<CreatedVenue> {
  const response = await fetch('/api/author/venues', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, confirm_duplicate: options.confirmDuplicate === true }),
  })

  const body = await response.json().catch(() => null) as Record<string, unknown> | null

  if (response.status === 409) {
    const error = (body?.error ?? {}) as { code?: string; message?: string }
    throw new DuplicateVenueError(
      error.message ?? 'That venue may already be in the catalogue',
      error.code === 'venue_exists' ? 'venue_exists' : 'possible_duplicate',
      (body?.duplicates as DuplicateWarning[] | undefined) ?? [],
      (body?.venue as { id: string; slug: string; name: string } | undefined) ?? null,
    )
  }

  if (!response.ok) {
    const error = (body?.error ?? {}) as {
      code?: string; message?: string; fields?: { field: string; message: string }[]
    }
    throw new AuthorError(
      response.status,
      error.code ?? 'request_failed',
      error.message ?? `Request failed (${response.status})`,
      error.fields ?? [],
    )
  }

  return body as unknown as CreatedVenue
}

// ── Listings ────────────────────────────────────────────────────────────────

export type SavedListing = {
  id: string
  slug: string
  status: 'draft' | 'pending_review' | 'published' | 'rejected' | 'archived'
  /** Why it came back, verbatim from the editor who sent it (#33). */
  rejection_reason?: string | null
  listing: ListingInput
  media: { id: string; url: string; alt_text: string | null; width: number | null; height: number | null }[]
  updated_at: string
}

export type ListingStub = {
  id: string; slug: string; title: string; status: string
  listing_type: string; starts_at: string; updated_at: string
}

export const createListing = (input: Partial<ListingInput>) =>
  request<{ id: string; slug: string; status: string }>('/api/author/listings', {
    method: 'POST', body: JSON.stringify(input),
  })

export const fetchListing = (id: string) =>
  request<SavedListing>(`/api/author/listings/${encodeURIComponent(id)}`)

export const updateListing = (id: string, input: Partial<ListingInput>) =>
  request<{ id: string; slug: string; status: string; updated_at: string }>(
    `/api/author/listings/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  )

export const fetchMyListings = () =>
  request<{ data: ListingStub[] }>('/api/author/listings')

export type DuplicateFlag = {
  id: string; slug: string; title: string; score: number; message: string
}

export const submitListing = (id: string) =>
  request<{ id: string; slug: string; status: string; duplicate: DuplicateFlag | null }>(
    `/api/author/listings/${encodeURIComponent(id)}/submit`, { method: 'POST' },
  )

// ── Moderation (#33) ────────────────────────────────────────────────────────

export type QueueEntry = {
  id: string; slug: string; title: string; status: string
  listing_type: string; source: string
  starts_at: string | null; updated_at: string
  venue_name: string | null
  author: { email: string; name: string | null } | null
  organization_name: string | null
  media_count: number
  category_slugs: string[]
  duplicate: { id: string; slug: string; title: string; status: string; score: number | null } | null
}

export type Queue = {
  data: QueueEntry[]
  counts: Record<string, number>
  next: string | null
}

export const fetchQueue = (status = 'pending_review', after?: string | null) =>
  request<Queue>(
    `/api/author/queue?status=${encodeURIComponent(status)}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
  )

export type BulkResult = {
  applied: string[]
  refused: { id: string; reason: string }[]
  status: string
}

/**
 * One decision, many listings. The single-listing buttons go through here too
 * with an array of one, so there is one code path to the server rather than
 * two that can drift — the API applies the same per-row checks either way.
 */
export const moderate = (action: 'publish' | 'reject' | 'archive', ids: string[], reason?: string) =>
  request<BulkResult>('/api/author/queue/actions', {
    method: 'POST', body: JSON.stringify({ action, ids, reason }),
  })

export const mergeListing = (id: string, into: string) =>
  request<{ merged: string; into: string; slug: string; inherited: string[] }>(
    `/api/author/listings/${encodeURIComponent(id)}/merge`,
    { method: 'POST', body: JSON.stringify({ into }) },
  )

export const publishListing = (id: string) =>
  request<{ id: string; slug: string; status: string }>(
    `/api/author/listings/${encodeURIComponent(id)}/publish`, { method: 'POST' },
  )

/**
 * Media is multipart, so it skips the JSON content-type above. Alt text is
 * required by the API rather than encouraged: an image without it is a WCAG
 * failure the moment it renders (#49).
 */
export async function uploadMedia(listingId: string, file: File, altText: string) {
  const form = new FormData()
  form.set('file', file)
  form.set('alt_text', altText)
  return request<{ id: string; url: string }>(
    `/api/author/listings/${encodeURIComponent(listingId)}/media`,
    { method: 'POST', body: form },
  )
}
