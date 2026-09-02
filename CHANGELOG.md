# Changelog

All notable changes to NepScene are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Application scaffold: Worker (Hono) + React SPA, per-environment Cloudflare
  bindings, migration pipeline and a Vitest harness that runs integration tests
  over real HTTP against a real local D1 (#9)
- Catalogue schema: listings with `listing_type` and `source`, venues as
  canonical entities, organizations, artists, categories, media and slug
  history (#20, #21, #22, #24, #25)
- Catalog API v1 — listings, listing detail, venues, venue detail, organizers,
  categories, search and a single-request homepage bootstrap. Bounded by a hard
  page cap, keyset-paginated and upcoming by default (#23)
- Edge-first read path: Cache API responses keyed by a KV version stamp, D1
  read replication via the Sessions API, and an `x-d1-round-trips` header on
  every response so the round-trip budget is measurable (#23)
- `/api/cache/status` probes the cache, KV and D1 with live round trips and
  reports measured latency, rather than reporting that an env var is set
- Demo catalogue seed covering every listing type and source, with dates
  relative to `now` so it never becomes a catalogue of finished events (#26)
- Accounts: email and password sign-in (PBKDF2-SHA256 via WebCrypto), Google
  sign-in over the authorization code flow with PKCE, opaque session cookies
  stored only as their SHA-256, email verification, and per-IP rate limiting on
  credential endpoints (#27)
- Roles and permissions: visitor, organizer, editor and admin resolved through a
  permission matrix rather than role checks in handlers (#28)
- Media upload and delete on R2, scoped by listing ownership or organization
  membership, with alt text required at the point of upload, and intrinsic
  dimensions read from the file header so the client can reserve space (#25)
- Publication workflow: submit, publish, reject, archive and unpublish, with
  the legal transitions enforced in the UPDATE itself and every move recorded
  in an audit trail (#20, #23, #28)
- Devanagari transliteration for slugs — इन्द्र जात्रा becomes `indra-jatra`,
  including word-final schwa deletion and schwa retention after conjuncts (#24)
- Password reset and password change, both revoking every other session (#27)
- Role administration with an audit record of who changed what (#28)
- ESLint enforcing the catalog / author / identity module boundary (#9)
- OpenAPI 3.1 contract served at `/api/openapi.json`, with the integration
  tests validating real responses against it (#23)
- `scripts/seed-volume.mjs` — 10,000 listings in about three seconds, and
  `scripts/verify-catalogue.mjs` — referential integrity and anomaly reporting (#26)
- `scripts/import-waahtickets.mjs` — imports all 50 WaahTickets events and 47
  locations with no data loss, repairing one overnight end-time on the way in
  (#20, #21)
- Design token layer extracted from WaahTickets: purpose-named colour, spacing,
  type, radius, elevation, motion and a named z-index scale, with light and dark
  defined only at the semantic layer (#15)
- Core UI primitives — button, field, input, textarea, select, checkbox, card,
  badge, chip, alert, modal, tabs, spinner, skeleton — each keyboard operable,
  focus-visible and rendered in a gallery in every state (#16)
- Light and dark theming with an inline pre-paint script, an OS-follows-by-
  default preference, and reduced-motion support (#17)
- Application shell: sticky header, primary nav, mobile menu with a focus trap,
  skip link, correct landmarks and a footer, holding from 320px to 2560px (#18)
- NepScene brand identity: crimson accent, one mark used as favicon, app icon
  and wordmark lockup, and a rasterised social card (#19)
- Playwright browser suite covering keyboard operability, focus trapping,
  theme-on-first-paint and responsive behaviour at six widths
- WCAG 2.1 AA contrast enforced by a test that computes ratios from the token
  file, plus stylesheet checks that no component CSS carries a literal colour
  or a raw z-index
- Repository scaffold: product scope, architecture, extraction plan and ways of working
- DevOps pipeline: CI, per-PR previews, staging on merge, gated production promotion
- CodeQL analysis and dependency review
- Migration hygiene check rejecting duplicate migration numbers
- Scope guard flagging commerce vocabulary in review
- Issue templates for epics, features, tasks and bugs
- Backlog: 8 epics and 36 features across milestones M0–M5
