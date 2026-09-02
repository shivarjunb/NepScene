-- 0001 — Catalogue core (M1: #20 listings, #21 venues, #22 taxonomy, #24 slugs, #25 media)
--
-- The centre of gravity is the LISTING, not the sellable event. A listing may
-- have no organization (community events), no venue (announcements) and no
-- price (most of what happens in Nepal). See docs/ARCHITECTURE.md.
--
-- Conventions carried over from WaahTickets so the extraction stays a port:
--   ids           TEXT (uuid v4)
--   timestamps    TEXT, ISO-8601 UTC ('2026-09-02T10:30:00Z')
--   booleans      INTEGER 0/1
--
-- Guardrail (docs/SCOPE.md): no column here is an input to a transaction.
-- The offer_* columns on listings are an authored link-out plus a cached
-- display snapshot. Nothing in this database computes money.

-- ─── Organizations (#22) ─────────────────────────────────────────────────────
CREATE TABLE organizations (
    id            TEXT PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    legal_name    TEXT,
    description   TEXT,
    logo_url      TEXT,
    website_url   TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    is_verified   INTEGER NOT NULL DEFAULT 0,
    created_by    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- ─── Venues (#21) ────────────────────────────────────────────────────────────
-- Canonical, not a per-listing child row. A venue owns a page and dedupes
-- across listings; WaahTickets' event_locations could do neither, which is why
-- its map grouped by rounded coordinates instead of by place.
CREATE TABLE venues (
    id              TEXT PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT,
    address         TEXT,
    area            TEXT,               -- neighbourhood: Thamel, Lakeside, Pulchowk
    city            TEXT,
    district        TEXT,
    province        TEXT,
    country         TEXT NOT NULL DEFAULT 'NP',
    latitude        REAL,
    longitude       REAL,
    google_place_id TEXT,               -- dedupe key when picked from the map
    cover_image_url TEXT,
    website_url     TEXT,
    phone           TEXT,
    capacity        INTEGER,            -- informational; not an inventory count
    is_verified     INTEGER NOT NULL DEFAULT 0,
    created_by      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX idx_venues_city ON venues(city);
CREATE INDEX idx_venues_coords ON venues(latitude, longitude);
CREATE UNIQUE INDEX idx_venues_place_id ON venues(google_place_id) WHERE google_place_id IS NOT NULL;

-- ─── Categories (#22) ────────────────────────────────────────────────────────
CREATE TABLE categories (
    id         TEXT PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    name_ne    TEXT,                    -- Nepali label (#46 renders it)
    icon       TEXT,                    -- lucide icon name, shared with the map pins
    color      TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active  INTEGER NOT NULL DEFAULT 1
);

-- ─── Artists / performers (#22) ──────────────────────────────────────────────
CREATE TABLE artists (
    id         TEXT PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    bio        TEXT,
    image_url  TEXT,
    links      TEXT,                    -- JSON: {"instagram": "...", "spotify": "..."}
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- ─── Listings (#20) ──────────────────────────────────────────────────────────
CREATE TABLE listings (
    id              TEXT PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    summary         TEXT,               -- one-line teaser for cards and pins
    description     TEXT,

    -- Type says whether the thing is even sellable; source says who wrote it.
    -- Together they are what makes a catalogue NepScene can publish.
    listing_type    TEXT NOT NULL CHECK (listing_type IN
                      ('ticketed_internal', 'ticketed_external', 'free', 'announcement')),
    source          TEXT NOT NULL CHECK (source IN
                      ('organizer', 'submission', 'import', 'editorial')),
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                      ('draft', 'pending_review', 'published', 'rejected', 'archived')),

    organization_id TEXT REFERENCES organizations(id),  -- nullable: community events have no org
    venue_id        TEXT REFERENCES venues(id),         -- nullable: announcements have no place

    starts_at       TEXT NOT NULL,      -- ISO-8601 UTC
    ends_at         TEXT,
    is_all_day      INTEGER NOT NULL DEFAULT 0,
    timezone        TEXT NOT NULL DEFAULT 'Asia/Kathmandu',

    cover_image_url TEXT,
    external_url    TEXT,               -- the event's own home on the web

    -- The offer seam (docs/SCOPE.md). Rendered, never computed. offer_checked_at
    -- makes it obvious that the price is a cached snapshot, not an authority.
    offer_url              TEXT,
    offer_provider         TEXT CHECK (offer_provider IN ('waahtickets', 'external')),
    offer_price_from_paisa INTEGER,     -- display only, integer paisa
    offer_currency         TEXT NOT NULL DEFAULT 'NPR',
    offer_sold_out         INTEGER NOT NULL DEFAULT 0,
    offer_checked_at       TEXT,

    -- Map presentation. Coordinates here override the venue's, for the cases
    -- where the gathering is not exactly at the registered address.
    location_lat     REAL,
    location_lng     REAL,
    map_pin_icon     TEXT,
    map_popup_config TEXT,              -- JSON, ported from WaahTickets' customizer

    is_featured  INTEGER NOT NULL DEFAULT 0,
    published_at TEXT,
    created_by   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

-- The feed's keyset index: every public read is (status, starts_at, id).
CREATE INDEX idx_listings_feed ON listings(status, starts_at, id);
CREATE INDEX idx_listings_venue ON listings(venue_id);
CREATE INDEX idx_listings_organization ON listings(organization_id);
CREATE INDEX idx_listings_type ON listings(listing_type);
CREATE INDEX idx_listings_source ON listings(source);

CREATE TABLE listing_categories (
    listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (listing_id, category_id)
);

CREATE INDEX idx_listing_categories_category ON listing_categories(category_id, listing_id);

CREATE TABLE listing_artists (
    listing_id    TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    artist_id     TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    billing_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (listing_id, artist_id)
);

CREATE INDEX idx_listing_artists_artist ON listing_artists(artist_id, listing_id);

-- ─── Media (#25) ─────────────────────────────────────────────────────────────
-- Bytes live in R2; this table is the index. r2_key is the only handle the
-- application stores — public URLs are derived, never persisted, so the media
-- host can change without a migration.
CREATE TABLE listing_media (
    id         TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    r2_key     TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL DEFAULT 'image' CHECK (kind IN ('image', 'video')),
    mime_type  TEXT NOT NULL,
    width      INTEGER,
    height     INTEGER,
    bytes      INTEGER,
    alt_text   TEXT,                    -- required for AA compliance (#49)
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_listing_media_listing ON listing_media(listing_id, sort_order);

-- ─── Slug history (#24) ──────────────────────────────────────────────────────
-- A published URL is a promise. When a slug changes the old one 301s here
-- rather than 404ing, which is also what keeps search rankings.
CREATE TABLE slug_redirects (
    entity_type TEXT NOT NULL CHECK (entity_type IN ('listing', 'venue', 'organization', 'artist')),
    old_slug    TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (entity_type, old_slug)
);
