-- 0015 — The scrape-run ledger
--
-- The scrapers run on a machine outside Cloudflare (they drive a browser),
-- and until now the only record of a run was a GitHub Actions artifact — which
-- the account's billing lock refuses to store. This table is the record
-- instead: one row per run, whether the nightly schedule or an administrator
-- started it, what each scraper did (the runner's summary.json, verbatim),
-- and where in R2 the full output landed.
--
-- Written by two parties. The admin console inserts a `queued` row when the
-- button is pressed and dispatches the workflow with that id; the runner
-- reports `running`, then `succeeded` or `failed`, through /api/internal with
-- a shared token. A scheduled run has no console row to update and inserts
-- its own. `requested_by` is therefore null for every scheduled run.
--
-- `apply_env` is the D1 environment the importers wrote drafts into, or null
-- for a scrape-only run. Drafts only: an imported listing reaches the public
-- site through the moderation queue, where the "imported" filter and
-- "publish all" live, never directly from a run.

CREATE TABLE scrape_runs (
    id            TEXT PRIMARY KEY,
    trigger       TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
    requested_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    apply_env     TEXT CHECK (apply_env IS NULL OR apply_env IN ('preview', 'staging', 'production')),
    github_run_id INTEGER,
    summary       TEXT,             -- scripts/scrape-all.mjs summary.json, as JSON
    output_key    TEXT,             -- R2 key of the output tarball, once uploaded
    error         TEXT,             -- why a run failed, in one line
    requested_at  TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT
);

-- The console shows the newest runs first, and refuses a second run while one
-- is still queued or running; both reads are answered from this index.
CREATE INDEX idx_scrape_runs_recent ON scrape_runs(requested_at DESC);
