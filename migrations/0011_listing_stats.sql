-- 0011 — How many people looked, per listing per day (#34)
--
-- The retention hook, and the reason it is in scope at all: an organizer who
-- can see that 400 people looked at their listing has a reason to post the
-- next one. One who sees nothing has no reason to come back.
--
-- **A daily counter, not an event log.** The obvious shape is a row per view
-- with a timestamp and a session id, rolled up nightly. It is also the shape
-- that makes this table the largest in the database within a month, needs a
-- retention policy nobody will write, and buys precision no acceptance
-- criterion asks for — the requirement is counts that update at least daily.
-- An UPSERT into (listing_id, day) is one statement, bounded at one row per
-- listing per day, and needs no rollup job to go wrong at 3am.
--
-- What that costs, stated rather than discovered later: there is no per-visitor
-- detail, no funnel, no "where did they come from". The day any of those is
-- actually wanted, this table is not in the way — it is a rollup that an event
-- log could equally produce.
--
-- **views and clicks are different questions.** A view is somebody landing on
-- the listing; a click is somebody leaving it for the ticket or the event's own
-- site. The ratio is the only thing here that tells an organizer whether the
-- listing is working, as opposed to merely being found.
--
-- **The day is Kathmandu's, not UTC.** A gig on Friday night generates views
-- until 2am, and a UTC day boundary would file half of them under Saturday.
-- The Worker computes the string; SQLite is never asked what day it is.
CREATE TABLE listing_stats (
    listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    day        TEXT NOT NULL,             -- 'YYYY-MM-DD' in Asia/Kathmandu
    views      INTEGER NOT NULL DEFAULT 0,
    clicks     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (listing_id, day)
);

-- The dashboard's query is "totals for these listings", which is a scan of
-- this listing's rows — served by the primary key. The index below is for the
-- other direction: "what happened yesterday", which a report will want and
-- which the primary key cannot answer without reading the whole table.
CREATE INDEX idx_listing_stats_day ON listing_stats(day);
