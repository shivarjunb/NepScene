/**
 * The Catalog API's contract (#23), served at `GET /api/openapi.json`.
 *
 * It lives in TypeScript rather than a hand-maintained YAML file so that it is
 * one artefact, not two that drift: the integration tests validate real
 * responses against these schemas, so a change to a handler that does not
 * change this document fails the build.
 */
const CATEGORY_REF = {
  type: 'object',
  required: ['slug', 'name', 'is_primary'],
  properties: {
    slug: { type: 'string' },
    name: { type: 'string' },
    // The taxonomy's Nepali label (#46). Null falls back to `name`.
    name_ne: { type: ['string', 'null'] },
    color: { type: ['string', 'null'] },
    icon: { type: ['string', 'null'] },
    // Exactly one per listing, and the one the pin is derived from.
    is_primary: { type: 'boolean' },
  },
} as const

/**
 * Computed from the primary category on every read. There is no stored icon to
 * disagree with the filter chips — see api/catalog/pin.ts.
 */
const PIN = {
  type: 'object',
  required: ['icon', 'color', 'category'],
  properties: {
    icon: { type: 'string' },
    color: { type: 'string' },
    category: { type: ['string', 'null'] },
  },
} as const

/**
 * One image, ready to render. `sources` is ordered best-compression-first, so a
 * `<picture>` can be built by iterating it; `url` is the original and the last
 * resort. `aspect_ratio` is sent rather than divided out by the client, because
 * a card that computes it from a null width reserves nothing.
 */
const MEDIA_ITEM = {
  type: ['object', 'null'],
  required: ['id', 'url', 'kind', 'alt_text', 'sources'],
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    kind: { enum: ['image', 'video'] },
    alt_text: { type: ['string', 'null'] },
    width: { type: ['integer', 'null'] },
    height: { type: ['integer', 'null'] },
    aspect_ratio: { type: ['number', 'null'] },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'srcset'],
        properties: { type: { type: 'string' }, srcset: { type: 'string' } },
      },
    },
  },
} as const

const TAG_REF = {
  type: 'object',
  required: ['slug', 'label'],
  properties: { slug: { type: 'string' }, label: { type: 'string' } },
} as const

const VENUE_REF = {
  type: ['object', 'null'],
  required: ['id', 'slug', 'name'],
  properties: {
    id: { type: 'string' },
    slug: { type: 'string' },
    name: { type: 'string' },
    area: { type: ['string', 'null'] },
    city: { type: ['string', 'null'] },
    address: { type: ['string', 'null'] },
    district: { type: ['string', 'null'] },
    province: { type: ['string', 'null'] },
    latitude: { type: ['number', 'null'] },
    longitude: { type: ['number', 'null'] },
  },
} as const

const OFFER = {
  type: ['object', 'null'],
  required: ['purchasable', 'price_from', 'currency', 'url', 'provider', 'sold_out'],
  properties: {
    purchasable: { type: 'boolean' },
    // Display only, integer paisa. NepScene renders this; it never computes it.
    price_from: { type: ['integer', 'null'] },
    currency: { type: 'string' },
    url: { type: ['string', 'null'] },
    provider: { enum: ['waahtickets', 'external'] },
    sold_out: { type: 'boolean' },
    checked_at: { type: ['string', 'null'] },
  },
} as const

const LISTING_SUMMARY = {
  type: 'object',
  required: [
    'id', 'slug', 'title', 'title_ne', 'listing_type', 'source', 'starts_at',
    'is_all_day', 'timezone', 'is_featured', 'venue', 'organizer', 'categories', 'pin',
    'cover', 'offer',
  ],
  properties: {
    id: { type: 'string' },
    slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
    title: { type: 'string' },
    // The Nepali half (#46). Null means "render the English one", never
    // "render nothing" — `title` is the field every language-less surface uses.
    title_ne: { type: ['string', 'null'] },
    summary: { type: ['string', 'null'] },
    summary_ne: { type: ['string', 'null'] },
    listing_type: { enum: ['ticketed_internal', 'ticketed_external', 'free', 'announcement'] },
    source: { enum: ['organizer', 'submission', 'import', 'editorial'] },
    starts_at: { type: 'string' },
    ends_at: { type: ['string', 'null'] },
    is_all_day: { type: 'boolean' },
    timezone: { type: 'string' },
    cover_image_url: { type: ['string', 'null'] },
    external_url: { type: ['string', 'null'] },
    is_featured: { type: 'boolean' },
    latitude: { type: ['number', 'null'] },
    longitude: { type: ['number', 'null'] },
    distance_km: { type: 'number' },
    venue: VENUE_REF,
    organizer: {
      type: ['object', 'null'],
      required: ['id', 'slug', 'name', 'is_verified'],
      properties: {
        id: { type: 'string' }, slug: { type: 'string' },
        name: { type: 'string' }, is_verified: { type: 'boolean' },
      },
    },
    categories: { type: 'array', items: CATEGORY_REF },
    pin: PIN,
    cover: MEDIA_ITEM,
    offer: OFFER,
  },
} as const

