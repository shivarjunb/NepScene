# Recurring and multi-date events

**Spike #35. Decision, 2026-09-09. Output is this document and two follow-up
features; no code ships with it.**

> **Recommendation: one listing, many occurrence rows, materialised at write
> time.** A recurrence rule is an authoring convenience that *generates* rows —
> it is never a thing the read path expands. Everything downstream stays
> indexable, keyset-pageable and cacheable exactly as it is today.

## Why this is a spike and not a ticket

Every listing in NepScene has one `starts_at` and one optional `ends_at`
(migration 0001). That is enough for a gig and wrong for almost everything
else that fills a Nepali calendar: Indra Jatra runs eight days, a play runs
three weekends, an open mic runs every Tuesday until it stops.

WaahTickets sidesteps this — one row, one start, one end — which is part of why
its catalogue cannot represent a festival. Copying that shape here would be
copying the defect.

The choice is hard to reverse because it decides what a *row* is. Slugs,
cursors, the map's pins, the venue page's "what's coming up", the feed's
`ORDER BY starts_at` and the `(status, starts_at, id)` index all read that row.
Getting it wrong means a migration through every listing in the catalogue and
a rewrite of the read path that #23 spent its whole budget making fast.

## The three models

### A. One listing, many occurrences

A child table. The listing owns identity — slug, media, taxonomy, venue,
description — and `listing_occurrences` owns the dates.

```
listings ──< listing_occurrences (starts_at, ends_at, …)
```

### B. Many listings, a shared parent

Each date is a full listing row; a `series` row groups them.

```
listing_series ──< listings (one per date)
```

### C. A recurrence rule, expanded at read time

The listing carries an RRULE (`FREQ=WEEKLY;BYDAY=TU;UNTIL=…`) and the API
expands it per request.

## How each behaves against what NepScene already has

