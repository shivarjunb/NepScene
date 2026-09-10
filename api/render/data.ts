import type { Env } from '../env'
import type { ReadSession } from '../lib/d1'
import { readSession } from '../lib/d1'
import { notFound } from '../lib/http'
import {
  artistBySlugQuery, buildFeedQuery, categoriesQuery, listingBySlugQuery,
  organizerBySlugQuery, organizersQuery, relatedListingsQuery, slugRedirectQuery,
  venueBySlugQuery, venuesQuery,
} from '../catalog/queries'
import {
  toArtistSummary, toListingDetail, toListingSummary, toOrganizerSummary, toVenueSummary,
} from '../catalog/serialize'
import { ARTIST_PAGE_THRESHOLD } from '../catalog/places'
import type {
  ArtistSummary, Bootstrap, ListingDetail, ListingSummary, OrganizerSummary, VenueSummary,
} from '../catalog/types'

/**
 * What a server-rendered page needs, loaded the short way (#45).
 *
 * **No HTTP hop back into our own API.** The Worker already holds the query
 * functions and the serializers, so a rendered page calls them directly. Going
 * out through `fetch` to `/api/catalog/...` would be a full request cycle —
 * routing, parsing, cache lookup — to reach code in the same isolate, and on a
 * page that is already paying for a D1 round trip it is the one cost with
 * nothing to show for it.
 *
 * The consequence, stated because it is the thing to watch: these are the same
 * statements the API runs, so the payload is identical by construction — and
 * `useResource` seeds from it under the API path it would otherwise have
 * fetched, which is what makes the two halves interchangeable.
 */
const LISTINGS_PER_PAGE_VIEW = 20
const PAST_PER_PAGE_VIEW = 10
const RELATED_LIMIT = 6
const BOOTSTRAP_UPCOMING = 24
const BOOTSTRAP_FEATURED = 6
const INDEX_LIMIT = 50

/** A slug that has moved. The page redirects rather than 404s (#24). */
export class MovedPermanently extends Error {
  constructor(readonly location: string) {
    super(`Moved to ${location}`)
  }
}

export type PageData = {
  /** Keyed by the API path the client would have fetched. */
  preload: Record<string, unknown>
  /** Everything the metadata and structured data are built from. */
  subject:
    | { kind: 'home'; bootstrap: Bootstrap }
    | { kind: 'listing'; listing: ListingDetail }
    | { kind: 'venue'; venue: VenueSummary & Record<string, unknown>; listings: ListingSummary[] }
    | { kind: 'organizer'; organizer: OrganizerSummary; listings: ListingSummary[] }
    | { kind: 'artist'; artist: ArtistSummary; listings: ListingSummary[] }
    | { kind: 'venues' }
    | { kind: 'organizers' }
    | { kind: 'search'; query: string }
}

export async function loadHome(env: Env): Promise<PageData> {
  const session = readSession(env)
  const now = new Date().toISOString()
  const categories = categoriesQuery(now)
  const upcoming = buildFeedQuery({ includePast: false, limit: BOOTSTRAP_UPCOMING, now })
  const featured = buildFeedQuery({
    includePast: false, featured: true, limit: BOOTSTRAP_FEATURED, now,
  })

  const [categoryRows, upcomingRows, featuredRows] = await session.batch<Record<string, unknown>>([
    { sql: categories.sql, params: categories.params },
    { sql: upcoming.sql, params: upcoming.params },
    { sql: featured.sql, params: featured.params },
  ])

  const bootstrap = {
    categories: (categoryRows ?? []) as unknown as Bootstrap['categories'],
    upcoming: (upcomingRows ?? []).slice(0, BOOTSTRAP_UPCOMING).map(toListingSummary),
    featured: (featuredRows ?? []).slice(0, BOOTSTRAP_FEATURED).map(toListingSummary),
  }

  return { preload: { '/bootstrap': bootstrap }, subject: { kind: 'home', bootstrap } }
}

export async function loadListing(env: Env, slug: string): Promise<PageData> {
  const session = readSession(env)
  const now = new Date().toISOString()
  const detail = listingBySlugQuery(slug)
  const related = relatedListingsQuery({ slug, limit: RELATED_LIMIT, now })

  const [detailRows, relatedRows] = await session.batch<Record<string, unknown>>([
    { sql: detail.sql, params: detail.params },
    { sql: related.sql, params: related.params },
  ])

  const row = detailRows?.[0]
  if (!row) {
    // A published URL is a promise (#24): the page redirects to the current
    // slug rather than 404ing, and the canonical tag on the destination is
    // what stops the two competing in an index.
    await redirectOrThrow(session, 'listing', slug, (current) => `/listings/${current}`)
  }

  const listing = {
    ...toListingDetail(row as Record<string, unknown>),
    related: (relatedRows ?? []).map(toListingSummary),
  }
  return {
    preload: { [`/listings/${slug}`]: listing },
    subject: { kind: 'listing', listing },
  }
}

