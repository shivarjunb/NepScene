import type { ArtistSummary, ListingDetail, OrganizerSummary, VenueSummary } from '../catalog/types'

/**
 * What a page says about itself to a crawler and to a chat app (#45).
 *
 * **Generated from content, never templated over it.** "Rock Night — NepScene"
 * is a title; "Event — NepScene" is a title twelve thousand pages share, and a
 * search engine treats a site of duplicate titles as a site with one page. So
 * every field here is built from the row: the listing's own name, its date, its
 * venue, its city.
 *
 * Pure on purpose. Every acceptance criterion about metadata — unique, from
 * real content, handling a missing field and a very long title — is a claim
 * about a function, and this is that function.
 */
export type Metadata = {
  title: string
  description: string
  /** Absolute. A crawler resolves nothing. */
  canonical: string
  image: string
  imageAlt: string
  /** `article` for a listing, `website` for a browse surface. */
  ogType: 'website' | 'article'
  /** Set where the same page exists in the other language (#46). */
  alternates: { hreflang: string; href: string }[]
  /** Only where the page should not be indexed at all. */
  noindex?: boolean
}

const SITE = 'NepScene'
/**
 * Google truncates a title around 60 characters and a description around 160.
 * Cutting them here rather than letting it happen means the cut lands at a word
 * and ends in an ellipsis, instead of mid-syllable.
 */
const MAX_TITLE = 60
const MAX_DESCRIPTION = 160