const PAGE = {
  type: 'object',
  required: ['data', 'page'],
  properties: {
    data: { type: 'array', items: LISTING_SUMMARY },
    page: {
      type: 'object',
      required: ['limit', 'has_more', 'next_cursor'],
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        has_more: { type: 'boolean' },
        // Opaque. A client that parses it is a client we cannot change it for.
        next_cursor: { type: ['string', 'null'] },
      },
    },
  },
} as const

const LISTING_DETAIL = {
  type: 'object',
  required: [...LISTING_SUMMARY.required, 'description', 'media', 'artists', 'tags'],
  properties: {
    ...LISTING_SUMMARY.properties,
    description: { type: ['string', 'null'] },
    description_ne: { type: ['string', 'null'] },
    published_at: { type: ['string', 'null'] },
    // What to read next (#43). Ranked same-venue, same-organizer, then shared
    // category, and it never contains the listing it is on.
    related: { type: 'array', items: LISTING_SUMMARY },
    // Which room or stage inside the venue; the venue itself is not duplicated.
    venue_room: { type: ['string', 'null'] },
    map_popup_config: {},
    media: { type: 'array', items: { ...MEDIA_ITEM, type: 'object' } },
    artists: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'name'],
        properties: {
          slug: { type: 'string' }, name: { type: 'string' },
          image_url: { type: ['string', 'null'] },
          listing_count: { type: 'integer' },
          // Whether /artists/{slug} will answer. The API owns the threshold.
          has_page: { type: 'boolean' },
        },
      },
    },
    tags: { type: 'array', items: TAG_REF },
  },
} as const

/**
 * A search says more than a feed does: what it counted, what it corrected, and
 * — when it found nothing — where else to go. The rows themselves are the same
 * `ListingSummary` everything else serves.
 */
const FACET = {
  type: 'object',
  required: ['value', 'label', 'count'],
  properties: {
    value: { type: 'string' },
    label: { type: 'string' },
    label_ne: { type: ['string', 'null'] },
    count: { type: 'integer' },
    from: { type: ['string', 'null'] },
    to: { type: ['string', 'null'] },
  },
} as const

const SUGGESTION = {
  type: 'object',
  required: ['kind', 'slug', 'label'],
  properties: {
    kind: { enum: ['listing', 'venue', 'city', 'area', 'organizer', 'artist', 'category', 'tag'] },
    slug: { type: 'string' },
    label: { type: 'string' },
  },
} as const

const SEARCH_RESULT = {
  type: 'object',
  required: ['data', 'page', 'facets', 'corrected_from', 'alternatives'],
  properties: {
    ...PAGE.properties,
    facets: {
      type: 'object',
      required: ['city', 'category', 'price', 'when'],
      properties: {
        city: { type: 'array', items: FACET },
        category: { type: 'array', items: FACET },
        price: { type: 'array', items: FACET },
        when: { type: 'array', items: FACET },
      },
    },
    // Set when the query was respelled to find these results, so the page can
    // say "showing results for …" rather than quietly answering a different
    // question.
    corrected_from: { type: ['string', 'null'] },
    alternatives: { type: 'array', items: SUGGESTION },
  },
} as const

const ERROR = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
} as const

export const SCHEMAS = {
  ListingSummary: LISTING_SUMMARY,
  ListingPage: PAGE,
  ListingDetail: LISTING_DETAIL,
  SearchResult: SEARCH_RESULT,
  Suggestion: SUGGESTION,
  Offer: OFFER,
  Error: ERROR,
} as const

const feedParameters = [
  ['category', 'Category slug'], ['tag', 'Free-form tag; normalised, so `Open Mic` finds `open-mic`'],
  ['artist', 'Artist slug'], ['city', 'City name, case-insensitive'],
  ['venue', 'Venue slug'], ['organizer', 'Organizer slug'],
  ['type', 'listing_type'], ['price', 'free, ticketed or announcement — the band the facet counts'],
  ['featured', 'Only featured listings'],
  ['from', 'ISO-8601 lower bound on starts_at'], ['to', 'ISO-8601 upper bound on starts_at'],
  ['include_past', 'Include finished listings; off by default'],
  ['cursor', 'Opaque keyset cursor from a previous page'],
  ['limit', 'Page size, 1-50, default 20'],
].map(([name, description]) => ({ name, in: 'query', description, schema: { type: 'string' } }))

