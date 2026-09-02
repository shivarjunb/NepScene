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
Sessions, sign-in, roles.

**Decision (2026-09-02): NepScene owns its accounts.** "One account works in
both products" becomes a token contract with WaahTickets when there is something
worth handing over; reading another product's user table would couple the two
schemas permanently, and only works while both live in one D1 — the same trap
the datastore decision avoids.

- Email and password (PBKDF2-SHA256 via WebCrypto — Workers has no bcrypt) and
  Google sign-in over the authorization code flow with PKCE.
- A session cookie is opaque and HttpOnly; the database stores only its
  SHA-256, so a database leak yields no usable cookie.
- Four roles — visitor, organizer, editor, admin — resolved through a
  permission matrix. Handlers ask what a user *may do*, never what they *are*.
- Credential endpoints are rate limited per IP in KV. It is approximate by
  construction, and nothing exact depends on it.
- Session lookup is mounted on `/api/auth/*` and `/api/author/*` only. The
  catalogue is anonymous so it stays edge-cacheable and pays no D1 round trip
  for a signed-in reader.

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
GET  /api/catalog/bootstrap         everything the homepage needs, in one call
```

### Identity and authoring (authenticated)

```
POST /api/auth/register             email + password, signs in
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/verify-email
GET  /api/auth/me                   the account and its permissions
PATCH /api/auth/me                  name, avatar
POST /api/auth/sessions/revoke-all  sign out everywhere
GET  /api/auth/google/start         authorization code flow with PKCE
GET  /api/auth/google/callback

POST   /api/author/listings/:id/media   upload to R2; alt text required
DELETE /api/author/media/:mediaId
```

Shared feed parameters: `category`, `city`, `venue`, `organizer`, `type`,
`featured`, `from`, `to`, `include_past`, `cursor`, `limit` (max 50). Responses
are `{ data, page: { limit, has_more, next_cursor } }`; the cursor is an opaque
keyset over `(starts_at, id)`. Every response reports `x-cache` and
`x-d1-round-trips`, which is how the budget below stays honest rather than
aspirational.

Two rules learned directly from the WaahTickets audit, where the equivalent endpoint
returned the entire catalogue with 28 of 50 events already finished:

- **Always bounded.** Cursor pagination, hard maximum page size, no unbounded reads.
- **Upcoming by default.** Past listings require an explicit opt-in parameter.

### Offer API (consumed, not owned)

NepScene calls WaahTickets to resolve offers, batched per feed page. It must never
block a render: on timeout or error, listings render without offers.

## The read path: edge-first, no external hops

This section is written from a production measurement, not a preference. On
2026-09-02 the deployed WaahTickets worker was profiled from Nepal (served from
Cloudflare's Kathmandu colo):

| Request | Time |
|---|---|
| `/health` — worker only, no I/O | **~30ms** |
| `/r/:code` — one D1 query, no cache | **~290ms** |
| Any endpoint using the Upstash cache wrapper | **~2,000ms, every time** |

Two separate defects were found, and the second was the one that mattered.
First, the Upstash database behind the configured URL had been deleted (the
hostname no longer resolved) — a dead external dependency reported as healthy,
because the status endpoint only checked that env vars existed. Second, and far
worse: a wildcard middleware on the ads router ran `ensureAdsTables` — **eight
sequential idempotent DDL statements** — before *every* `/api/*` request routed
after its mount point. Each D1 operation from the Kathmandu colo to the APAC
primary costs a flat ~200ms regardless of complexity (`SELECT 1` and
`CREATE TABLE IF NOT EXISTS` measure identically), so 8 × 200ms ≈ the whole
observed 2s. Memoizing the DDL per isolate took every endpoint from ~2.0s to
~0.3s in one deploy.

The governing arithmetic: **response time ≈ sequential D1 round trips × 200ms.**
Query complexity was irrelevant — the entire 1.4MB database scans in microseconds.
Only round-trip count mattered.

Four rules follow:

1. **No external network hop on the public read path.** An external cache (Upstash,
   any hosted Redis) costs a full internet round trip from the serving colo even
   when healthy, and fails slowly when not. The public catalog is served entirely
   from Cloudflare-local storage:
   - **Cache API (`caches.default`)** for catalog GET responses — per-colo, free,
     ~0ms on hit. Short TTL plus purge-on-publish.
   - **Workers KV** for settings and configuration blobs — edge-cached after first
     read, free tier covers 100k reads/day.
   - **D1 with read replication (Sessions API)** as the source of truth — replicas
     serve reads from a nearby region instead of the distant primary, cutting the
     ~290ms single-query cost substantially for a Nepal-based audience.

2. **A cache health check performs a live round trip.** "The env var is set" is not
   a health check. `/api/cache/status` must read and write a probe key and report
   measured latency.

3. **A cache outage degrades to direct D1 reads and must never surface as an error
   — or add latency.** Failure must be fast (a short timeout on any optional
   dependency), counted, and alerted on. WaahTickets' cache failed slowly and
   silently for an unknown period; nothing measured it.

4. **No schema work in request paths, and no I/O fan-out in middleware.** Schema
   belongs to migrations; a request handler may assume tables exist. Any wildcard
   middleware runs at most one I/O operation, because middleware cost multiplies
   across every route behind it. Budget each endpoint's sequential D1 round trips
   explicitly — one for a cached read, two or three for anything — and treat a
   fourth as a design smell.

The homepage additionally gets its data in **one request** (server-rendered with
data inlined, or a single bootstrap endpoint) rather than the five separate
settings/catalog calls the WaahTickets SPA makes — on a 3G connection, request
count dominates.
