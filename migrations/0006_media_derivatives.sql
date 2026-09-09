-- 0006 — Derivatives, content-addressed keys (#25)
--
-- A discovery feed is mostly pictures. WaahTickets stores originals in R2 and
-- proxies them whole, which serves a 2MB banner to a phone on 3G in Pokhara;
-- that single fact is the biggest lever NepScene has on mobile performance.
--
-- The original stays the source of truth. Derivatives are a cache of it that
-- happens to live in R2 — every row here can be deleted and regenerated from
-- the original without the catalogue noticing.

-- ─── Content addressing ──────────────────────────────────────────────────────
-- The key is now derived from the bytes: listings/<id>/<sha256>.<ext>. Two
-- consequences worth the column. Re-uploading the same file to the same listing
-- writes the same key instead of a second copy, and `immutable` on the read
-- path stops being a promise the application cannot keep — a key's content can
-- no longer change, because different content is a different key.
--
-- Scoped by listing rather than globally so that deleting a listing can delete
-- its objects without reference counting. Cross-listing duplicates cost storage;
-- a wrongly deleted image costs a page.
ALTER TABLE listing_media ADD COLUMN content_hash TEXT;

-- ─── Derivatives ─────────────────────────────────────────────────────────────
CREATE TABLE media_derivatives (
    id         TEXT PRIMARY KEY,
    media_id   TEXT NOT NULL REFERENCES listing_media(id) ON DELETE CASCADE,
    r2_key     TEXT NOT NULL UNIQUE,
    format     TEXT NOT NULL CHECK (format IN ('avif', 'webp', 'jpeg', 'png')),
    width      INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    bytes      INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

-- The read path always wants every derivative of one image, narrowest first —
-- that is the order a srcset is written in.
CREATE INDEX idx_media_derivatives_media ON media_derivatives(media_id, width);

-- One variant per (image, format, width). Without this a retried upload
-- silently doubles the srcset and the browser picks whichever it saw last.
CREATE UNIQUE INDEX idx_media_derivatives_variant
    ON media_derivatives(media_id, format, width);
