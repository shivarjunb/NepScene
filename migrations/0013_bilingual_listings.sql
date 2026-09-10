-- 0013 — A listing in both languages (#46)
--
-- Nepali is a second copy of three fields, not a second listings table and not
-- a JSON blob keyed by language code.
--
-- **Why columns.** A translations table (listing_id, field, lang, value) is the
-- shape that generalises, and generalising is the mistake here: it costs a join
-- and a pivot on the hottest read in the system to buy a third language that
-- #46 explicitly rules out of scope. When a third language is genuinely wanted,
-- this is three columns to migrate out of, and the read path will have earned
-- the join.
--
-- **Why nullable, and why English is not.** Content arrives in one language or
-- the other or both, and most of it arrives in English. `title` stays NOT NULL
-- and remains what every non-translated surface reads — a slug, an og:title, a
-- moderation queue, an export. `title_ne` is an addition to a listing, never a
-- replacement for it, so a listing can never exist that some part of the system
-- cannot name.
--
-- **Search reads these directly.** They are matched by the same LIKE list as
-- their English counterparts (api/catalog/queries.ts), which is half of what
-- makes a Devanagari query find a Devanagari title; the other half is the
-- transliteration in api/lib/fold.ts, which is what makes a Latin query find
-- one.
ALTER TABLE listings ADD COLUMN title_ne       TEXT;
ALTER TABLE listings ADD COLUMN summary_ne     TEXT;
ALTER TABLE listings ADD COLUMN description_ne TEXT;
