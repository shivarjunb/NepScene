-- 0003 — Identity, sessions and roles (M1: #27, #28)
--
-- NepScene owns its accounts. "One account works in both products" becomes a
-- token contract with WaahTickets when there is something to hand over; until
-- then, coupling to another product's user table would couple the two schemas
-- (docs/ARCHITECTURE.md — the seam is drawn, not paid for yet).
--
-- Nothing here stores a credential in the clear: passwords are PBKDF2 digests
-- and a session cookie is only ever seen as its SHA-256 hash.

CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL,            -- stored lowercased; see idx_users_email
    email_verified INTEGER NOT NULL DEFAULT 0,
    name           TEXT,
    avatar_url     TEXT,

    -- Null for a Google-only account. An account can gain a password later
    -- without changing rows, which is why provider is not a single flag.
    password_hash  TEXT,
    google_sub     TEXT,

    -- One role per user is enough for authoring and moderation (docs/SCOPE.md).
    -- Organization-scoped permissions live in organization_users below.
    role           TEXT NOT NULL DEFAULT 'visitor'
                     CHECK (role IN ('visitor', 'organizer', 'editor', 'admin')),

    is_active      INTEGER NOT NULL DEFAULT 1,
    last_login_at  TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_users_email ON users(email);
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

-- The session id IS the SHA-256 of the cookie value. A database leak therefore
-- yields no usable cookie, and lookup stays a primary-key hit.
CREATE TABLE user_sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent   TEXT,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL
);

CREATE INDEX idx_user_sessions_user ON user_sessions(user_id, expires_at);

-- Email verification and password reset. Same table because they have the same
-- shape and the same expiry discipline; `kind` keeps them from crossing.
CREATE TABLE user_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('email_verify', 'password_reset')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_user_tokens_user ON user_tokens(user_id, kind);

-- Who may author for which organization. An organizer with no row here can
-- create listings only under their own name.
CREATE TABLE organization_users (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_role        TEXT NOT NULL DEFAULT 'member'
                      CHECK (org_role IN ('owner', 'manager', 'member')),
    created_at      TEXT NOT NULL,
    PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX idx_organization_users_user ON organization_users(user_id);
