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
  required: ['slug', 'name'],
  properties: {
    slug: { type: 'string' },
    name: { type: 'string' },
    color: { type: ['string', 'null'] },
    icon: { type: ['string', 'null'] },
  },
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
    'id', 'slug', 'title', 'listing_type', 'source', 'starts_at',
    'is_all_day', 'timezone', 'is_featured', 'venue', 'organizer', 'categories', 'offer',
  ],
  properties: {
    id: { type: 'string' },
    slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
    title: { type: 'string' },
    summary: { type: ['string', 'null'] },
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
    map_pin_icon: { type: ['string', 'null'] },
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
  required: [...LISTING_SUMMARY.required, 'description', 'media', 'artists'],
  properties: {
    ...LISTING_SUMMARY.properties,
    description: { type: ['string', 'null'] },
    published_at: { type: ['string', 'null'] },
    map_popup_config: {},
    media: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'url', 'kind', 'alt_text'],
        properties: {
          id: { type: 'string' },
          url: { type: 'string' },
          kind: { enum: ['image', 'video'] },
          alt_text: { type: ['string', 'null'] },
          width: { type: ['integer', 'null'] },
          height: { type: ['integer', 'null'] },
        },
      },
    },
    artists: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'name'],
        properties: {
          slug: { type: 'string' }, name: { type: 'string' },
          image_url: { type: ['string', 'null'] },
        },
      },
    },
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
  Offer: OFFER,
  Error: ERROR,
} as const

const feedParameters = [
  ['category', 'Category slug'], ['city', 'City name, case-insensitive'],
  ['venue', 'Venue slug'], ['organizer', 'Organizer slug'],
  ['type', 'listing_type'], ['featured', 'Only featured listings'],
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
          { name: 'q', in: 'query', description: 'Matches title, summary, venue, area, city and organizer', schema: { type: 'string' } },
          { name: 'lat', in: 'query', schema: { type: 'number' } },
          { name: 'lng', in: 'query', schema: { type: 'number' } },
          { name: 'radius_km', in: 'query', description: 'Default 10, max 500', schema: { type: 'number' } },
        ],
        responses: { '200': jsonResponse('ListingPage', 'Matching listings, with distance_km when a centre is given'), ...errorResponses },
      },
    },
    '/api/catalog/venues': { get: { summary: 'Venues, ordered by slug', responses: { '200': { description: 'A bounded page of venues' } } } },
    '/api/catalog/venues/{slug}': { get: { summary: 'A venue and what is on there', responses: { '200': { description: 'Venue with upcoming listings' }, ...errorResponses } } },
    '/api/catalog/organizers/{slug}': { get: { summary: 'An organizer and their listings', responses: { '200': { description: 'Organizer with upcoming listings' }, ...errorResponses } } },
    '/api/catalog/categories': { get: { summary: 'Reference categories with upcoming counts', responses: { '200': { description: 'All active categories' } } } },
    '/api/catalog/bootstrap': { get: { summary: 'Everything the homepage needs, in one request', responses: { '200': { description: 'Categories, upcoming and featured listings' } } } },
    '/api/health': { get: { summary: 'Liveness and version. Touches no dependency.', responses: { '200': { description: 'ok' } } } },
    '/api/cache/status': { get: { summary: 'Live read/write probes of the cache, KV and D1 with measured latency', responses: { '200': { description: 'ok or degraded' }, '503': { description: 'D1 unreachable' } } } },
  },
  components: { schemas: SCHEMAS },
} as const
