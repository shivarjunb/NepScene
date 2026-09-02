-- 0004 — Audit trail and publication state transitions (#20, #28)
--
-- Two criteria drive this: "every edit is recorded with actor and timestamp"
-- and "publication state transitions are constrained — a draft cannot skip
-- review". The second is enforced in the database rather than the handler,
-- because a constraint that lives in one code path is not a constraint.

CREATE TABLE audit_log (
    id          TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('listing', 'venue', 'organization', 'user', 'media')),
    entity_id   TEXT NOT NULL,
    action      TEXT NOT NULL,          -- 'published', 'role_changed', 'media_added', …
    actor_id    TEXT REFERENCES users(id),
    actor_role  TEXT,                   -- the role at the time, which may change later
    details     TEXT,                   -- JSON: what changed, before and after
    created_at  TEXT NOT NULL
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, created_at);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at);

-- Publication workflow, as a state machine:
--
--   draft ──> pending_review ──> published ──> archived
--     ^            │  ^              │
--     └── rejected ┘  └──────────────┘
--
-- draft → published is deliberately absent. Everything that goes public is
-- reviewed, including an editor's own work.
--
-- This is NOT a trigger, though it wants to be. `wrangler d1 execute` and
-- `d1 migrations apply` both split SQL on semicolons before sending it, so a
-- trigger body — which needs inner semicolons — cannot be applied through the
-- deploy pipeline at all. A constraint that only exists on a developer's
-- machine is worse than no constraint, so the transition is enforced in the
-- UPDATE itself: every status write names the states it is legal to move from,
-- and a zero-row result means the transition was refused. See the TRANSITIONS
-- table in api/author/listings.ts, which is the only place status is written.