| | A — occurrences | B — listing per date | C — rule at read time |
|---|---|---|---|
| **Feed ordering and the keyset cursor** | Cursor moves to `(occurrence.starts_at, occurrence.id)`. Still a real column, still indexable, still opaque to clients | Unchanged — this is the only model that touches nothing | **Breaks.** You cannot keyset-paginate rows that do not exist. Every recurring listing in the catalogue must be expanded before the first page can be cut |
| **"Upcoming by default"** (#23's rule) | `WHERE occurrence.starts_at >= now` — an index range scan | Same as today | Every recurring listing expanded on every request, then filtered in the Worker. This is the WaahTickets read path with extra steps |
| **Edge cache** | Unchanged; the response is still a pure function of the query and the catalogue version | Unchanged | Unchanged in mechanism, but each miss now costs an expansion |
| **Map pins** | One pin per venue, as now. A weekly event contributes the occurrences inside the visible window — usually one | 52 rows for one open mic. `venueGrouping` collapses them to one pin, so the map survives, but it fetched 52 rows to draw one | Same as A once expanded, at the same cost as above |
| **Venue page** ("what's coming up here") | One entry per event, next date shown | 52 entries for one open mic. Unusable without a de-duplication step that is really model A implemented in the presentation layer | As A |
| **Slugs and canonical URLs** (#24) | One slug per event. A date is a sub-path or a parameter, canonicalised to the bare slug | 52 slugs for one event, 52 near-identical pages. Every one of them competes with the others for the same query | One slug, but nothing stable to link a *specific date* to |
| **Editing** | Change the description once | Change the description 52 times, or build a fan-out that is model A with worse failure modes | Change once |
| **"Cancelled this week only"** | One occurrence row, cancelled | Natural — it is just that listing | Needs an exception list bolted onto the rule (`EXDATE`), which is model A appearing again in a worse format |
| **Migration cost from today** | Backfill one occurrence per listing; rewrite the feed's `FROM` | Nil — today's schema *is* B with a null parent | Backfill nil, rewrite everything that reads dates |

### Walking the three real cases

**A weekly open mic at Purple Haze, every Tuesday, indefinitely.**
- **A:** one listing, one slug, occurrences generated a year ahead and topped up. The map shows one pin. The venue page shows one entry: "Open Mic Night — next Tuesday". The feed, browsed without a date filter, shows it once.
- **B:** 52 listings, 52 slugs, 52 rows on the venue page, and a feed in which the first screen of "Concerts in Kathmandu" is the same open mic six times. This is the failure that made it worth writing a document.
- **C:** correct output, produced by expanding an unbounded rule on every request. "Indefinitely" has no end date, so the expansion needs an arbitrary horizon anyway — at which point the horizon is doing model A's job without model A's index.

**Indra Jatra, eight days, one festival, different programme each day.**
- **A:** one listing, eight occurrences, each with its own start and end and an optional per-occurrence note. One page, one slug, eight dated entries.
- **B:** eight listings that must be kept in sync by hand, and a search for "Indra Jatra" that returns eight results ranked against each other.
- **C:** expressible (`FREQ=DAILY;COUNT=8`) only while every day is identical, which is the one thing a festival's days are not.

**A play with eight performances over three weekends.**
- **A:** eight occurrences. The irregular pattern is just eight rows.
- **B:** eight listings; same problems as Indra Jatra.
- **C:** not expressible as one rule. Two rules, or a rule plus exceptions, which is a list of dates written in a format that resists being queried.

## The recommendation

**Model A, with the rule demoted to an authoring tool.**

The important part is the second half. "Recurring events" is usually taken to
mean storing a rule, and that is the trap: the moment the rule is the source of
truth, the dates are computed rather than stored, and everything that made the
read path fast — an index on a real column, a keyset cursor, a bounded query —
stops applying. The rule belongs in the wizard, where it saves an author typing
eight dates, and the thing it produces is eight rows.

Put another way: the answer to "does the catalogue know what is on next
Tuesday?" must be a range scan, not a computation.

### Schema sketch

```sql
-- Migration 00XX — occurrences
CREATE TABLE listing_occurrences (
    id         TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,

    starts_at  TEXT NOT NULL,               -- ISO-8601 UTC, as listings.starts_at is
    ends_at    TEXT,
    is_all_day INTEGER NOT NULL DEFAULT 0,

    -- Per-date overrides, and only the ones that genuinely vary. A different
    -- description per night is a different listing; a different room, a
    -- different door time and "cancelled" are the same event on a bad day.
    venue_room TEXT,
    note       TEXT,                        -- "Day 3: the chariot procession"
    status     TEXT NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled', 'cancelled')),

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- The feed's index moves here, keeping the same shape: the tuple the cursor
-- pages over and the column the range scan uses.
CREATE INDEX idx_occurrences_feed ON listing_occurrences(starts_at, id);
CREATE INDEX idx_occurrences_listing ON listing_occurrences(listing_id, starts_at);

-- How the dates were made, so the wizard can offer to extend or edit them as a
-- group. Nullable: dates typed by hand have no rule, and that is a normal
-- listing, not a degenerate recurring one.
ALTER TABLE listings ADD COLUMN recurrence_rule TEXT;   -- RFC 5545 RRULE, or NULL
ALTER TABLE listings ADD COLUMN recurrence_until TEXT;  -- how far rows are generated
```

`listings.starts_at` and `ends_at` **stay**, redefined as *the next scheduled
occurrence*, maintained by the write path and by the nightly sweep that already
exists for auto-archive (#33). That is a denormalisation and it is worth
stating why rather than pretending it is free:

- It keeps `idx_listings_feed` useful for every query that wants one row per
  listing — the category browse, the venue page, the organizer dashboard —
  without a `GROUP BY` over occurrences.
- It means the migration below can land in two independent steps rather than as
  one rewrite of the read path.
- The drift risk is real and is contained by having exactly one writer: the
  same code that inserts or deletes an occurrence recomputes it, and the sweep
  reconciles it nightly. Nothing else may write those two columns.

### Map behaviour, specified

- **A weekly event is one pin, not fifty-two.** The map queries occurrences
  within its visible date window (it already takes `from`/`to`), and then
  de-duplicates to one marker per `(venue, listing)` pair before grouping. A
  window that genuinely contains three Tuesdays shows one pin whose popup lists
  three dates.
- Venue grouping (`venueGrouping.ts`, ported in #36) is unchanged: it groups by
  venue and takes a primary event. It receives fewer rows, not different ones.
- A `cancelled` occurrence is not drawn at all. It is not a greyed-out pin: the
  map's job is what is on.

### Search behaviour, specified

- **With a date filter** (`from`/`to`, or "this weekend"): one result per
  occurrence in range. Asking what is on Friday and being told about a Tuesday
  residency would be wrong.
- **Without one** (a category browse, a city browse, a text search): one result
  per listing, at its next scheduled occurrence, ordered by that. This is the
  rule that stops the first screen of "Concerts in Kathmandu" being the same
  open mic six times.
- The distinction is a `GROUP BY listing_id` toggled by whether a date range was
  given, not a new endpoint or a new parameter for clients to get wrong.

### Slugs and canonical URLs, specified

- **One slug per listing**, unchanged (#24). A recurring event has one page.
- A specific date is `/listings/<slug>/<YYYY-MM-DD>`, which renders the same
  page scrolled to that occurrence and emits
  `<link rel="canonical" href="/listings/<slug>">`. Fifty-two URLs that are
  each other's near-duplicates is the thing to avoid; fifty-two URLs that all
  declare one canonical is not.
- An unknown or cancelled date under a valid slug is a 200 on the listing page,
  not a 404. The event exists; that date does not.
- `slug_redirects` needs no change — it maps old slug to listing, and
  occurrences have no slugs of their own.
- Structured data (#45) emits one `Event` per upcoming occurrence on the
  listing page rather than a single `Event` with a date range, because a range
  claims eight continuous days where there are three separate weekends.

## Migration path

Four steps, each independently deployable and independently revertible. No step
requires the one after it.

1. **Add the tables and backfill.** One occurrence per existing listing, copied
   from `starts_at`/`ends_at`/`is_all_day`. Nothing reads it yet. This is a
   pure `CREATE TABLE` plus an `INSERT … SELECT`; it cannot break a read path
   that does not know it exists.
2. **Move the write path.** Creating or editing a listing writes its
   occurrence; `listings.starts_at` becomes derived. Still one occurrence per
   listing everywhere, so no read changes.
3. **Move the read path.** The feed, search and the map read occurrences and
   page over `(occurrence.starts_at, occurrence.id)`. The cursor is opaque and
   `invalid_cursor` is already a defined error, so cursors in flight across the
   deploy degrade to "start again" rather than to a wrong page — the one
   user-visible consequence of the whole migration, and it lasts one deploy.
4. **Let authors make more than one.** The wizard's When step gains "this
   happens more than once", the rule generates rows, and per-occurrence editing
   and cancellation arrive with it.

**What it costs.** Steps 1 and 2 are additive and low-risk. Step 3 is the real
work: `api/catalog/queries.ts` (~340 lines) changes its `FROM`, `shared.ts`
changes what the cursor is built from, and the map query gains a
de-duplication. The tests that pin the feed's behaviour are the safety net and
they are already written.

**What it does not cost.** No listing's slug changes. No URL breaks. The edge
cache and its version stamp are untouched. `listing_media`, `listing_tags`,
`listing_categories` and `listing_artists` are all keyed on the listing and stay
exactly as they are — which is the payoff for putting identity on the listing
rather than on the date.

## Why not the alternatives, in one line each

- **B (listing per date)** is free today and expensive forever: it makes the
  catalogue's most visible surfaces — the feed, the venue page, search results —
  worse in direct proportion to how well a recurring event is doing.
- **C (rule at read time)** trades a storage problem for a latency problem, on
  the one path this project has already decided must be an index range scan
  (docs/ARCHITECTURE.md, "The read path").

## Follow-up

Two features rather than one, because the read path and the authoring surface
are separately shippable and neither fits in a week alongside the other.

| # | Feature | Steps | Estimate |
|---|---|---|---|
| [#81](../../issues/81) | Occurrence model and the read path | 1–3 above | ~5 days |
| [#82](../../issues/82) | Authoring recurring and multi-date events | 4 above | ~4 days |

Neither is M2 work. The first is worth doing before or alongside the map port
(#36), because the map is the surface that a listing-per-date model damages
most and the one it would be most expensive to rewrite twice.
