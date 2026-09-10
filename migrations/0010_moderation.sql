-- 0010 — What a moderator needs the row to remember (#33)
--
-- The state machine itself is migration 0004 and needs nothing added: draft →
-- pending_review → published → archived, enforced in the UPDATE's WHERE clause
-- because a trigger cannot survive `d1 migrations apply` splitting on
-- semicolons. What is missing is everything *around* a decision — why it was
-- made, what it was made against, and when the listing stopped being current.
--
-- Four columns, and each one exists because the alternative is worse.
--
-- **rejection_reason.** The audit log already records a rejection with its
-- reason in `details`. That is the right place for history and the wrong place
-- for display: showing an author why their listing came back would mean a
-- query into a JSON blob on a table indexed for auditing, on every load of
-- their own listing. The reason is denormalised onto the row it is about. It
-- is the *last* reason, deliberately — an author resubmitting needs to know
-- what to fix now, not the argument from three months ago, which the audit log
-- still has.
--
-- **suspected_duplicate_of and duplicate_score.** Duplicate detection runs at
-- submission rather than in the queue, and the answer is stored rather than
-- recomputed. Recomputing per row would put a similarity search inside the
-- moderation queue's page load — the one screen that must stay fast because it
-- is worked through in bulk. Stored, the queue reads it in the join it was
-- already doing. The staleness this buys is acceptable and bounded: the check
-- re-runs on every resubmission, which is exactly when the listing changed.
--
--   NULL score means "checked, nothing found"; NULL both means "never checked",
--   which is every row that predates this migration.
--
-- **duplicate_of.** Set on the *loser* of a merge, pointing at the survivor.
-- Not a deletion, because two things still need the row: the slug it owned has
-- to be redirectable (#24), and an author whose submission was merged should be
-- shown where it went rather than finding it gone.
--
-- Nullable columns only, so this is ALTER TABLE ADD COLUMN — the one schema
-- change SQLite makes in place — one statement each, no table rebuild, no
-- PRAGMA dance of the kind 0008 needed.

ALTER TABLE listings ADD COLUMN rejection_reason TEXT;

ALTER TABLE listings ADD COLUMN suspected_duplicate_of TEXT REFERENCES listings(id);

ALTER TABLE listings ADD COLUMN duplicate_score REAL;

ALTER TABLE listings ADD COLUMN duplicate_of TEXT REFERENCES listings(id);

-- The moderation queue's own index. Its query is "everything pending, oldest
-- first" — the opposite order to the feed's, and on a different column, so
-- idx_listings_feed (status, starts_at, id) cannot serve it: it would order by
-- when the event happens rather than by how long its author has been waiting.
CREATE INDEX idx_listings_queue ON listings(status, updated_at);

-- Auto-archive's index. The sweep asks for published listings whose end has
-- passed, and COALESCE(ends_at, starts_at) is the expression it asks by: a
-- listing with no explicit end finishes when it starts. Indexing the
-- expression rather than the columns is what keeps the nightly sweep from
-- scanning every published row in the catalogue.
CREATE INDEX idx_listings_finished ON listings(status, COALESCE(ends_at, starts_at));
