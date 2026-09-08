-- 0005 — Free-form tags, and pin appearance derived from the category (#22)
--
-- Two halves of the same criterion: one canonical taxonomy that the map and
-- the browse filters both read, plus a free-form layer for everything a closed
-- list cannot anticipate.
--
-- Categories are closed and seeded (0002). Tags are open and authored. Keeping
-- them in separate tables is what lets the first stay trustworthy — a filter
-- chip means something because nobody can invent a category — while the second
-- absorbs 'holi', 'open-mic', 'kids-welcome' without a migration each time.

-- ─── Tags ────────────────────────────────────────────────────────────────────
-- The slug IS the identity. Two authors typing 'Open Mic' and 'open mic' mean
-- the same tag, and a catalogue that treats them as two is a catalogue whose
-- tag pages are all half-empty. `label` keeps the first spelling seen, for
-- display only.
CREATE TABLE tags (
    slug       TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE listing_tags (
    listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    tag_slug   TEXT NOT NULL REFERENCES tags(slug) ON DELETE CASCADE,
    PRIMARY KEY (listing_id, tag_slug)
);

CREATE INDEX idx_listing_tags_tag ON listing_tags(tag_slug, listing_id);

-- ─── One primary category, exactly ───────────────────────────────────────────
-- Pin appearance is derived from the primary category, so "primary" has to be
-- a function, not a convention. Without this index a listing can carry two
-- primaries and its pin colour depends on row order.
CREATE UNIQUE INDEX idx_listing_categories_primary
    ON listing_categories(listing_id) WHERE is_primary = 1;

-- ─── The second field, removed ───────────────────────────────────────────────
-- listings.map_pin_icon was WaahTickets' mistake ported forward: an icon set
-- independently of the category, which is why that codebase needed a separate
-- `pinCategory` threaded through the map and why its filter chips and its pins
-- could disagree. Appearance now derives from categories.icon / categories.color
-- (see api/catalog/pin.ts). #32 ports the appearance customiser on top of this
-- derivation rather than alongside a duplicate column.
ALTER TABLE listings DROP COLUMN map_pin_icon;
