# Changelog

All notable changes to NepScene are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The media pipeline generates and serves derivatives (#25). Images are stored
  under a key derived from their own SHA-256, so the same file uploaded twice is
  one object and `immutable` on the read path stops being a promise the
  application cannot keep. Derivatives are encoded by the browser at four widths
  (320/640/960/1440, never above the original) and **verified** on the way in —
  format, size, width-on-the-ladder and aspect ratio are all read from each
  file's own header, so nothing the request *claims* is trusted. The catalogue
  serves them as a per-format `srcset`, AVIF then WebP then the original, with
  `aspect_ratio` so the box exists before the bytes do. Feed rows carry a
  `cover` with the same shape: without derivatives on the summary a card on a
  phone downloads the full-size banner, which is the WaahTickets behaviour this
  replaces
- `POST /api/author/media/sweep` (admin, dry-run by default) reclaims R2 objects
  no row references. Every write puts bytes before the row that points at them —
  the other order leaves broken images — so a request that dies in between has
  to be collected by something (#25)
- `ResponsiveImage` renders a `<picture>` with `sizes`, intrinsic dimensions and
  lazy loading. `sizes` is required by the component's own types: a srcset
  without it is decoration, because the browser assumes full-viewport width and
  fetches the widest rung on a phone (#25)
- Free-form tags alongside the fixed categories: `tags` and `listing_tags`, a
  `tag=` filter on the feed and search, `GET /api/catalog/tags`, and tags on the
  listing detail. Categories stay closed and seeded so a filter chip means
  something; tags absorb `holi`, `open-mic` and `kids-welcome` without a
  migration each time. Spellings normalise through the same slug rules as URLs,
  so `Open Mic`, `open mic` and `Open-Mic` are one tag rather than three
  half-empty browse pages (#22)
- An `artist=` filter on the feed, so the listing-to-artist relationship
  resolves in both directions rather than only outwards from a listing (#22)
- `npm run ci:guards` fails the build on a committed credential
  (`scripts/check-secrets.mjs`). GitHub push protection is on and does block —
  a Slack token and a Stripe key were both refused — but a Google API key in the
  `AIza…` shape pushed to this repository cleanly, and that is the shape of the
  Maps key. The guard covers what push protection does not: by format for the
  Google credentials, by variable name for tokens no regex can recognise on
  sight. It reads `git ls-files`, so a gitignored `.dev.vars` is not flagged (#13)

### Changed
- **Breaking (Catalog API).** `MediaItem` gains `sources`, `aspect_ratio` and a
  `cover` on every listing summary; uploads now reject an image whose header
  will not parse, because a picture with no intrinsic size cannot reserve a box
  and layout shift is what a reader actually notices (#25)
- **Breaking (Catalog API).** Map pin appearance is derived from the primary
  category instead of stored: `listings.map_pin_icon` is dropped and listings
  carry `pin: { icon, color, category }`, computed on every read. WaahTickets
  let an author set a pin icon independently of the event's type, and paid for
  it twice — the map needed a separate `pinCategory` concept to reconcile the
  icon with the filter chips, and the two drifted anyway. A partial unique index
  makes "the primary category" a function rather than a convention, so a pin's
  colour can no longer depend on row order. The WaahTickets importer reports the
  events whose stored icon disagreed with their type rather than carrying the
  disagreement across (#22, and the default #32 customises on top of)

### Fixed
- The social card is absolute. `og:image` was a relative `/brand/og-card.png`, and
  Facebook, X and WhatsApp fetch that URL with no base — the result is not a broken
  image but no preview card at all, which nothing in the application ever notices.
  The origin is injected at build time per environment (`VITE_PUBLIC_ORIGIN`), and
  `scripts/smoke.mjs` now fails a deploy whose card is relative or does not resolve
  (#19)
- The production promotion gate now runs before the approval gate, not after it.
  The check that an unverified SHA had passed staging lived inside the job that
  declares `environment: production`, and GitHub holds such a job at the approval
  gate before any step runs — so the refusal could only fire once a reviewer had
  already approved the promotion. Split into an ungated `gate` job that `promote`
  needs, and granted `actions: read` so the run-history query it depends on cannot
  fail for a permissions reason and be mistaken for a refusal (#11)

## [0.1.0] — 2026-09-02

First release. Everything below reached `main` in one merge (#54): the scaffold,
the design system, the catalogue core and Catalog API v1, identity and roles, the
three Cloudflare environments, and a delivery pipeline that runs.

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

### Fixed
- Preview deploys never worked: `versions upload` ran without `--env preview`, so
  it uploaded the top-level configuration — whose bindings are local placeholders
  — and failed on an invalid KV namespace after provisioning a stray R2 bucket
  (#11)
- Staging and production migrations ran without `--env`, so wrangler resolved the
  database from the top-level configuration and could not find it (#12)
- Coverage reported 0% of 997 statements: the `v8` provider cannot instrument code
  running inside workerd. Under `istanbul` the real figure is 91% of statements,
  now enforced as a threshold that fails the build on a drop (#10)
- Smoke tests could not fail: they requested `/health`, which the SPA fallback
  answers with a 200 for any unmatched path, against a domain that does not
  resolve. They now assert `/api/health` reports the expected environment (#11)
- The scope guard missed `createCheckout` and `orderItems` — the casings commerce
  would actually arrive in (#10)

### Changed
- CI is one `verify` job rather than a four-way matrix: on a single self-hosted
  runner the matrix ran serially and reinstalled dependencies four times, costing
  thirteen minutes. Same checks, 2m10s (#10, #53)
- Actions run on a self-hosted runner; hosted runners remain blocked at the
  account level (#53)
- Actions approval required for all outside contributors — the repository is
  public and the runner is a personal machine (#53)
- `main` is protected: no direct pushes, `verify` required, linear history (#14)