const jsonResponse = (schema: string, description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
})

const errorResponses = {
  '400': jsonResponse('Error', 'A parameter was rejected rather than silently defaulted'),
  '404': jsonResponse('Error', 'No such resource, or it is not published'),
}

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'NepScene Catalog API',
    version: '1.0.0',
    description:
      'Read-only discovery catalogue. Every endpoint is bounded and upcoming by default. ' +
      'Responses carry x-cache and x-d1-round-trips so the read-path budget stays observable.',
  },
  servers: [
    { url: 'https://nepscene.bhattarai-shiva.workers.dev', description: 'production' },
    { url: 'https://nepscene-staging.bhattarai-shiva.workers.dev', description: 'staging' },
  ],
  paths: {
    '/api/catalog/listings': {
      get: {
        summary: 'Published listings, soonest first',
        parameters: feedParameters,
        responses: { '200': jsonResponse('ListingPage', 'A bounded page of listings'), ...errorResponses },
      },
    },
    '/api/catalog/listings/{slug}': {
      get: {
        summary: 'One published listing',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': jsonResponse('ListingDetail', 'The listing, with media and artists'),
          '301': { description: 'The slug was renamed; Location carries the current one' },
          ...errorResponses,
        },
      },
    },
    '/api/catalog/search': {
      get: {
        summary: 'Search by text, place and distance',
        parameters: [
          ...feedParameters,
          { name: 'q', in: 'query', description: 'Matches title, summary, venue, area, city, organizer, category and tag, in either script', schema: { type: 'string' } },
          { name: 'exact', in: 'query', description: '1 to suppress spelling correction on a zero-result query', schema: { type: 'string' } },
          { name: 'lat', in: 'query', schema: { type: 'number' } },
          { name: 'lng', in: 'query', schema: { type: 'number' } },
          { name: 'radius_km', in: 'query', description: 'Default 10, max 500', schema: { type: 'number' } },
        ],
        responses: { '200': jsonResponse('SearchResult', 'Ranked listings with facet counts, with distance_km when a centre is given'), ...errorResponses },
      },
    },
    '/api/catalog/suggest': {
      get: {
        summary: 'Search-as-you-type suggestions drawn from the catalogue itself',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Up to eight suggestions, best first' } },
      },
    },
    '/api/catalog/venues': { get: { summary: 'Venues, ordered by slug', responses: { '200': { description: 'A bounded page of venues' } } } },
    '/api/catalog/venues/{slug}': { get: { summary: 'A venue and what is on there', responses: { '200': { description: 'Venue with upcoming and past listings' }, ...errorResponses } } },
    '/api/catalog/organizers': { get: { summary: 'Organizers with something published, ordered by slug', responses: { '200': { description: 'A bounded page of organizers' } } } },
    '/api/catalog/organizers/{slug}': { get: { summary: 'An organizer and their listings', responses: { '200': { description: 'Organizer with upcoming and past listings' }, ...errorResponses } } },
    '/api/catalog/artists/{slug}': { get: { summary: 'An artist with enough listings to warrant a page', responses: { '200': { description: 'Artist with upcoming and past listings' }, '404': { description: 'Unknown, or below the threshold for a page' } } } },
    '/api/catalog/categories': { get: { summary: 'Reference categories with upcoming counts', responses: { '200': { description: 'All active categories' } } } },
    '/api/catalog/tags': { get: { summary: 'Tags in use on upcoming listings, most used first', responses: { '200': { description: 'Up to 40 tags with upcoming counts' } } } },
    '/api/catalog/here': { get: { summary: 'Which of twenty Nepali cities the request appears to come from, for the opening map view (#38)', responses: { '200': { description: 'A city, its centroid, and whether it was guessed from the IP or defaulted' } } } },
    '/api/catalog/bootstrap': { get: { summary: 'Everything the homepage needs, in one request', responses: { '200': { description: 'Categories, upcoming and featured listings' } } } },
    '/api/health': { get: { summary: 'Liveness and version. Touches no dependency.', responses: { '200': { description: 'ok' } } } },
    '/api/cache/status': { get: { summary: 'Live read/write probes of the cache, KV and D1 with measured latency', responses: { '200': { description: 'ok or degraded' }, '503': { description: 'D1 unreachable' } } } },
  },
  components: { schemas: SCHEMAS },
} as const
