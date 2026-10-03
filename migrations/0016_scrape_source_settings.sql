-- Missing overrides keep the checked-in source enabled by default.
CREATE TABLE scrape_source_settings (
  source_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);
