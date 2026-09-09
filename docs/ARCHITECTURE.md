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
organizations ──┬── listings ──┬── listing_media ── media_derivatives
                │      │       ├── listing_categories ── categories  (closed)
                │      │       ├── listing_tags ─────── tags         (open)
                │      │       └── listing_artists ──── artists
                │      │
                │      └── venue_id ──> venues
                │
                └── users (shared identity)
```

The taxonomy has two halves and they are not interchangeable. **Categories** are
seeded, closed and validated by a foreign key — that is what lets a filter chip
mean something, and what map pin appearance is derived from. **Tags** are
free-form and authored, normalised through the slug rules so one tag is one tag.
Tags never affect appearance; if they did, the closed half would stop being
canonical the first time somebody typed `concert`.

Notable differences from the WaahTickets schema:

| WaahTickets | NepScene | Why |
|---|---|---|
| `events` requires an organization | `listings.organization_id` nullable | Community and imported events have no org |
| `event_locations` is a per-event child row | `venues` is a canonical entity | A venue must own a page and dedupe across events |
| Event implies ticket types | `listing_type` says whether it is even sellable | Free and external events are first-class |
| No provenance | `source` column | A publicly writable catalogue must know who wrote what |
| `map_pin_icon` set independently of `event_type` | Pin appearance derived from the primary category | Two fields for one fact drift; WaahTickets needed a separate `pinCategory` to reconcile them |

**One date per listing, for now.** `listings.starts_at` and `ends_at` hold a
single occurrence, which is enough for a gig and wrong for a festival, a
theatre run or a weekly residency. The model that replaces it was decided in
#35 — one listing, many materialised occurrence rows, with any recurrence rule
demoted to an authoring convenience that generates them — and is written up in
[RECURRING_EVENTS.md](RECURRING_EVENTS.md), with the implementation in #81 and
#82. Nothing here anticipates it; the point of that document is that it does
not have to.

## API contracts

### Catalog API (public, read-only)

```
GET  /api/catalog/listings          cursor-paginated, upcoming by default
GET  /api/catalog/listings/:slug
POST /api/catalog/listings/:slug/events  the view/click beacon; 202, no body
GET  /api/catalog/venues
GET  /api/catalog/venues/:slug
GET  /api/catalog/organizers/:slug
GET  /api/catalog/categories
GET  /api/catalog/tags              tags in use on upcoming listings
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
DELETE /api/auth/me                 leave; confirmation required
GET  /api/auth/me/export            everything held, as JSON
POST /api/auth/email/change         claims a new address; proves it on verify
POST /api/auth/sessions/revoke-all  sign out everywhere
GET  /api/auth/google/start         authorization code flow with PKCE
GET  /api/auth/google/callback

GET    /api/author/lookups              categories, venues, artists, orgs, tags — one batch
GET    /api/author/listings             the author's own work, newest first
POST   /api/author/listings             creates a draft; accepts an incomplete one
GET    /api/author/listings/:id         edit mode's load, one round trip
PATCH  /api/author/listings/:id         the autosave target; partial by construction
DELETE /api/author/listings/:id
POST   /api/author/listings/:id/submit  validates; 400 lists the fields still missing
POST   /api/author/listings/:id/publish editor and above
POST   /api/author/listings/:id/reject   body: { reason } — refused without one
POST   /api/author/listings/:id/{archive,unpublish}
POST   /api/author/listings/:id/merge   body: { into } — folds this one into that

GET    /api/author/queue?status=        the moderation queue, oldest first
POST   /api/author/queue/actions        body: { action, ids[], reason? } — max 50

GET    /api/author/dashboard            your own listings, with view counts; one round trip
POST   /api/author/listings/:id/duplicate  copies into a new, dateless draft

GET    /api/author/venues?q=             venue autocomplete, ranked; one round trip
POST   /api/author/venues               creates one; 409 names the venue it resembles

