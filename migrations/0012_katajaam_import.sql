-- Stable source identity and content identity protect repeated/concurrent imports.
-- Existing listings keep NULL import keys and are unaffected by these indexes.
ALTER TABLE listings ADD COLUMN import_source_id TEXT;
ALTER TABLE listings ADD COLUMN import_fingerprint TEXT;
CREATE UNIQUE INDEX idx_listing_import_source ON listings(import_source_id)
  WHERE import_source_id IS NOT NULL;
CREATE UNIQUE INDEX idx_listing_import_fingerprint ON listings(import_fingerprint)
  WHERE import_fingerprint IS NOT NULL;

-- Alternate source IDs can refer to one real event. Keep these even after edits.
CREATE TABLE import_sources (
  source_id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);
CREATE INDEX idx_import_sources_listing ON import_sources(listing_id);
