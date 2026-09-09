-- 0008 — A draft may not know when it is yet (#30)
--
-- listings.starts_at was NOT NULL, which is right for a listing and wrong for a
-- draft. The wizard autosaves from the first keystroke, long before anyone has
-- picked a date, so `POST /api/author/listings` had to invent one — it stamped
-- the creation time. That is a silent wrong answer rather than a missing one:
-- reopen the draft and the When step reads back a real-looking date the author
-- never chose, validation has nothing to object to, and the listing publishes
-- as happening the moment it was started.
--
-- So the column becomes nullable, and "no date yet" is stored as no date.
-- Validation refuses to submit without one (api/author/validate.ts), which is
-- where the requirement actually belongs: a draft may be incomplete, a
-- published listing may not.
--
-- The public read path is unaffected by construction. Every catalog query
-- filters `status = 'published' AND COALESCE(ends_at, starts_at) >= ?`, and a
-- NULL start with a NULL end makes that comparison NULL rather than true, so a
-- dateless row is excluded from every feed, count and search without a single
-- query changing. The keyset cursor orders by (starts_at, id) over published
-- rows only, all of which have a start because validation required one.
--
-- SQLite cannot drop NOT NULL in place, so this is the standard table rebuild:
-- new table, copy, drop, rename, recreate indexes. Foreign keys are disabled
-- around it because the child tables reference listings(id) and would otherwise
-- see the rows vanish with the old table.
--
-- No trigger bodies here: `wrangler d1 migrations apply` splits on semicolons,
-- so a statement with inner semicolons never survives the pipeline (see 0004).

PRAGMA foreign_keys = OFF;

CREATE TABLE listings_new (
    id              TEXT PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    summary         TEXT,
    description     TEXT,

    listing_type    TEXT NOT NULL CHECK (listing_type IN
                      ('ticketed_internal', 'ticketed_external', 'free', 'announcement')),
    source          TEXT NOT NULL CHECK (source IN
                      ('organizer', 'submission', 'import', 'editorial')),
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                      ('draft', 'pending_review', 'published', 'rejected', 'archived')),

    organization_id TEXT REFERENCES organizations(id),
    venue_id        TEXT REFERENCES venues(id),

    -- The one change. Nullable while a draft is being written; required before
    -- it may be submitted, and therefore never null on anything public.
    starts_at       TEXT,
    ends_at         TEXT,
    is_all_day      INTEGER NOT NULL DEFAULT 0,
    timezone        TEXT NOT NULL DEFAULT 'Asia/Kathmandu',

    cover_image_url TEXT,
    external_url    TEXT,

    offer_url              TEXT,
    offer_provider         TEXT CHECK (offer_provider IN ('waahtickets', 'external')),
    offer_price_from_paisa INTEGER,
    offer_currency         TEXT NOT NULL DEFAULT 'NPR',
    offer_sold_out         INTEGER NOT NULL DEFAULT 0,
    offer_checked_at       TEXT,

    location_lat     REAL,
    location_lng     REAL,
    map_popup_config TEXT,

    is_featured  INTEGER NOT NULL DEFAULT 0,
    published_at TEXT,
    created_by   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

INSERT INTO listings_new
SELECT id, slug, title, summary, description, listing_type, source, status,
       organization_id, venue_id, starts_at, ends_at, is_all_day, timezone,
       cover_image_url, external_url, offer_url, offer_provider,
       offer_price_from_paisa, offer_currency, offer_sold_out, offer_checked_at,
       location_lat, location_lng, map_popup_config, is_featured, published_at,
       created_by, created_at, updated_at
  FROM listings;

DROP TABLE listings;

ALTER TABLE listings_new RENAME TO listings;

-- The feed's keyset index: every public read is (status, starts_at, id).
CREATE INDEX idx_listings_feed ON listings(status, starts_at, id);
CREATE INDEX idx_listings_venue ON listings(venue_id);
CREATE INDEX idx_listings_organization ON listings(organization_id);
CREATE INDEX idx_listings_type ON listings(listing_type);
CREATE INDEX idx_listings_source ON listings(source);

PRAGMA foreign_keys = ON;