POST   /api/author/listings/:id/media   upload to R2; alt text required
DELETE /api/author/media/:mediaId
POST   /api/author/media/sweep         admin; reclaims unreferenced R2 objects
```

**A draft is not validated; a submission is.** The wizard autosaves every few
seconds and a half-written listing is the normal state of a draft, so `POST` and
`PATCH` accept anything that parses. The rules in `api/author/validate.ts` gate
the `draft → pending_review` transition and nothing before it, and a refusal
comes back as `{ error: { code: 'incomplete_listing', fields: [{ field, message }] } }`
so the wizard can send the author to the step that is wrong.

That module is the one file shared between the Worker and the browser. The read
types are mirrored rather than imported (`app/lib/catalog.ts` says why), but
rules are not additive the way types are: two copies of "an external listing
needs a ticket URL" drift silently. It stays free of platform globals so both
halves can compile it.

Write handlers report `x-d1-round-trips` exactly as the read path does. The
budget is 1 for a lookup, an edit-mode load or a venue search, and 2 for a
create or an update. A venue create refused as a possible duplicate costs 1: it
read, it wrote nothing, and it must not pay for the write it declined to make.

Shared feed parameters: `category`, `tag`, `artist`, `city`, `venue`, `organizer`, `type`,
`featured`, `from`, `to`, `include_past`, `cursor`, `limit` (max 50). Responses
are `{ data, page: { limit, has_more, next_cursor } }`; the cursor is an opaque
keyset over `(starts_at, id)`. Every response reports `x-cache` and
`x-d1-round-trips`, which is how the budget below stays honest rather than
aspirational.

Two rules learned directly from the WaahTickets audit, where the equivalent endpoint
returned the entire catalogue with 28 of 50 events already finished:

- **Always bounded.** Cursor pagination, hard maximum page size, no unbounded reads.
- **Upcoming by default.** Past listings require an explicit opt-in parameter.

## Venues: finding one before making another

A venue is canonical (`venues`, migration 0001) precisely so that it can own a
page and dedupe across listings, which only works if authors keep finding the
one that already exists. If creating a venue is easier than finding one,
everyone creates one, and the catalogue re-accumulates the duplicates the
canonical table was built to remove. So the whole venue surface is arranged
around search-before-create.

**Ranking without a full-text index.** There is no FTS5 table in this schema and
there is not going to be one: keeping an FTS table in sync needs triggers, and
`wrangler d1 migrations apply` splits SQL on semicolons, so a trigger body never
survives the pipeline (migration 0004 says the same thing about status
transitions). The shape instead is the one `api/lib/geo.ts` already uses for
distance — a coarse, index-friendly `LIKE` prefilter in SQL that decides which
60 rows survive the `LIMIT`, and the real comparison in the Worker over that
bounded set. SQL cannot normalise Devanagari, punctuation or word boundaries;
`api/author/venueMatch.ts` can, and it is pure, so the ranking is unit-tested
rather than inferred from a query plan.

**Duplicate detection is two thresholds, and they cover each other.**

| Signal | Threshold | Why that number |
|---|---|---|
| Name | Sørensen–Dice ≥ **0.80** over bigrams, or one name's words contained in the other's | The highest-scoring pair that is genuinely two places — "Patan Durbar Square" against "Basantapur Durbar Square" — is 0.70. The lowest-scoring pair that is genuinely one place — "Bhrikutimandap Exhibition Hall" against "Bhrikuti Mandap Exhibition Ground" — is 0.82. 0.80 sits in that gap. Containment is separate because Dice scores "Purple Haze" against "Purple Haze Rock Bar" at 0.72, below any line that also rejects the two durbar squares |
| Distance | **150 m** | Floor: two honest attempts at the same place disagree by roughly that much — a phone's GPS in a Thamel alley is good to 20-40 m, and Google's geocoder on a Nepali address is routinely 100 m out. Ceiling: Thamel has several genuinely distinct bars inside 200 m of each other, so 500 m would warn constantly and be learned as noise |

Neither signal is sufficient alone, which is the point of having two. A
transposition in a short name ("Purpel Haze") scores 0.67 and is caught by the
pin; a venue entered with no coordinates at all is caught by the name. The name
signal is suppressed when both venues name a city and the cities differ, because
Nepali place names repeat — a "Lakeside" in Kathmandu is not the Pokhara one.

**A warning refuses the write rather than riding along with it.** The gentler
alternative is to create the venue and return the warning beside it. It does not
work: the duplicate is in the catalogue by the time anyone reads the warning, and
undoing it is a merge nobody will do. `POST /api/author/venues` answers 409 with
`{ error: { code: 'possible_duplicate', … }, duplicates: [...] }` naming the venue
and the distance, and a repeat with `confirm_duplicate: true` goes through and is
audited as an override. A matching `google_place_id` is not a warning at all —
Google saying "this is the same place" is an identity, not a resemblance, and
migration 0001's unique index would refuse the row anyway.

**A room is not a venue** (`listings.venue_room`, migration 0009). Without that
column the only way to write "Hall B, Bhrikutimandap" is to create a venue called
"Bhrikutimandap Hall B", and then somebody writes "Bhrikuti Mandap - Hall B".
Free text, no index, no lookup table: rooms are named by whoever runs the
building, change between events, and nothing joins on them.

### Geocoding stays in the browser

**Decision (2026-09-09): NepScene does not proxy Google's Geocoding API.** There
is no `/api/author/geocode`, forward or reverse, and this is the reasoning so
that it is not relitigated by whoever next wants one.

The deciding factor is the key, and there are two different ones in play:

- `VITE_GOOGLE_MAPS_API_KEY` is a build-time public value baked into the bundle
  and HTTP-referrer restricted per environment (docs/DEVOPS.md > Secrets). The
  map cannot draw without it, so it is on the page whatever we decide here.
- The Geocoding **web service** does not accept referrer restrictions — Google
  supports those for the JavaScript, Static and Embed APIs only. A key called
  from a Worker can be restricted by API but not by caller, and Cloudflare offers
  no stable egress IP to restrict to instead.

So proxying protects nothing. The key it would guard is already in the bundle for
the map; what it adds is a *second*, strictly less restrictable secret, plus an
authenticated geocoding endpoint of our own that is itself an abusable proxy and
would now need its own rate limiting. That is more attack surface and more
latency in exchange for no reduction in exposure.

The browser path is not a workaround either. The Maps JS SDK the picker already
loads carries `google.maps.Geocoder`, which uses the same referrer-restricted key
that draws the map, so forward and reverse geocoding cost no Worker round trip
and no external hop at all — and rule 1 below stays a rule rather than something
with an exception carved out of it for authoring. It is the same division of
labour as the media pipeline: the browser does the work, and the Worker checks
the result rather than trusting it. Whatever the geocoder returns is written
through `POST /api/author/venues`, which range-checks the coordinates — the Nepal
bounding box in `validateVenue` exists to catch a latitude and longitude entered
the wrong way round, which is otherwise invisible because 85.3N 27.7E is a
perfectly valid point in the Arctic Ocean — and then duplicate-checks the venue.

What would change this: an importer. `scripts/import-waahtickets.mjs` has no
browser, and if it ever has to place a venue it will need a server-side key. That
belongs in the importer's own credentials, run out of band, not in a Worker
endpoint the public site can call — exactly as an importer with no browser
uploads no derivatives and its original is served alone.

### Offer API (consumed, not owned)

NepScene calls WaahTickets to resolve offers, batched per feed page. It must never
block a render: on timeout or error, listings render without offers.

## Publication: the path out of a draft

The state machine is migration 0004 and `TRANSITIONS` in `api/author/listings.ts`
— one table, and every status write goes through it. The queue, the bulk action
and the merge in `api/author/moderation.ts` add no transition of their own: a
bulk action that could reach a state the single action cannot would be a hole in
the state machine with a friendly name on it.

**A rejection is refused without a reason.** The author reads what the editor
types, verbatim, and "rejected" on its own tells them nothing they can act on.
The check is in the handler rather than the form, because a reason a client may
omit is a reason that will be omitted — by the bulk action, by a script, by the
next client. The reason is denormalised onto `listings.rejection_reason`
(migration 0010) and cleared by every move that is not a rejection; the history
stays in the audit log, which is what an audit log is for.

**Trusted authors do not wait, but they do not skip review either.** An editor
publishing their own listing submits and publishes in one motion — two
transitions, both audited — rather than moving `draft → published`, which the
state machine does not have. The distinction matters when someone asks later
who reviewed a listing: the answer is always a name and a timestamp, even when
it is the author's own.

**Duplicate detection runs at submission and flags rather than refuses.** The
asymmetry with the venue check (which refuses) is about who is next. A duplicate
venue is created by the author, seen by nobody, and merged by nobody. A
duplicate listing goes straight to a moderator about to look at both, so the
flag has a reader — and refusing a genuine second event that merely resembles
the first would be worse than a warning an editor can dismiss. The score is
stored on the row (`suspected_duplicate_of`, `duplicate_score`) rather than
recomputed, because recomputing would put a similarity search inside the one
screen that is worked through in bulk.

Three signals, weighted 0.5 / 0.3 / 0.2 across title, time and place, with a
threshold of 0.75 — and a *contradicted* place vetoes outright, whatever the
title says, because the same tribute night in Kathmandu and in Pokhara is two
gigs. A listing needs three signals where a venue needed two: a venue's name is
close to an identity, and "Open Mic Night" is the title of fifty-two different
events a year. The numbers are reasoned rather than measured — there is no
corpus of known-duplicate Nepali listings yet — so the calibration lives in
`tests/unit/listingMatch.test.ts` as the cases they must get right.

**Merging: the survivor wins every field it has an answer for, the loser fills
the blanks.** Not "longest wins", which rewards padding; not "newest wins",
since the second submission is usually the thinner one, which is why it looked
like a duplicate. Sets — categories, tags, artists — are unioned. Media *moves*
rather than being copied, so no R2 object ends up with two owners. The loser is
archived pointing at the survivor rather than deleted: its slug has to stay
redirectable (#24), and its author deserves to be shown where it went.

**Auto-archive is the Worker's one cron**, at 18:15 UTC — midnight in Kathmandu.
It archives published listings whose `COALESCE(ends_at, starts_at)` passed more
than 24 hours ago, a hundred at a time. The read path already hides finished
events, so this is not about what the public sees: without it, `published` would
be the status of every event that ever happened, and the queue counts, the
dashboard filters and every future report would describe a catalogue that is
mostly the past. The day of grace is because a gig that ended at 2am is still
being looked up at 9am.

## Counting, and what is deliberately not counted

An organizer who can see that 400 people looked at their listing has a reason
to post the next one. That is the whole justification for `listing_stats`
(migration 0011), and it is why the numbers are on the dashboard row rather
than behind an analytics tab.

**A daily counter, not an event log.** `POST /api/catalog/listings/:slug/events`
upserts into `(listing_id, day)` — one statement, off the response path,
bounded at one row per listing per day. An event log with a row per view is the
obvious alternative and it is the shape that makes this the largest table in the
database within a month, needs a retention policy nobody will write, and buys
precision no criterion asks for. What it costs, said now rather than discovered
later: no per-visitor detail, no funnel, no referrer. The day any of those is
wanted, a rollup is what an event log would have produced anyway.

**The beacon is a POST from JavaScript, and that is the bot filter.** A crawler
fetching the page never runs it, which removes the largest source of noise
without a user-agent list to maintain. A view is deduplicated per browser tab
session, so a reload is not a second person; a click is not, because going to
the ticket page twice is two clicks.

**Nothing here identifies anybody.** No cookie is read, no IP is stored, and
the row has no dimension but the day — so there is nothing to disclose beyond
"we count views" and nothing to delete when an account is (#29).

The day is Kathmandu's. A Friday gig is looked up until 2am, and a UTC boundary
would file half of those views under Saturday.

## Leaving

Deleting an account is where a public catalogue and a personal record pull in
opposite directions, so the rule is stated rather than discovered: **what was
published stays published, what was never published goes.**

A published or archived listing survives with `created_by` cleared. It belongs
to the catalogue — people have linked to it and are planning to attend it — and
ownership falls to the organization's other members where there is one, or to
editors where there is not. That is `listing:edit_any` doing its existing job;
nothing new is invented to hold an ownerless listing. Drafts, submissions
awaiting review and rejected listings are deleted with their images: they are
the person's own unfinished writing, and keeping them is a privacy problem
rather than a preservation one.

The user row is deleted, not flagged inactive. Sessions, tokens and memberships
cascade; audit entries keep their action and the role at the time and lose the
actor id, because what the catalogue did is its own history while who did it is
personal data.

## Media

Bytes live in R2 and are proxied through the Worker, so the bucket stays private
and the public URL survives a storage change. Keys are content-addressed —
`listings/<listing id>/<sha256>.<ext>` — which is what makes `immutable` honest:
the content behind a key cannot change, because different content is a different
key. Scoped per listing rather than globally so deleting a listing can delete its
objects without reference counting; cross-listing duplicates cost storage, and a
wrongly deleted image costs a page.

Derivatives are encoded **by the browser** and verified by the Worker. This
deploys to `workers.dev`, which has no zone, so Cloudflare's `/cdn-cgi/image/`
resizing is not reachable at all, and encoding AVIF in the Worker means a WASM
codec inside the request's CPU budget for an image the uploading device has
already decoded. Nothing the client *claims* is trusted: format, byte size,
width and aspect ratio are read from each uploaded file's own header and checked
against the original (`api/media/pipeline.ts`). An importer with no browser
uploads no derivatives and its original is served alone — degraded, not broken.

The read path returns a `srcset` per format, AVIF first, with the original as
the fallback in `url`. Every listing summary carries a `cover` of the same
shape: without derivatives on the *summary*, a card on a phone downloads the
full-size banner, which is exactly the WaahTickets behaviour the pipeline exists
to replace.

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
