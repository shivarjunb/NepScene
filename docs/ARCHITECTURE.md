# Architecture

## Shape

A single Cloudflare Worker serving a React SPA and a Hono API, backed by D1 and R2.
One deployable, three internal modules with enforced boundaries.

```
┌─────────────────────────────────────────────────────┐
│  Cloudflare Worker                                  │
│                                                     │
│   React 19 + Vite SPA        Hono API               │
│   ├── public/  discovery     ├── catalog/  read     │
│   ├── author/  authoring     ├── author/   write    │
│   └── admin/   moderation    └── identity/ auth     │
│                                                     │
│              D1 (SQLite)      R2 (media)            │
└──────────────────────┬──────────────────────────────┘
                       │  Offer API (read-only, HTTP)
                       ▼
              WaahTickets (separate product)
```

## Why one Worker

The obvious alternative is separate services per module. We are not doing that, for
the same reason WaahTickets is not splitting its database: D1 cannot join across
databases, and premature service boundaries buy independence at the cost of
hand-rolled distributed joins.

The boundary we do enforce is **module-level, inside one deployable** — catalog code
may not import author code, and neither may reach into identity's tables directly.
That gives us the discipline of a split without the operational cost. If NepScene
later needs to scale or release independently of its own authoring surface, the
seam is already drawn.

## Modules

### `catalog` — read
Serves listings, venues, organizers, categories and geography to the public site.
Read-only, aggressively cacheable, no authentication required. This is the module
that must stay fast; everything else can be slow.

### `author` — write
Event and venue creation, editing, media upload, publish workflow, moderation
queue. Authenticated, role-gated, low traffic. Correctness over speed.

### `identity` — accounts
Sessions, sign-in, roles. Shared with WaahTickets so one account works in both
products.

## Data model

The catalogue centre of gravity is the **listing**, not the sellable event. This is
the key departure from WaahTickets, whose schema assumes an event exists in order to
sell seats.

```
organizations ──┬── listings ──┬── listing_media
                │      │       ├── listing_categories
                │      │       └── listing_artists ── artists
                │      │
                │      └── venue_id ──> venues
                │
                └── users (shared identity)
```

Notable differences from the WaahTickets schema:

| WaahTickets | NepScene | Why |
|---|---|---|
| `events` requires an organization | `listings.organization_id` nullable | Community and imported events have no org |
| `event_locations` is a per-event child row | `venues` is a canonical entity | A venue must own a page and dedupe across events |
| Event implies ticket types | `listing_type` says whether it is even sellable | Free and external events are first-class |
| No provenance | `source` column | A publicly writable catalogue must know who wrote what |

## API contracts

### Catalog API (public, read-only)

```
GET  /api/catalog/listings          cursor-paginated, upcoming by default
GET  /api/catalog/listings/:slug
GET  /api/catalog/venues
GET  /api/catalog/venues/:slug
GET  /api/catalog/organizers/:slug
GET  /api/catalog/categories
GET  /api/catalog/search            q, city, category, date range, distance
```

Two rules learned directly from the WaahTickets audit, where the equivalent endpoint
returned the entire catalogue with 28 of 50 events already finished:

- **Always bounded.** Cursor pagination, hard maximum page size, no unbounded reads.
- **Upcoming by default.** Past listings require an explicit opt-in parameter.

### Offer API (consumed, not owned)

NepScene calls WaahTickets to resolve offers, batched per feed page. It must never
block a render: on timeout or error, listings render without offers.

## Caching

Catalog reads are cached and versioned per resource, invalidated on publish.
A cache outage degrades to direct D1 reads and must never surface as an error.
(WaahTickets ships an unconfigured Upstash wrapper — NepScene provisions it in M0
rather than shipping the same dormant code.)
