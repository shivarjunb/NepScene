import type {
  ArtistSummary, ListingDetail, ListingSummary, OrganizerSummary, VenueSummary,
} from '../catalog/types'

/**
 * Schema.org, as the JSON-LD a listing page carries (#45).
 *
 * The reason this is worth doing properly rather than at all: there is no
 * competitor with good structured data for Nepali events. A listing that emits
 * a valid `Event` can appear in Google's event experiences — a card with a
 * date, a place and a price — and one that emits a nearly-valid `Event` appears
 * nowhere at all, because the validator is pass/fail. So the shapes below are
 * conservative: a field goes in when the catalogue actually has it, and is
 * omitted when it does not. **An invented value is worse than a missing one**;
 * Google penalises structured data that disagrees with the page.
 *
 * Pure, and typed loosely on purpose — JSON-LD is a document, not an interface,
 * and pinning every optional property in TypeScript would obscure that the
 * shape is defined by schema.org rather than by us.
 */
type Json = Record<string, unknown>

const absolute = (origin: string, path: string) => `${origin}${path}`

/** Drops keys whose value is null or undefined, at any depth. */
export function compact<T extends Json>(value: T): T {
  const out: Json = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue
    if (Array.isArray(entry)) {
      const items = entry.filter((item) => item !== null && item !== undefined)
      if (items.length > 0) out[key] = items
      continue
    }
    if (typeof entry === 'object') {
      const nested = compact(entry as Json)
      if (Object.keys(nested).length > 0) out[key] = nested
      continue
    }
    out[key] = entry
  }
  return out as T
}

/**
 * `Place` for a venue. `address` is a `PostalAddress` rather than a string
 * because the validator wants the country separable, and `addressCountry` is
 * the one field we always know.
 */
export function placeOf(
  venue: {
    name: string; address?: string | null; area?: string | null; city?: string | null
    district?: string | null; province?: string | null
    latitude?: number | null; longitude?: number | null
    slug?: string
  },
  origin: string,
): Json {
  return compact({
    '@type': 'Place',
    name: venue.name,
    ...(venue.slug ? { url: absolute(origin, `/venues/${venue.slug}`) } : {}),
    address: compact({
      '@type': 'PostalAddress',
      streetAddress: venue.address ?? venue.area ?? null,
      addressLocality: venue.city ?? null,
      addressRegion: venue.province ?? venue.district ?? null,
      addressCountry: 'NP',
    }),
    geo: venue.latitude !== null && venue.latitude !== undefined
      && venue.longitude !== null && venue.longitude !== undefined
      ? { '@type': 'GeoCoordinates', latitude: venue.latitude, longitude: venue.longitude }
      : null,
  })
}

export function organizationOf(organizer: OrganizerSummary, origin: string): Json {
  return compact({
    '@type': 'Organization',
    name: organizer.name,
    url: absolute(origin, `/organizers/${organizer.slug}`),
    logo: organizer.logo_url ?? null,
    sameAs: organizer.website_url ?? null,
    description: organizer.description ?? null,
  })
}

/**
 * The offer, and when there is none.
 *
 * `eventAttendanceMode` and `eventStatus` are required by Google's Event
 * guidelines in all but name — a missing status is read as "unknown" and the
 * result is dropped. `offers` is omitted entirely for a listing with no offer,
 * which is *not* the same as an offer of zero: "free" is a price of 0 with a
 * URL, and a community picnic has neither.
 */
function offersOf(listing: ListingDetail, origin: string): Json | null {
  const url = listing.offer?.url ?? listing.external_url ?? absolute(origin, `/listings/${listing.slug}`)

  if (listing.listing_type === 'free') {
    return compact({
      '@type': 'Offer',
      price: 0,
      priceCurrency: 'NPR',
      availability: 'https://schema.org/InStock',
      url,
    })
  }

  const offer = listing.offer
  if (!offer || offer.price_from === null) return null

  return compact({
    '@type': 'Offer',
    // Paisa to rupees, the only arithmetic permitted on this value
    // (docs/SCOPE.md). `lowPrice` would need an `AggregateOffer`; this is a
    // single offer whose price is a floor, so `price` plus the honest
    // `validFrom` is the closest true statement.
    price: offer.price_from / 100,
    priceCurrency: offer.currency,
    availability: offer.sold_out
      ? 'https://schema.org/SoldOut'
      : 'https://schema.org/InStock',
    url,
    validFrom: offer.checked_at ?? null,
  })
}