export function truncate(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= limit) return collapsed
  const cut = collapsed.slice(0, limit - 1)
  const lastSpace = cut.lastIndexOf(' ')
  // A word boundary, unless the first word is already longer than the limit.
  return `${(lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** "Rock Night — NepScene", trimmed so the site name always survives. */
export function titleOf(subject: string): string {
  const suffix = ` — ${SITE}`
  return `${truncate(subject, MAX_TITLE - suffix.length)}${suffix}`
}

const sentence = (parts: (string | null | undefined)[]) =>
  parts.filter((part) => part && part.trim() !== '').join(' ')

/** The date a human would read, in the listing's own zone. */
export function readableDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(iso))
}

export type Origin = string

const url = (origin: Origin, path: string) => `${origin}${path}`

/** The brand card, for everything with no picture of its own. */
export const FALLBACK_IMAGE = '/brand/og-card.png'

/**
 * The bilingual pair (#46). Language is state rather than a route, so the two
 * documents differ by a query parameter — which is enough for `hreflang`, and
 * keeps the in-page toggle from having to navigate.
 */
function alternatesFor(origin: Origin, path: string): Metadata['alternates'] {
  const base = url(origin, path)
  const separator = path.includes('?') ? '&' : '?'
  return [
    { hreflang: 'en', href: base },
    { hreflang: 'ne', href: `${base}${separator}lang=ne` },
    { hreflang: 'x-default', href: base },
  ]
}

export function listingMetadata(
  listing: ListingDetail, origin: Origin, language: 'en' | 'ne' = 'en',
): Metadata {
  const name = language === 'ne' && listing.title_ne ? listing.title_ne : listing.title
  const teaser = language === 'ne' && listing.summary_ne
    ? listing.summary_ne
    : listing.summary ?? listing.description

  const where = listing.venue
    ? sentence(['at', listing.venue.name, listing.venue.city ? `in ${listing.venue.city}` : null])
    : null

  // The description falls back through what the listing actually has: its own
  // words, then the facts. A listing with no summary still gets a sentence
  // nobody else has, because the date and the venue are its own.
  const description = truncate(
    teaser
      ? sentence([teaser])
      : sentence([name, where, `on ${readableDate(listing.starts_at, listing.timezone)}.`]),
    MAX_DESCRIPTION,
  )

  const cover = listing.media.find((item) => item.kind === 'image') ?? listing.cover
  return {
    title: titleOf(sentence([name, where])),
    description,
    canonical: url(origin, `/listings/${listing.slug}`),
    // The listing's own poster is the card. For an events site that is not a
    // compromise on a generated image — the poster is the image people want,
    // and it is already at the right sizes through the media pipeline (#25).
    image: url(origin, cover ? cover.url : listing.cover_image_url ?? FALLBACK_IMAGE),
    imageAlt: cover?.alt_text ?? name,
    ogType: 'article',
    alternates: alternatesFor(origin, `/listings/${listing.slug}`),
  }
}

export function venueMetadata(
  venue: VenueSummary & { description?: string | null }, origin: Origin,
): Metadata {
  const place = [venue.area, venue.city].filter(Boolean).join(', ') || null
  const upcoming = venue.upcoming_listing_count
  return {
    title: titleOf(place ? `What's on at ${venue.name}, ${place}` : `What's on at ${venue.name}`),
    description: truncate(
      venue.description
        ?? sentence([
          upcoming > 0
            ? `${upcoming} event${upcoming === 1 ? '' : 's'} coming up at ${venue.name}`
            : `Events at ${venue.name}`,
          place ? `in ${place}` : null,
        ]) + '.',
      MAX_DESCRIPTION,
    ),
    canonical: url(origin, `/venues/${venue.slug}`),
    image: url(origin, venue.cover_image_url ?? FALLBACK_IMAGE),
    imageAlt: venue.name,
    ogType: 'website',
    alternates: alternatesFor(origin, `/venues/${venue.slug}`),
  }
}

export function organizerMetadata(organizer: OrganizerSummary, origin: Origin): Metadata {
  const upcoming = organizer.upcoming_listing_count
  return {
    title: titleOf(`Events by ${organizer.name}`),
    description: truncate(
      organizer.description
        ?? `${upcoming > 0 ? `${upcoming} event${upcoming === 1 ? '' : 's'} coming up from` : 'Events from'} ${organizer.name} on NepScene.`,
      MAX_DESCRIPTION,
    ),
    canonical: url(origin, `/organizers/${organizer.slug}`),
    image: url(origin, organizer.logo_url ?? FALLBACK_IMAGE),
    imageAlt: organizer.name,
    ogType: 'website',
    alternates: alternatesFor(origin, `/organizers/${organizer.slug}`),
  }
}

export function artistMetadata(artist: ArtistSummary, origin: Origin): Metadata {
  return {
    title: titleOf(`${artist.name} — upcoming shows`),
    description: truncate(
      artist.bio ?? `Where to see ${artist.name} in Nepal, and everywhere they have played.`,
      MAX_DESCRIPTION,
    ),
    canonical: url(origin, `/artists/${artist.slug}`),
    image: url(origin, artist.image_url ?? FALLBACK_IMAGE),
    imageAlt: artist.name,
    ogType: 'website',
    alternates: alternatesFor(origin, `/artists/${artist.slug}`),
  }
}

export function homeMetadata(origin: Origin): Metadata {
  return {
    title: "NepScene — what's happening around Nepal",
    description: truncate(
      'Concerts, festivals, sport, comedy, food and community events across Nepal. '
      + "Find what's on, near you, soon.",
      MAX_DESCRIPTION,
    ),
    canonical: url(origin, '/'),
    image: url(origin, FALLBACK_IMAGE),
    imageAlt: "NepScene — what's happening around Nepal",
    ogType: 'website',
    alternates: alternatesFor(origin, '/'),
  }
}

/**
 * A search result page. **Not indexed**, and that is the point: a crawler that
 * follows filter links generates a page per combination, and a catalogue of a
 * few thousand listings becomes millions of thin, near-duplicate URLs that
 * spend the crawl budget the listing pages need. It is still server-rendered,
 * because a reader arriving without JavaScript should still see results.
 */
export function searchMetadata(query: string, origin: Origin): Metadata {
  return {
    title: titleOf(query ? `Search: ${query}` : 'Search events in Nepal'),
    description: truncate(
      query
        ? `Events matching “${query}” across Nepal.`
        : 'Search every event on NepScene by name, place, city or category.',
      MAX_DESCRIPTION,
    ),
    canonical: url(origin, '/search'),
    image: url(origin, FALLBACK_IMAGE),
    imageAlt: 'NepScene',
    ogType: 'website',
    alternates: [],
    noindex: true,
  }
}

export function indexMetadata(
  kind: 'venues' | 'organizers', origin: Origin,
): Metadata {
  const isVenues = kind === 'venues'
  return {
    title: titleOf(isVenues ? 'Venues across Nepal' : 'Event organizers in Nepal'),
    description: truncate(
      isVenues
        ? 'Every venue with something on, from Thamel to Lakeside, and what is coming up at each.'
        : 'The people and organizations putting on events across Nepal, and everything they have listed.',
      MAX_DESCRIPTION,
    ),
    canonical: url(origin, `/${kind}`),
    image: url(origin, FALLBACK_IMAGE),
    imageAlt: 'NepScene',
    ogType: 'website',
    alternates: alternatesFor(origin, `/${kind}`),
  }
}
