-- 0014 — The admin console's two indexes
--
-- The console lists accounts with what each has written, and the audit trail
-- newest first. Neither read had an index because neither read existed: the
-- dashboard scopes by author *and* organization through `MINE` and the audit
-- indexes are by entity and by actor, which answer "what happened to this
-- listing?" and "what did this person do?" but not "what happened lately?".
--
-- Both are single-column and both are on tables that grow only when a person
-- does something, so the write cost is nothing anyone will measure.

CREATE INDEX idx_listings_created_by ON listings(created_by);
CREATE INDEX idx_audit_created ON audit_log(created_at);