export async function loadVenue(env: Env, slug: string): Promise<PageData> {
  const session = readSession(env)
  const now = new Date().toISOString()
  const venue = venueBySlugQuery(slug, now)
  const upcoming = buildFeedQuery({
    venue: slug, includePast: false, limit: LISTINGS_PER_PAGE_VIEW, now,
  })
  const past = buildFeedQuery({
    venue: slug, includePast: true, finishedBefore: now,
    limit: PAST_PER_PAGE_VIEW, now, order: 'desc',
  })

  const [venueRows, upcomingRows, pastRows] = await session.batch<Record<string, unknown>>([
    { sql: venue.sql, params: venue.params },
    { sql: upcoming.sql, params: upcoming.params },
    { sql: past.sql, params: past.params },
  ])

  const row = venueRows?.[0]
  if (!row) await redirectOrThrow(session, 'venue', slug, (current) => `/venues/${current}`)

  const found = row as Record<string, unknown>
  const payload = {
    venue: {
      ...toVenueSummary(found),
      description: found.description ?? null,
      website_url: found.website_url ?? null,
      phone: found.phone ?? null,
      capacity: found.capacity ?? null,
      google_place_id: found.google_place_id ?? null,
    },
    listings: (upcomingRows ?? []).slice(0, LISTINGS_PER_PAGE_VIEW).map(toListingSummary),
    past: (pastRows ?? []).slice(0, PAST_PER_PAGE_VIEW).map(toListingSummary),
  }

  return {
    preload: { [`/venues/${slug}`]: payload },
    subject: { kind: 'venue', venue: payload.venue, listings: payload.listings },
  }
}

export async function loadOrganizer(env: Env, slug: string): Promise<PageData> {
  const session = readSession(env)
  const now = new Date().toISOString()
  const organizer = organizerBySlugQuery(slug, now)
  const upcoming = buildFeedQuery({
    organizer: slug, includePast: false, limit: LISTINGS_PER_PAGE_VIEW, now,
  })
  const past = buildFeedQuery({
    organizer: slug, includePast: true, finishedBefore: now,
    limit: PAST_PER_PAGE_VIEW, now, order: 'desc',
  })

  const [organizerRows, upcomingRows, pastRows] = await session.batch<Record<string, unknown>>([
    { sql: organizer.sql, params: organizer.params },
    { sql: upcoming.sql, params: upcoming.params },
    { sql: past.sql, params: past.params },
  ])

  const row = organizerRows?.[0]
  if (!row) {
    await redirectOrThrow(session, 'organization', slug, (current) => `/organizers/${current}`)
  }

  const payload = {
    organizer: toOrganizerSummary(row as Record<string, unknown>),
    listings: (upcomingRows ?? []).slice(0, LISTINGS_PER_PAGE_VIEW).map(toListingSummary),
    past: (pastRows ?? []).slice(0, PAST_PER_PAGE_VIEW).map(toListingSummary),
  }

  return {
    preload: { [`/organizers/${slug}`]: payload },
    subject: { kind: 'organizer', organizer: payload.organizer, listings: payload.listings },
  }
}

export async function loadArtist(env: Env, slug: string): Promise<PageData> {
  const session = readSession(env)
  const now = new Date().toISOString()
  const artist = artistBySlugQuery(slug, now)
  const upcoming = buildFeedQuery({
    artist: slug, includePast: false, limit: LISTINGS_PER_PAGE_VIEW, now,
  })
  const past = buildFeedQuery({
    artist: slug, includePast: true, finishedBefore: now,
    limit: PAST_PER_PAGE_VIEW, now, order: 'desc',
  })

  const [artistRows, upcomingRows, pastRows] = await session.batch<Record<string, unknown>>([
    { sql: artist.sql, params: artist.params },
    { sql: upcoming.sql, params: upcoming.params },
    { sql: past.sql, params: past.params },
  ])

  const row = artistRows?.[0]
  if (!row) throw notFound('No artist with that slug')

  const summary = toArtistSummary(row)
  // The same threshold the API applies, so a page that would 404 there is not
  // rendered — and therefore never indexed — here.
  if (summary.listing_count < ARTIST_PAGE_THRESHOLD) {
    throw notFound('That artist has too few listings for a page of their own')
  }

  const payload = {
    artist: summary,
    listings: (upcomingRows ?? []).slice(0, LISTINGS_PER_PAGE_VIEW).map(toListingSummary),
    past: (pastRows ?? []).slice(0, PAST_PER_PAGE_VIEW).map(toListingSummary),
  }

  return {
    preload: { [`/artists/${slug}`]: payload },
    subject: { kind: 'artist', artist: summary, listings: payload.listings },
  }
}

export async function loadVenues(env: Env): Promise<PageData> {
  const session = readSession(env)
  const { sql, params } = venuesQuery({ limit: INDEX_LIMIT, now: new Date().toISOString() })
  const rows = await session.all<Record<string, unknown>>(sql, params)
  const data = rows.slice(0, INDEX_LIMIT).map(toVenueSummary)
  return {
    preload: {
      [`/venues?limit=${INDEX_LIMIT}`]: {
        data,
        page: { limit: INDEX_LIMIT, has_more: rows.length > INDEX_LIMIT, next_cursor: null },
      },
    },
    subject: { kind: 'venues' },
  }
}

export async function loadOrganizers(env: Env): Promise<PageData> {
  const session = readSession(env)
  const { sql, params } = organizersQuery({ limit: INDEX_LIMIT, now: new Date().toISOString() })
  const rows = await session.all<Record<string, unknown>>(sql, params)
  const data = rows.slice(0, INDEX_LIMIT).map(toOrganizerSummary)
  return {
    preload: {
      [`/organizers?limit=${INDEX_LIMIT}`]: {
        data,
        page: { limit: INDEX_LIMIT, has_more: rows.length > INDEX_LIMIT, next_cursor: null },
      },
    },
    subject: { kind: 'organizers' },
  }
}

/**
 * A miss becomes a redirect when the slug has moved, and a 404 otherwise. The
 * lookup only runs on a miss, so a live page never pays for it.
 */
async function redirectOrThrow(
  session: ReadSession, entity: string, slug: string, to: (current: string) => string,
): Promise<never> {
  const redirect = slugRedirectQuery(entity, slug)
  const moved = await session.first<{ current_slug: string | null }>(redirect.sql, redirect.params)
  if (moved?.current_slug) throw new MovedPermanently(to(moved.current_slug))
  throw notFound('No such page')
}