/**
 * `Event` for a listing.
 *
 * `endDate` is emitted only when the listing has one. Google prefers an end
 * date and will infer one when it is absent, which is better than the two-hour
 * guess the calendar export makes — a guess in structured data is a claim, and
 * a wrong claim is what gets a site's rich results turned off.
 */
export function eventOf(listing: ListingDetail, origin: string): Json {
  const image = listing.media.find((item) => item.kind === 'image') ?? listing.cover
  return compact({
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: listing.title,
    // The Nepali title as an alternate name rather than a second document:
    // one URL, both spellings, which is what a bilingual catalogue actually
    // has (#46).
    alternateName: listing.title_ne ?? null,
    url: absolute(origin, `/listings/${listing.slug}`),
    startDate: listing.starts_at,
    endDate: listing.ends_at ?? null,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    description: listing.summary ?? listing.description ?? null,
    image: image ? absolute(origin, image.url) : listing.cover_image_url ?? null,
    location: listing.venue
      ? placeOf({ ...listing.venue, slug: listing.venue.slug }, origin)
      : null,
    organizer: listing.organizer
      ? compact({
          '@type': 'Organization',
          name: listing.organizer.name,
          url: absolute(origin, `/organizers/${listing.organizer.slug}`),
        })
      : null,
    performer: listing.artists.length > 0
      ? listing.artists.map((artist) => compact({
          '@type': 'PerformingGroup',
          name: artist.name,
          url: artist.has_page ? absolute(origin, `/artists/${artist.slug}`) : null,
        }))
      : null,
    offers: offersOf(listing, origin),
    inLanguage: listing.title_ne ? ['en', 'ne'] : 'en',
  })
}

/** A venue page describes the place, and lists what is on there. */
export function venuePageOf(
  venue: VenueSummary & { description?: string | null; website_url?: string | null },
  listings: ListingSummary[],
  origin: string,
): Json {
  return compact({
    '@context': 'https://schema.org',
    ...placeOf({ ...venue, slug: venue.slug }, origin),
    description: venue.description ?? null,
    sameAs: venue.website_url ?? null,
    event: listings.map((listing) => compact({
      '@type': 'Event',
      name: listing.title,
      url: absolute(origin, `/listings/${listing.slug}`),
      startDate: listing.starts_at,
    })),
  })
}

export function organizerPageOf(
  organizer: OrganizerSummary, listings: ListingSummary[], origin: string,
): Json {
  return compact({
    '@context': 'https://schema.org',
    ...organizationOf(organizer, origin),
    event: listings.map((listing) => compact({
      '@type': 'Event',
      name: listing.title,
      url: absolute(origin, `/listings/${listing.slug}`),
      startDate: listing.starts_at,
    })),
  })
}

export function artistPageOf(
  artist: ArtistSummary, listings: ListingSummary[], origin: string,
): Json {
  return compact({
    '@context': 'https://schema.org',
    '@type': 'PerformingGroup',
    name: artist.name,
    url: absolute(origin, `/artists/${artist.slug}`),
    description: artist.bio ?? null,
    image: artist.image_url ?? null,
    sameAs: Object.values(artist.links),
    event: listings.map((listing) => compact({
      '@type': 'Event',
      name: listing.title,
      url: absolute(origin, `/listings/${listing.slug}`),
      startDate: listing.starts_at,
    })),
  })
}

/**
 * The site itself, on the homepage. `SearchAction` is what offers a search box
 * under the result in Google — the one piece of structured data on this site
 * that is about NepScene rather than about an event.
 */
export function websiteOf(origin: string): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'NepScene',
    url: `${origin}/`,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${origin}/search?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  }
}

/** Where this page sits, so a result shows a path rather than a bare URL. */
export function breadcrumbsOf(
  trail: { name: string; path: string }[], origin: string,
): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((step, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: step.name,
      item: absolute(origin, step.path),
    })),
  }
}

/**
 * JSON-LD as it goes into the document. `<` is escaped because a description
 * containing `</script>` would otherwise close the tag it is sitting in — the
 * one injection this file can suffer.
 */
export function serialiseJsonLd(documents: Json[]): string {
  return JSON.stringify(documents.length === 1 ? documents[0] : documents)
    .replace(/</g, '\\u003c')
}
